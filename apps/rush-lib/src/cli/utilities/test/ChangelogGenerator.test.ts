// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { expect } from 'chai';

import { IChangelog } from '../../../data/Changelog';
import { ChangeType } from '../../../data/ChangeManagement';
import RushConfiguration from '../../../data/RushConfiguration';
import RushConfigurationProject from '../../../data/RushConfigurationProject';
import ChangelogGenerator from '../ChangelogGenerator';
import { IChangeInfoHash } from '../PublishUtilities';

import * as path from 'path';

describe('updateIndividualChangelog', () => {

  it('can translate a single change request into a new changelog object', () => {
    const actualResult: IChangelog = ChangelogGenerator.updateIndividualChangelog(
      {
        packageName: 'a',
        newVersion: '1.0.0',
        changeType: ChangeType.major,
        changes: [{
          packageName: 'a',
          type: 'major',
          changeType: ChangeType.major,
          comment: 'Patching a'
        }]
      },
      'rootMajorChange',
      false)!;

    const expectedResult: IChangelog = {
      name: 'a',
      entries: [
        {
          version: '1.0.0',
          tag: 'a_v1.0.0',
          date: '',
          comments: {
            major: [
              {
                author: undefined,
                comment: 'Patching a',
                commit: undefined
              }
            ]
          }
        }
      ]
    };

    // Ignore comparing date.
    expectedResult.entries[0].date = actualResult.entries[0].date;

    expect(actualResult).eql(expectedResult);
  });

  it('can merge a new change request into an existing changelog', () => {
    const actualResult: IChangelog = ChangelogGenerator.updateIndividualChangelog(
      {
        packageName: 'a',
        newVersion: '1.0.0',
        changeType: ChangeType.major,
        changes: [{
          packageName: 'a',
          type: 'major',
          changeType: ChangeType.major,
          comment: 'Patching a'
        }]
      },
      path.resolve(__dirname, 'exampleChangelog'),
      false
    )!;

    const expectedResult: IChangelog = {
      name: 'a',
      entries: [
        {
          version: '1.0.0',
          tag: 'a_v1.0.0',
          date: '',
          comments: {
            major: [
              {
                author: undefined,
                comment: 'Patching a',
                commit: undefined
              }
            ]
          }
        },
        {
          version: '0.0.1',
          tag: 'a_v0.0.1',
          date: 'Wed, 30 Nov 2016 18:37:45 GMT',
          comments: {
            patch: [
              {
                comment: 'Patching a'
              }
            ]
          }
        }
      ]
    };

    // Ignore comparing date.
    expectedResult.entries[0].date = actualResult.entries[0].date;

    expect(actualResult).eql(expectedResult);
  });

  it('can avoid adding duplicate entries', () => {
    const actualResult: IChangelog = ChangelogGenerator.updateIndividualChangelog(
      {
        packageName: 'a',
        newVersion: '0.0.1',
        changeType: ChangeType.patch,
        changes: [{
          packageName: 'a',
          type: 'patch',
          changeType: ChangeType.patch,
          comment: 'Patching a'
        }]
      },
      path.resolve(__dirname, 'exampleChangelog'),
      false
    )!;

    /* tslint:disable-next-line:no-unused-expression */
    expect(actualResult).to.be.undefined;
  });

  it('can handle dependency bumps', () => {
    const actualResult: IChangelog = ChangelogGenerator.updateIndividualChangelog(
      {
        packageName: 'a',
        newVersion: '0.0.2',
        changeType: ChangeType.dependency,
        changes: [{
          packageName: 'a',
          type: 'dependency',
          changeType: ChangeType.dependency,
          comment: 'Updating a'
        }]
      },
      path.resolve(__dirname, 'exampleChangelog'),
      false
    )!;

    const expectedResult: IChangelog = {
      name: 'a',
      entries: [
        {
          version: '0.0.2',
          tag: 'a_v0.0.2',
          date: undefined,
          comments: {
            dependency: [
              {
                author: undefined,
                comment: 'Updating a',
                commit: undefined
              }
            ]
          }
        },
        {
          version: '0.0.1',
          tag: 'a_v0.0.1',
          date: 'Wed, 30 Nov 2016 18:37:45 GMT',
          comments: {
            patch: [
              {
                comment: 'Patching a'
              }
            ]
          }
        }
      ]
    };

    // Remove date.
    actualResult.entries[0].date = undefined;

    expect(actualResult).eql(expectedResult);
  });

});

describe('updateChangelogs', () => {
  const rushJsonFile: string = path.resolve(__dirname, 'packages', 'rush.json');
  let rushConfiguration: RushConfiguration;

  beforeEach(() => {
    rushConfiguration = RushConfiguration.loadFromConfigurationFile(rushJsonFile);
  });

  /* tslint:disable:no-string-literal */
  it('skips changes logs if the project version is not changed.', () => {
    const changeHash: IChangeInfoHash = {};
    // Package a does not have version change.
    changeHash['a'] = {
      packageName: 'a',
      changeType: ChangeType.dependency,
      newVersion: '1.0.0',
      changes: []
    };
    // Package b has version change.
    changeHash['b'] = {
      packageName: 'b',
      changeType: ChangeType.patch,
      newVersion: '1.0.1',
      changes: []
    };
    const updatedChangeLogs: IChangelog[] = ChangelogGenerator.updateChangelogs(
      changeHash, rushConfiguration.projectsByName, false);
    expect(updatedChangeLogs.length).eqls(1);
    expect(updatedChangeLogs[0].name).eqls('b');
  });

  it('skips changes logs if the project is in pre-release', () => {
    const changeHash: IChangeInfoHash = {};
    // Package a is a prerelease
    changeHash['a'] = {
      packageName: 'a',
      changeType: ChangeType.dependency,
      newVersion: '1.0.1-pre.1',
      changes: []
    };
    // Package b is not a prerelease
    changeHash['b'] = {
      packageName: 'b',
      changeType: ChangeType.patch,
      newVersion: '1.0.1',
      changes: []
    };
    // Makes package 'a' prerelease package.
    const rushProjectA: RushConfigurationProject = rushConfiguration.projectsByName.get('a')!;
    rushProjectA.packageJson.version = '1.0.1-pre.1';

    const updatedChangeLogs: IChangelog[] = ChangelogGenerator.updateChangelogs(
      changeHash, rushConfiguration.projectsByName, false);
    expect(updatedChangeLogs.length).eqls(1);
    expect(updatedChangeLogs[0].name).eqls('b');
  });
  /* tslint:enable:no-string-literal */
});
