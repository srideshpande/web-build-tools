// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as fsx from 'fs-extra';
import * as os from 'os';
import {
  CommandLineFlagParameter,
  CommandLineIntegerParameter,
  CommandLineStringListParameter,
  ICommandLineActionOptions
} from '@microsoft/ts-command-line';
import { JsonFile } from '@microsoft/node-core-library';

import {
  ErrorDetectionMode,
  ErrorDetector,
  IErrorDetectionRule,
  IRushLinkJson,
  RushConfigurationProject,
  Stopwatch,
  TestErrorDetector,
  TsErrorDetector,
  TsLintErrorDetector,
  Event
} from '../../index';
import { BaseRushAction } from './BaseRushAction';
import TaskRunner from '../taskRunner/TaskRunner';
import ProjectBuildTask from '../taskRunner/ProjectBuildTask';
import RushCommandLineParser from './RushCommandLineParser';

export default class RebuildAction extends BaseRushAction {

  /**
   * Defines the default state of forced (aka clean) build, where we do not try and compare
   * dependencies to evaluate if we need to build or not.
   */
  protected _isIncrementalBuildAllowed: boolean;

  private _dependentList: Map<string, Set<string>>;
  private _fromFlag: CommandLineStringListParameter;
  private _npmParameter: CommandLineFlagParameter;
  private _rushLinkJson: IRushLinkJson;
  private _parallelismParameter: CommandLineIntegerParameter;
  private _parser: RushCommandLineParser;
  private _productionParameter: CommandLineFlagParameter;
  private _toFlag: CommandLineStringListParameter;
  private _vsoParameter: CommandLineFlagParameter;
  private _minimalParameter: CommandLineFlagParameter;
  private _verboseParameter: CommandLineFlagParameter;

  constructor(parser: RushCommandLineParser, options?: ICommandLineActionOptions) {
    super(options || {
      actionVerb: 'rebuild',
      summary: 'Clean and rebuild the entire set of projects',
      documentation: 'The Rush rebuild command assumes that the package.json file for each'
      + ' project contains scripts for "npm run clean" and "npm run test".  It invokes'
      + ' these commands to build each project.  Projects are built in parallel where'
      + ' possible, but always respecting the dependency graph for locally linked projects.'
      + ' The number of simultaneous processes will be equal to the number of machine cores.'
      + ' unless overridden by the --parallelism flag.'
    });
    this._parser = parser;
    this._isIncrementalBuildAllowed = false;
  }

  protected onDefineParameters(): void {
    this._productionParameter = this.defineFlagParameter({
      parameterLongName: '--production',
      description: 'Perform a production build'
    });
    this._vsoParameter = this.defineFlagParameter({
      parameterLongName: '--vso',
      description: 'Display error messages in the format expected by the Visual Studio Team Services build interface'
    });
    this._npmParameter = this.defineFlagParameter({
      parameterLongName: '--npm',
      description: 'Perform a npm-mode build. Designed for building code for distribution on NPM'
    });
    this._parallelismParameter = this.defineIntegerParameter({
      parameterLongName: '--parallelism',
      parameterShortName: '-p',
      key: 'COUNT',
      description: 'Change limit the number of simultaneous builds. This value defaults to the number of CPU cores'
    });
    this._toFlag = this.defineStringListParameter({
      parameterLongName: '--to',
      parameterShortName: '-t',
      key: 'PROJECT1',
      description: 'Build the specified project and all of its dependencies'
    });
    this._fromFlag = this.defineStringListParameter({
      parameterLongName: '--from',
      parameterShortName: '-f',
      key: 'PROJECT2',
      description: 'Build all projects that directly or indirectly depend on the specified project'
    });
    this._minimalParameter = this.defineFlagParameter({
      parameterLongName: '--minimal',
      parameterShortName: '-m',
      description: 'Invokes the build script with the "--minimal" option, which speeds up the build by running the ' +
        'minimal set of tasks required to produce executable output'
    });
    this._verboseParameter = this.defineFlagParameter({
      parameterLongName: '--verbose',
      parameterShortName: '-v',
      description: 'Display the logs during the build, rather than just displaying the build status summary'
    });
  }

  protected run(): void {
    if (!fsx.existsSync(this.rushConfiguration.rushLinkJsonFilename)) {
      throw new Error(`File not found: ${this.rushConfiguration.rushLinkJsonFilename}` +
        `${os.EOL}Did you run "rush link"?`);
    }
    this.eventHooksManager.handle(Event.preRushBuild);
    this._rushLinkJson = JsonFile.load(this.rushConfiguration.rushLinkJsonFilename);

    const stopwatch: Stopwatch = Stopwatch.start();

    const isQuietMode: boolean = !(this._verboseParameter.value);

    const taskRunner: TaskRunner = new TaskRunner(isQuietMode, this._parallelismParameter.value);

    const toFlags: string[] = this._toFlag.value;
    const fromFlags: string[] = this._fromFlag.value;

    if (toFlags) {
      this._registerToFlags(taskRunner, toFlags);
    }
    if (fromFlags) {
      this._registerFromFlags(taskRunner, fromFlags);
    }
    if (!toFlags && !fromFlags) {
      this._registerAll(taskRunner);
    }

    taskRunner.execute()
      .then(
      () => {
        stopwatch.stop();
        console.log(colors.green(`rush ${this.options.actionVerb} (${stopwatch.toString()})`));
        this._collectTelemetry(stopwatch, true);
        this._parser.flushTelemetry();
        this.eventHooksManager.handle(Event.postRushBuild, this._parser.isDebug);
      },
      () => {
        stopwatch.stop();
        console.log(colors.red(`rush ${this.options.actionVerb} - Errors! (${stopwatch.toString()})`));
        this._collectTelemetry(stopwatch, false);
        this._parser.flushTelemetry();
        this.eventHooksManager.handle(Event.postRushBuild, this._parser.isDebug);
        this._parser.exitWithError();
      });
  }

  private _collectTelemetry(stopwatch: Stopwatch, success: boolean): void {
    this._parser.telemetry.log({
      name: 'build',
      duration: stopwatch.duration,
      result: success ? 'Succeeded' : 'Failed',
      extraData: {
        to: (!!this._toFlag.value).toString(),
        from: (!!this._fromFlag.value).toString(),
        min: (!!this._minimalParameter.value).toString()
      }
    });
  }

  private _registerToFlags(taskRunner: TaskRunner, toFlags: string[]): void {
    for (const toFlag of toFlags) {
      const toProject: RushConfigurationProject | undefined = this.rushConfiguration.findProjectByShorthandName(toFlag);
      if (!toProject) {
        throw new Error(`The project '${toFlag}' does not exist in rush.json`);
      }

      const deps: Set<string> = this._collectAllDependencies(toProject.packageName);

      // Register any dependencies it may have
      deps.forEach(dep => this._registerTask(taskRunner, this.rushConfiguration.getProjectByName(dep)));

      // Register the dependency graph to the TaskRunner
      deps.forEach(dep => taskRunner.addDependencies(dep, this._rushLinkJson.localLinks[dep] || []));
    }
  }

  private _registerFromFlags(taskRunner: TaskRunner, fromFlags: string[]): void {
    for (const fromFlag of fromFlags) {
      const fromProject: RushConfigurationProject | undefined
        = this.rushConfiguration.findProjectByShorthandName(fromFlag);
      if (!fromProject) {
        throw new Error(`The project '${fromFlag}' does not exist in rush.json`);
      }

      // Only register projects which depend on the current package, as well as things that depend on them
      this._buildDependentGraph();

      // We will assume this project will be built, but act like it has no dependencies
      const dependents: Set<string> = this._collectAllDependents(fromProject.packageName);
      dependents.add(fromProject.packageName);

      // Register all downstream dependents
      dependents.forEach(dependent => {
        this._registerTask(taskRunner, this.rushConfiguration.getProjectByName(dependent));
      });

      // Only register dependencies graph for projects which have been registered
      // e.g. package C may depend on A & B, but if we are only building A's downstream, we will ignore B
      dependents.forEach(dependent =>
        taskRunner.addDependencies(dependent,
          (this._rushLinkJson.localLinks[dependent] || []).filter(dep => dependents.has(dep))));
    }
  }

  private _registerAll(taskRunner: TaskRunner): void {
    // Register all tasks
    for (const rushProject of this.rushConfiguration.projects) {
      this._registerTask(taskRunner, rushProject);
    }

    // Add all dependencies
    for (const projectName of Object.keys(this._rushLinkJson.localLinks)) {
      taskRunner.addDependencies(projectName, this._rushLinkJson.localLinks[projectName]);
    }
  }

  /**
   * Collects all upstream dependencies for a certain project
   */
  private _collectAllDependencies(project: string): Set<string> {
    const deps: Set<string> = new Set<string>(this._rushLinkJson.localLinks[project]);
    deps.forEach(dep => this._collectAllDependencies(dep).forEach(innerDep => deps.add(innerDep)));
    deps.add(project);
    return deps;
  }

  /**
   * Collects all downstream dependents of a certain project
   */
  private _collectAllDependents(project: string): Set<string> {
    const deps: Set<string> = new Set<string>();
    (this._dependentList.get(project) || new Set<string>()).forEach((dep) => {
      deps.add(dep);
    });
    deps.forEach(dep => this._collectAllDependents(dep).forEach(innerDep => deps.add(innerDep)));
    return deps;
  }

  /**
   * Inverts the localLinks to arrive at the dependent graph, rather than using the dependency graph
   * this helps when using the --from flag
   */
  private _buildDependentGraph(): void {
    this._dependentList = new Map<string, Set<string>>();

    Object.keys(this._rushLinkJson.localLinks).forEach(project => {
      this._rushLinkJson.localLinks[project].forEach(dep => {
        if (!this._dependentList.has(dep)) {
          this._dependentList.set(dep, new Set<string>());
        }
        this._dependentList.get(dep)!.add(project);
      });
    });
  }

  private _registerTask(taskRunner: TaskRunner, project: RushConfigurationProject | undefined): void {
    if (project) {
      const errorMode: ErrorDetectionMode = this._vsoParameter.value
        ? ErrorDetectionMode.VisualStudioOnline
        : ErrorDetectionMode.LocalBuild;

      const activeRules: IErrorDetectionRule[] = [
        TestErrorDetector,
        TsErrorDetector,
        TsLintErrorDetector
      ];
      const errorDetector: ErrorDetector = new ErrorDetector(activeRules);
      const projectTask: ProjectBuildTask = new ProjectBuildTask(
        project,
        this.rushConfiguration,
        errorDetector,
        errorMode,
        this._productionParameter.value,
        this._npmParameter.value,
        this._minimalParameter.value,
        this._isIncrementalBuildAllowed);

      if (!taskRunner.hasTask(projectTask.name)) {
        taskRunner.addTask(projectTask);
      }
    }
  }
}
