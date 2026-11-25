/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentEnvelope, ResolvedAttachment } from './claudePrompt.js';
import { CLAUDE_REDACTED, CLAUDE_SECRET_PATTERNS, ClaudeSecretSpan, findClaudeSecretSpans, replaceClaudeSecretSpans } from './claudeSecretPatterns.js';

/**
 * Secrets the attachment scanner finds in `text`, sorted by position and never
 * overlapping. Every pattern runs on the original text. When two patterns cover
 * the same characters, the one earlier in {@link CLAUDE_SECRET_PATTERNS} wins,
 * so an `sk-ant-` key inside an `.env` line counts once. Patterns marked
 * `logOnly` are skipped, and so is text that is already `[redacted]`.
 * Detection is a best effort and is never complete.
 */
export function scanClaudeSecrets(text: string): ClaudeSecretSpan[] {
	const kept: ClaudeSecretSpan[] = [];
	for (const entry of CLAUDE_SECRET_PATTERNS) {
		if (entry.logOnly) {
			continue;
		}
		for (const span of findClaudeSecretSpans(text, entry)) {
			if (entry.scanMinLength !== undefined && span.end - span.start < entry.scanMinLength) {
				continue;
			}
			if (text.slice(span.start, span.end) === CLAUDE_REDACTED) {
				continue;
			}
			if (!kept.some(other => span.start < other.end && other.start < span.end)) {
				kept.push(span);
			}
		}
	}
	return kept.sort((a, b) => a.start - b.start);
}

/** `text` with every secret {@link scanClaudeSecrets} finds replaced by `[redacted]`. */
export function removeClaudeSecrets(text: string): string {
	const spans = scanClaudeSecrets(text);
	return spans.length > 0 ? replaceClaudeSecretSpans(text, spans) : text;
}

/**
 * How many secrets the bulk content of a submission carries: file, symbol and
 * selection bodies, Git diffs, terminal output, pasted text, and the active
 * editor selection that goes with the prompt. The typed request, paths, chat
 * references and problem messages are not scanned.
 */
export function countEnvelopeSecrets(envelope: AgentEnvelope): number {
	let count = 0;
	for (const text of bulkTexts(envelope)) {
		count += scanClaudeSecrets(text).length;
	}
	return count;
}

/** The same submission with each secret in its bulk content replaced by `[redacted]`. */
export function removeEnvelopeSecrets(envelope: AgentEnvelope): AgentEnvelope {
	const selection = envelope.activeFile?.selection;
	return {
		...envelope,
		activeFile: envelope.activeFile && selection !== undefined ? { ...envelope.activeFile, selection: removeClaudeSecrets(selection) } : envelope.activeFile,
		attachments: envelope.attachments.map(removeAttachmentSecrets),
	};
}

function removeAttachmentSecrets(attachment: ResolvedAttachment): ResolvedAttachment {
	switch (attachment.kind) {
		case 'file':
			return attachment.content === undefined ? attachment : { ...attachment, content: removeClaudeSecrets(attachment.content) };
		case 'symbol':
		case 'selection':
			return { ...attachment, content: removeClaudeSecrets(attachment.content) };
		case 'git-diff':
			return { ...attachment, stat: removeClaudeSecrets(attachment.stat), patch: removeClaudeSecrets(attachment.patch) };
		case 'terminal':
			return { ...attachment, lines: removeClaudeSecrets(attachment.lines) };
		case 'pasted-text':
			return { ...attachment, text: removeClaudeSecrets(attachment.text) };
		default:
			return attachment;
	}
}

function* bulkTexts(envelope: AgentEnvelope): Iterable<string> {
	if (envelope.activeFile?.selection) {
		// The compiled prompt drops the active selection when a chip already carries it.
		const selection = envelope.activeFile.selection;
		if (!envelope.attachments.some(attachment => attachment.kind === 'selection' && attachment.content === selection)) {
			yield selection;
		}
	}
	for (const attachment of envelope.attachments) {
		switch (attachment.kind) {
			case 'file':
				if (attachment.content) {
					yield attachment.content;
				}
				break;
			case 'symbol':
			case 'selection':
				yield attachment.content;
				break;
			case 'git-diff':
				yield attachment.stat;
				yield attachment.patch;
				break;
			case 'terminal':
				yield attachment.lines;
				break;
			case 'pasted-text':
				yield attachment.text;
				break;
		}
	}
}
