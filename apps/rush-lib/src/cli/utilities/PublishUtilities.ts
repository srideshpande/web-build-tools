// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

/**
 * This file contains a set of helper functions that are unit tested and used with the PublishAction,
 * which itself it a thin wrapper around these helpers.
 */

import { EOL } from 'os';
import * as fsx from 'fs-extra';
import * as path from 'path';
import * as semver from 'semver';

import IPackageJson from '../../utilities/IPackageJson';
import {
  IChangeInfo,
  ChangeType
} from '../../data/ChangeManagement';
import RushConfigurationProject from '../../data/RushConfigurationProject';
import Utilities from '../../utilities/Utilities';
import { execSync } from 'child_process';
import PrereleaseToken from './PrereleaseToken';
import ChangeFiles from './ChangeFiles';

export interface IChangeInfoHash {
  [key: string]: IChangeInfo;
}

export default class PublishUtilities {
  /**
   * Finds change requests in the given folder.
   * @param changesPath Path to the changes folder.
   * @returns Dictionary of all change requests, keyed by package name.
   */
  public static findChangeRequests(
    allPackages: Map<string, RushConfigurationProject>,
    changeFiles: ChangeFiles,
    includeCommitDetails?: boolean,
    prereleaseToken?: PrereleaseToken,
    projectsToExclude?: Set<string>
  ): IChangeInfoHash {

    const allChanges: IChangeInfoHash = {};
    console.log(`Finding changes in: ${changeFiles.getChangesPath()}`);

    const files: string[] = changeFiles.getFiles();

    // Add the minimum changes defined by the change descriptions.
    files.forEach((fullPath: string) => {
      const changeRequest: IChangeInfo = JSON.parse(fsx.readFileSync(fullPath, 'utf8'));

      if (includeCommitDetails) {
        PublishUtilities._updateCommitDetails(fullPath, changeRequest.changes);
      }

      for (const change of changeRequest.changes!) {
        PublishUtilities._addChange(change, allChanges, allPackages, prereleaseToken, projectsToExclude);
      }
    });

    // For each requested package change, ensure downstream dependencies are also updated.
    for (const packageName in allChanges) {
      if (allChanges.hasOwnProperty(packageName)) {
        PublishUtilities._updateDownstreamDependencies(
          allChanges[packageName],
          allChanges,
          allPackages,
          prereleaseToken,
          projectsToExclude
        );
      }
    }

    // Update orders so that downstreams are marked to come after upstreams.
    for (const packageName in allChanges) {
      if (allChanges.hasOwnProperty(packageName)) {
        const change: IChangeInfo = allChanges[packageName];
        const project: RushConfigurationProject = allPackages.get(packageName)!;
        const pkg: IPackageJson = project.packageJson;
        const deps: string[] = project.downstreamDependencyProjects;

        // Write the new version expected for the change.
        const skipVersionBump: boolean = PublishUtilities._shouldSkipVersionBump(project,
          prereleaseToken, projectsToExclude);
        if (skipVersionBump) {
          change.newVersion = pkg.version;
        } else {
          change.newVersion = (change.changeType! >= ChangeType.patch) ?
            semver.inc(pkg.version, PublishUtilities._getReleaseType(change.changeType!)) :
            pkg.version;
        }

        if (deps) {
          for (const depName of deps) {
            const depChange: IChangeInfo = allChanges[depName];

            if (depChange) {
              depChange.order = Math.max(change.order! + 1, depChange.order!);
            }
          }
        }
      }
    }

    return allChanges;
  }

  /**
   * Given the changes hash, flattens them into a sorted array based on their dependency order.
   * @params allChanges - hash of change requests.
   * @returns Sorted array of change requests.
   */
  public static sortChangeRequests(allChanges: IChangeInfoHash): IChangeInfo[] {
    return Object
      .keys(allChanges)
      .map(key => allChanges[key])
      .sort((a, b) => a.order! < b.order! ? -1 : 1);
  }

  /**
   * Given a single change request, updates the package json file with updated versions on disk.
   */
  public static updatePackages(
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    shouldCommit: boolean,
    prereleaseToken?: PrereleaseToken,
    projectsToExclude?: Set<string>
  ): Map<string, IPackageJson> {
    const updatedPackages: Map<string, IPackageJson> = new Map<string, IPackageJson>();

    Object.keys(allChanges).forEach(packageName => {
      const updatedPackage: IPackageJson = PublishUtilities._writePackageChanges(
        allChanges[packageName],
        allChanges,
        allPackages,
        shouldCommit,
        prereleaseToken,
        projectsToExclude);
      updatedPackages.set(updatedPackage.name, updatedPackage);
    });

    return updatedPackages;
  }

  /**
   * Returns the generated tagname to use for a published commit, given package name and version.
   */
  public static createTagname(packageName: string, version: string): string {
    return packageName + '_v' + version;
  }

  public static isRangeDependency(version: string): boolean {
    const LOOSE_PKG_REGEX: RegExp = />=?(?:\d+\.){2}\d+(\-[0-9A-Za-z-.]*)?\s+<(?:\d+\.){2}\d+/;

    return LOOSE_PKG_REGEX.test(version);
  }

  public static getEnvArgs(): { [key: string]: string } {
    const env: { [key: string]: string } = {};

    // Copy existing process.env values (for nodist)
    Object.keys(process.env).forEach((key: string) => {
      env[key] = process.env[key];
    });
    return env;
  }

  public static execCommand(
    shouldExecute: boolean,
    command: string,
    args: string[] = [],
    workingDirectory: string = process.cwd(),
    env?: { [key: string]: string }
  ): void {

    let relativeDirectory: string = path.relative(process.cwd(), workingDirectory);
    const envArgs: { [key: string]: string } = PublishUtilities.getEnvArgs();

    if (relativeDirectory) {
      relativeDirectory = `(${relativeDirectory})`;
    }

    if (env) {
      Object.keys(env).forEach((name: string) => envArgs[name] = env[name]);
    }

    console.log(
      `${EOL}* ${shouldExecute ? 'EXECUTING' : 'DRYRUN'}: ${command} ${args.join(' ')} ${relativeDirectory}`
    );

    if (shouldExecute) {
      Utilities.executeCommand(
        command,
        args,
        workingDirectory,
        false,
        env);
    }
  }

  public static getNewDependencyVersion(dependencies: { [key: string]: string; },
    dependencyName: string,
    newProjectVersion: string
  ): string {
    const currentDependencyVersion: string = dependencies[dependencyName];
    let newDependencyVersion: string;

    if (PublishUtilities.isRangeDependency(currentDependencyVersion)) {
      newDependencyVersion = PublishUtilities._getNewRangeDependency(newProjectVersion);
    } else if (currentDependencyVersion.lastIndexOf('~', 0) === 0) {
      newDependencyVersion = '~' + newProjectVersion;
    } else if (currentDependencyVersion.lastIndexOf('^', 0) === 0) {
      newDependencyVersion = '^' + newProjectVersion;
    } else {
      newDependencyVersion = newProjectVersion;
    }
    return newDependencyVersion;
  }

  private static _getReleaseType(changeType: ChangeType): semver.ReleaseType {
    switch (changeType) {
      case ChangeType.major:
        return 'major';
      case ChangeType.minor:
        return 'minor';
      case ChangeType.patch:
        return 'patch';
      default:
        throw new Error(`Wrong change type ${changeType}`);
    }
  }

  private static _getNewRangeDependency(newVersion: string): string {
    let upperLimit: string = newVersion;
    if (semver.prerelease(newVersion)) {
      // Remove the prerelease first, then bump major.
      upperLimit = semver.inc(newVersion, 'patch');
    }
    upperLimit = semver.inc(upperLimit, 'major');

    return `>=${newVersion} <${upperLimit}`;
  }

  private static _shouldSkipVersionBump(project: RushConfigurationProject,
    prereleaseToken?: PrereleaseToken,
    projectsToExclude?: Set<string>
  ): boolean {
    // Suffix does not bump up the version.
    // Excluded projects do not bump up version.
    return prereleaseToken && prereleaseToken.isSuffix ||
      projectsToExclude && projectsToExclude.has(project.packageName) ||
      !project.shouldPublish;
  }

  private static _updateCommitDetails(filename: string, changes: IChangeInfo[] | undefined): void {
    try {
      const fileLog: string = execSync('git log -n 1 ' + filename, { cwd: path.dirname(filename) }).toString();
      const author: string = fileLog.match(/Author: (.*)/)![1];
      const commit: string = fileLog.match(/commit (.*)/)![1];

      changes!.forEach(change => {
        change.author = author;
        change.commit = commit;
      });
    } catch (e) { /* no-op, best effort. */ }
  }

  private static _writePackageChanges(
    change: IChangeInfo,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    shouldCommit: boolean,
    prereleaseToken?: PrereleaseToken,
    projectsToExclude?: Set<string>
  ): IPackageJson {

    const project: RushConfigurationProject = allPackages.get(change.packageName)!;
    const pkg: IPackageJson = project.packageJson;

    const shouldSkipVersionBump: boolean = !project.shouldPublish ||
      !!projectsToExclude && projectsToExclude.has(change.packageName);

    const newVersion: string = shouldSkipVersionBump ? pkg.version :
      PublishUtilities._getChangeInfoNewVersion(change, prereleaseToken);

    if (!shouldSkipVersionBump) {
      console.log(
        `${EOL}* ${shouldCommit ? 'APPLYING' : 'DRYRUN'}: ${ChangeType[change.changeType!]} update ` +
        `for ${change.packageName} to ${newVersion}`
      );
    } else {
      console.log(
        `${EOL}* ${shouldCommit ? 'APPLYING' : 'DRYRUN'}: update ` + `for ${change.packageName} at ${newVersion}`
      );
    }

    const packagePath: string = path.join(project.projectFolder, 'package.json');

    pkg.version = newVersion;

    // Update the package's dependencies.
    PublishUtilities._updateDependencies(pkg.name, pkg.dependencies, allChanges, allPackages,
      prereleaseToken, projectsToExclude);
    // Update the package's dev dependencies.
    PublishUtilities._updateDependencies(pkg.name, pkg.devDependencies, allChanges, allPackages,
      prereleaseToken, projectsToExclude);

    change.changes!.forEach(subChange => {
      if (subChange.comment) {
        console.log(` - [${ChangeType[subChange.changeType!]}] ${subChange.comment}`);
      }
    });

    if (shouldCommit) {
      fsx.writeFileSync(packagePath, JSON.stringify(pkg, undefined, 2), { encoding: 'utf8' });
    }
    return pkg;
  }

  private static _isCyclicDependency(
    allPackages: Map<string, RushConfigurationProject>,
    packageName: string,
    dependencyName: string
  ): boolean {
    const packageConfig: RushConfigurationProject | undefined = allPackages.get(packageName);
    return !!packageConfig && packageConfig.cyclicDependencyProjects.has(dependencyName);
  }

  private static _updateDependencies(
    packageName: string,
    dependencies: { [key: string]: string; } | undefined,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    prereleaseToken: PrereleaseToken | undefined,
    projectsToExclude?: Set<string>
  ): void {

    if (dependencies) {
      Object.keys(dependencies).forEach(depName => {
        if (!PublishUtilities._isCyclicDependency(allPackages, packageName, depName)) {
          const depChange: IChangeInfo = allChanges[depName];
          if (!depChange) {
            return;
          }
          const depProject: RushConfigurationProject = allPackages.get(depName)!;

          if (!depProject.shouldPublish || projectsToExclude && projectsToExclude.has(depName)) {
            // No version change.
            return;
          } else if (depChange && prereleaseToken && prereleaseToken.hasValue) {
            // TODO: treat prerelease version the same as non-prerelease version.
            // For prelease, the newVersion needs to be appended with prerelease name.
            // And dependency should specify the specific prerelease version.
            dependencies[depName] = PublishUtilities._getChangeInfoNewVersion(depChange, prereleaseToken);
          } else if (depChange && depChange.changeType! >= ChangeType.patch) {
            PublishUtilities._updateDependencyVersion(
              packageName,
              dependencies,
              depName,
              depChange,
              allChanges,
              allPackages);
          }
        }
      });
    }
  }

  /**
   * Gets the new version from the ChangeInfo.
   * The value of newVersion in ChangeInfo remains unchanged when the change type is dependency,
   * However, for pre-release build, it won't pick up the updated pre-released dependencies. That is why
   * this function should return a pre-released patch for that case.
   */
  private static _getChangeInfoNewVersion(
    change: IChangeInfo,
    prereleaseToken: PrereleaseToken | undefined
  ): string {
    let newVersion: string = change.newVersion!;
    if (prereleaseToken && prereleaseToken.hasValue) {
      if (prereleaseToken.isPrerelease && change.changeType === ChangeType.dependency) {
        newVersion = semver.inc(newVersion, 'patch');
      }
      return `${newVersion}-${prereleaseToken.name}`;
    } else {
      return newVersion;
    }
  }

  /**
   * Adds the given change to the allChanges map.
   *
   * @returns true if the change caused the dependency change type to increase.
   */
  private static _addChange(
    change: IChangeInfo,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    prereleaseToken?: PrereleaseToken,
    projectsToExclude?: Set<string>
  ): boolean {
    let hasChanged: boolean = false;
    const packageName: string = change.packageName;
    const project: RushConfigurationProject | undefined = allPackages.get(packageName);

    if (!project) {
      console.log(`The package ${packageName} was requested for publishing but ` +
        `does not exist. Skip this change.`);
      return false;
    }

    const pkg: IPackageJson = project.packageJson;
    let currentChange: IChangeInfo;

    // If the given change does not have a changeType, derive it from the "type" string.
    if (change.changeType === undefined) {
      change.changeType = ChangeType[change.type!];
    }

    if (!allChanges[packageName]) {
      hasChanged = true;
      currentChange = allChanges[packageName] = {
        packageName,
        changeType: change.changeType,
        order: 0,
        changes: [change]
      };
    } else {
      currentChange = allChanges[packageName];

      const oldChangeType: ChangeType = currentChange.changeType!;

      currentChange.changeType = Math.max(currentChange.changeType!, change.changeType!);
      currentChange.changes!.push(change);

      hasChanged = hasChanged || (oldChangeType !== currentChange.changeType);
    }
    const skipVersionBump: boolean = PublishUtilities._shouldSkipVersionBump(project,
      prereleaseToken, projectsToExclude);

    if (skipVersionBump) {
      currentChange.newVersion = pkg.version;
      hasChanged = false;
      currentChange.changeType = ChangeType.none;
    } else {
      currentChange.newVersion = change.changeType! >= ChangeType.patch ?
        semver.inc(pkg.version, PublishUtilities._getReleaseType(currentChange.changeType!)) :
        pkg.version;
      currentChange.newRangeDependency = PublishUtilities._getNewRangeDependency(currentChange.newVersion);
    }
    return hasChanged;
  }

  private static _updateDownstreamDependencies(
    change: IChangeInfo,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    prereleaseToken: PrereleaseToken | undefined,
    projectsToExclude?: Set<string>
  ): void {

    const packageName: string = change.packageName;
    const downstreamNames: string[] = allPackages.get(packageName)!.downstreamDependencyProjects;

    // Iterate through all downstream dependencies for the package.
    if (downstreamNames) {
      if ((change.changeType! >= ChangeType.patch) ||
        (prereleaseToken && prereleaseToken.hasValue)) {
        for (const depName of downstreamNames) {
          const pkg: IPackageJson = allPackages.get(depName)!.packageJson;

          PublishUtilities._updateDownstreamDependency(pkg.name, pkg.dependencies, change, allChanges, allPackages,
            prereleaseToken, projectsToExclude);
          PublishUtilities._updateDownstreamDependency(pkg.name, pkg.devDependencies, change, allChanges, allPackages,
            prereleaseToken, projectsToExclude);
        }
      }
    }
  }

  private static _updateDownstreamDependency(
    parentPackageName: string,
    dependencies: { [packageName: string]: string } | undefined,
    change: IChangeInfo,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>,
    prereleaseToken: PrereleaseToken | undefined,
    projectsToExclude?: Set<string>
  ): void {

    if (dependencies && dependencies[change.packageName]) {
      const requiredVersion: string = dependencies[change.packageName];
      const alwaysUpdate: boolean = !!prereleaseToken && prereleaseToken.hasValue &&
        !allChanges.hasOwnProperty(parentPackageName);

      // If the version range exists and has not yet been updated to this version, update it.
      if (requiredVersion !== change.newRangeDependency || alwaysUpdate) {

        // Either it already satisfies the new version, or doesn't.
        // If not, the downstream dep needs to be republished.
        const changeType: ChangeType = semver.satisfies(change.newVersion!, requiredVersion) ?
          ChangeType.dependency :
          ChangeType.patch;

        const hasChanged: boolean = PublishUtilities._addChange({
          packageName: parentPackageName,
          changeType
        }, allChanges, allPackages, prereleaseToken, projectsToExclude);

        if (hasChanged || alwaysUpdate) {
          // Only re-evaluate downstream dependencies if updating the parent package's dependency
          // caused a version bump.
          PublishUtilities._updateDownstreamDependencies(
            allChanges[parentPackageName],
            allChanges,
            allPackages,
            prereleaseToken,
            projectsToExclude
          );
        }
      }
    }
  }

  private static _updateDependencyVersion(
    packageName: string,
    dependencies: { [key: string]: string; },
    dependencyName: string,
    dependencyChange: IChangeInfo,
    allChanges: IChangeInfoHash,
    allPackages: Map<string, RushConfigurationProject>
  ): void {
    const currentDependencyVersion: string = dependencies[dependencyName];

    dependencies[dependencyName] = PublishUtilities.getNewDependencyVersion(
      dependencies,
      dependencyName,
      dependencyChange.newVersion!
    );

    // Add dependency version update comment.
    PublishUtilities._addChange(
      {
        packageName: packageName,
        changeType: ChangeType.dependency,
        comment:
        `Updating dependency "${dependencyName}" from \`${currentDependencyVersion}\`` +
        ` to \`${dependencies[dependencyName]}\``
      },
      allChanges,
      allPackages
    );
  }
}