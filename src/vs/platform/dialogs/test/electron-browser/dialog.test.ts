/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../native/common/native.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const osProperties: IOSProperties = {
		type: 'Test OS',
		release: '1.0',
		arch: 'test-arch',
		platform: 'test',
		cpus: []
	};

	test('about details omit the Copilot runtime and SDK', () => {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			copilotVersions: { runtime: '1.0.84', sdk: '0.1.23' }
		};
		const { details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);

		assert.ok(details.includes('Version:'));
		assert.ok(details.includes('Test OS'));
		assert.ok(details.includes('Claude protocol: 1'));
		assert.ok(details.includes('not affiliated with or endorsed by Anthropic'));
		assert.ok(detailsToCopy.includes('Claude protocol: 1'));
		assert.strictEqual(details.includes('@github/copilot'), false);
		assert.strictEqual(detailsToCopy.includes('@github/copilot'), false);
	});
});
