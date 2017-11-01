// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as glob from 'glob';
import * as colors from 'colors';
import * as os from 'os';
import * as path from 'path';
import * as fsx from 'fs-extra';
import * as semver from 'semver';
import * as tar from 'tar';
import * as wordwrap from 'wordwrap';
import globEscape = require('glob-escape');
import { JsonFile } from '@microsoft/node-core-library';

import AsyncRecycler from '../../utilities/AsyncRecycler';
import RushConfiguration from '../../data/RushConfiguration';
import RushConfigurationProject from '../../data/RushConfigurationProject';
import { RushConstants } from '../../RushConstants';
import Utilities from '../../utilities/Utilities';
import { Stopwatch } from '../../utilities/Stopwatch';
import IPackageJson from '../../utilities/IPackageJson';
import { IRushTempPackageJson } from '../utilities/Package';
import ShrinkwrapFile from '../utilities/ShrinkwrapFile';

const MAX_INSTALL_ATTEMPTS: number = 5;

const wrap: (textToWrap: string) => string = wordwrap.soft(Utilities.getConsoleWidth());

/**
 * Controls the behavior of InstallManager.installCommonModules()
 */
export enum InstallType {
  /**
   * The default behavior: (1) If the timestamps are up to date, don't do anything.
   * (2) Otherwise, if the common folder is in a good state, do an incremental install.
   * (3) Otherwise, delete everything, clear the cache, and do a clean install.
   */
  Normal,
  /**
   * Force a clean install, i.e. delete "common\node_modules", clear the cache,
   * and then install.
   */
  ForceClean,
  /**
   * Same as ForceClean, but also clears the global NPM cache (which is not threadsafe).
   */
  UnsafePurge
}

/**
 * This class implements common logic between "rush install" and "rush generate".
 */
export default class InstallManager {
  private _rushConfiguration: RushConfiguration;
  private _commonNodeModulesMarkerFilename: string;
  private _asyncRecycler: AsyncRecycler;

  /**
   * Returns a map of all direct dependencies that only have a single semantic version specifier
   */
  public static collectImplicitlyPinnedVersions(rushConfiguration: RushConfiguration): Map<string, string> {
    const directDependencies: Map<string, Set<string>> = new Map<string, Set<string>>();

    rushConfiguration.projects.forEach((project: RushConfigurationProject) => {
      InstallManager._addDependenciesToMap(rushConfiguration, directDependencies,
        project.cyclicDependencyProjects, project.packageJson.dependencies);
      InstallManager._addDependenciesToMap(rushConfiguration, directDependencies,
        project.cyclicDependencyProjects, project.packageJson.devDependencies);
    });

    const implicitlyPinned: Map<string, string> = new Map<string, string>();
    directDependencies.forEach((versions: Set<string>, dep: string) => {
      if (versions.size === 1) {
        const version: string = versions.values().next().value;
        implicitlyPinned.set(dep, version);
      }
    });
    return implicitlyPinned;
  }

  // tslint:disable-next-line:no-any
  public static _keys<T>(data: Map<T, any>): Array<T> {
    const keys: Array<T> = new Array<T>();

    const iterator: Iterator<T> = data.keys();
    let current: IteratorResult<T> = iterator.next();
    while (!current.done) {
      keys.push(current.value);
      current = iterator.next();
    }
    return keys;
  }

  private static _addDependencyToMap(directDependencies: Map<string, Set<string>>,
    dependency: string, version: string): void {
    if (!directDependencies.has(dependency)) {
      directDependencies.set(dependency, new Set<string>());
    }
    directDependencies.get(dependency)!.add(version);
  }

  private static _addDependenciesToMap(
    rushConfiguration: RushConfiguration,
    directDependencies: Map<string, Set<string>>,
    cyclicDeps: Set<string>, deps: { [dep: string]: string } | undefined): void {

    if (deps) {
      Object.keys(deps).forEach((dependency: string) => {
        const version: string = deps[dependency];

        // If the dependency is not a local project OR
        //    the dependency is a cyclic dependency OR
        //    we depend on a different version than the one locally
        if (!rushConfiguration.getProjectByName(dependency) || cyclicDeps.has(dependency) ||
          !semver.satisfies(rushConfiguration.getProjectByName(dependency)!.packageJson.version, version)) {
          InstallManager._addDependencyToMap(directDependencies, dependency, version);
        }
      });
    }
  }

  constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;

    // Example: "C:\MyRepo\common\last-install.flag"
    this._commonNodeModulesMarkerFilename = path.join(
      this._rushConfiguration.commonTempFolder, 'last-install.flag');

    this._asyncRecycler = new AsyncRecycler(this._rushConfiguration);
  }

  /**
   * Returns the filename of the flag file used to detect invalid installations.
   * The file itself may not actually exist.  If the file exists, it means an "npm install"
   * was successfully completed for the "common/node_modules" folder.
   * Example: "C:\MyRepo\common\last-install.flag"
   */
  public get commonNodeModulesMarkerFilename(): string {
    return this._commonNodeModulesMarkerFilename;
  }

  /**
   * If the "npm-local" symlink hasn't been set up yet, this creates it, installing the
   * specified NPM version in the user's home directory if needed.
   */
  public ensureLocalNpmTool(forceReinstall: boolean): void {
    // Example: "C:\Users\YourName\.rush"
    const rushHomeFolder: string = path.join(this._rushConfiguration.homeFolder, '.rush');

    if (!fsx.existsSync(rushHomeFolder)) {
      console.log('Creating ' + rushHomeFolder);
      fsx.mkdirSync(rushHomeFolder);
    }

    // Example: "C:\Users\YourName\.rush\npm-1.2.3"
    const npmToolFolder: string = path.join(rushHomeFolder, 'npm-' + this._rushConfiguration.npmToolVersion);
    // Example: "C:\Users\YourName\.rush\npm-1.2.3\last-install.flag"
    const npmToolFlagFile: string = path.join(npmToolFolder, 'last-install.flag');

    // NOTE: We don't care about the timestamp for last-install.flag, because nobody will change
    // the package.json for this case
    if (forceReinstall || !fsx.existsSync(npmToolFlagFile)) {
      console.log(colors.bold('Installing NPM version ' + this._rushConfiguration.npmToolVersion) + os.EOL);

      Utilities.installPackageInDirectory(
        npmToolFolder,
        'npm',
        this._rushConfiguration.npmToolVersion,
        'npm-local-install',
        MAX_INSTALL_ATTEMPTS
      );

      // Create the marker file to indicate a successful install
      fsx.writeFileSync(npmToolFlagFile, '');
      console.log('Successfully installed NPM ' + this._rushConfiguration.npmToolVersion);
    } else {
      console.log('Found NPM version ' + this._rushConfiguration.npmToolVersion + ' in ' + npmToolFolder);
    }

    // Example: "C:\MyRepo\common\temp"
    if (!fsx.existsSync(this._rushConfiguration.commonTempFolder)) {
      fsx.mkdirsSync(this._rushConfiguration.commonTempFolder);
    }

    // Example: "C:\MyRepo\common\temp\npm-local"
    const localNpmToolFolder: string = path.join(this._rushConfiguration.commonTempFolder, 'npm-local');
    if (fsx.existsSync(localNpmToolFolder)) {
      fsx.unlinkSync(localNpmToolFolder);
    }
    console.log(os.EOL + 'Symlinking "' + localNpmToolFolder + '"');
    console.log('  --> "' + npmToolFolder + '"');
    fsx.symlinkSync(npmToolFolder, localNpmToolFolder, 'junction');
  }

  /**
   * Regenerates the common/package.json and all temp_modules projects.
   */
  public createTempModules(): void {
    this.createTempModulesAndCheckShrinkwrap(undefined);
  }

  /**
   * Regenerates the common/package.json and all temp_modules projects.
   * If shrinkwrapFile is provided, this function also validates whether it contains
   * everything we need to install and returns true if so; in all other cases,
   * the return value is false.
   */
  public createTempModulesAndCheckShrinkwrap(shrinkwrapFile: ShrinkwrapFile | undefined): boolean {
    const stopwatch: Stopwatch = Stopwatch.start();

    // Example: "C:\MyRepo\common\temp\projects"
    const tempProjectsFolder: string = path.join(this._rushConfiguration.commonTempFolder,
      RushConstants.rushTempProjectsFolderName);

    console.log(os.EOL + colors.bold('Updating temp projects in ' + tempProjectsFolder));

    Utilities.createFolderWithRetry(tempProjectsFolder);

    // We will start with the assumption that it's valid, and then set it to false if
    // any of the checks fail
    let shrinkwrapIsValid: boolean = true;

    if (!shrinkwrapFile) {
      shrinkwrapIsValid = false;
    }

    // Find the implicitly pinnedVersions
    // These are any first-level dependencies for which we only consume a single version range
    // (e.g. every package that depends on react uses an identical specifier)
    const implicitlyPinned: Map<string, string> =
      InstallManager.collectImplicitlyPinnedVersions(this._rushConfiguration);
    const pinnedVersions: Map<string, string> = new Map<string, string>();

    implicitlyPinned.forEach((version: string, dependency: string) => {
      pinnedVersions.set(dependency, version);
    });

    this._rushConfiguration.pinnedVersions.forEach((version: string, dependency: string) => {
      pinnedVersions.set(dependency, version);
    });

    if (shrinkwrapFile) {
      // Check any pinned dependencies first
      pinnedVersions.forEach((version: string, dependency: string) => {
        if (!shrinkwrapFile.hasCompatibleDependency(dependency, version)) {
          console.log(colors.yellow(wrap(
            `${os.EOL}The NPM shrinkwrap file does not provide "${dependency}"`
            + ` (${version}) required by pinned versions`)));
          shrinkwrapIsValid = false;
        }
      });

      if (this._findOrphanedTempProjects(shrinkwrapFile)) {
        // If there are any orphaned projects, then "npm install" would fail because the shrinkwrap
        // contains references such as "resolved": "file:projects\\project1" that refer to nonexistent
        // file paths.
        shrinkwrapIsValid = false;
      }
    }

    // Either way, resync the temporary shrinkwrap file.
    // Copy (or delete) common\npm-shrinkwrap.json --> common\temp\npm-shrinkwrap.json
    this.syncFile(this._rushConfiguration.committedShrinkwrapFilename,
      this._rushConfiguration.tempShrinkwrapFilename);

    // Also copy down the committed .npmrc file, if there is one
    // "common\.npmrc" --> "common\temp\.npmrc"
    const committedNpmrcPath: string = path.join(this._rushConfiguration.commonRushConfigFolder, '.npmrc');
    const tempNpmrcPath: string = path.join(this._rushConfiguration.commonTempFolder, '.npmrc');
    this.syncFile(committedNpmrcPath, tempNpmrcPath);

    const commonPackageJson: IPackageJson = {
      dependencies: {},
      description: 'Temporary file generated by the Rush tool',
      name: 'rush-common',
      private: true,
      version: '0.0.0'
    };

    // Add any pinned versions to the top of the commonPackageJson
    // do this in alphabetical order for simpler debugging
    InstallManager._keys(pinnedVersions).sort().forEach((dependency: string) => {
      commonPackageJson.dependencies![dependency] = pinnedVersions.get(dependency)!;
    });

    // To make the common/package.json file more readable, sort alphabetically
    // according to rushProject.tempProjectName instead of packageName.
    const sortedRushProjects: RushConfigurationProject[] = this._rushConfiguration.projects.slice(0);
    sortedRushProjects.sort(
      (a: RushConfigurationProject, b: RushConfigurationProject) => a.tempProjectName.localeCompare(b.tempProjectName)
    );

    for (const rushProject of sortedRushProjects) {
      const packageJson: IPackageJson = rushProject.packageJson;

      // Example: "C:\MyRepo\common\temp\projects\my-project-2.tgz"
      const tarballFile: string = this._getTarballFilePath(rushProject);

      // Example: "my-project-2"
      const unscopedTempProjectName: string = rushProject.unscopedTempProjectName;

      // Example: dependencies["@rush-temp/my-project-2"] = "file:./projects/my-project-2.tgz"
      commonPackageJson.dependencies![rushProject.tempProjectName]
        = `file:./${RushConstants.rushTempProjectsFolderName}/${rushProject.unscopedTempProjectName}.tgz`;

      const tempPackageJson: IRushTempPackageJson = {
        name: rushProject.tempProjectName,
        version: '0.0.0',
        private: true,
        dependencies: {}
      };

      // If there are any optional dependencies, copy them over directly
      if (packageJson.optionalDependencies) {
        tempPackageJson.optionalDependencies = packageJson.optionalDependencies;
      }

      // Collect pairs of (packageName, packageVersion) to be added as temp package dependencies
      const pairs: { packageName: string, packageVersion: string }[] = [];

      // If there are devDependencies, we need to merge them with the regular
      // dependencies.  If the same library appears in both places, then the
      // regular dependency takes precedence over the devDependency.
      // It also takes precedence over a duplicate in optionalDependencies,
      // but NPM will take care of that for us.  (Frankly any kind of duplicate
      // should be an error, but NPM is pretty lax about this.)
      if (packageJson.devDependencies) {
        for (const packageName of Object.keys(packageJson.devDependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.devDependencies[packageName] });
        }
      }

      if (packageJson.dependencies) {
        for (const packageName of Object.keys(packageJson.dependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.dependencies[packageName] });
        }
      }

      for (const pair of pairs) {
        // Is there a locally built Rush project that could satisfy this dependency?
        // If so, then we will symlink to the project folder rather than to common/temp/node_modules.
        // In this case, we don't want "npm install" to process this package, but we do need
        // to record this decision for "rush link" later, so we add it to a special 'rushDependencies' field.
        const localProject: RushConfigurationProject | undefined =
          this._rushConfiguration.getProjectByName(pair.packageName);
        if (localProject) {

          // Don't locally link if it's listed in the cyclicDependencyProjects
          if (!rushProject.cyclicDependencyProjects.has(pair.packageName)) {

            // Also, don't locally link if the SemVer doesn't match
            const localProjectVersion: string = localProject.packageJson.version;
            if (semver.satisfies(localProjectVersion, pair.packageVersion)) {

              // We will locally link this package
              if (!tempPackageJson.rushDependencies) {
                tempPackageJson.rushDependencies = {};
              }
              tempPackageJson.rushDependencies[pair.packageName] = pair.packageVersion;
              continue;
            }
          }
        }

        // We will NOT locally link this package; add it as a regular dependency.
        tempPackageJson.dependencies![pair.packageName] = pair.packageVersion;

        if (shrinkwrapFile) {
          if (!shrinkwrapFile.hasCompatibleDependency(pair.packageName, pair.packageVersion,
            rushProject.tempProjectName)) {
            console.log(colors.yellow(
              wrap(`${os.EOL}The NPM shrinkwrap file is missing "${pair.packageName}"`
                + ` (${pair.packageVersion}) required by "${rushProject.packageName}".`)));
            shrinkwrapIsValid = false;
          }
        }
      }

      // NPM expects the root of the tarball to have a directory called 'package'
      const npmPackageFolder: string = 'package';

      // Example: "C:\MyRepo\common\temp\projects\my-project-2.new"
      const tempProjectFolder: string = path.join(
        this._rushConfiguration.commonTempFolder,
        RushConstants.rushTempProjectsFolderName,
        unscopedTempProjectName + '.new');

      // Example: "C:\MyRepo\common\temp\projects\my-project-2\package.json"
      const tempPackageJsonFilename: string = path.join(tempProjectFolder, RushConstants.packageJsonFilename);

      // Example: "C:\MyRepo\common\temp\projects\my-project-2.old"
      const extractedFolder: string = tempProjectFolder + '.old';

      // we only want to overwrite the package if the existing tarball's package.json is different from tempPackageJson
      let shouldOverwrite: boolean = true;
      try {
        // extract the tarball and compare the package.json directly
        if (fsx.existsSync(tarballFile)) {

          // ensure the folder we are about to extract into exists
          Utilities.createFolderWithRetry(extractedFolder);

          tar.extract({
            cwd: extractedFolder,
            file: tarballFile,
            sync: true
          });

          const extractedPackageJsonFilename: string =
            path.join(extractedFolder, npmPackageFolder, RushConstants.packageJsonFilename);

          // compare the extracted package.json with the one we are about to write
          const oldBuffer: Buffer = fsx.readFileSync(extractedPackageJsonFilename);
          const newBuffer: Buffer = new Buffer(JsonFile.stringify(tempPackageJson));

          if (Buffer.compare(oldBuffer, newBuffer) === 0) {
            shouldOverwrite = false;
          }
        }
      } catch (error) {
        // ignore the error, we will go ahead and create a new tarball
      }

      if (shouldOverwrite) {
        // ensure the folder we are about to zip exists
        Utilities.createFolderWithRetry(tempProjectFolder);

        // write the expected package.json file into the zip staging folder
        JsonFile.save(tempPackageJson, tempPackageJsonFilename);

        // create the new tarball, this overwrites the existing one
        tar.create({
          gzip: true,
          file: tarballFile,
          cwd: tempProjectFolder,
          portable: true,
          noPax: true,
          sync: true,
          prefix: npmPackageFolder
        }, ['package.json']);

        console.log(`Updating ${tarballFile}`);
      }

      // clean up the old tarball & the temp folder
      fsx.removeSync(tempProjectFolder);
      fsx.removeSync(extractedFolder);
    }

    // Example: "C:\MyRepo\common\temp\package.json"
    const commonPackageJsonFilename: string = path.join(this._rushConfiguration.commonTempFolder,
      RushConstants.packageJsonFilename);

    // Don't update the file timestamp unless the content has changed, since "rush install"
    // will consider this timestamp
    JsonFile.save(commonPackageJson, commonPackageJsonFilename, { onlyIfChanged: true });

    stopwatch.stop();
    console.log(`Finished creating temporary modules (${stopwatch.toString()})`);

    return shrinkwrapIsValid;
  }

  /**
   * Runs "npm install" in the common folder, in one of three ways:
   * 1. No action because it is already up to date
   * 2. Incremental action ("npm prune", "npm install", etc).
   * 3. Full clean and "npm install"
   */
  public installCommonModules(installType: InstallType): void {
    // Example: "C:\MyRepo\common\temp\npm-local\node_modules\.bin\npm"
    const npmToolFilename: string = this._rushConfiguration.npmToolFilename;
    if (!fsx.existsSync(npmToolFilename)) {
      // This normally should never occur -- it indicates that some code path forgot to call
      // InstallManager.ensureLocalNpmTool().
      throw new Error('Expected to find local NPM here: "' + npmToolFilename + '"');
    }

    console.log(os.EOL + colors.bold('Checking node_modules in ' + this._rushConfiguration.commonTempFolder)
      + os.EOL);

    const commonNodeModulesFolder: string = path.join(this._rushConfiguration.commonTempFolder,
      'node_modules');

    // This marker file indicates that the last "rush install" completed successfully
    const markerFileExistedAtStart: boolean = fsx.existsSync(this.commonNodeModulesMarkerFilename);

    // If "--clean" or "--full-clean" was specified, or if the last install was interrupted,
    // then we will need to delete the node_modules folder.  Otherwise, we can do an incremental
    // install.
    const deletingNodeModules: boolean = installType !== InstallType.Normal || !markerFileExistedAtStart;

    // Based on timestamps, can we skip this install entirely?
    if (!deletingNodeModules) {
      const potentiallyChangedFiles: string[] = [];

      // Consider the timestamp on the node_modules folder; if someone tampered with it
      // or deleted it entirely, then we can't skip this install
      potentiallyChangedFiles.push(commonNodeModulesFolder);

      // Additionally, if they pulled an updated npm-shrinkwrap.json file from Git,
      // then we can't skip this install
      potentiallyChangedFiles.push(this._rushConfiguration.committedShrinkwrapFilename);

      // Also consider timestamps for all the temp tarballs. (createTempModulesAndCheckShrinkwrap() will
      // carefully preserve these timestamps unless something has changed.)
      // Example: "C:\MyRepo\common\temp\projects\my-project-2.tgz"
      potentiallyChangedFiles.push(...this._rushConfiguration.projects.map(x => {
        return this._getTarballFilePath(x);
      }));

      // NOTE: If commonNodeModulesMarkerFilename (or any of the potentiallyChangedFiles) does not
      // exist, then isFileTimestampCurrent() returns false.
      if (Utilities.isFileTimestampCurrent(this.commonNodeModulesMarkerFilename, potentiallyChangedFiles)) {
        // Nothing to do, because everything is up to date according to time stamps
        return;
      }
    } else {
      console.log(`Deleting the NPM cache folder`);
      // This is faster and more thorough than "npm cache clean"
      this._asyncRecycler.moveFolder(this._rushConfiguration.npmCacheFolder);

      console.log(`Deleting the "npm-tmp" folder`);
      this._asyncRecycler.moveFolder(this._rushConfiguration.npmTmpFolder);
    }

    if (markerFileExistedAtStart) {
      // Delete the successful install file to indicate the install transaction has started
      fsx.unlinkSync(this.commonNodeModulesMarkerFilename);
    }

    // Since we're tampering with common/node_modules, delete the "rush link" flag file if it exists;
    // this ensures that a full "rush link" is required next time
    Utilities.deleteFile(this._rushConfiguration.rushLinkJsonFilename);

    // Is there an existing "node_modules" folder to consider?
    if (fsx.existsSync(commonNodeModulesFolder)) {
      // Should we delete the entire "node_modules" folder?
      if (deletingNodeModules) {
        // YES: Delete "node_modules"

        // Explain to the user why we are hosing their node_modules folder
        if (installType === InstallType.Normal) {
          console.log('Deleting the "node_modules" folder because the previous Rush install' +
            ' did not complete successfully.');
        } else {
          console.log('Deleting old files from ' + commonNodeModulesFolder);
        }

        this._asyncRecycler.moveFolder(commonNodeModulesFolder);

        // Since it may be a while before NPM gets around to creating the "node_modules" folder,
        // create an empty folder so that the above warning will be shown if we get interrupted.
        Utilities.createFolderWithRetry(commonNodeModulesFolder);
      } else {
        // NO: Do an incremental install in the "node_modules" folder

        console.log(`Running "npm prune" in ${this._rushConfiguration.commonTempFolder}`);
        const npmArgs: string[] = ['prune'];
        this.pushConfigurationNpmArgs(npmArgs);
        Utilities.executeCommandWithRetry(npmToolFilename, npmArgs, MAX_INSTALL_ATTEMPTS,
          this._rushConfiguration.commonTempFolder);

        // Delete the (installed image of) the temp projects, since "npm install" does not
        // detect changes for "file:./" references.
        // We recognize the temp projects by their names, which always start with "rush-".

        // Example: "C:\MyRepo\common\temp\node_modules\@rush-temp"
        const pathToDeleteWithoutStar: string = path.join(commonNodeModulesFolder, RushConstants.rushTempNpmScope);
        console.log(`Deleting ${pathToDeleteWithoutStar}\\*`);
        // Glob can't handle Windows paths
        const normalizedpathToDeleteWithoutStar: string
          = Utilities.getAllReplaced(pathToDeleteWithoutStar, '\\', '/');

        // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/*"
        for (const tempModulePath of glob.sync(globEscape(normalizedpathToDeleteWithoutStar) + '/*')) {
          // We could potentially use AsyncRecycler here, but in practice these folders tend
          // to be very small
          Utilities.dangerouslyDeletePath(tempModulePath);
        }
      }
    }

    // If any folders were moved into the AsyncRecycler, get that going before we start
    // the expensive "npm install" operation.
    this._asyncRecycler.deleteAll();

    // Run "npm install" in the common folder

    // NOTE: we do NOT install optional dependencies for Rush, as it seems that optional dependencies do not
    //       work properly with shrinkwrap. Consider the "fsevents" package. This is a Mac specific package
    //       which is an optional second-order dependency. Optional dependencies work by attempting to install
    //       the package, but removes the package if the install failed.
    //       This means that someone running generate on a Mac WILL have fsevents included in their shrinkwrap.
    //       When someone using Windows attempts to install from the shrinkwrap, the install will fail.
    //
    //       If someone generates the shrinkwrap using Windows, then fsevents will NOT be listed in the shrinkwrap.
    //       When someone using Mac attempts to install from the shrinkwrap, (as of NPM 4), they will NOT have the
    //       optional dependency installed.
    //
    //       One possible solution would be to have the shrinkwrap include information about whether the dependency
    //       is optional or not, but it does not appear to do so. Also, this would result in strange behavior where
    //       people would have different node_modules based on their system.

    const npmInstallArgs: string[] = ['install', '--no-optional'];
    this.pushConfigurationNpmArgs(npmInstallArgs);

    console.log(os.EOL + colors.bold(`Running "npm install" in ${this._rushConfiguration.commonTempFolder}`)
      + os.EOL);
    Utilities.executeCommandWithRetry(npmToolFilename,
      npmInstallArgs,
      MAX_INSTALL_ATTEMPTS,
      this._rushConfiguration.commonTempFolder);

    this._fixupNpm5Regression();

    // Finally, create the marker file to indicate a successful install
    fsx.createFileSync(this.commonNodeModulesMarkerFilename);
    console.log('');
  }

  /**
   * Used when invoking the NPM tool.  Appends the common configuration options
   * to the command-line.
   */
  public pushConfigurationNpmArgs(npmArgs: string[]): void {
    npmArgs.push('--cache', this._rushConfiguration.npmCacheFolder);
    npmArgs.push('--tmp', this._rushConfiguration.npmTmpFolder);
  }

  /**
   * Copies the file "sourcePath" to "targetPath", overwriting the target file location.
   * If the source file does not exist, then the target file is deleted.
   */
  public syncFile(sourcePath: string, targetPath: string): void {
    if (fsx.existsSync(sourcePath)) {
      console.log('Updating ' + targetPath);
      fsx.copySync(sourcePath, targetPath);
    } else {
      if (fsx.existsSync(targetPath)) {
        console.log('Deleting ' + targetPath);
        fsx.unlinkSync(targetPath);
      }
    }
  }

  /**
   * Gets the path to the tarball
   * Example: "C:\MyRepo\common\temp\projects\my-project-2.tgz"
   */
  private _getTarballFilePath(project: RushConfigurationProject): string {
    return path.join(
      this._rushConfiguration.commonTempFolder,
      RushConstants.rushTempProjectsFolderName,
      `${project.unscopedTempProjectName}.tgz`);
  }

  /**
   * This is a workaround for a bug introduced in NPM 5 (and still unfixed as of NPM 5.5.1):
   * https://github.com/npm/npm/issues/19006
   *
   * The regression is that "npm install" sets the package.json "version" field for the
   * @rush-temp projects to a value like "file:projects/example.tgz", when it should be "0.0.0".
   * This causes "rush link" to fail later, when read-package-tree tries to parse the bad version.
   * The error looks like this:
   *
   * ERROR: Failed to parse package.json for foo: Invalid version: "file:projects/example.tgz"
   *
   * Our workaround is to rewrite the package.json files for each of the @rush-temp projects
   * in the node_modules folder, after "npm install" completes.
   */
  private _fixupNpm5Regression(): void {
    const pathToDeleteWithoutStar: string = path.join(this._rushConfiguration.commonTempFolder,
      'node_modules', RushConstants.rushTempNpmScope);
    // Glob can't handle Windows paths
    const normalizedpathToDeleteWithoutStar: string
      = Utilities.getAllReplaced(pathToDeleteWithoutStar, '\\', '/');

    let anyChanges: boolean = false;

    // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/*/package.json"
    for (const packageJsonPath of glob.sync(globEscape(normalizedpathToDeleteWithoutStar) + '/*/package.json')) {
      // Example: "C:/MyRepo/common/temp/node_modules/@rush-temp/example/package.json"
      const packageJsonObject: IRushTempPackageJson = JsonFile.load(packageJsonPath);

      // The temp projects always use "0.0.0" as their version
      packageJsonObject.version = '0.0.0';

      if (JsonFile.save(packageJsonObject, packageJsonPath, { onlyIfChanged: true })) {
        anyChanges = true;
      }
    }

    if (anyChanges) {
      console.log(os.EOL + colors.yellow(wrap(`Applied workaround for NPM 5 bug`)) + os.EOL);
    }
  }

  /**
   * Checks for temp projects that exist in the shrinkwrap file, but don't exist
   * in rush.json.  This might occur, e.g. if a project was recently deleted or renamed.
   *
   * @returns true if orphans were found, or false if everything is okay
   */
  private _findOrphanedTempProjects(shrinkwrapFile: ShrinkwrapFile): boolean {

    // We can recognize temp projects because they are under the "@rush-temp" NPM scope.
    for (const tempProjectName of shrinkwrapFile.getTempProjectNames()) {
      if (!this._rushConfiguration.findProjectByTempName(tempProjectName)) {
        console.log(os.EOL + colors.yellow(wrap(
          `Your NPM shrinkwrap file references a project "${tempProjectName}" which no longer exists.`))
          + os.EOL);
        return true;  // found one
      }
    }

    return false;  // none found
  }
}
