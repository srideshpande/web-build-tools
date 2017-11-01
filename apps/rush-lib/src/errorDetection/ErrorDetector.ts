// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import TaskError from './TaskError';

/**
 * @public
 */
export enum ErrorDetectionMode {
  LocalBuild = 1,
  VisualStudio = 2,
  VisualStudioOnline = 3
}

/**
 * @public
 */
export interface IErrorDetectionRule {
  (line: string): TaskError | undefined;
}

/**
 * Creates an Error Detection Rule based on a regex and a function which converts a regex match to a TaskError
 * @public
 */
export function RegexErrorDetector(regex: RegExp,
    getError: (match: RegExpExecArray) => TaskError | undefined): IErrorDetectionRule {

  return (line: string): TaskError | undefined => {
    const match: RegExpExecArray | null = regex.exec(line);
    if (match) {
      return getError(match);
    }
    return undefined;
  };
}

/**
 * The error detector will find all errors in a chunk of text by running a number
 * of error detection rules against each line of text.
 * @public
 */
export default class ErrorDetector {
  private _rules: IErrorDetectionRule[];

  constructor(rules: IErrorDetectionRule[]) {
    this._rules = rules;
  }

  public execute(data: string): TaskError[] {
    const errors: TaskError[] = [];
    data.split('\n').forEach((line: string) => {
      const error: TaskError | undefined = this._checkLine(line);
      if (error) {
        errors.push(error);
      }
    });
    return errors;
  }

  private _checkLine(line: string): TaskError | undefined {
    for (const rule of this._rules) {
      const error: TaskError | undefined = rule(line);
      if (error) {
        return error;
      }
    }
    return undefined;
  }
}
