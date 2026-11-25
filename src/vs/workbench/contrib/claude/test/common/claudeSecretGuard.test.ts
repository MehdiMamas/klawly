/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { AgentEnvelope } from '../../../../../platform/claude/common/claudePrompt.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IPrompt, IPromptResult, IPromptResultWithCancel, IPromptWithCustomCancel, IPromptWithDefaultCancel } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { screenClaudeAttachmentSecrets, screenClaudeElicitationSecrets } from '../../common/claudeSecretGuard.js';

/** Presses the button whose label (without mnemonics) is `choice`, and records what was shown. */
class ChoosingDialogService extends TestDialogService {
	readonly shown: { message: string; detail?: string; buttons: string[]; cancel?: string }[] = [];

	constructor(private readonly _choice: string) {
		super();
	}

	override prompt<T>(prompt: IPromptWithCustomCancel<T>): Promise<IPromptResultWithCancel<T>>;
	override prompt<T>(prompt: IPromptWithDefaultCancel<T>): Promise<IPromptResult<T>>;
	override prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>>;
	override async prompt<T>(prompt: IPrompt<T>): Promise<IPromptResult<T>> {
		const buttons = (prompt.buttons ?? []).map(button => ({ label: button.label.replace(/&&/g, ''), run: button.run }));
		const cancel = typeof prompt.cancelButton === 'object' ? { label: prompt.cancelButton.label ?? 'Cancel', run: prompt.cancelButton.run } : undefined;
		this.shown.push({ message: prompt.message, detail: typeof prompt.detail === 'string' ? prompt.detail : prompt.detail?.value, buttons: buttons.map(button => button.label), cancel: cancel?.label });
		const pressed = [...buttons, ...(cancel ? [cancel] : [])].find(button => button.label === this._choice);
		assert.ok(pressed, `no button ${this._choice}`);
		return { result: await pressed.run({ checkboxChecked: false }) };
	}
}

const FAKE_KEY = ['sk', '-ant-', 'api03-guardtestvalue'].join('');

function envelope(content: string): AgentEnvelope {
	return {
		userText: 'Explain',
		mode: 'agent',
		workspaceRoot: '/repo',
		attachments: [
			{ kind: 'pasted-text', text: content, lineCount: 2, truncated: false },
			{ kind: 'terminal', title: 'bash', lines: 'DB_PASSWORD=hunter2', truncated: false },
		],
		diagnostics: [],
		instructionFiles: [],
	};
}

suite('Claude attachment secret guard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Send Anyway sends the attachments unchanged', async () => {
		const dialogs = new ChoosingDialogService('Send Anyway');
		const original = envelope(`key ${FAKE_KEY}`);
		const result = await screenClaudeAttachmentSecrets(original, dialogs, new TestConfigurationService());
		assert.strictEqual(result, original);
		assert.deepStrictEqual(dialogs.shown, [{
			message: 'This attachment appears to contain 2 secrets.',
			detail: 'Detection is a best effort: it can miss a secret or flag text that is not one. Remove Secrets replaces each match with [redacted] before sending.',
			buttons: ['Send Anyway', 'Remove Secrets'],
			cancel: 'Cancel',
		}]);
	});

	test('Remove Secrets redacts each match and sends the rest', async () => {
		const dialogs = new ChoosingDialogService('Remove Secrets');
		const result = await screenClaudeAttachmentSecrets(envelope(`key ${FAKE_KEY}`), dialogs, new TestConfigurationService());
		assert.deepStrictEqual(result?.attachments, [
			{ kind: 'pasted-text', text: 'key [redacted]', lineCount: 2, truncated: false },
			{ kind: 'terminal', title: 'bash', lines: 'DB_PASSWORD=[redacted]', truncated: false },
		]);
		assert.strictEqual(result?.userText, 'Explain');
	});

	test('Cancel stops the send', async () => {
		const dialogs = new ChoosingDialogService('Cancel');
		assert.strictEqual(await screenClaudeAttachmentSecrets(envelope(`key ${FAKE_KEY}`), dialogs, new TestConfigurationService()), undefined);
		assert.strictEqual(dialogs.shown.length, 1);
	});

	test('one secret uses the singular message', async () => {
		const dialogs = new ChoosingDialogService('Send Anyway');
		const single: AgentEnvelope = { ...envelope('nothing here'), attachments: [{ kind: 'pasted-text', text: FAKE_KEY, lineCount: 1, truncated: false }] };
		await screenClaudeAttachmentSecrets(single, dialogs, new TestConfigurationService());
		assert.strictEqual(dialogs.shown[0]?.message, 'This attachment appears to contain 1 secret.');
	});

	test('no dialog when nothing is found or the setting is off', async () => {
		const dialogs = new ChoosingDialogService('Cancel');
		const clean: AgentEnvelope = { ...envelope('plain text'), attachments: [{ kind: 'pasted-text', text: 'plain text', lineCount: 1, truncated: false }] };
		assert.strictEqual(await screenClaudeAttachmentSecrets(clean, dialogs, new TestConfigurationService()), clean);
		const off = new TestConfigurationService({ [CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING]: false });
		const secret = envelope(`key ${FAKE_KEY}`);
		assert.strictEqual(await screenClaudeAttachmentSecrets(secret, dialogs, off), secret);
		assert.strictEqual(dialogs.shown.length, 0);
	});
});

suite('Claude MCP form secret guard (issue 428)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const answer = { token: `key ${FAKE_KEY}`, tags: ['plain', FAKE_KEY], count: 3, notify: true };

	test('Remove Secrets redacts text and list answers; Cancel keeps the form open; a clean or unscanned answer passes', async () => {
		const removing = new ChoosingDialogService('Remove Secrets');
		const removed = await screenClaudeElicitationSecrets(answer, 'deploy', removing, new TestConfigurationService());
		const cancelled = await screenClaudeElicitationSecrets(answer, 'deploy', new ChoosingDialogService('Cancel'), new TestConfigurationService());
		const quiet = new ChoosingDialogService('Cancel');
		const clean = { name: 'v2.1' };
		const passed = [
			await screenClaudeElicitationSecrets(clean, 'deploy', quiet, new TestConfigurationService()) === clean,
			await screenClaudeElicitationSecrets(answer, 'deploy', quiet, new TestConfigurationService({ [CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING]: false })) === answer,
		];
		assert.deepStrictEqual({ removed, message: removing.shown[0]?.message, buttons: removing.shown[0]?.buttons, cancelled, passed, quiet: quiet.shown.length }, {
			removed: { token: 'key [redacted]', tags: ['plain', '[redacted]'], count: 3, notify: true },
			message: 'Your answer to deploy appears to contain 2 secrets.',
			buttons: ['Send Anyway', 'Remove Secrets'],
			cancelled: undefined,
			passed: [true, true],
			quiet: 0,
		});
	});
});
