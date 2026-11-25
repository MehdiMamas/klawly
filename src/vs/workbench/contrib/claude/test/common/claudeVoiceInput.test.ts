/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeVoiceAvailability, claudeVoiceDraft, claudeVoiceLevel, claudeVoiceLocalReady } from '../../common/claudeVoiceInput.js';

suite('Klawly voice input', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('on-device transcription first, then the system dictation of each platform', () => {
		const mode = (supported: boolean, os: OperatingSystem) => {
			const availability = claudeVoiceAvailability(supported, os);
			return { mode: availability.mode, hint: availability.hint !== undefined };
		};
		assert.deepStrictEqual({
			macLocal: mode(true, OperatingSystem.Macintosh),
			windowsLocal: mode(true, OperatingSystem.Windows),
			linuxLocal: mode(true, OperatingSystem.Linux),
			mac: mode(false, OperatingSystem.Macintosh),
			windows: mode(false, OperatingSystem.Windows),
			linux: mode(false, OperatingSystem.Linux),
		}, {
			macLocal: { mode: 'local', hint: false },
			windowsLocal: { mode: 'local', hint: false },
			linuxLocal: { mode: 'local', hint: false },
			mac: { mode: 'system', hint: true },
			windows: { mode: 'system', hint: true },
			linux: { mode: 'none', hint: true },
		});
	});

	test('a packaged build without a dictation runtime offers the system dictation at once', () => {
		const runtime = { version: '2.0.1', urlTemplate: 'https://example.com/dictation-runtime/2.0.1/{target}.tgz' };
		const mode = (platformSupported: boolean, isBuilt: boolean, dictationRuntime: typeof runtime | undefined, bundled?: boolean) =>
			claudeVoiceAvailability(claudeVoiceLocalReady(platformSupported, isBuilt, dictationRuntime, bundled), OperatingSystem.Windows).mode;
		assert.deepStrictEqual({
			fromSource: mode(true, false, undefined),
			packagedWithRuntime: mode(true, true, runtime),
			packagedWithBundledRuntime: mode(true, true, undefined, true),
			packagedWithoutRuntime: mode(true, true, undefined),
			packagedWithEmptyRuntime: mode(true, true, { version: '', urlTemplate: '' }),
			unsupportedPlatform: mode(false, false, runtime),
			unsupportedPlatformBundled: mode(false, true, undefined, true),
		}, {
			fromSource: 'local',
			packagedWithRuntime: 'local',
			packagedWithBundledRuntime: 'local',
			packagedWithoutRuntime: 'system',
			packagedWithEmptyRuntime: 'system',
			unsupportedPlatform: 'system',
			unsupportedPlatformBundled: 'system',
		});
	});

	test('dictated text lands at the caret with one space on each side', () => {
		assert.deepStrictEqual([
			claudeVoiceDraft('', '', ' fix the test '),
			claudeVoiceDraft('Please', '', 'fix the test'),
			claudeVoiceDraft('Please ', 'now', 'fix the test'),
			claudeVoiceDraft('a\n', ' b', 'middle'),
			claudeVoiceDraft('keep', ' this', '   '),
		], [
			{ value: 'fix the test', caret: 12 },
			{ value: 'Please fix the test', caret: 19 },
			{ value: 'Please fix the test now', caret: 20 },
			{ value: 'a\nmiddle b', caret: 8 },
			{ value: 'keep this', caret: 4 },
		]);
	});

	test('the meter reads silence as zero and caps loud input', () => {
		assert.deepStrictEqual([
			claudeVoiceLevel(new Uint8Array(0)),
			claudeVoiceLevel(new Uint8Array(8).fill(128)),
			claudeVoiceLevel(new Uint8Array([144, 112, 144, 112])),
			claudeVoiceLevel(new Uint8Array([255, 0, 255, 0])),
		], [0, 0, 0.5, 1]);
	});
});
