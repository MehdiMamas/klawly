/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createBrowserAboutDialogDetails } from '../../common/browserAboutDetails.js';

suite('Browser About dialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('details include the Claude protocol version', () => {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
		};
		const { details, detailsToCopy } = createBrowserAboutDialogDetails(productService, 'TestBrowser');

		assert.ok(details.includes('Version:'));
		assert.ok(details.includes('Browser: TestBrowser'));
		assert.ok(details.includes('Claude protocol: 1'));
		assert.ok(details.includes('not affiliated with or endorsed by Anthropic'));
		assert.ok(detailsToCopy.includes('Claude protocol: 1'));
		assert.strictEqual(details.includes('@github/copilot'), false);
		assert.strictEqual(detailsToCopy.includes('@github/copilot'), false);
	});

	test('an alpha build shows which alpha it is', () => {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			version: '1.141.0',
			klawlyRelease: 'alpha.8',
		};
		const { detailsToCopy } = createBrowserAboutDialogDetails(productService, 'TestBrowser');

		assert.strictEqual(detailsToCopy.split('\n')[0], 'Version: 1.141.0 Alpha 8');
	});
});
