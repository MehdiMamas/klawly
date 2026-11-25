/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { AgentMode, ContextAttachment, GitDiffScope, SerializedRange } from './claudeContext.js';
import { ActiveFileContext, AgentEnvelope, DiagnosticSummary, ResolvedAttachment, clipText } from './claudePrompt.js';

/** Reads the editor and IDE state that existed at send time. */
export interface ContextReaders {
	relativePath(uri: string): string;
	readText(uri: string): Promise<{ content: string; languageId?: string; versionId?: number; unsaved: boolean } | undefined>;
	readMarkers(uri: string | undefined, severity?: readonly number[]): Promise<readonly DiagnosticSummary[]>;
	readGit(scope: GitDiffScope, path?: string, ref?: string): Promise<{ stat: string; patch: string; truncated: boolean }>;
	readTerminal(terminalId: number, lines: number): Promise<{ title: string; text: string; truncated: boolean } | undefined>;
	activeEditor(): ActiveFileContext | undefined;
	workspaceRoot(): string;
	/** Klawly's plan folder for this user as an absolute path, read for Plan mode only. */
	planFolder?(): Promise<string>;
	readChat?(attachment: Extract<ContextAttachment, { kind: 'chat' }>, composerSessionId?: string): Promise<ResolvedAttachment>;
}

export async function resolveContextEnvelope(
	userText: string,
	mode: AgentMode,
	attachments: readonly ContextAttachment[],
	readers: ContextReaders,
	composerSessionId?: string,
): Promise<AgentEnvelope> {
	const resolved: ResolvedAttachment[] = [];
	const diagnostics: DiagnosticSummary[] = [];
	for (const attachment of attachments) {
		const next = await resolveOne(attachment, readers, composerSessionId);
		if (next.kind === 'diagnostics') {
			diagnostics.push(...next.items);
		}
		resolved.push(next);
	}
	const planFolder = mode === 'plan' ? await readers.planFolder?.() : undefined;
	return {
		userText,
		mode,
		workspaceRoot: readers.workspaceRoot(),
		activeFile: readers.activeEditor(),
		attachments: resolved,
		diagnostics,
		instructionFiles: [],
		...(planFolder ? { planFolder } : {}),
	};
}

async function resolveOne(attachment: ContextAttachment, readers: ContextReaders, composerSessionId?: string): Promise<ResolvedAttachment> {
	switch (attachment.kind) {
		case 'file': {
			const read = await readers.readText(attachment.uri);
			const clipped = clipText(read?.content ?? '');
			return {
				kind: 'file',
				path: readers.relativePath(attachment.uri),
				languageId: read?.languageId,
				content: read ? clipped.text : undefined,
				unsaved: read?.unsaved ?? false,
				truncated: clipped.truncated,
			};
		}
		case 'folder':
			return { kind: 'folder', path: readers.relativePath(attachment.uri) };
		case 'symbol': {
			const read = await readers.readText(attachment.uri);
			const content = sliceRange(read?.content, attachment.range);
			const clipped = clipText(content);
			return {
				kind: 'symbol',
				path: readers.relativePath(attachment.uri),
				name: attachment.name,
				range: attachment.range,
				content: clipped.text,
				truncated: clipped.truncated,
			};
		}
		case 'selection': {
			const read = await readers.readText(attachment.uri);
			const content = sliceRange(read?.content, attachment.range);
			const clipped = clipText(content);
			return {
				kind: 'selection',
				path: readers.relativePath(attachment.uri),
				languageId: read?.languageId,
				range: attachment.range,
				content: clipped.text,
				stale: read?.versionId !== undefined && read.versionId !== attachment.versionId,
				truncated: clipped.truncated,
			};
		}
		case 'diagnostics': {
			if (attachment.items) {
				return { kind: 'diagnostics', items: attachment.items.map(item => ({ ...item })) };
			}
			const items = await readers.readMarkers(attachment.uri, attachment.severity);
			return { kind: 'diagnostics', items };
		}
		case 'git-diff': {
			const git = await readers.readGit(attachment.scope, attachment.path, attachment.ref);
			return { kind: 'git-diff', scope: attachment.scope, ...(attachment.ref ? { ref: attachment.ref } : {}), stat: git.stat, patch: git.patch, truncated: git.truncated };
		}
		case 'terminal': {
			if (typeof attachment.text === 'string') {
				const clipped = clipText(attachment.text);
				return { kind: 'terminal', title: attachment.title ?? 'Terminal', lines: clipped.text, truncated: clipped.truncated };
			}
			const terminal = await readers.readTerminal(attachment.terminalId, attachment.lines);
			return {
				kind: 'terminal',
				title: terminal?.title ?? 'Terminal',
				lines: terminal?.text ?? '',
				truncated: terminal?.truncated ?? false,
			};
		}
		case 'image': {
			// Claude reads the image from disk, so it gets a path it can open, not a file URI (issue 744).
			const uri = URI.parse(attachment.localUri);
			return { kind: 'image', path: uri.scheme === 'file' ? uri.fsPath : attachment.localUri };
		}
		case 'pasted-text': {
			const clipped = clipText(attachment.text);
			return { kind: 'pasted-text', text: clipped.text, lineCount: attachment.lineCount, truncated: clipped.truncated, label: attachment.label };
		}
		case 'chat':
			if (!readers.readChat) {
				return {
					kind: 'chat',
					sessionId: attachment.sessionId,
					reference: {
						title: attachment.title ?? attachment.sessionId,
						sessionId: attachment.sessionId,
						turnStart: attachment.turnRange?.[0] ?? 1,
						turnEnd: attachment.turnRange?.[1] ?? attachment.asOfTurn,
						asOfTurn: attachment.asOfTurn,
						path: '',
						summary: '',
						scope: attachment.scope,
						deleted: true,
						otherWorkspace: false,
					},
				};
			}
			return readers.readChat(attachment, composerSessionId);
	}
}

/** `content` is the whole buffer. The range is 1-based, inclusive start, exclusive end column. */
export function sliceRange(content: string | undefined, range: SerializedRange): string {
	if (!content) {
		return '';
	}
	const lines = content.split(/\r?\n/);
	const start = Math.max(0, range.startLine - 1);
	const end = Math.max(start, range.endLine - 1);
	const selected = lines.slice(start, end + 1);
	if (selected.length === 0) {
		return '';
	}
	if (selected.length === 1) {
		return selected[0].slice(Math.max(0, range.startColumn - 1), Math.max(0, range.endColumn - 1));
	}
	const last = selected.length - 1;
	selected[0] = selected[0].slice(Math.max(0, range.startColumn - 1));
	selected[last] = selected[last].slice(0, Math.max(0, range.endColumn - 1));
	return selected.join('\n');
}

/** Line-by-line comparison. An insertion shifts every later line, so this is not a unified diff. */
export function formatLineAlignedDiff(path: string, before: string, after: string): string {
	if (before === after) {
		return `${path} unchanged`;
	}
	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');
	const hunks: string[] = ['line-aligned comparison, not a unified diff', `--- ${path}`, `+++ ${path}`];
	const limit = Math.min(Math.max(beforeLines.length, afterLines.length), 80);
	for (let index = 0; index < limit; index++) {
		if (beforeLines[index] !== afterLines[index]) {
			if (beforeLines[index] !== undefined) {
				hunks.push(`-${beforeLines[index]}`);
			}
			if (afterLines[index] !== undefined) {
				hunks.push(`+${afterLines[index]}`);
			}
		}
	}
	if (beforeLines.length > limit || afterLines.length > limit) {
		hunks.push('…');
	}
	return hunks.join('\n');
}
