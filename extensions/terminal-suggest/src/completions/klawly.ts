/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import code, { commonOptions, extensionManagementOptions, troubleshootingOptions } from './code';

const klawlyCompletionSpec: Fig.Spec = {
	...code,
	name: 'klawly',
	options: [
		...commonOptions,
		...extensionManagementOptions('klawly'),
		...troubleshootingOptions('klawly'),
	],
};

export default klawlyCompletionSpec;
