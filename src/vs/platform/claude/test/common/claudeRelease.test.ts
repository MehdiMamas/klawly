/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { darwinUpdatePlatform, formatProductVersion, formatReleaseVersion, parseReleaseTag } from '../../common/claudeRelease.js';

/** An alpha or beta build says which one it is (issue 475). */
suite('Claude release', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a release tag stamps the alpha or beta and keeps the semver version', () => {
		assert.deepStrictEqual(['v1.141.0-alpha.8', ' v1.141.0-alpha.08 ', 'v1.141.0', '1.141.0-alpha.8', 'v1.141.0-beta.1', 'v1.141-alpha.1', 'v1.141.0-rc.1'].map(parseReleaseTag), [
			{ version: '1.141.0', release: 'alpha.8' },
			{ version: '1.141.0', release: 'alpha.8' },
			undefined,
			undefined,
			{ version: '1.141.0', release: 'beta.1' },
			undefined,
			undefined,
		]);
	});

	test('About and the update tooltip show the alpha or beta', () => {
		assert.deepStrictEqual({
			stamped: formatReleaseVersion('1.141.0', 'alpha.8'),
			beta: formatReleaseVersion('1.141.0', 'beta.1'),
			betaUpdate: formatProductVersion('1.141.0-beta.2'),
			unstamped: formatReleaseVersion('1.141.0', undefined),
			unknownRelease: formatReleaseVersion('1.141.0', 'nightly'),
			update: formatProductVersion('1.141.0-alpha.12'),
			plainUpdate: formatProductVersion('1.141.0'),
		}, {
			stamped: '1.141.0 Alpha 8',
			beta: '1.141.0 Beta 1',
			betaUpdate: '1.141.0 Beta 2',
			unstamped: '1.141.0',
			unknownRelease: '1.141.0',
			update: '1.141.0 Alpha 12',
			plainUpdate: '1.141.0',
		});
	});

	test('macOS asks the feed for the platform upstream sends', () => {
		assert.deepStrictEqual([darwinUpdatePlatform('arm64', undefined), darwinUpdatePlatform('x64', undefined), darwinUpdatePlatform('arm64', 'darwin-universal'), darwinUpdatePlatform('arm64', undefined, true), darwinUpdatePlatform('x64', undefined, true)], ['darwin-arm64', 'darwin', 'darwin-universal', 'darwin-arm64-zip', 'darwin-zip']);
	});
});
