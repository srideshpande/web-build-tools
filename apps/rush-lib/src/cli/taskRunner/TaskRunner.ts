﻿// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as os from 'os';
import { Interleaver } from '@microsoft/stream-collator';

import { Stopwatch } from '../../utilities/Stopwatch';
import ITask, { ITaskDefinition } from './ITask';
import TaskStatus from './TaskStatus';
import TaskError from './TaskError';

/**
 * A class which manages the execution of a set of tasks with interdependencies.
 * Any class of task definition may be registered, and dependencies between tasks are
 * easily specified. Initially, and at the end of each task execution, all unblocked tasks
 * are added to a ready queue which is then executed. This is done continually until all
 * tasks are complete, or prematurely fails if any of the tasks fail. Note that all task
 * definitions must
 * @todo #168352: add unit tests
 */
export default class TaskRunner {
  private _tasks: Map<string, ITask>;
  private _buildQueue: ITask[];
  private _quietMode: boolean;
  private _hasAnyFailures: boolean;
  private _parallelism: number;
  private _currentActiveTasks: number;

  constructor(quietMode: boolean = false, parallelism?: number) {
    this._tasks = new Map<string, ITask>();
    this._buildQueue = [];
    this._quietMode = quietMode;
    this._hasAnyFailures = false;

    this._parallelism = parallelism || os.cpus().length;
  }

  /**
   * Registers a task definition to the map of defined tasks
   */
  public addTask(taskDefinition: ITaskDefinition): void {
    if (this._tasks.has(taskDefinition.name)) {
      throw new Error('A task with that name has already been registered.');
    }

    const task: ITask = taskDefinition as ITask;
    task.dependencies = new Set<ITask>();
    task.dependents = new Set<ITask>();
    task.errors = new Set<TaskError>();
    task.status = TaskStatus.Ready;
    task.criticalPathLength = undefined;
    this._tasks.set(task.name, task);

    if (!this._quietMode) {
      console.log(`Registered ${task.name}`);
    }
  }

  /**
   * Returns true if a task with that name has been registered
   */
  public hasTask(taskName: string): boolean {
    return this._tasks.has(taskName);
  }

  /**
   * Defines the list of dependencies for an individual task.
   * @param taskName - the string name of the task for which we are defining dependencies. A task with this
   * name must already have been registered.
   * @taskDependencies
   */
  public addDependencies(taskName: string, taskDependencies: string[]): void {
    const task: ITask | undefined = this._tasks.get(taskName);

    if (!task) {
      throw new Error(`The task '${taskName}' has not been registered`);
    }
    if (!taskDependencies) {
      throw new Error('The list of dependencies must be defined');
    }

    for (const dependencyName of taskDependencies) {
      if (!this._tasks.has(dependencyName)) {
        throw new Error(`The project '${dependencyName}' has not been registered.`);
      }
      const dependency: ITask = this._tasks.get(dependencyName)!;
      task.dependencies.add(dependency);
      dependency.dependents.add(task);
    }
  }

  /**
   * Executes all tasks which have been registered, returning a promise which is resolved when all the
   * tasks are completed successfully, or rejects when any task fails.
   */
  public execute(): Promise<void> {
    this._currentActiveTasks = 0;
    console.log(`Executing a maximum of ${this._parallelism} simultaneous processes...${os.EOL}`);

    this._checkForCyclicDependencies(this._tasks.values(), []);

    // Precalculate the number of dependent packages
    this._tasks.forEach((task: ITask) => {
      this._calculateCriticalPaths(task);
    });

    // Add everything to the buildQueue
    this._tasks.forEach((task: ITask) => {
      this._buildQueue.push(task);
    });

    // Sort the queue in descending order, nothing will mess with the order
    this._buildQueue.sort((taskA: ITask, taskB: ITask): number => {
      return taskB.criticalPathLength! - taskA.criticalPathLength!;
    });

    return new Promise<void>((complete: () => void, reject: () => void) => {
      this._startAvailableTasks(complete, reject);
    });
  }

  /**
   * Pulls the next task with no dependencies off the build queue
   * Removes any non-ready tasks from the build queue (this should only be blocked tasks)
   */
  private _getNextTask(): ITask | undefined {
    for (let i: number = 0; i < this._buildQueue.length; i++) {
      const task: ITask = this._buildQueue[i];

      if (task.status !== TaskStatus.Ready) {
        // It shouldn't be on the queue, remove it
        this._buildQueue.splice(i, 1);
        // Decrement since we modified the array
        i--;
      } else if (task.dependencies.size === 0 && task.status === TaskStatus.Ready) {
        // this is a task which is ready to go. remove it and return it
        return this._buildQueue.splice(i, 1)[0];
      }
      // Otherwise task is still waiting
    }
    return undefined; // There are no tasks ready to go at this time
  }

  /**
   * Helper function which finds any tasks which are available to run and begins executing them.
   * It calls the complete callback when all tasks are completed, or rejects if any task fails.
   */
  private _startAvailableTasks(complete: () => void, reject: (err?: Object) => void): void {
    if (!this._areAnyTasksReadyOrExecuting()) {
      this._printTaskStatus();
      if (this._hasAnyFailures) {
        reject();
      } else {
        complete();
      }
    }

    let ctask: ITask | undefined;
    while (this._currentActiveTasks < this._parallelism && (ctask = this._getNextTask())) {
      this._currentActiveTasks++;
      const task: ITask = ctask;
      task.status = TaskStatus.Executing;
      console.log(colors.white(`> Starting task [${task.name}]`));

      task.stopwatch = Stopwatch.start();
      task.writer = Interleaver.registerTask(task.name, this._quietMode);

      task.execute(task.writer)
        .then((result: TaskStatus) => {
          task.stopwatch.stop();
          task.writer.close();

          this._currentActiveTasks--;
          switch (result) {
            case TaskStatus.Success:
              this._markTaskAsSuccess(task);
              break;
            case TaskStatus.SuccessWithWarning:
              this._markTaskAsSuccessWithWarning(task);
              break;
            case TaskStatus.Skipped:
              this._markTaskAsSkipped(task);
              break;
            case TaskStatus.Failure:
              this._hasAnyFailures = true;
              this._markTaskAsFailed(task);
              break;
          }

          this._startAvailableTasks(complete, reject);

        }).catch((errors: TaskError[]) => {
          task.writer.close();

          this._currentActiveTasks--;

          this._hasAnyFailures = true;
          task.errors = new Set<TaskError>(errors);
          this._markTaskAsFailed(task);
          this._startAvailableTasks(complete, reject);
        }
      );
    }
  }

  /**
   * Marks a task as having failed and marks each of its dependents as blocked
   */
  private _markTaskAsFailed(task: ITask): void {
    console.log(colors.red(`${os.EOL}> Completed task [${task.name}] with errors!`));
    task.status = TaskStatus.Failure;
    task.dependents.forEach((dependent: ITask) => {
      this._markTaskAsBlocked(dependent, task);
    });
  }

  /**
   * Marks a task and all its dependents as blocked
   */
  private _markTaskAsBlocked(task: ITask, failedTask: ITask): void {
    if (task.status === TaskStatus.Ready) {
      console.log(colors.red(`> [${task.name}] blocked by [${failedTask.name}]!`));
      task.status = TaskStatus.Blocked;
      task.dependents.forEach((dependent: ITask) => {
        this._markTaskAsBlocked(dependent, failedTask);
      });
    }
  }

  /**
   * Marks a task as being completed, and removes it from the dependencies list of all its dependents
   */
  private _markTaskAsSuccess(task: ITask): void {
    console.log(colors.green(`> Completed task [${task.name}] in ${task.stopwatch.toString()}`));
    task.status = TaskStatus.Success;

    task.dependents.forEach((dependent: ITask) => {
      dependent.isIncrementalBuildAllowed = false;
      dependent.dependencies.delete(task);
    });
  }

  /**
   * Marks a task as being completed, but with warnings written to stderr, and removes it from the dependencies
   * list of all its dependents
   */
  private _markTaskAsSuccessWithWarning(task: ITask): void {
    console.log(colors.yellow(`> Completed task [${task.name}] with warnings in ${task.stopwatch.toString()}`));
    task.status = TaskStatus.SuccessWithWarning;
    task.dependents.forEach((dependent: ITask) => {
      dependent.isIncrementalBuildAllowed = false;
      dependent.dependencies.delete(task);
    });
  }

  /**
   * Marks a task as skipped.
   */
  private _markTaskAsSkipped(task: ITask): void {
    console.log(colors.green(`> Skipped task [${task.name}] in ${task.stopwatch.toString()}`));
    task.status = TaskStatus.Skipped;
    task.dependents.forEach((dependent: ITask) => {
      dependent.dependencies.delete(task);
    });
  }

  /**
   * Do any Ready or Executing tasks exist?
   */
  private _areAnyTasksReadyOrExecuting(): boolean {
    let anyNonCompletedTasks: boolean = false;
    this._tasks.forEach((task: ITask) => {
      if (task.status === TaskStatus.Executing || task.status === TaskStatus.Ready) {
        anyNonCompletedTasks = true;
      }
    });
    return anyNonCompletedTasks;
  }

  /**
   * Checks for projects that indirectly depend on themselves.
   */
  private _checkForCyclicDependencies(tasks: Iterable<ITask>, dependencyChain: string[]): void {
    for (const task of tasks) {
      if (dependencyChain.indexOf(task.name) >= 0) {
        throw new Error('A cyclic dependency was encountered:\n'
          + '  ' + [...dependencyChain, task.name].reverse().join('\n  -> ')
          + '\nConsider using the cyclicDependencyProjects option for rush.json.');
      }
      dependencyChain.push(task.name);
      this._checkForCyclicDependencies(task.dependents, dependencyChain);
      dependencyChain.pop();
    }
  }

  /**
   * Calculate the number of packages which must be built before we reach
   * the furthest away "root" node
   */
  private _calculateCriticalPaths(task: ITask): number {

    // Return the memoized value
    if (task.criticalPathLength !== undefined) {
      return task.criticalPathLength;
    }

    // If no dependents, we are in a "root"
    if (task.dependents.size === 0) {
      return task.criticalPathLength = 0;
    } else {
      // Otherwise we are as long as the longest package + 1
      const depsLengths: number[] = [];
      task.dependents.forEach(dep => this._calculateCriticalPaths(dep));
      return task.criticalPathLength = Math.max(...depsLengths) + 1;
    }
  }

  /**
   * Prints out a report of the status of each project
   */
  private _printTaskStatus(): void {
    const tasksByStatus: { [status: number]: ITask[] } = {};
    this._tasks.forEach((task: ITask) => {
      if (tasksByStatus[task.status]) {
        tasksByStatus[task.status].push(task);
      } else {
        tasksByStatus[task.status] = [task];
      }
    });

    console.log('');

    this._printStatus('EXECUTING', tasksByStatus[TaskStatus.Executing], colors.yellow);
    this._printStatus('READY', tasksByStatus[TaskStatus.Ready], colors.white);
    this._printStatus('SKIPPED', tasksByStatus[TaskStatus.Skipped], colors.grey);
    this._printStatus('SUCCESS', tasksByStatus[TaskStatus.Success], colors.green);
    this._printStatus('SUCCESS WITH WARNINGS', tasksByStatus[TaskStatus.SuccessWithWarning], colors.yellow.underline);
    this._printStatus('BLOCKED', tasksByStatus[TaskStatus.Blocked], colors.red);
    this._printStatus('FAILURE', tasksByStatus[TaskStatus.Failure], colors.red);

    const tasksWithErrors: ITask[] = tasksByStatus[TaskStatus.Failure];
    if (tasksWithErrors) {
      tasksWithErrors.forEach((task: ITask) => {
        task.errors.forEach((error: TaskError) => {
          if (error) {
            console.log(colors.red(`[${task.name}] ${error.toString()}`));
          }
        });
      });
    }

    console.log('');
  }

  private _printStatus(status: string, tasks: ITask[], color: (a: string) => string): void {
    if (tasks && tasks.length) {
      console.log(color(`${status} (${tasks.length})`));
      console.log(color('================================'));
      for (let i: number = 0; i < tasks.length; i++) {
        const task: ITask = tasks[i];
        console.log(color(task.name));
        if (task.writer) {
          let stderr: string = task.writer.getStdError();
          if (stderr && (task.status === TaskStatus.Failure || task.status === TaskStatus.SuccessWithWarning)) {
            stderr = stderr.split(os.EOL)
              .map(text => text.trim())
              .filter(text => text)
              .join(os.EOL);

            console.log(stderr + (i !== tasks.length - 1 ? os.EOL : ''));
          }
        }
      }
      console.log(color('================================' + os.EOL));
    }
  }
}
