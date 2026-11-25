/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { IDictationRuntimeProductConfig } from '../../../../base/common/product.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Shows the microphone in the composer. */
export const CLAUDE_VOICE_ENABLED_SETTING = 'claude.voice.enabled';
/** Sends the prompt when dictation stops. Off by default: dictated text waits for Enter. */
export const CLAUDE_VOICE_AUTO_SEND_SETTING = 'claude.voice.autoSend';

export const CLAUDE_VOICE_TOGGLE_COMMAND_ID = 'claude.voice.toggle';
export const CLAUDE_VOICE_DELETE_MODEL_COMMAND_ID = 'claude.voice.deleteModel';

/**
 * Where a dictation is.
 * - `preparing`: the microphone is open and audio is kept while the on-device model downloads or loads.
 * - `listening`: speech becomes live text in the composer.
 * - `transcribing`: the microphone is closed and the final text is on its way.
 */
export type ClaudeVoicePhase = 'idle' | 'preparing' | 'listening' | 'transcribing' | 'error';

export interface ClaudeVoiceStatus {
	readonly phase: ClaudeVoicePhase;
	/** Model download progress in [0, 1] while `preparing`, when known. */
	readonly progress?: number;
	/** What went wrong, for `error`. */
	readonly error?: string;
}

export interface ClaudeVoiceTranscript {
	/** Everything heard so far in this dictation. */
	readonly text: string;
	readonly isFinal: boolean;
}

export const CLAUDE_VOICE_IDLE: ClaudeVoiceStatus = { phase: 'idle' };

export const IClaudeVoiceInputService = createDecorator<IClaudeVoiceInputService>('claudeVoiceInputService');

/**
 * Dictation for the composer. Audio is captured in the window and transcribed
 * on this machine by the on-device transcription service; nothing is sent to
 * a server. One dictation runs at a time.
 */
export interface IClaudeVoiceInputService {
	readonly _serviceBrand: undefined;

	/** Whether on-device transcription can run here. When false the composer points to the system's own dictation. */
	readonly isSupported: boolean;

	readonly status: ClaudeVoiceStatus;
	readonly onDidChangeStatus: Event<ClaudeVoiceStatus>;
	/** Live text while listening, then the final text after `stop`. */
	readonly onDidTranscribe: Event<ClaudeVoiceTranscript>;

	/** The microphone level in [0, 1] while listening, for the meter. */
	level(): number;

	/** Opens the microphone in `targetWindow` and starts a dictation. A failure ends in the `error` phase. */
	start(targetWindow: Window & typeof globalThis): Promise<void>;
	/** Closes the microphone and resolves with the final text. */
	stop(): Promise<string>;
	/** Closes the microphone and drops the text. */
	cancel(): Promise<void>;
	/** Deletes the downloaded model and runtime; the next dictation downloads them again. */
	deleteModel(): Promise<void>;
}

export interface ClaudeVoiceAvailability {
	/** `local` transcribes on this machine; `system` points to the OS dictation; `none` has neither. */
	readonly mode: 'local' | 'system' | 'none';
	/** What the composer says instead of listening, for `system` and `none`. */
	readonly hint?: string;
}

/**
 * Whether on-device transcription can load its native runtime here.
 * A build from source loads it from `node_modules/foundry-local-sdk/prebuilds`.
 * Klawly's packaging keeps the prebuilds of the target platform and stamps
 * `klawlyDictationBundled` in `product.json` (issue 547). Upstream's packaged
 * builds download them instead from the `dictationRuntime` source (VS Code's
 * CDN, stamped by Microsoft's build). A package with neither has no runtime,
 * so the composer offers the OS dictation at once instead of failing after the
 * first click.
 */
export function claudeVoiceLocalReady(platformSupported: boolean, isBuilt: boolean, runtime: IDictationRuntimeProductConfig | undefined, bundled: boolean | undefined): boolean {
	if (!platformSupported) {
		return false;
	}
	return !isBuilt || !!bundled || !!(runtime?.urlTemplate && runtime.version);
}

/**
 * Which voice input the composer offers. On-device transcription first; where
 * it cannot run, the OS dictation types into the composer like a keyboard.
 */
export function claudeVoiceAvailability(localSupported: boolean, os: OperatingSystem): ClaudeVoiceAvailability {
	if (localSupported) {
		return { mode: 'local' };
	}
	switch (os) {
		case OperatingSystem.Macintosh:
			return { mode: 'system', hint: localize('claudeVoiceHintMac', "On-device voice input is not available on this Mac. Use macOS Dictation instead: press the Microphone key or Fn twice in the composer.") };
		case OperatingSystem.Windows:
			return { mode: 'system', hint: localize('claudeVoiceHintWindows', "On-device voice input is not available on this PC. Use Windows Voice Typing instead: press Windows+H in the composer.") };
		default:
			return { mode: 'none', hint: localize('claudeVoiceHintNone', "Voice input is not available on this platform.") };
	}
}

export interface ClaudeVoiceDraft {
	readonly value: string;
	/** The caret after the dictated text. */
	readonly caret: number;
}

/**
 * The composer text with `transcript` dictated between `before` and `after`
 * (the text on each side of the caret when dictation started), with one space
 * on each side where the words would otherwise run together.
 */
export function claudeVoiceDraft(before: string, after: string, transcript: string): ClaudeVoiceDraft {
	const spoken = transcript.trim();
	if (!spoken) {
		return { value: before + after, caret: before.length };
	}
	const lead = before && !/\s$/.test(before) ? ' ' : '';
	const trail = after && !/^\s/.test(after) ? ' ' : '';
	const head = before + lead + spoken + trail;
	return { value: head + after, caret: head.length };
}

/** The meter level for one analyser frame of unsigned 8-bit samples (128 is silence). */
export function claudeVoiceLevel(samples: Uint8Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sum = 0;
	for (const sample of samples) {
		const centered = (sample - 128) / 128;
		sum += centered * centered;
	}
	// Speech sits around 0.05 to 0.2 RMS; scale so normal speech fills most of the meter.
	return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
