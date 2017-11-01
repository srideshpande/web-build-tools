// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';
import * as colors from 'colors';
import * as wordwrap from 'wordwrap';
import { CommandLineParser, CommandLineFlagParameter } from '@microsoft/ts-command-line';

import { RushConstants } from '../../RushConstants';
import { CommandLineConfiguration } from '../../data/CommandLineConfiguration';
import RushConfiguration from '../../data/RushConfiguration';
import Utilities from '../../utilities/Utilities';
import ChangeAction from './ChangeAction';
import CheckAction from './CheckAction';
import GenerateAction from './GenerateAction';
import InstallAction from './InstallAction';
import LinkAction from './LinkAction';
import PublishAction from './PublishAction';
import UnlinkAction from './UnlinkAction';
import ScanAction from './ScanAction';
import VersionAction from './VersionAction';
import { CustomCommandFactory } from './CustomCommandFactory';
import { CustomRushAction } from './CustomRushAction';

import Telemetry from '../utilities/Telemetry';

export default class RushCommandLineParser extends CommandLineParser {
  public telemetry: Telemetry;
  public rushConfig: RushConfiguration;

  private _debugParameter: CommandLineFlagParameter;

  constructor() {
    super({
      toolFilename: 'rush',
      toolDescription: 'Rush helps you to manage a collection of NPM'
      + ' projects.  Rush collects the dependencies for all projects to perform a minimal install,'
      + ' detects which projects can be locally linked, and performs a fast parallel'
      + ' build according to the detected dependency graph.  If you want to decompose'
      + ' your monolithic project into many small packages but are afraid of the dreaded'
      + ' NPM progress bar, Rush is for you.'
    });
    this._populateActions();
  }

  public catchSyncErrors(promise: Promise<void>): void {
    promise.catch((error: Error) => {
      this._exitAndReportError(error);
    });
  }

  public exitWithError(): void {
    try {
      this.flushTelemetry();
    } finally {
      process.exit(1);
    }
  }

  public get isDebug(): boolean {
    return this._debugParameter.value;
  }

  public flushTelemetry(): void {
    if (this.telemetry) {
      this.telemetry.flush();
    }
  }

  protected onDefineParameters(): void {
    this._debugParameter = this.defineFlagParameter({
      parameterLongName: '--debug',
      parameterShortName: '-d',
      description: 'Show the full call stack if an error occurs while executing the tool'
    });
  }

  protected onExecute(): void {
    if (this._debugParameter.value) {
      // For debugging, don't catch any exceptions; show the full call stack
      this._execute();
    } else {
      try {
        this._execute();
      } catch (error) {
        this._exitAndReportError(error);
      }
    }
  }

  private _execute(): void {
    this.telemetry = new Telemetry(this.rushConfig);
    super.onExecute();
    this.flushTelemetry();
  }

  private _populateActions(): void {
    try {
      this.rushConfig = RushConfiguration.loadFromDefaultLocation();

      const commandLineConfigFile: string = path.join(
        this.rushConfig.commonRushConfigFolder, RushConstants.commandLineFilename);

      const commandLineConfig: CommandLineConfiguration =
        CommandLineConfiguration.tryLoadFromFile(commandLineConfigFile);

      this.addAction(new ChangeAction(this));
      this.addAction(new CheckAction(this));
      this.addAction(new GenerateAction(this));
      this.addAction(new InstallAction(this));
      this.addAction(new LinkAction(this));
      this.addAction(new PublishAction(this));
      this.addAction(new ScanAction(this));
      this.addAction(new UnlinkAction(this));
      this.addAction(new VersionAction(this));

      CustomCommandFactory.createCommands(this, commandLineConfig)
        .forEach((customAction: CustomRushAction) => {
          this.addAction(customAction);
        });
    } catch (error) {
      this._exitAndReportError(error);
    }
  }

  private _exitAndReportError(error: Error): void {
    if (this._debugParameter.value) {
      // If catchSyncErrors() called this, then show a call stack similar to what NodeJS
      // would show for an uncaught error
      console.error(os.EOL + error.stack);
    } else {
      const prefix: string = 'ERROR: ';
      const wrap: (textToWrap: string) => string = wordwrap.soft(prefix.length, Utilities.getConsoleWidth());
      console.error(os.EOL + colors.red(prefix + wrap(error.message).trim()));
    }
    this.exitWithError();
  }
}
