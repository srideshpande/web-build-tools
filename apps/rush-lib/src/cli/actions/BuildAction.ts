// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import {
  CommandLineFlagParameter
} from '@microsoft/ts-command-line';
import RushCommandLineParser from './RushCommandLineParser';
import RebuildAction from './RebuildAction';

export default class BuildAction extends RebuildAction {
  private _cleanParameter: CommandLineFlagParameter;

  constructor(parser: RushCommandLineParser) {
    super(parser, {
      actionVerb: 'build',
      summary: '(EXPERIMENTAL) Build all projects that haven\'t been built, or have changed since they were last '
        + 'built.',
      documentation: 'The Rush build command assumes that the package.json file for each'
        + ' project contains scripts for "npm run clean" and "npm run test".  It invokes'
        + ' these commands to build each project.  Projects are built in parallel where'
        + ' possible, but always respecting the dependency graph for locally linked projects.'
        + ' The number of simultaneous processes will be equal to the number of machine cores.'
        + ' unless overridden by the --parallelism flag.'
    });
  }

  protected onDefineParameters(): void {
    super.onDefineParameters();

    this._cleanParameter = this.defineFlagParameter({
      parameterLongName: '--clean',
      parameterShortName: '-c',
      description: 'Skip incremental build detection and force a clean build. Same as the "rebuild" command.'
    });
  }

  protected onExecute(): void {
    // If the clean flag is false, we will support incremental build by default.
    this._isIncrementalBuildAllowed = !this._cleanParameter.value;

    super.onExecute();
  }
}