// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { cloneDeep } from 'lodash';
import * as semver from 'semver';

import {
  IVersionPolicyJson,
  ILockStepVersionJson,
  IIndividualVersionJson
} from './VersionPolicyConfiguration';

import IPackageJson from '../utilities/IPackageJson';

/**
 * Type of version bumps
 * @alpha
 */
export enum BumpType {
  // No version bump
  'none',
  // Prerelease version bump
  'prerelease',
  // Patch version bump
  'patch',
  // Preminor version bump
  'preminor',
  // Minor version bump
  'minor',
  // Major version bump
  'major'
}

/**
 * Version policy base type names
 * @alpha
 */
export enum VersionPolicyDefinitionName {
  'lockStepVersion',
  'individualVersion'
}

/**
 * This is the base class for version policy which controls how versions get bumped.
 * @alpha
 */
export abstract class VersionPolicy {
  private _policyName: string;
  private _definitionName: VersionPolicyDefinitionName;

  /**
   * Loads from version policy json
   *
   * @param versionPolicyJson - version policy Json
   */
  public static load(versionPolicyJson: IVersionPolicyJson): VersionPolicy | undefined {
    const definition: VersionPolicyDefinitionName = VersionPolicyDefinitionName[versionPolicyJson.definitionName];
    if (definition === VersionPolicyDefinitionName.lockStepVersion) {
       // tslint:disable-next-line:no-use-before-declare
      return new LockStepVersionPolicy(versionPolicyJson as ILockStepVersionJson);
    } else if (definition === VersionPolicyDefinitionName.individualVersion) {
      // tslint:disable-next-line:no-use-before-declare
      return new IndividualVersionPolicy(versionPolicyJson as IIndividualVersionJson);
    }

    return undefined;
  }

  constructor(versionPolicyJson: IVersionPolicyJson) {
    this._policyName = versionPolicyJson.policyName;
    this._definitionName = VersionPolicyDefinitionName[versionPolicyJson.definitionName];
  }

  /**
   * Version policy name
   */
  public get policyName(): string {
    return this._policyName;
  }

  /**
   * Version policy definition name
   */
  public get definitionName(): VersionPolicyDefinitionName {
    return this._definitionName;
  }

  /**
   * Returns an updated package json that satisfies the policy.
   *
   * @param project - package json
   */
  public abstract ensure(project: IPackageJson): IPackageJson | undefined;

  /**
   * Bumps version based on the policy
   *
   * @param bumpType - (optional) override bump type
   * @param identifier - (optional) override prerelease Id
   */
  public abstract bump(bumpType?: BumpType, identifier?: string): void;

  /**
   * Serialized json for the policy
   */
  public abstract get json(): IVersionPolicyJson;

  /**
   * Validates the specified version and throws if the version does not satisfy the policy.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public abstract validate(versionString: string, packageName: string): void;
}

/**
 * This policy indicates all related projects should use the same version.
 * @alpha
 */
export class LockStepVersionPolicy extends VersionPolicy {
  private _version: semver.SemVer;
  // nextBump is probably not needed. It can be prerelease only.
  // Other types of bumps can be passed in as a parameter to bump method, so can identifier.
  private _nextBump: BumpType;

  constructor(versionPolicyJson: ILockStepVersionJson) {
    super(versionPolicyJson);
    this._version = new semver.SemVer(versionPolicyJson.version);
    this._nextBump = BumpType[versionPolicyJson.nextBump];
  }

  /**
   * The value of the lockstep version
   */
  public get version(): semver.SemVer {
    return this._version;
  }

  /**
   * The type of bump for next bump.
   */
  public get nextBump(): BumpType {
    return this._nextBump;
  }

  /**
   * Serialized json for this policy
   */
  public get json(): ILockStepVersionJson {
    return {
      policyName: this.policyName,
      definitionName: VersionPolicyDefinitionName[this.definitionName],
      version: this.version.format(),
      nextBump: BumpType[this.nextBump]
    };
  }

  /**
   * Returns an updated package json that satisfies the version policy.
   *
   * @param project - input package json
   */
  public ensure(project: IPackageJson): IPackageJson | undefined {
    const packageVersion: semver.SemVer = new semver.SemVer(project.version);
    const compareResult: number = packageVersion.compare(this._version);
    if (compareResult === 0) {
      return undefined;
    } else if (compareResult > 0) {
      const errorMessage: string = `Version ${project.version} in package ${project.name}`
        + ` is higher than locked version ${this._version.format()}.`;
      throw new Error(errorMessage);
    }
    return this._updatePackageVersion(project, this._version);
  }

  /**
   * Bumps the version of the lockstep policy
   *
   * @param bumpType - Overwrite bump type in version-policy.json with the provided value.
   * @param identifier - Prerelease identifier if bump type is prerelease.
   */
  public bump(bumpType?: BumpType, identifier?: string): void {
    this.version.inc(this._getReleaseType(bumpType || this.nextBump), identifier);
  }

  /**
   * Validates the specified version and throws if the version does not satisfy lockstep version.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public validate(versionString: string, packageName: string): void {
    const versionToTest: semver.SemVer = new semver.SemVer(versionString, false);
    if (this.version.compare(versionToTest) !== 0) {
      throw new Error(`Invalid version ${versionString} in ${packageName}`);
    }
  }

  private _updatePackageVersion(project: IPackageJson, newVersion: semver.SemVer): IPackageJson {
    const updatedProject: IPackageJson = cloneDeep(project);
    updatedProject.version = newVersion.format();
    return updatedProject;
  }

  private _getReleaseType(bumpType: BumpType): semver.ReleaseType {
    // Eventually we should just use ReleaseType and get rid of bump type.
    return BumpType[bumpType] as semver.ReleaseType;
  }
}

/**
 * This policy indicates all related projects get version bump driven by their own changes.
 * @alpha
 */
export class IndividualVersionPolicy extends VersionPolicy {
  private _lockedMajor: number | undefined;

  constructor(versionPolicyJson: IIndividualVersionJson) {
    super(versionPolicyJson);
    this._lockedMajor = versionPolicyJson.lockedMajor;
  }

  /**
   * The major version that has been locked
   */
  public get lockedMajor(): number | undefined {
    return this._lockedMajor;
  }

  /**
   * Serialized json for this policy
   */
  public get json(): IIndividualVersionJson {
    return {
      policyName: this.policyName,
      definitionName: VersionPolicyDefinitionName[this.definitionName],
      lockedMajor: this.lockedMajor
    };
  }

  /**
   * Returns an updated package json that satisfies the version policy.
   *
   * @param project - input package json
   */
  public ensure(project: IPackageJson): IPackageJson | undefined {
    if (this.lockedMajor) {
      const version: semver.SemVer = new semver.SemVer(project.version);
      if (version.major < this.lockedMajor) {
        const updatedProject: IPackageJson = cloneDeep(project);
        updatedProject.version = `${this._lockedMajor}.0.0`;
        return updatedProject;
      } else if (version.major > this.lockedMajor) {
        const errorMessage: string = `Version ${project.version} in package ${project.name}`
          + ` is higher than locked major version ${this._lockedMajor}.`;
        throw new Error(errorMessage);
      }
    }
    return undefined;
  }

  /**
   * Bumps version.
   * Individual version policy lets change files drive version bump. This method currently does not do anything.
   *
   * @param bumpType - bump type
   * @param identifier - prerelease id
   */
  public bump(bumpType?: BumpType, identifier?: string): void {
    // individual version policy lets change files drive version bump.
  }

  /**
   * Validates the specified version and throws if the version does not satisfy the policy.
   *
   * @param versionString - version string
   * @param packageName - package name
   */
  public validate(versionString: string, packageName: string): void {
    const versionToTest: semver.SemVer = new semver.SemVer(versionString, false);
    if (this._lockedMajor !== undefined) {
      if (this._lockedMajor !== versionToTest.major) {
        throw new Error(`Invalid major version ${versionString} in ${packageName}`);
      }
    }
  }
}
