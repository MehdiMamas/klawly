/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { MockKeybindingService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ClaudeComposerVoice } from '../../browser/chat/claudeComposerVoice.js';
import { CLAUDE_VOICE_IDLE, ClaudeVoiceStatus, ClaudeVoiceTranscript, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';

/** Dictation without a microphone: the test says what was heard and when the model fails. */
class FakeVoiceInputService implements IClaudeVoiceInputService {
	declare readonly _serviceBrand: undefined;
	readonly isSupported = true;
	status: ClaudeVoiceStatus = CLAUDE_VOICE_IDLE;
	readonly calls: string[] = [];
	private readonly _onDidChangeStatus: Emitter<ClaudeVoiceStatus>;
	readonly onDidChangeStatus: Event<ClaudeVoiceStatus>;
	private readonly _onDidTranscribe: Emitter<ClaudeVoiceTranscript>;
	readonly onDidTranscribe: Event<ClaudeVoiceTranscript>;
	/** What `stop` hears as the final text. */
	finalText = '';

	constructor(store: Pick<DisposableStore, 'add'>) {
		this._onDidChangeStatus = store.add(new Emitter<ClaudeVoiceStatus>());
		this.onDidChangeStatus = this._onDidChangeStatus.event;
		this._onDidTranscribe = store.add(new Emitter<ClaudeVoiceTranscript>());
		this.onDidTranscribe = this._onDidTranscribe.event;
	}

	level(): number {
		return 0.5;
	}

	async start(): Promise<void> {
		this.calls.push('start');
		this.set({ phase: 'listening' });
	}

	async stop(): Promise<string> {
		this.calls.push('stop');
		this.set({ phase: 'transcribing' });
		this._onDidTranscribe.fire({ text: this.finalText, isFinal: true });
		this.set(CLAUDE_VOICE_IDLE);
		return this.finalText;
	}

	async cancel(): Promise<void> {
		this.calls.push('cancel');
		this.set(CLAUDE_VOICE_IDLE);
	}

	async deleteModel(): Promise<void> { }

	hear(text: string): void {
		this._onDidTranscribe.fire({ text, isFinal: false });
	}

	set(status: ClaudeVoiceStatus): void {
		this.status = status;
		this._onDidChangeStatus.fire(status);
	}
}

suite('Klawly composer voice input', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(text: string, settings: Record<string, unknown> = {}) {
		const composer = append(mainWindow.document.body, $('.claude-composer'));
		store.add({ dispose: () => composer.remove() });
		const input = append(composer, $<HTMLTextAreaElement>('textarea'));
		const toolbar = append(composer, $('.claude-composer-toolbar'));
		const send = append(toolbar, $('button'));
		input.value = text;
		input.setSelectionRange(text.length, text.length);
		const service = new FakeVoiceInputService(store);
		const host = { changes: 0, sent: 0, layouts: 0 };
		const voice = store.add(new ClaudeComposerVoice(composer, toolbar, send, input, {
			didChangeText: () => host.changes++,
			submit: () => host.sent++,
			requestLayout: () => host.layouts++,
		}, service, new TestConfigurationService(settings), NullHoverService, new MockKeybindingService()));
		const bar = composer.querySelector<HTMLElement>('.claude-voice-bar')!;
		const snapshot = () => ({ state: voice.button.dataset.state, bar: bar.hidden ? undefined : bar.textContent, value: input.value, readOnly: input.readOnly });
		return { voice, service, input, host, snapshot };
	}

	function key(name: string): KeyboardEvent {
		return new KeyboardEvent('keydown', { key: name, cancelable: true });
	}

	test('listening shows live text read-only; Enter finishes and leaves it editable without sending', async () => {
		const { voice, service, host, snapshot } = setup('Please');
		voice.toggle();
		service.hear('fix the');
		const listening = snapshot();
		service.finalText = 'fix the test';
		const used = voice.handleKeyDown(key('Enter'));
		await Promise.resolve();
		assert.deepStrictEqual({ listening, used, after: snapshot(), calls: service.calls, sent: host.sent }, {
			listening: { state: 'listening', bar: 'Listening. Enter finishes, Escape cancels.', value: 'Please fix the', readOnly: true },
			used: true,
			after: { state: 'idle', bar: undefined, value: 'Please fix the test', readOnly: false },
			calls: ['start', 'stop'],
			sent: 0,
		});
	});

	test('Escape cancels and puts back the text from before', () => {
		const { voice, service, snapshot } = setup('draft');
		voice.toggle();
		service.hear('something else');
		const used = voice.handleKeyDown(key('Escape'));
		assert.deepStrictEqual({ used, after: snapshot(), calls: service.calls, unused: voice.handleKeyDown(key('Escape')) }, {
			used: true,
			after: { state: 'idle', bar: undefined, value: 'draft', readOnly: false },
			calls: ['start', 'cancel'],
			unused: false,
		});
	});

	test('an error keeps what was heard, says what failed, and Escape closes it', () => {
		const { voice, service, snapshot } = setup('');
		voice.toggle();
		service.hear('half a');
		service.set({ phase: 'error', error: 'The voice model could not load.' });
		const failed = snapshot();
		voice.handleKeyDown(key('Escape'));
		assert.deepStrictEqual({ state: failed.state, startsWithError: failed.bar?.startsWith('The voice model could not load.'), value: failed.value, readOnly: failed.readOnly, after: snapshot().state }, {
			state: 'error',
			startsWithError: true,
			value: 'half a',
			readOnly: false,
			after: 'idle',
		});
	});

	test('the auto-send setting sends the dictated prompt', async () => {
		const { voice, service, host } = setup('', { claude: { voice: { autoSend: true } } });
		voice.toggle();
		service.finalText = 'run the tests';
		voice.toggle();
		await Promise.resolve();
		assert.deepStrictEqual({ sent: host.sent, calls: service.calls }, { sent: 1, calls: ['start', 'stop'] });
	});
});
