/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { ClaudeElicitationContent, ClaudeElicitationValue } from '../../../../platform/claude/common/claudeElicitation.js';
import { CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING, readClaudeScanAttachments } from '../../../../platform/claude/common/claudeConfiguration.js';
import { AgentEnvelope } from '../../../../platform/claude/common/claudePrompt.js';
import { countEnvelopeSecrets, removeClaudeSecrets, removeEnvelopeSecrets, scanClaudeSecrets } from '../../../../platform/claude/common/claudeSecretScan.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

type SecretChoice = 'send' | 'remove' | 'cancel';

/**
 * Runs the attachment secret scan before a send (master plan section 41).
 * Returns the envelope to compile: unchanged when nothing was found, the scan is
 * off, or the user chose Send Anyway; with each secret replaced by `[redacted]`
 * for Remove Secrets. Returns undefined for Cancel, and the caller must not send.
 */
export async function screenClaudeAttachmentSecrets(envelope: AgentEnvelope, dialogs: IDialogService, configuration: IConfigurationService): Promise<AgentEnvelope | undefined> {
	if (!readClaudeScanAttachments(configuration.getValue(CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING))) {
		return envelope;
	}
	const count = countEnvelopeSecrets(envelope);
	if (count === 0) {
		return envelope;
	}
	const { result } = await dialogs.prompt<SecretChoice>({
		type: Severity.Warning,
		message: count === 1
			? localize('claudeSecretFoundOne', "This attachment appears to contain 1 secret.")
			: localize('claudeSecretFoundMany', "This attachment appears to contain {0} secrets.", count),
		detail: localize('claudeSecretFoundDetail', "Detection is a best effort: it can miss a secret or flag text that is not one. Remove Secrets replaces each match with [redacted] before sending."),
		buttons: [
			{ label: localize({ key: 'claudeSecretSendAnyway', comment: ['&& denotes a mnemonic'] }, "&&Send Anyway"), run: () => 'send' },
			{ label: localize({ key: 'claudeSecretRemove', comment: ['&& denotes a mnemonic'] }, "&&Remove Secrets"), run: () => 'remove' },
		],
		cancelButton: { label: localize('claudeSecretCancel', "Cancel"), run: () => 'cancel' },
	});
	switch (result) {
		case 'send':
			return envelope;
		case 'remove':
			return removeEnvelopeSecrets(envelope);
		default:
			return undefined;
	}
}

/**
 * Runs the same secret scan on an MCP form answer before it goes to the server
 * (issue 428, section 41). Returns the content to send: unchanged when nothing
 * was found, the scan is off, or the user chose Send Anyway; with each secret
 * replaced by `[redacted]` for Remove Secrets. Undefined for Cancel: the form
 * stays open and nothing is sent.
 */
export async function screenClaudeElicitationSecrets(content: ClaudeElicitationContent, server: string, dialogs: IDialogService, configuration: IConfigurationService): Promise<ClaudeElicitationContent | undefined> {
	if (!readClaudeScanAttachments(configuration.getValue(CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING))) {
		return content;
	}
	const texts = Object.values(content).flatMap(value => typeof value === 'string' ? [value] : typeof value === 'object' ? value : []);
	const count = texts.reduce((sum, text) => sum + scanClaudeSecrets(text).length, 0);
	if (count === 0) {
		return content;
	}
	const { result } = await dialogs.prompt<SecretChoice>({
		type: Severity.Warning,
		message: count === 1
			? localize('claudeElicitationSecretOne', "Your answer to {0} appears to contain 1 secret.", server)
			: localize('claudeElicitationSecretMany', "Your answer to {0} appears to contain {1} secrets.", server, count),
		detail: localize('claudeElicitationSecretDetail', "The answer goes to the MCP server and stays in this session. Detection is a best effort: it can miss a secret or flag text that is not one. Remove Secrets replaces each match with [redacted] before sending."),
		buttons: [
			{ label: localize({ key: 'claudeSecretSendAnyway', comment: ['&& denotes a mnemonic'] }, "&&Send Anyway"), run: () => 'send' },
			{ label: localize({ key: 'claudeSecretRemove', comment: ['&& denotes a mnemonic'] }, "&&Remove Secrets"), run: () => 'remove' },
		],
		cancelButton: { label: localize('claudeSecretCancel', "Cancel"), run: () => 'cancel' },
	});
	switch (result) {
		case 'send':
			return content;
		case 'remove': {
			const redact = (value: ClaudeElicitationValue): ClaudeElicitationValue => typeof value === 'string' ? removeClaudeSecrets(value) : typeof value === 'object' ? value.map(text => removeClaudeSecrets(text)) : value;
			return Object.fromEntries(Object.entries(content).map(([key, value]) => [key, redact(value)]));
		}
		default:
			return undefined;
	}
}
