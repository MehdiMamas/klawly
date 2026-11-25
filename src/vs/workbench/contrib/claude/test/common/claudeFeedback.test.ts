/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { scrubClaudeDiagnosticsText } from '../../common/claudeDiagnosticsExport.js';
import { ClaudeFeedbackSendResult } from '../../../../../platform/claude/common/claudeFeedbackRelay.js';
import { claudeFeedbackPrefillDraft, buildClaudeFeedbackPayload, ClaudeFeedbackDraft, claudeFeedbackErrorLines, isEmptyClaudeFeedbackDraft, parseClaudeFeedbackDraft, serializeClaudeFeedbackDraft, claudeFeedbackImageName, claudeFeedbackImageType, claudeFeedbackIssueNumber, ClaudeFeedbackReport, ClaudeFeedbackSendError, ClaudeFeedbackBannedError, formatClaudeFeedbackBody, tailClaudeFeedbackLog } from '../../common/claudeFeedback.js';

const FAKE_KEY = ['sk', '-ant-', 'api03-feedbackvalue'].join('');
const FAKE_GITHUB = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');

function report(overrides: Partial<ClaudeFeedbackReport> = {}): ClaudeFeedbackReport {
	return {
		kind: 'bug',
		title: '  Chat\nfreezes  ',
		description: 'Sent a prompt and the pane froze.',
		system: [['Klawly', '1.141.0 (b12d8cd1)'], ['OS', 'Darwin | 25.0 arm64']],
		errors: ['Error: boom', '    at run (file.js:1:1)'],
		images: [{ name: 'screenshot.png', type: 'image/png', bytes: VSBuffer.fromString('png') }],
		texts: [{ name: 'main.log', contents: 'hello' }, { name: 'empty.log', contents: '' }],
		...overrides,
	};
}

suite('Klawly feedback', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats the issue body', () => {
		assert.strictEqual(formatClaudeFeedbackBody(report()), [
			'**Kind:** Bug',
			'',
			'Sent a prompt and the pane froze.',
			'',
			'### System',
			'',
			'| | |',
			'| --- | --- |',
			'| Klawly | 1.141.0 (b12d8cd1) |',
			'| OS | Darwin \\| 25.0 arm64 |',
			'',
			'<details><summary>Recent errors (2)</summary>',
			'',
			'```text',
			'Error: boom',
			'    at run (file.js:1:1)',
			'```',
			'',
			'</details>',
		].join('\n'));
	});

	test('leaves out system info and errors when not included, and uses a longer fence than the log', () => {
		assert.strictEqual(formatClaudeFeedbackBody(report({ kind: 'idea', system: undefined, errors: undefined, description: '' })), '**Kind:** Idea\n\n_No description._');
		assert.ok(formatClaudeFeedbackBody(report({ errors: ['Error: ```oops```'] })).includes('````text'));
	});

	test('builds the relay payload: one-line title, base64 attachments, empty logs dropped', () => {
		const payload = buildClaudeFeedbackPayload(report());
		assert.deepStrictEqual({
			title: payload.title,
			attachments: payload.attachments.map(a => [a.name, a.type, decodeBase64(a.data).toString()]),
		}, {
			title: 'Chat freezes',
			attachments: [['screenshot.png', 'image/png', 'png'], ['main.log', 'text/plain', 'hello']],
		});
	});

	test('picks error lines and tails long logs', () => {
		assert.deepStrictEqual(claudeFeedbackErrorLines('ok\nError: x\n    at y\nfine\nRequest failed'), ['Error: x', '    at y', 'Request failed']);
		assert.strictEqual(tailClaudeFeedbackLog('one\ntwo\nthree', 100), 'one\ntwo\nthree');
		assert.strictEqual(tailClaudeFeedbackLog('one\ntwo\nthree', 8), '[earlier lines left out]\nthree');
	});

	test('turns a send result into the issue number or a whole-sentence error (issue 538)', () => {
		const outcome = (result: ClaudeFeedbackSendResult) => {
			try {
				return claudeFeedbackIssueNumber(result);
			} catch (error) {
				return `${error instanceof ClaudeFeedbackSendError}: ${error instanceof Error ? error.message : error}`;
			}
		};
		assert.deepStrictEqual([
			outcome({ kind: 'sent', number: 42 }),
			outcome({ kind: 'network' }),
			outcome({ kind: 'rejected', status: 429, error: 'Too many reports. Try again later.' }),
			outcome({ kind: 'rejected', status: 502 }),
			// A rate limit with only a Retry-After header (issue 739).
			outcome({ kind: 'rejected', status: 429, retryAfter: 594 }),
		], [
			42,
			'true: Couldn\'t reach the feedback service. Check your connection and try again.',
			'true: Could not send: Too many reports. Try again later.',
			'true: Could not send: the feedback service answered 502.',
			'true: Could not send: too many reports. Try again in 10 minutes.',
		]);
	});

	test('an image is named and labeled by what its bytes are, not by its label (issue 698)', () => {
		const types = [
			new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]),
			new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]),
			new Uint8Array([0x47, 0x49, 0x46, 0x38]),
			new Uint8Array([]),
		].map(bytes => claudeFeedbackImageType(bytes));
		assert.deepStrictEqual({ types, names: [claudeFeedbackImageName('screenshot', 'image/jpeg'), claudeFeedbackImageName('pasted-1', 'image/png')] }, {
			types: ['image/png', 'image/jpeg', undefined, undefined],
			names: ['screenshot.jpg', 'pasted-1.png'],
		});
	});

	test('a send refused for sign-in or a ban says so (issue 949)', () => {
		const ban = { login: 'octo-cat', bannedAt: '2026-10-14T10:00:00.000Z', reason: 'Abusive.', reportExcerpt: 'text', issue: 951, appealEmail: 'someone@example.com' };
		const outcome = (result: ClaudeFeedbackSendResult) => {
			try {
				return claudeFeedbackIssueNumber(result);
			} catch (error) {
				return error instanceof ClaudeFeedbackBannedError ? { banned: error.ban.login, message: error.message } : String(error instanceof Error ? error.message : error);
			}
		};
		assert.deepStrictEqual([outcome({ kind: 'login_required' }), outcome({ kind: 'login_required', message: 'Sign in first.' }), outcome({ kind: 'banned', ban })], [
			'Sign in to GitHub to send feedback. If you already did, update Klawly and try again.',
			'Sign in first.',
			{ banned: 'octo-cat', message: "Your GitHub account @octo-cat can't send feedback." },
		]);
	});

	test('a refused attachment is named on the error, so the form can offer to remove it (issue 698)', () => {
		const attachment = (error: string) => {
			try {
				claudeFeedbackIssueNumber({ kind: 'rejected', status: 400, error });
				return 'sent';
			} catch (e) {
				return e instanceof ClaudeFeedbackSendError ? e.attachment : 'other';
			}
		};
		assert.deepStrictEqual([
			attachment('Attachment screenshot.png does not match its type.'),
			attachment('Attachment my shot.jpg has an unsupported type.'),
			attachment('Attachment attached-1.png is not base64.'),
			attachment('Too many reports. Try again later.'),
		], ['screenshot.png', 'my shot.jpg', 'attached-1.png', undefined]);
	});

	test('a draft survives storage as JSON, images included, and damaged entries are dropped (issue 739)', () => {
		const draft = report();
		const kept: ClaudeFeedbackDraft = { kind: 'idea', title: 'T', description: 'D', images: draft.images, includeDiagnostics: false };
		const parsed = parseClaudeFeedbackDraft(JSON.parse(JSON.stringify(serializeClaudeFeedbackDraft(kept))));
		assert.deepStrictEqual({
			parsed: parsed && { ...parsed, images: parsed.images.map(image => [image.name, image.type, image.bytes.toString()]) },
			damaged: [undefined, null, 'text', { ...kept, kind: 'rant' }].map(parseClaudeFeedbackDraft),
			badImage: parseClaudeFeedbackDraft({ ...kept, images: [{ name: 'x.gif', type: 'image/gif', data: '' }] })?.images,
			empty: [isEmptyClaudeFeedbackDraft({ ...kept, title: ' ', description: '\n' }), isEmptyClaudeFeedbackDraft(kept)],
		}, {
			parsed: { kind: 'idea', title: 'T', description: 'D', images: [['screenshot.png', 'image/png', 'png']], includeDiagnostics: false },
			damaged: [undefined, undefined, undefined, undefined],
			badImage: [],
			empty: [true, false],
		});
	});

	test('issue 1174: a Claude prefill never overwrites a kept draft and never sends', () => {
		const shot = { name: 'screenshot.png', type: 'image/png' as const, bytes: VSBuffer.fromString('png') };
		const prefill = { kind: 'bug' as const, title: 'New', description: 'From Claude' };
		const kept: ClaudeFeedbackDraft = { kind: 'idea', title: 'Mine', description: 'My words', images: [], includeDiagnostics: false };
		assert.deepStrictEqual({
			fresh: claudeFeedbackPrefillDraft(prefill, undefined, shot),
			empty: claudeFeedbackPrefillDraft(prefill, { ...kept, title: '', description: ' ' }, undefined).title,
			merged: claudeFeedbackPrefillDraft(prefill, kept, undefined),
			noTitle: claudeFeedbackPrefillDraft(prefill, { ...kept, title: ' ' }, undefined).title,
		}, {
			fresh: { ...prefill, images: [shot], includeDiagnostics: true },
			empty: 'New',
			merged: { kind: 'idea', title: 'Mine', description: 'My words\n\nFrom Claude', images: [], includeDiagnostics: false },
			noTitle: 'New',
		});
	});

	test('log redaction removes secrets and the home folder', () => {
		assert.strictEqual(scrubClaudeDiagnosticsText(`/Users/dev/p ${FAKE_KEY} token ${FAKE_GITHUB}`, ['/Users/dev']), '~/p [redacted] token [redacted]');
	});
});
