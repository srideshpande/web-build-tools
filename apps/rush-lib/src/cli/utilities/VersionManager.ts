// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as semver from 'semver';
import * as fsx from 'fs-extra';
import { cloneDeep } from 'lodash';

import {
  VersionPolicy,
  BumpType,
  LockStepVersionPolicy
} from '../../data/VersionPolicy';
import { ChangeFile } from '../../data/ChangeFile';
import { ChangeType, IChangeInfo } from '../../data/ChangeManagement';
import RushConfiguration from '../../data/RushConfiguration';
import RushConfigurationProject from '../../data/RushConfigurationProject';
import { VersionPolicyConfiguration } from '../../data/VersionPolicyConfiguration';
import IPackageJson from '../../utilities/IPackageJson';
import PublishUtilities from './PublishUtilities';
import ChangeManager from './ChangeManager';

export class VersionManager {
  private _versionPolicyConfiguration: VersionPolicyConfiguration;
  private _updatedProjects: Map<string, IPackageJson>;
  private _changeFiles: Map<string, ChangeFile>;

  constructor(private _rushConfiguration: RushConfiguration,
    private _userEmail: string,
    _versionPolicyConfiguration?: VersionPolicyConfiguration
  ) {
    this._versionPolicyConfiguration = _versionPolicyConfiguration ?
      _versionPolicyConfiguration : this._rushConfiguration.versionPolicyConfiguration;

    this._updatedProjects = new Map<string, IPackageJson>();
    this._changeFiles = new Map<string, ChangeFile>();
  }

  /**
   * Ensures project versions follow the provided version policy. If version policy is not
   * provided, all projects will have their version checked according to the associated version policy.
   * package.json files will be updated if needed.
   * This method does not commit changes.
   * @param versionPolicyName -- version policy name
   * @param shouldCommit -- should update files to disk
   */
  public ensure(versionPolicyName?: string, shouldCommit?: boolean): void {
    this._ensure(versionPolicyName, shouldCommit);
  }

  /**
   * Bumps sversions following version policies.
   *
   * @param lockStepVersionPolicyName - a specified lock step version policy name. Without this value,
   * versions for all lock step policies and all individual policies will be bumped.
   * With this value, only the specified lock step policy will be bumped along with all individual policies.
   * @param bumpType - overrides the default bump type and only works for lock step policy
   * @param identifier - overrides the prerelease identifier and only works for lock step policy
   * @param shouldCommit - whether the changes will be written to disk
   */
  public bump(lockStepVersionPolicyName?: string,
    bumpType?: BumpType,
    identifier?: string,
    shouldCommit?: boolean
  ): void {
    // Bump all the lock step version policies.
    this._versionPolicyConfiguration.bump(lockStepVersionPolicyName, bumpType, identifier, shouldCommit);

    // Update packages and generate change files due to lock step bump.
    this._ensure(lockStepVersionPolicyName, shouldCommit);

    // Refresh rush configuration
    this._rushConfiguration = RushConfiguration.loadFromConfigurationFile(this._rushConfiguration.rushJsonFile);

    // Update projects based on individual policies
    const changeManager: ChangeManager = new ChangeManager(this._rushConfiguration,
      this._getLockStepProjects());
    changeManager.load(this._rushConfiguration.changesFolder);
    if (changeManager.hasChanges()) {
      changeManager.validateChanges(this._versionPolicyConfiguration);
      changeManager.apply(!!shouldCommit)!.forEach(packageJson => {
        this._updatedProjects.set(packageJson.name, packageJson);
      });
      changeManager.updateChangelog(!!shouldCommit, this._updatedProjects);
    }
  }

  public get updatedProjects(): Map<string, IPackageJson> {
    return this._updatedProjects;
  }

  public get changeFiles(): Map<string, ChangeFile> {
    return this._changeFiles;
  }

  private _ensure(versionPolicyName?: string, shouldCommit?: boolean): void {
    this._updateVersionsByPolicy(versionPolicyName);

    // Update all dependencies if needed.
    this._updateDependencies();

    if (shouldCommit) {
      this._updatePackageJsonFiles();
      this._changeFiles.forEach((changeFile) => {
        changeFile.writeSync();
      });
    }
  }

  private _getLockStepProjects(): Set<string> | undefined {
    const lockStepVersionPolicyNames: Set<string> = new Set<string>();

    this._versionPolicyConfiguration.versionPolicies.forEach((versionPolicy) => {
      if (versionPolicy instanceof LockStepVersionPolicy) {
        lockStepVersionPolicyNames.add(versionPolicy.policyName);
      }
    });
    const lockStepProjectNames: Set<string> = new Set<string>();
    this._rushConfiguration.projects.forEach((rushProject) => {
      if (lockStepVersionPolicyNames.has(rushProject.versionPolicyName!)) {
        lockStepProjectNames.add(rushProject.packageName);
      }
    });
    return lockStepProjectNames;
  }

  private _updateVersionsByPolicy(versionPolicyName?: string): void {
    // Update versions based on version policy
    this._rushConfiguration.projects.forEach(rushProject => {
      const projectVersionPolicyName: string | undefined = rushProject.versionPolicyName;
      if (projectVersionPolicyName &&
          (!versionPolicyName || projectVersionPolicyName === versionPolicyName)) {
        const versionPolicy: VersionPolicy = this._versionPolicyConfiguration.getVersionPolicy(
          projectVersionPolicyName);
        const updatedProject: IPackageJson | undefined = versionPolicy.ensure(rushProject.packageJson);
        if (updatedProject) {
          this._updatedProjects.set(updatedProject.name, updatedProject);

          // No need to create an entry for prerelease version bump.
          if (!this._isPrerelease(updatedProject.version)) {
            this._addChangeInfo(updatedProject.name,
              [this._createChangeInfo(updatedProject, rushProject)]);
          }
        }
      }
    });
  }

  private _isPrerelease(version: string): boolean {
    return !!semver.prerelease(version);
  }

  private _addChangeInfo(packageName: string,
    changeInfos: IChangeInfo[]
  ): void {
    if (!changeInfos.length) {
      return;
    }
    let changeFile: ChangeFile | undefined = this._changeFiles.get(packageName);
    if (!changeFile) {
      changeFile = new ChangeFile({
        changes: [],
        packageName: packageName,
        email: this._userEmail
      }, this._rushConfiguration);
      this._changeFiles.set(packageName, changeFile);
    }
    changeInfos.forEach((changeInfo) => {
      changeFile!.addChange(changeInfo);
    });
  }

  private _updateDependencies(): void {
    this._rushConfiguration.projects.forEach(rushProject => {
      let clonedProject: IPackageJson | undefined = this._updatedProjects.get(rushProject.packageName);
      let projectVersionChanged: boolean = true;
      if (!clonedProject) {
        clonedProject = cloneDeep(rushProject.packageJson);
        projectVersionChanged = false;
      }
      this._updateProjectAllDependencies(rushProject, clonedProject, projectVersionChanged);
    });
  }

  private _updateProjectAllDependencies(
    rushProject: RushConfigurationProject,
    clonedProject: IPackageJson,
    projectVersionChanged: boolean
  ): void {
    if (!clonedProject.dependencies && !clonedProject.devDependencies) {
      return;
    }
    const changes: IChangeInfo[] = [];
    let updated: boolean = false;
    if (this._updateProjectDependencies(clonedProject.dependencies, changes,
      clonedProject, rushProject, projectVersionChanged)
    ) {
      updated = true;
    }
    if (this._updateProjectDependencies(clonedProject.devDependencies, changes,
      clonedProject, rushProject, projectVersionChanged)
    ) {
      updated = true;
    }

    if (updated) {
      this._updatedProjects.set(clonedProject.name, clonedProject);

      this._addChangeInfo(clonedProject.name, changes);
    }
  }

  private _updateProjectDependencies(dependencies: { [key: string]: string; } | undefined,
    changes: IChangeInfo[],
    clonedProject: IPackageJson,
    rushProject: RushConfigurationProject,
    projectVersionChanged: boolean
  ): boolean {
    if (!dependencies) {
      return false;
    }
    let updated: boolean = false;
    this._updatedProjects.forEach((updatedDependentProject, updatedDependentProjectName) => {
      if (dependencies[updatedDependentProjectName]) {
        if (rushProject.cyclicDependencyProjects.has(updatedDependentProjectName)) {
          // Skip if cyclic
          console.log(`Found cyclic ${rushProject.packageName} ${updatedDependentProjectName}`);
          return;
        }

        const oldDependencyVersion: string = dependencies[updatedDependentProjectName];
        const newDependencyVersion: string = PublishUtilities.getNewDependencyVersion(
            dependencies,
            updatedDependentProjectName,
            updatedDependentProject.version
          );

        if (newDependencyVersion !== oldDependencyVersion) {
          updated = true;
          if (rushProject.shouldPublish) {
            this._trackDependencyChange(changes, clonedProject, projectVersionChanged,
              updatedDependentProject,
              updatedDependentProjectName,
              oldDependencyVersion,
              newDependencyVersion
            );
          }
          dependencies[updatedDependentProjectName] = newDependencyVersion;
        }
      }
    });
    return updated;
  }

  private _trackDependencyChange(
    changes: IChangeInfo[],
    clonedProject: IPackageJson,
    projectVersionChanged: boolean,
    updatedDependentProject: IPackageJson,
    updatedDependentProjectName: string,
    oldDependencyVersion: string,
    newDependencyVersion: string
  ): void {
    if (!semver.satisfies(updatedDependentProject.version, oldDependencyVersion) && !projectVersionChanged) {
      this._addChange(changes,
        {
          changeType: ChangeType.patch,
          packageName: clonedProject.name
        }
      );
    }

    // If current version is not a prerelease version and new dependency is also not a prerelease version,
    // add change entry. Otherwise, too many changes will be created for frequent releases.
    if (!this._isPrerelease(updatedDependentProject.version) && !this._isPrerelease(clonedProject.version)) {
      this._addChange(changes,
        {
          changeType: ChangeType.dependency,
          comment: `Dependency ${updatedDependentProjectName} version bump from ${oldDependencyVersion}` +
            ` to ${newDependencyVersion}.`,
          packageName: clonedProject.name
        }
      );
    }
  }

  private _addChange(changes: IChangeInfo[], newChange: IChangeInfo): void {
    const exists: boolean = changes.some((changeInfo) => {
      return (changeInfo.author === newChange.author &&
        changeInfo.changeType === newChange.changeType &&
        changeInfo.comment === newChange.comment &&
        changeInfo.commit === newChange.commit &&
        changeInfo.packageName === newChange.packageName &&
        changeInfo.type === newChange.type
      );
    });
    if (!exists) {
      changes.push(newChange);
    }
  }

  private _updatePackageJsonFiles(): void {
    this._updatedProjects.forEach((newPackageJson, packageName) => {
      const rushProject: RushConfigurationProject | undefined = this._rushConfiguration.getProjectByName(packageName);
      // Update package.json
      if (rushProject) {
        const packagePath: string = path.join(rushProject.projectFolder, 'package.json');
        fsx.writeFileSync(packagePath, JSON.stringify(newPackageJson, undefined, 2), { encoding: 'utf8' });
      }
    });
  }

  private _createChangeInfo(newPackageJson: IPackageJson,
    rushProject: RushConfigurationProject
  ): IChangeInfo {
    return {
      changeType: ChangeType.none,
      newVersion: newPackageJson.version,
      packageName: newPackageJson.name,
      comment: `Package version bump from ${rushProject.packageJson.version} to ${newPackageJson.version}` +
        ` by version policy`
    };
  }

}