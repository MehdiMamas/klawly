/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { createPcmCaptureNode, IPcmCaptureNode } from '../../../chat/browser/pcmCaptureWorklet.js';
import { CLAUDE_VOICE_IDLE, ClaudeVoiceStatus, ClaudeVoiceTranscript, claudeVoiceLevel, claudeVoiceLocalReady, IClaudeVoiceInputService } from '../../common/claudeVoiceInput.js';

/** The on-device model takes 16 kHz mono PCM. */
const SAMPLE_RATE = 16000;
/** Samples per chunk the capture worklet posts (256 ms). */
const CHUNK_SIZE = 4096;

/**
 * The model and runtime folders the on-device transcription service fills.
 * Shared with the editor's dictation so the model downloads once; the runtime
 * folder sits next to the model folder.
 */
const MODEL_FOLDER = 'chatDictationModels';
const RUNTIME_FOLDER = 'chatDictationRuntime';

interface ClaudeVoiceCapture {
	readonly context: AudioContext;
	readonly stream: MediaStream;
	readonly analyser: AnalyserNode;
	readonly samples: Uint8Array<ArrayBuffer>;
	readonly flush: () => Promise<void>;
	/** `open` is cleared when the capture closes, so a chunk the worklet posts late is dropped. */
	readonly gate: { open: boolean };
}

/**
 * Composer dictation on top of upstream's on-device transcription service
 * (`ILocalTranscriptionService`, a utility process running Foundry Local).
 * That service needs no account; Copilot's chat dictation service is not used.
 */
export class ClaudeVoiceInputService extends Disposable implements IClaudeVoiceInputService {
	declare readonly _serviceBrand: undefined;

	readonly isSupported: boolean;

	private _status: ClaudeVoiceStatus = CLAUDE_VOICE_IDLE;
	private readonly _onDidChangeStatus = this._register(new Emitter<ClaudeVoiceStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	private readonly _onDidTranscribe = this._register(new Emitter<ClaudeVoiceTranscript>());
	readonly onDidTranscribe = this._onDidTranscribe.event;

	private _capture: ClaudeVoiceCapture | undefined;
	/** Bumped by every start, stop and cancel, so a late callback from an older dictation does nothing. */
	private _generation = 0;

	constructor(
		@ILocalTranscriptionService private readonly _local: ILocalTranscriptionService,
		@IEnvironmentService private readonly _environment: IEnvironmentService,
		@IFileService private readonly _files: IFileService,
		@ILogService private readonly _log: ILogService,
		@IProductService product: IProductService,
	) {
		super();
		this.isSupported = claudeVoiceLocalReady(_local.isSupported, _environment.isBuilt, product.dictationRuntime, product.klawlyDictationBundled);
		this._register(_local.onDidTranscribe(result => {
			if (this._status.phase === 'listening' || this._status.phase === 'preparing') {
				this._onDidTranscribe.fire({ text: result.text, isFinal: false });
			}
		}));
		this._register(_local.onDidChangeModelStatus(model => {
			if (this._status.phase !== 'listening' && this._status.phase !== 'preparing') {
				return;
			}
			switch (model.state) {
				case LocalTranscriptionModelState.Downloading:
				case LocalTranscriptionModelState.Loading:
					this.setStatus({ phase: 'preparing', progress: model.progress });
					break;
				case LocalTranscriptionModelState.Ready:
					this.setStatus({ phase: 'listening' });
					break;
				case LocalTranscriptionModelState.Error:
					this.fail(model.error ?? localize('claudeVoiceModelFailed', "The voice model could not load."));
					break;
			}
		}));
	}

	get status(): ClaudeVoiceStatus {
		return this._status;
	}

	level(): number {
		const capture = this._capture;
		if (!capture || this._status.phase !== 'listening') {
			return 0;
		}
		capture.analyser.getByteTimeDomainData(capture.samples);
		return claudeVoiceLevel(capture.samples);
	}

	async start(targetWindow: Window & typeof globalThis): Promise<void> {
		if (!this.isSupported || this._status.phase === 'preparing' || this._status.phase === 'listening' || this._status.phase === 'transcribing') {
			return;
		}
		const generation = ++this._generation;
		this.setStatus({ phase: 'preparing' });
		let stream: MediaStream;
		try {
			// Electron asks for the microphone once (the core window allows `media`).
			stream = await targetWindow.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
		} catch (error) {
			if (generation === this._generation) {
				this.fail(localize('claudeVoiceNoMicrophone', "Klawly could not open the microphone. Check that one is connected and that Klawly may use it."), error);
			}
			return;
		}
		if (generation !== this._generation) {
			stream.getTracks().forEach(track => track.stop());
			return;
		}
		try {
			// Resolves at once: the service keeps the audio while the model downloads or loads.
			await this._local.start({ cacheDir: this.modelFolder().fsPath });
			const capture = await this.openCapture(targetWindow, stream);
			if (generation !== this._generation) {
				this.closeCapture(capture);
				return;
			}
			this._capture = capture;
			const model = await this._local.getModelStatus();
			// Read the getter: the model events may have moved the status on while we awaited.
			if (generation === this._generation && this.status.phase === 'preparing' && model.state === LocalTranscriptionModelState.Ready) {
				this.setStatus({ phase: 'listening' });
			}
		} catch (error) {
			stream.getTracks().forEach(track => track.stop());
			if (generation === this._generation) {
				this.fail(localize('claudeVoiceStartFailed', "Voice input could not start."), error);
			}
		}
	}

	async stop(): Promise<string> {
		const capture = this._capture;
		if (this._status.phase !== 'listening' && this._status.phase !== 'preparing') {
			return '';
		}
		const generation = ++this._generation;
		this.setStatus({ phase: 'transcribing' });
		if (capture) {
			// Send the audio still in the worklet before the service finalizes.
			await capture.flush();
		}
		this.releaseCapture();
		try {
			const text = await this._local.stop();
			if (generation === this._generation) {
				this._onDidTranscribe.fire({ text, isFinal: true });
				this.setStatus(CLAUDE_VOICE_IDLE);
			}
			return text;
		} catch (error) {
			if (generation === this._generation) {
				this.fail(localize('claudeVoiceStopFailed', "The dictation could not be transcribed."), error);
			}
			return '';
		}
	}

	async cancel(): Promise<void> {
		const active = this._status.phase !== 'idle';
		this._generation++;
		this.releaseCapture();
		this.setStatus(CLAUDE_VOICE_IDLE);
		if (active) {
			await this._local.cancel();
		}
	}

	async deleteModel(): Promise<void> {
		await this.cancel();
		for (const folder of [this.modelFolder(), joinPath(this._environment.cacheHome, RUNTIME_FOLDER)]) {
			if (await this._files.exists(folder)) {
				await this._files.del(folder, { recursive: true });
			}
		}
	}

	override dispose(): void {
		this._generation++;
		this.releaseCapture();
		super.dispose();
	}

	private modelFolder() {
		return joinPath(this._environment.cacheHome, MODEL_FOLDER);
	}

	private async openCapture(targetWindow: Window & typeof globalThis, stream: MediaStream): Promise<ClaudeVoiceCapture> {
		const context = new targetWindow.AudioContext({ sampleRate: SAMPLE_RATE });
		// The context is created after several awaits, so it can start suspended.
		context.resume().catch(() => { /* the worklet then posts nothing and the dictation stays empty */ });
		const source = context.createMediaStreamSource(stream);
		const gate = { open: true };
		let node: IPcmCaptureNode;
		try {
			node = await createPcmCaptureNode(targetWindow, context, CHUNK_SIZE, samples => {
				if (gate.open) {
					this._local.pushAudio(encodePcm16(samples)).catch(error => this._log.warn('[claude-voice] audio push failed', error));
				}
			});
		} catch (error) {
			context.close().catch(() => { /* already closed */ });
			throw error;
		}
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		analyser.smoothingTimeConstant = 0.75;
		source.connect(analyser);
		analyser.connect(node.node);
		node.node.connect(context.destination);
		return { context, stream, analyser, samples: new Uint8Array(analyser.fftSize), flush: node.flush, gate };
	}

	private releaseCapture(): void {
		const capture = this._capture;
		this._capture = undefined;
		if (capture) {
			this.closeCapture(capture);
		}
	}

	private closeCapture(capture: ClaudeVoiceCapture): void {
		capture.gate.open = false;
		capture.stream.getTracks().forEach(track => track.stop());
		capture.context.close().catch(() => { /* already closed */ });
	}

	private fail(message: string, error?: unknown): void {
		if (error !== undefined) {
			this._log.warn(`[claude-voice] ${message}`, error);
		}
		this._generation++;
		this.releaseCapture();
		this._local.cancel().catch(() => { /* nothing to cancel */ });
		this.setStatus({ phase: 'error', error: message });
	}

	private setStatus(status: ClaudeVoiceStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}
}

/** Little-endian PCM16 from float samples in [-1, 1]. */
function encodePcm16(samples: Float32Array): VSBuffer {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
	}
	return VSBuffer.wrap(bytes);
}

registerSingleton(IClaudeVoiceInputService, ClaudeVoiceInputService, InstantiationType.Delayed);
