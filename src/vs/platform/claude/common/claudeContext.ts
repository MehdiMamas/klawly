/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentMode = 'agent' | 'ask' | 'plan' | 'debug';

/** Line/column range, 1-based, inclusive start and exclusive end column. */
export interface SerializedRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

/** One problem carried on a diagnostics chip so send uses that snapshot, not a later read. */
export interface DiagnosticAttachmentItem {
	readonly uri?: string;
	readonly path?: string;
	readonly severity: string;
	readonly message: string;
	readonly line?: number;
	readonly column?: number;
	readonly source?: string;
	readonly code?: string;
}

/**
 * What a git-diff attachment covers. `branch` is the committed work since the
 * branch left its base (`ref` names the base, else the repository's own); `commit`
 * is one commit (`ref` is its id).
 */
export type GitDiffScope = 'working-tree' | 'staged' | 'all' | 'branch' | 'commit';

export type ContextAttachment =
	| { kind: 'file'; uri: string; range?: SerializedRange }
	| { kind: 'folder'; uri: string }
	| { kind: 'symbol'; uri: string; name: string; range: SerializedRange }
	| { kind: 'selection'; uri: string; range: SerializedRange; versionId: number }
	| { kind: 'diagnostics'; uri?: string; severity?: number[]; items?: readonly DiagnosticAttachmentItem[] }
	| { kind: 'git-diff'; scope: GitDiffScope; path?: string; ref?: string; title?: string }
	| { kind: 'terminal'; terminalId: number; lines: number; text?: string; title?: string }
	/** `name` is what the user knows the image by (issue 743); the stored copy has a generated name. */
	| { kind: 'image'; localUri: string; name?: string }
	/** `label` is set when the paste sits in the message as `[label]`, a pill, instead of a chip (issue 737). */
	| { kind: 'pasted-text'; id: string; text: string; lineCount: number; label?: string }
	| { kind: 'chat'; sessionId: string; subagentId?: string; turnRange?: [number, number]; scope: 'summary' | 'full'; asOfTurn: number; title?: string; workspaceId?: string; workspaceName?: string };

export interface ComposerSubmission {
	text: string;
	attachments: ContextAttachment[];
}

export interface ComposerState {
	text: string;
	mode: AgentMode;
	attachments: ContextAttachment[];
	queued: ComposerSubmission[];
}

/** A composer message held while a turn is running. */
export interface PendingInput {
	id: string;
	text: string;
	attachments: ContextAttachment[];
	behavior: 'queue' | 'steer';
	createdAt: number;
	/** What Claude gets when it differs from `text`: the message with its attachments. */
	compiled?: string;
}
