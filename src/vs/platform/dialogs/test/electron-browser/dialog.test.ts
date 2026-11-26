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

	test('About details name the product and carry no Copilot lines', () => {
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		const { title, details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		assert.strictEqual(title, product.nameLong);
		assert.deepStrictEqual(
			[details, detailsToCopy].map(value => value.split('\n').filter(line => /copilot/i.test(line))),
			[[], []]
		);
		assert.ok(detailsToCopy.endsWith('OS: Test OS test-arch 1.0'));
	});
});
