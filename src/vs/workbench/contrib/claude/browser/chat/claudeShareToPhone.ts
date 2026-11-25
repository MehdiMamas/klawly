/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { claudeQrCodeSvg } from '../../../../../platform/claude/common/claudeQrCode.js';
import { CLAUDE_SHARE_TO_PHONE_COMMAND_ID, CLAUDE_STOP_SHARING_TO_PHONE_COMMAND_ID, claudeRemoteControlName, ClaudeRemoteControlState } from '../../../../../platform/claude/common/claudeRemoteControl.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { CLAUDE_AGENT_ENABLED } from '../../common/claudeContextKeys.js';
import { KLAWLY_CATEGORY } from '../../common/claudeViews.js';

/**
 * Share to Phone (issue 517): Claude Code's Remote Control on the current chat.
 * Claude Code connects the running session to the user's Claude account, so
 * the Claude app and claude.ai/code list it and can send it messages; Klawly
 * runs no relay. Tool permissions still ask in Klawly. The confirmation is a
 * dialog and the outcome a notification with the link (DL-23); the words are
 * Claude Code's (DL-11).
 */
class ClaudeShareToPhone {

	constructor(
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClipboardService private readonly _clipboard: IClipboardService,
		@IDialogService private readonly _dialogs: IDialogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IOpenerService private readonly _opener: IOpenerService,
	) { }

	/** Starts Remote Control on the current chat, or shows the link again when it is already on. */
	async share(): Promise<void> {
		const runtimeId = this.runtimeSessionId();
		if (!runtimeId || !await this.supported()) {
			return;
		}
		const current = await this._runtime.getRemoteControl?.(runtimeId).catch(() => undefined);
		if (current?.enabled) {
			this.showShared(runtimeId, current);
			return;
		}
		const { confirmed } = await this._dialogs.confirm({
			type: Severity.Info,
			message: localize('claudeShareToPhoneTitle', "Share This Chat to Your Phone?"),
			detail: localize('claudeShareToPhoneDetail', "Claude Code's Remote Control connects this chat to your Claude account. The Claude app and claude.ai/code then list it, show what Claude does and can send it messages. Tool permissions still ask here in Klawly.\n\nSharing stops when you stop it, or when Klawly quits. If the chat restarts, Klawly shares it again."),
			primaryButton: localize({ key: 'claudeShareToPhoneRun', comment: ['&& denotes a mnemonic'] }, "&&Share"),
		});
		if (!confirmed) {
			return;
		}
		let state: ClaudeRemoteControlState;
		try {
			if (!this._runtime.setRemoteControl) {
				throw new Error(localize('claudeShareToPhoneNoRuntime', "This Claude runtime cannot start Remote Control."));
			}
			state = await this._runtime.setRemoteControl(runtimeId, true, claudeRemoteControlName(this._agent.getCurrentSession()?.title));
		} catch (error) {
			this._notifications.error(localize('claudeShareToPhoneFailed', "Claude Code could not start Remote Control: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		this.showShared(runtimeId, state);
	}

	/** Stops Remote Control on the current chat. */
	async stop(): Promise<void> {
		const runtimeId = this.runtimeSessionId();
		if (runtimeId) {
			await this.stopSession(runtimeId);
		}
	}

	private async stopSession(runtimeId: string): Promise<void> {
		try {
			await this._runtime.setRemoteControl?.(runtimeId, false);
		} catch (error) {
			this._notifications.error(localize('claudeStopSharingFailed', "Claude Code could not stop Remote Control: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}
		this._notifications.info(localize('claudeStopSharingDone', "This chat is no longer shared to your phone."));
	}

	/** Where to find the shared chat, with the link to open or copy and a way to stop. */
	private showShared(runtimeId: string, state: ClaudeRemoteControlState): void {
		const url = state.sessionUrl ?? state.connectUrl;
		const choices: IPromptChoice[] = [];
		if (url) {
			choices.push({
				label: localize('claudeShareToPhoneOpen', "Open Link"),
				run: () => this._opener.open(URI.parse(url), { openExternal: true }),
			}, {
				label: localize('claudeShareToPhoneCopy', "Copy Link"),
				run: () => this._clipboard.writeText(url),
			});
			if (claudeQrCodeSvg(url)) {
				choices.push({
					label: localize('claudeShareToPhoneQr', "Show QR Code"),
					run: () => this.showQrCode(url),
				});
			}
		}
		choices.push({
			label: localize('claudeShareToPhoneStop', "Stop Sharing"),
			run: () => this.stopSession(runtimeId),
		});
		const message = state.name
			? localize('claudeSharedNamed', "\"{0}\" is shared to your phone. Open the Claude app and find it in your Claude Code sessions, or open the link on any device signed in to your Claude account.", state.name)
			: localize('claudeShared', "This chat is shared to your phone. Open the Claude app and find it in your Claude Code sessions, or open the link on any device signed in to your Claude account.");
		this._notifications.prompt(Severity.Info, message, choices, { sticky: true });
	}

	/** The link as a QR code in a dialog, so a phone camera can open it (issue 863). Dark on white in every theme. */
	private async showQrCode(url: string): Promise<void> {
		const svg = claudeQrCodeSvg(url, 6);
		if (!svg) {
			return;
		}
		const image = `![${localize('claudeShareToPhoneQrAlt', "QR code for the link to this chat")}](data:image/svg+xml;base64,${encodeBase64(VSBuffer.fromString(svg))})`;
		await this._dialogs.prompt({
			type: Severity.Info,
			message: localize('claudeShareToPhoneQrTitle', "Scan With Your Phone"),
			detail: localize('claudeShareToPhoneQrDetail', "Point your phone's camera at the code to open this chat in the Claude app. Your Claude account has to be signed in on the phone."),
			buttons: [{ label: localize('claudeShareToPhoneQrDone', "Done"), run: () => undefined }],
			cancelButton: true,
			custom: { markdownDetails: [{ markdown: new MarkdownString(image) }] },
		});
	}

	/** The running Claude Code session behind the current chat. Remote Control needs one. */
	private runtimeSessionId(): string | undefined {
		const session = this._agent.getCurrentSession();
		const runtimeId = session && this._agent.getRuntimeSessionId(session.id);
		if (!runtimeId) {
			this._notifications.info(localize('claudeShareToPhoneNoSession', "Remote Control shares a running chat. Send a message first, then share it."));
		}
		return runtimeId;
	}

	/** False, after saying so, when `claude --help` lists no Remote Control. An unreadable help lets Claude Code answer instead. */
	private async supported(): Promise<boolean> {
		const capability = await this._runtime.getCloudCapability?.().catch(() => undefined);
		if (capability?.binary && !capability.error && capability.remoteControl === false) {
			this._notifications.error(localize('claudeShareToPhoneNeedsUpdate', "Claude Code {0} has no Remote Control. Update Claude Code, then try again.", capability.version ?? ''));
			return false;
		}
		return true;
	}
}

/** Klawly: Share to Phone and Stop Sharing to Phone, from the command palette and the chat's More menu. */
export function registerClaudeShareToPhone(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SHARE_TO_PHONE_COMMAND_ID,
				title: { ...localize2('klawlyShareToPhone', "Share Chat to Phone..."), original: 'Share Chat to Phone... (Remote Control, Phone, Mobile)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IInstantiationService).createInstance(ClaudeShareToPhone).share();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_STOP_SHARING_TO_PHONE_COMMAND_ID,
				title: localize2('klawlyStopSharingToPhone', "Stop Sharing Chat to Phone"),
				category: KLAWLY_CATEGORY,
				f1: true,
				precondition: CLAUDE_AGENT_ENABLED,
			});
		}

		run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IInstantiationService).createInstance(ClaudeShareToPhone).stop();
		}
	});
}
