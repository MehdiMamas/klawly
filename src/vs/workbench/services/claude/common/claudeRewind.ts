/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentReducerEvent, AgentViewState, TurnViewModel } from './claudeAgentState.js';
import { CheckpointChange } from './claudeCheckpointService.js';
import { buildTurnReview, ReviewFile } from './claudeReview.js';

/**
 * Where a rewind resumes Claude Code (issue 702): a copy of `claudeSessionId` cut
 * after `anchor`. Both are absent when the chat goes back to its first message,
 * which starts a new conversation.
 */
export interface ClaudeRewindTarget {
	readonly claudeSessionId?: string;
	readonly anchor?: string;
}

export type ClaudeRewindCheck =
	| { readonly enabled: true; readonly target: ClaudeRewindTarget }
	| { readonly enabled: false; readonly reason: string };

/**
 * Whether the chat can go back to this turn's message, and where Claude Code then
 * resumes. The turn before it must have finished with a reply Claude Code saved
 * (stopped and failed turns are skipped back to the last one that did),
 * and no compaction may have happened since this message was sent.
 */
export function claudeRewindCheck(events: readonly AgentReducerEvent[], state: AgentViewState, turnId: string): ClaudeRewindCheck {
	const index = state.turns.findIndex(turn => turn.id === turnId);
	if (index < 0) {
		return { enabled: false, reason: localize('claudeRewindMissing', "That message is no longer in the chat.") };
	}
	let sent = -1;
	for (let position = events.length - 1; position >= 0; position--) {
		const event = events[position];
		if (event.type === 'turn.submitted' && event.turnId === turnId) {
			sent = position;
			break;
		}
	}
	if (sent >= 0 && events.slice(sent).some(event => event.type === 'session.compacted' && event.parentRunId === undefined)) {
		return { enabled: false, reason: localize('claudeRewindCompacted', "The chat was compacted after this message, so it can't go back to it.") };
	}
	if (index === 0) {
		return { enabled: true, target: {} };
	}
	// Stopped and failed turns save no point, so the chat resumes at the last reply before them.
	let back = index - 1;
	while (back >= 0 && !state.turns[back].anchor && (state.turns[back].status === 'stopped' || state.turns[back].status === 'failed')) {
		back--;
	}
	if (back < 0) {
		return { enabled: true, target: {} };
	}
	const previous = state.turns[back];
	if (!previous.anchor) {
		return {
			enabled: false,
			reason: previous.status === 'complete'
				? noPoint()
				: localize('claudeRewindUnfinished', "Claude didn't finish the reply before this message, so the chat can't go back to it."),
		};
	}
	let claudeSessionId: string | undefined;
	for (const event of events) {
		if (event.type === 'session.started' && event.parentRunId === undefined && event.claudeSessionId) {
			claudeSessionId = event.claudeSessionId;
		} else if (event.type === 'session.completed' && event.parentRunId === undefined && event.anchor === previous.anchor) {
			return claudeSessionId
				? { enabled: true, target: { claudeSessionId, anchor: previous.anchor } }
				: { enabled: false, reason: noPoint() };
		}
	}
	return { enabled: false, reason: noPoint() };
}

function noPoint(): string {
	return localize('claudeRewindNoPoint', "Claude Code saved no point to go back to after the reply before this message. Replies handed to another chat, and chats from before this feature, can't be edited.");
}

/** The note after a file in the rewind list that a helper chat wrote, naming its model (issue 1406). */
export function claudeRewindHelperLabel(modelName: string | undefined): string {
	return modelName ? localize('claudeRewindHelperFile', "  (helper, {0})", modelName) : localize('claudeRewindHelperFileNoModel', "  (helper)");
}

/** The ids of the turn and every later one: the turns a rewind to it drops. */
export function claudeRewindTurnIds(state: AgentViewState, turnId: string): string[] {
	const index = state.turns.findIndex(turn => turn.id === turnId);
	return index < 0 ? [] : state.turns.slice(index).map(turn => turn.id);
}

/**
 * The hidden note sent ahead of the edited message when the user keeps the files
 * the dropped turns changed. Claude reads it; the chat does not show it.
 */
export function claudeRewindNote(paths: readonly string[]): string | undefined {
	if (paths.length === 0) {
		return undefined;
	}
	return `The user went back and edited an earlier message. Files changed after it are still on disk: ${paths.join(', ')}. Treat them as they are now; don't assume the dropped turns happened.`;
}

/** Files whose text now differs from before the dropped turns, with lines added and removed. */
export function claudeRewindFiles(sessionId: string, turnId: string, changes: readonly CheckpointChange[]): readonly ReviewFile[] {
	return buildTurnReview(sessionId, turnId, changes.map(change => ({
		uri: URI.parse(change.uri),
		originalText: change.originalText,
		modifiedText: change.currentText,
		existed: change.existed,
	}))).files;
}

/**
 * Whether a turn has shown nothing yet: no reply text, thinking, tool, question,
 * delegated chat or steered message. Stop on such a turn gives the message back
 * to the composer (issue 948).
 */
export function claudeTurnHasNoOutput(turn: TurnViewModel): boolean {
	return !turn.assistantText.trim()
		&& (turn.parts?.length ?? 0) === 0
		&& turn.cards.length === 0
		&& turn.permissions.length === 0
		&& (turn.elicitations?.length ?? 0) === 0
		&& (turn.delegates?.length ?? 0) === 0
		&& turn.steered.length === 0
		&& !turn.failure;
}

/** Files a rewind would restore, split by who changed them (issue 818). */
export interface ClaudeRewindGroups {
	/** Changed by this chat's own turns: selected by default. */
	readonly own: readonly ReviewFile[];
	/** Changed by other chats too: listed apart and unselected by default. */
	readonly others: readonly ReviewFile[];
	/** The paths in `others` that a helper chat Claude started also wrote (issue 1054). */
	readonly helperPaths: ReadonlySet<string>;
}

/**
 * Splits the changed files into this chat's and those other chats also wrote.
 * `otherChatPaths` holds the file paths other chats' turns changed, and
 * `helperChatPaths` the part of them that helper (delegated) chats changed.
 */
export function claudeRewindGroups(files: readonly ReviewFile[], otherChatPaths: ReadonlySet<string>, helperChatPaths: ReadonlySet<string> = new Set<string>()): ClaudeRewindGroups {
	const own: ReviewFile[] = [];
	const others: ReviewFile[] = [];
	for (const file of files) {
		(otherChatPaths.has(file.uri.fsPath) ? others : own).push(file);
	}
	return { own, others, helperPaths: new Set(others.map(file => file.uri.fsPath).filter(path => helperChatPaths.has(path))) };
}

/** The checkpoint URIs to restore after the user's per-file choice; the rest stay as they are. */
export function claudeRewindSelection(groups: ClaudeRewindGroups, picked: ReadonlySet<string>): { readonly restore: readonly string[]; readonly keep: readonly string[] } {
	const restore: string[] = [];
	const keep: string[] = [];
	for (const file of [...groups.own, ...groups.others]) {
		(picked.has(file.uri.toString()) ? restore : keep).push(file.uri.toString());
	}
	return { restore, keep };
}

/** One row of the "Files to Undo" picker (issue 1060): every file starts ticked. */
export interface ClaudeRewindPickItem {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly detail: string;
	/** Ticked unless another chat also changed the file (issue 1054). */
	readonly picked: boolean;
}

/**
 * The "Files to Undo" picker rows, with a plain `+added -removed` count per file (issue 1060).
 * Files other chats also changed come last, unticked and marked (issue 1054).
 */
export function claudeRewindPickItems(groups: ClaudeRewindGroups): readonly ClaudeRewindPickItem[] {
	const row = (file: ReviewFile, shared: boolean): ClaudeRewindPickItem => ({
		id: file.uri.toString(),
		label: file.name,
		description: file.directory,
		detail: shared
			? (groups.helperPaths.has(file.uri.fsPath)
				? localize('claudeRewindPickDetailHelper', "+{0} -{1}  Also changed by a helper chat", file.added, file.removed)
				: localize('claudeRewindPickDetailShared', "+{0} -{1}  Also changed by another chat", file.added, file.removed))
			: localize('claudeRewindPickDetail', "+{0} -{1}", file.added, file.removed),
		picked: !shared,
	});
	return [...groups.own.map(file => row(file, false)), ...groups.others.map(file => row(file, true))];
}

export interface ClaudeRewindCommit {
	readonly hash: string;
	readonly subject: string;
}

/** The dialog text that lists the commits made after the message; they are not undone, only named (issue 1054). */
export function claudeRewindCommitsNote(commits: readonly ClaudeRewindCommit[]): string {
	if (commits.length === 0) {
		return '';
	}
	const shown = commits.slice(0, 5).map(commit => `${commit.hash.slice(0, 7)}  ${commit.subject}`);
	const more = commits.length - shown.length;
	return '\n\n' + localize('claudeRewindCommits', "Commits made since this message stay in git:") + '\n' + shown.join('\n')
		+ (more > 0 ? '\n' + localize('claudeRewindCommitsMore', "and {0} more", more) : '');
}

/** Parses `git log --format=%H%x09%s` output (newest first) into commits. */
export function parseClaudeRewindCommits(output: string): readonly ClaudeRewindCommit[] {
	const commits: ClaudeRewindCommit[] = [];
	for (const line of output.split(/\r?\n/)) {
		const tab = line.indexOf('\t');
		const hash = (tab < 0 ? line : line.slice(0, tab)).trim();
		if (/^[0-9a-f]{7,64}$/i.test(hash)) {
			commits.push({ hash, subject: tab < 0 ? '' : line.slice(tab + 1).trim() });
		}
	}
	return commits;
}

/** The `git log` arguments listing the commits made after a turn's checkpoint HEAD. */
export function claudeRewindCommitsArgs(gitHeadAtTurn: string): string[] {
	return ['log', '--format=%H%x09%s', `${gitHeadAtTurn}..HEAD`];
}

/** The `git status` arguments whose output `claudeShellChangedFiles` compares (issue 1054). */
export function claudeRewindStatusArgs(): string[] {
	return ['status', '--porcelain=v1', '--untracked-files=all'];
}

/** Parses `git status --porcelain=v1` output into a map of path to its two-letter status. */
function parseClaudeRewindStatus(output: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		if (line.length < 4) {
			continue;
		}
		const rest = line.slice(3);
		const arrow = rest.indexOf(' -> ');
		result.set(arrow < 0 ? rest : rest.slice(arrow + 4), line.slice(0, 2));
	}
	return result;
}

/**
 * Files a shell command changed (issue 1054): paths whose `git status` entry is new or
 * different after the command, plus files that were dirty before and are clean now.
 * Sorted; paths are repo relative with forward slashes.
 */
export function claudeShellChangedFiles(statusBefore: string, statusAfter: string): readonly string[] {
	const before = parseClaudeRewindStatus(statusBefore);
	const after = parseClaudeRewindStatus(statusAfter);
	const changed = new Set<string>();
	for (const [path, status] of after) {
		if (before.get(path) !== status) {
			changed.add(path);
		}
	}
	for (const path of before.keys()) {
		if (!after.has(path)) {
			changed.add(path);
		}
	}
	return [...changed].sort();
}
