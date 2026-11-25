/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { $, addDisposableListener, append, EventType, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { OS } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { CLAUDE_VOICE_AUTO_SEND_SETTING, CLAUDE_VOICE_ENABLED_SETTING, CLAUDE_VOICE_TOGGLE_COMMAND_ID, ClaudeVoiceStatus, ClaudeVoiceTranscript, claudeVoiceAvailability, claudeVoiceDraft, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';
import '../media/claudeVoice.css';

/** A press on the microphone at least this long is push to talk: releasing it stops. */
const HOLD_MS = 400;
const METER_BARS = 5;

export interface ClaudeComposerVoiceHost {
	/** Dictation changed the composer text: keep the draft, the height and Send in step. */
	didChangeText(): void;
	/** Sends the prompt, for `claude.voice.autoSend`. */
	submit(): void;
	requestLayout(): void;
}

/**
 * The composer's microphone (issue 429): a toolbar button, a status row with a
 * level meter, and live text at the caret. The text stays read-only while it is
 * dictated; Enter or releasing a held button finishes and leaves it editable,
 * Escape cancels and puts back what was there. Nothing is sent unless
 * `claude.voice.autoSend` is on.
 */
export class ClaudeComposerVoice extends Disposable {
	readonly button: HTMLButtonElement;
	private readonly _bar: HTMLElement;
	private readonly _meter: HTMLElement;
	private readonly _label: HTMLElement;
	private readonly _meterFrame = this._register(new MutableDisposable());
	/** True while a dictation this composer started is in progress. */
	private _active = false;
	/**
	 * The OS dictation hint, shown instead of listening where on-device transcription cannot run:
	 * a small notice on the microphone, never a line inside the composer (issue 547).
	 */
	private readonly _hint = this._register(new MutableDisposable());
	/** True while the error of a dictation this composer started is shown. */
	private _showError = false;
	private _before = '';
	private _after = '';
	private _original = '';
	private _originalSelection: [number, number] = [0, 0];
	private _holdFrom = 0;
	private _stopOnRelease = false;

	constructor(
		composer: HTMLElement,
		toolbar: HTMLElement,
		anchor: HTMLElement,
		private readonly _input: HTMLTextAreaElement,
		private readonly _host: ClaudeComposerVoiceHost,
		@IClaudeVoiceInputService private readonly _voice: IClaudeVoiceInputService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IHoverService private readonly _hovers: IHoverService,
		@IKeybindingService private readonly _keybindings: IKeybindingService,
	) {
		super();
		this.button = $<HTMLButtonElement>('button.claude-icon-btn.claude-voice-button');
		this.button.type = 'button';
		toolbar.insertBefore(this.button, anchor);
		this._bar = $('.claude-voice-bar');
		this._bar.setAttribute('role', 'status');
		this._bar.setAttribute('aria-live', 'polite');
		this._bar.hidden = true;
		composer.insertBefore(this._bar, toolbar);
		this._meter = append(this._bar, $('span.claude-voice-meter'));
		this._meter.setAttribute('aria-hidden', 'true');
		for (let i = 0; i < METER_BARS; i++) {
			append(this._meter, $('span'));
		}
		this._label = append(this._bar, $('span.claude-voice-label'));

		this._register(_hovers.setupDelayedHover(this.button, () => ({ content: this.buttonLabel(), additionalClasses: ['claude-root'] })));
		this._register(addDisposableListener(this.button, EventType.POINTER_DOWN, event => this.onPress(event)));
		this._register(addDisposableListener(this.button, EventType.POINTER_UP, () => this.onRelease()));
		// Enter and Space on the focused button arrive as a click with no pointer.
		this._register(addDisposableListener(this.button, EventType.CLICK, event => {
			if (event.detail === 0) {
				this.toggle();
			}
		}));
		this._register(addDisposableListener(this.button, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape' && this.dismiss()) {
				event.preventDefault();
				event.stopPropagation();
			}
		}));
		this._register(_voice.onDidChangeStatus(status => this.onStatus(status)));
		this._register(_voice.onDidTranscribe(transcript => this.onTranscript(transcript)));
		this._register(_configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CLAUDE_VOICE_ENABLED_SETTING)) {
				this.paint();
			}
		}));
		this.paint();
	}

	/** The toggle command and a click: starts a dictation, or finishes the running one. */
	toggle(): void {
		const phase = this._voice.status.phase;
		if (this._active && (phase === 'listening' || phase === 'preparing')) {
			void this.stop();
		} else if (!this._active && phase !== 'transcribing') {
			this.start();
		}
	}

	/**
	 * Keys while dictating, from the composer's keydown. True when the key was
	 * used: Escape cancels (or closes a hint or an error), Enter finishes, and
	 * Enter while the final text is on its way does nothing rather than send.
	 */
	handleKeyDown(event: KeyboardEvent): boolean {
		let used = false;
		if (event.key === 'Escape') {
			used = this.dismiss();
		} else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && this._active) {
			if (this._voice.status.phase !== 'transcribing') {
				void this.stop();
			}
			used = true;
		}
		if (used) {
			event.preventDefault();
			event.stopPropagation();
		}
		return used;
	}

	/** Cancels a dictation this composer started, putting back the text from before. */
	cancel(): void {
		if (!this._active) {
			return;
		}
		this._input.value = this._original;
		this._input.setSelectionRange(this._originalSelection[0], this._originalSelection[1]);
		this.finish();
		void this._voice.cancel();
		this._host.didChangeText();
	}

	/**
	 * Stops listening without touching the text, when the composer switches to
	 * another session; that session keeps what was dictated so far.
	 */
	abandon(): void {
		if (this._active) {
			this.finish();
			void this._voice.cancel();
		}
	}

	private start(): void {
		const availability = claudeVoiceAvailability(this._voice.isSupported, OS);
		if (availability.mode !== 'local') {
			this._input.focus();
			this._hint.value = availability.hint ? this._hovers.showInstantHover({
				content: availability.hint,
				target: this.button,
				position: { hoverPosition: HoverPosition.ABOVE },
				appearance: { showPointer: true },
				additionalClasses: ['claude-root', 'claude-voice-hint'],
			}) : undefined;
			return;
		}
		this._hint.clear();
		this._showError = false;
		this._original = this._input.value;
		this._originalSelection = [this._input.selectionStart, this._input.selectionEnd];
		this._before = this._original.slice(0, this._input.selectionStart);
		this._after = this._original.slice(this._input.selectionEnd);
		this._active = true;
		this._input.readOnly = true;
		this._input.focus();
		void this._voice.start(getWindow(this._input));
		this.paint();
	}

	private async stop(): Promise<void> {
		await this._voice.stop();
	}

	/** Escape: cancels a dictation, or closes the hint or the error. */
	private dismiss(): boolean {
		if (this._active) {
			this.cancel();
			return true;
		}
		if (this._hint.value || this._showError) {
			this._hint.clear();
			this._showError = false;
			this.paint();
			return true;
		}
		return false;
	}

	private onPress(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		if (this._active) {
			this._stopOnRelease = true;
			return;
		}
		this._holdFrom = Date.now();
		this.start();
	}

	private onRelease(): void {
		const held = this._holdFrom > 0 && Date.now() - this._holdFrom >= HOLD_MS;
		if (this._active && (this._stopOnRelease || held)) {
			void this.stop();
		}
		this._holdFrom = 0;
		this._stopOnRelease = false;
	}

	private onTranscript(transcript: ClaudeVoiceTranscript): void {
		if (!this._active) {
			return;
		}
		const draft = claudeVoiceDraft(this._before, this._after, transcript.text);
		this._input.value = draft.value;
		this._input.setSelectionRange(draft.caret, draft.caret);
		this._host.didChangeText();
		if (transcript.isFinal) {
			this.finish();
			if (transcript.text.trim() && this._configuration.getValue<boolean>(CLAUDE_VOICE_AUTO_SEND_SETTING) === true) {
				this._host.submit();
			}
		}
	}

	private onStatus(status: ClaudeVoiceStatus): void {
		if (this._active && (status.phase === 'idle' || status.phase === 'error')) {
			// An error keeps what was heard so far, now editable.
			this._showError = status.phase === 'error';
			this.finish();
			return;
		}
		this.paint();
	}

	private finish(): void {
		this._active = false;
		this._input.readOnly = false;
		this._holdFrom = 0;
		this._stopOnRelease = false;
		this.paint();
	}

	private buttonLabel(): string {
		const label = this._active
			? localize('claudeVoiceStop', "Finish Voice Input")
			: localize('claudeVoiceStart', "Voice Input");
		const key = this._keybindings.lookupKeybinding(CLAUDE_VOICE_TOGGLE_COMMAND_ID)?.getLabel();
		return key ? localize('claudeVoiceLabelWithKey', "{0} ({1})", label, key) : label;
	}

	private paint(): void {
		const enabled = this._configuration.getValue<boolean>(CLAUDE_VOICE_ENABLED_SETTING) !== false;
		const status = this._voice.status;
		// Another composer's dictation (the chat in an editor tab, another window) shows there, not here.
		const phase = this._active || (this._showError && status.phase === 'error') ? status.phase : 'idle';
		this.button.hidden = !enabled && !this._active;
		this.button.dataset.state = phase;
		this.button.setAttribute('aria-pressed', String(this._active));
		this.button.setAttribute('aria-label', this.buttonLabel());
		this.button.replaceChildren($(ThemeIcon.asCSSSelector(
			phase === 'transcribing' ? ThemeIcon.modify(Codicon.loading, 'spin')
				: this._active ? Codicon.micFilled
					: Codicon.mic)));

		const wasHidden = this._bar.hidden;
		this._bar.hidden = phase === 'idle';
		this._bar.dataset.state = phase;
		this._meter.hidden = phase !== 'listening';
		this._label.textContent = this.barText(phase, status);
		if (wasHidden !== this._bar.hidden) {
			this._host.requestLayout();
		}
		this.paintMeter(phase === 'listening');
	}

	private barText(state: string, status: ClaudeVoiceStatus): string {
		switch (state) {
			case 'preparing':
				return status.progress !== undefined
					? localize('claudeVoiceDownloading', "Downloading the voice model ({0}%). Keep talking; Klawly keeps the audio.", Math.round(status.progress * 100))
					: localize('claudeVoicePreparing', "Getting the voice model ready. Keep talking; Klawly keeps the audio.");
			case 'listening':
				return localize('claudeVoiceListening', "Listening. Enter finishes, Escape cancels.");
			case 'transcribing':
				return localize('claudeVoiceTranscribing', "Transcribing.");
			case 'error': {
				const fallback = claudeVoiceAvailability(false, OS);
				return fallback.mode === 'system' && fallback.hint
					? localize('claudeVoiceErrorWithHint', "{0} {1}", status.error ?? '', fallback.hint)
					: status.error ?? '';
			}
			default:
				return '';
		}
	}

	/** The meter follows the microphone level each frame; it stays still under reduced motion (DL-08). */
	private paintMeter(listening: boolean): void {
		const targetWindow = getWindow(this._meter);
		if (!listening || targetWindow.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
			this._meterFrame.clear();
			this._meter.style.removeProperty('--claude-voice-level');
			return;
		}
		if (this._meterFrame.value) {
			return;
		}
		const frame = () => {
			this._meter.style.setProperty('--claude-voice-level', this._voice.level().toFixed(2));
			this._meterFrame.value = scheduleAtNextAnimationFrame(targetWindow, frame);
		};
		this._meterFrame.value = scheduleAtNextAnimationFrame(targetWindow, frame);
	}
}
