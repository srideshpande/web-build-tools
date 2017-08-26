// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as os from 'os';
import * as path from 'path';

import { IDocPackage } from '@microsoft/api-extractor/lib/IDocItem';
import JsonFile from '@microsoft/api-extractor/lib/JsonFile';

const apiJsonSchemaFilename: string = path.join(__dirname,
  '../node_modules/@microsoft/api-extractor/lib/schemas/api-json-schema.json');
const apiJsonSchema: { } = JsonFile.loadJsonFile(apiJsonSchemaFilename);

/**
 * TODO: This should be converted into a public API for the API Extractor library.
 */
export class ApiJsonFile {
  public readonly docPackage: IDocPackage;
  public readonly packageName: string;

  public static loadFromFile(apiJsonFilePath: string): ApiJsonFile {
    const docPackage: IDocPackage = JsonFile.loadJsonFile(apiJsonFilePath) as IDocPackage;

    JsonFile.validateSchema(docPackage, apiJsonSchema,
      (errorDetail: string): void => {
        const errorMessage: string
          = `ApiJsonGenerator validation error - output does not conform to api-json-schema.json:` + os.EOL
          + errorDetail;

        throw new Error(errorMessage);
      }
    );
Headers
    const packageName: string = path.basename(apiJsonFilePath).replace(/\.api\.json$/i, '');
    return new ApiJsonFile(packageName, docPackage);
  }

  private constructor(packageName: string, docPackage: IDocPackage) {
    this.packageName = packageName;
    this.docPackage = docPackage;
  }
}