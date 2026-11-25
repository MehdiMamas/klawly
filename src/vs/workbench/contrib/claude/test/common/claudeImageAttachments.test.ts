/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeImageLabel, imageMimeForName, isImageName, isStoredImagePath, SentImageIndex } from '../../common/claudeImageAttachments.js';

suite('Claude image attachments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const stored = 'file:///home/me/.klawly/User/claude-attachments/0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b.png';

	test('an image is named by its own name, then a real file name, never a stored id (issue 743)', () => {
		assert.deepStrictEqual([
			claudeImageLabel(stored, 'Pasted image'),
			claudeImageLabel(stored),
			claudeImageLabel('file:///repo/shots/cart%20mockup.png'),
			claudeImageLabel('C:\\shots\\menu.jpg'),
			isImageName('a.WEBP'),
			isImageName('a.svg'),
			imageMimeForName('a.jpeg'),
			imageMimeForName('a.bmp'),
		], ['Pasted image', 'Image', 'cart mockup.png', 'menu.jpg', true, false, 'image/jpeg', 'image/png']);
	});

	test('the Read of an attached image is recognized by its path, however it is spelled (issue 744)', () => {
		const index = new SentImageIndex();
		index.add([{ uri: 'file:///repo/shots/cart.png', name: 'cart.png' }, { uri: stored, name: 'Pasted image' }]);
		const storedPath = URI.parse(stored).fsPath;
		assert.deepStrictEqual([
			index.labelFor(URI.parse('file:///repo/shots/cart.png').fsPath),
			index.labelFor(storedPath),
			index.labelFor(storedPath.toUpperCase()),
			index.labelFor('/repo/src/app.ts'),
			index.labelFor('/home/me/.klawly/User/agent-sessions/s1/attachments/7c2d.png'),
			isStoredImagePath('/repo/claude-attachments/x.png'),
			isStoredImagePath('/repo/src/x.png'),
		], ['cart.png', 'Pasted image', 'Pasted image', undefined, '7c2d.png', true, false]);
		index.clear();
		assert.strictEqual(index.labelFor('/repo/shots/cart.png'), undefined);
	});
});
