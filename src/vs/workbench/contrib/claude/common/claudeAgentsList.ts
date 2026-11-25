/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { basename } from '../../../../base/common/path.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { BackgroundAgentStatus } from '../../../../platform/claude/common/claudeBackground.js';
import { ClaudeRunTarget } from '../../../../platform/claude/common/claudeCloud.js';
import { ClaudeExecutionTargetInfo, claudeExecutionTargetPhrase } from '../../../../platform/claude/common/claudeExecutionTarget.js';
import { hasPendingElicitation, TurnViewModel } from '../../../services/claude/common/claudeAgentState.js';
import { claudeAutoCostText } from './claudeAutoStatus.js';
import { claudeDepartmentSenderOf } from './claudeDepartmentCard.js';

/** What a row in the agents column says about its agent. */
export type ClaudeAgentRowState = 'running' | 'waiting' | 'failed' | 'stopped' | 'interrupted' | 'done' | 'idle';

/** Which agents the column lists. `cloud`: Claude Code cloud sessions started or messaged from Klawly (issue 532). */
export type ClaudeAgentsFilter = 'all' | 'local' | 'background' | 'cloud';

/** The facts the column needs about one session, read from the agent and background services. */
export interface ClaudeAgentRowInput {
	readonly id: string;
	readonly title: string;
	readonly updatedAt?: number;
	readonly workspaceName?: string;
	readonly interrupted?: boolean;
	readonly resumeFailed?: boolean;
	readonly turns: readonly TurnViewModel[];
	/** Set when the session is a background agent in its own worktree. */
	readonly background?: {
		readonly status: BackgroundAgentStatus;
		readonly filesChanged: number;
		readonly added: number;
		readonly removed: number;
	};
	/** Where Claude Code runs, when it is not this machine's workspace folder (issue 425). */
	readonly target?: ClaudeExecutionTargetInfo;
	/** Set when an automation started the background agent: the column lists its runs under it. */
	readonly automation?: {
		readonly key: string;
		readonly name: string;
		readonly icon: ThemeIcon;
	};
	/** Set when the chat is a project's coordinator or one of the agents it started (issue 899): the column lists it under the project. */
	readonly project?: {
		readonly key: string;
		readonly name: string;
	};
	/** The machine a synced session came from, when it was imported from another machine (issue 448). */
	readonly importedFrom?: string;
	/** `cloud` for a Claude Code cloud session Klawly started or messaged (issue 532); absent is local. */
	readonly runTarget?: ClaudeRunTarget;
	/** The cloud session's ID, when Klawly knows it. */
	readonly cloudSessionId?: string;
	/** Set when another project handed the chat its work (issue 1459, DL-121): when, and whether the user opened it yet. */
	readonly handoff?: { readonly at: number; readonly read: boolean };
	/** Set when Auto runs the chat (DL-109, DL-110): the row's second line gains the model and the live cost, and Failed says why. */
	readonly auto?: {
		readonly modelLabel?: string;
		readonly costUsd?: number;
		readonly failureReason?: string;
	};
}

export interface ClaudeAgentRow {
	readonly id: string;
	readonly title: string;
	readonly state: ClaudeAgentRowState;
	/** The second line: what the agent is doing now, or what it left behind. */
	readonly subtitle: string | undefined;
	readonly updatedAt: number;
	readonly background: boolean;
	/** The machine an imported session came from; the row shows a small badge naming it (issue 448). */
	readonly machine?: string;
	/** Set only for a cloud session's row, which shows the cloud icon (issue 532). */
	readonly runTarget?: 'cloud';
	/** True for a hand-off the user has not opened yet (issue 1459, DL-121). */
	readonly unread?: boolean;
	/** When another project handed the chat its work; the Departments timeline sorts on it. */
	readonly handoffAt?: number;
}

export interface ClaudeAgentRowGroup {
	/** A day, `project:<key>` for one project's chats, or `automation:<key>` for one automation's runs. */
	readonly id: 'departments' | 'today' | 'yesterday' | 'week' | 'older' | `project:${string}` | `automation:${string}`;
	readonly label: string;
	/** An automation's trigger icon; day groups have none. */
	readonly icon?: ThemeIcon;
	/** The Departments group's count of chats waiting on the user (issue 1177, DL-118); absent when none. */
	readonly badge?: number;
	/** The Departments group's count of hand-offs the user has not opened yet (issue 1459, DL-121); absent when none. */
	readonly unread?: number;
	readonly rows: readonly ClaudeAgentRow[];
}

const DAY = 24 * 60 * 60 * 1000;

/** One row per session, live state first: a running or waiting agent counts as updated now. */
export function claudeAgentRow(input: ClaudeAgentRowInput, now: number): ClaudeAgentRow {
	if (input.runTarget === 'cloud') {
		// Klawly does not stream a cloud session, so its row says where it is, not what it does.
		return {
			id: input.id,
			title: input.title,
			state: 'idle',
			subtitle: input.cloudSessionId
				? localize('claudeAgentRowCloud', "Cloud session {0}", input.cloudSessionId)
				: localize('claudeAgentRowCloudStarted', "Cloud session, started in a terminal"),
			updatedAt: input.updatedAt ?? now,
			background: false,
			runTarget: 'cloud',
		};
	}
	const state = agentRowState(input);
	const live = state === 'running' || state === 'waiting';
	return {
		id: input.id,
		title: input.title,
		state,
		subtitle: withAutoPhrase(withTargetPhrase(agentRowSubtitle(input, state), input.target), input, state),
		updatedAt: live ? now : input.updatedAt ?? now,
		background: !!input.background,
		unread: input.handoff && !input.handoff.read ? true : undefined,
		handoffAt: input.handoff?.at,
		machine: input.importedFrom?.trim() || undefined,
	};
}

/** An imported session as a row input: a read-only row with the machine badge and no turns (issue 448). */
export function claudeImportedSessionInput(session: { readonly machine: string; readonly id: string; readonly title: string; readonly updatedAt: number }): ClaudeAgentRowInput {
	return {
		id: `imported:${session.id}`,
		title: session.title.trim() || localize('claudeAgentRowImportedUntitled', "Synced session"),
		updatedAt: session.updatedAt,
		turns: [],
		importedFrom: session.machine,
	};
}

/** The hover on a machine badge: names the machine a synced session came from (issue 448). */
export function claudeMachineBadgeHover(machine: string): string {
	return localize('claudeAgentRowMachineHover', "Synced from {0}", machine);
}

/** Issue 1220: the Auto part of a row. Only when Auto is on and the chat has a turn; Failed carries the turn's reason. */
export function claudeAgentRowAuto(turns: readonly TurnViewModel[], autoOn: boolean, modelLabel: string | undefined, costUsd: number | undefined): ClaudeAgentRowInput['auto'] {
	if (!autoOn || !turns.length) {
		return undefined;
	}
	return { modelLabel, costUsd, failureReason: turns.at(-1)?.failure?.message };
}

/** DL-109/DL-110: an Auto row reads "Failed: reason · Sonnet · $1.87"; Failed always gives its reason. */
function withAutoPhrase(subtitle: string | undefined, input: ClaudeAgentRowInput, state: ClaudeAgentRowState): string | undefined {
	if (!input.auto) {
		return subtitle;
	}
	const base = state === 'failed'
		? localize('claudeAgentRowAutoFailed', "Failed: {0}", input.auto.failureReason?.trim() || localize('claudeAgentRowAutoNoReason', "No reason was reported"))
		: subtitle;
	const cost = claudeAutoCostText(input.auto.costUsd);
	const parts = [base, input.auto.modelLabel?.trim(), cost].filter((part): part is string => !!part);
	return parts.length ? parts.join(localize('claudeAgentRowAutoSeparator', " · ")) : undefined;
}

function agentRowState(input: ClaudeAgentRowInput): ClaudeAgentRowState {
	const last = input.turns.at(-1);
	if (last?.status === 'running') {
		return last.permissions.some(permission => permission.state === 'pending') || hasPendingElicitation(last) ? 'waiting' : 'running';
	}
	switch (input.background?.status) {
		case 'starting':
		case 'running':
			return 'running';
		case 'waiting':
			return 'waiting';
		case 'failed':
			return 'failed';
	}
	if (input.interrupted) {
		return 'interrupted';
	}
	if (last?.status === 'failed' || input.resumeFailed) {
		return 'failed';
	}
	if (last?.status === 'stopped') {
		return 'stopped';
	}
	return last ? 'done' : 'idle';
}

/** The status line with where the agent runs after it ("Edited 2 files · on build-box"). */
function withTargetPhrase(subtitle: string | undefined, target: ClaudeExecutionTargetInfo | undefined): string | undefined {
	const phrase = claudeExecutionTargetPhrase(target);
	if (!phrase) {
		return subtitle;
	}
	return subtitle ? localize('claudeAgentRowWithTarget', "{0} · {1}", subtitle, phrase) : phrase;
}

function agentRowSubtitle(input: ClaudeAgentRowInput, state: ClaudeAgentRowState): string | undefined {
	switch (state) {
		case 'waiting': {
			// An MCP form or sign-in asks for input, not approval (issue 428).
			const last = input.turns.at(-1);
			return last && !last.permissions.some(permission => permission.state === 'pending') && hasPendingElicitation(last)
				? localize('claudeAgentRowWaitingInput', "Waiting for your input")
				: localize('claudeAgentRowWaiting', "Waiting for your approval");
		}
		case 'running':
			return input.background?.status === 'starting' ? localize('claudeAgentRowStarting', "Starting...") : currentWork(input.turns.at(-1));
		case 'failed':
			return localize('claudeAgentRowFailed', "Failed");
		case 'stopped':
			return localize('claudeAgentRowStopped', "Stopped");
		case 'interrupted':
			return localize('claudeAgentRowInterrupted', "Interrupted");
		case 'idle':
			return undefined;
	}
	if (input.background) {
		const { filesChanged, added, removed } = input.background;
		if (!filesChanged) {
			return localize('claudeAgentRowNoChanges', "No changes");
		}
		return filesChanged === 1
			// allow-any-unicode-next-line
			? localize('claudeAgentRowDiffOne', "+{0} −{1} · 1 file", added, removed)
			// allow-any-unicode-next-line
			: localize('claudeAgentRowDiffMany', "+{0} −{1} · {2} files", added, removed, filesChanged);
	}
	const files = new Set(input.turns.flatMap(turn => turn.changedFiles)).size;
	if (!files) {
		return undefined;
	}
	return files === 1
		? localize('claudeAgentRowEditedOne', "Edited 1 file")
		: localize('claudeAgentRowEditedMany', "Edited {0} files", files);
}

/** The icon a row shows for its state: a spinner while running, a bell while it waits for you. */
export function claudeAgentRowIcon(state: ClaudeAgentRowState, background: boolean): ThemeIcon {
	switch (state) {
		case 'running': return ThemeIcon.modify(Codicon.loading, 'spin');
		case 'waiting': return Codicon.bellDot;
		case 'failed': return Codicon.error;
		case 'stopped': return Codicon.circleSlash;
		case 'interrupted': return Codicon.warning;
		case 'done': return background ? Codicon.gitBranch : Codicon.check;
		default: return Codicon.commentDiscussion;
	}
}

/** The newest running tool, as the status lines say it: "Editing todo.ts", "Running npm test". */
function currentWork(turn: TurnViewModel | undefined): string {
	const card = turn?.cards.findLast(candidate => candidate.state === 'running');
	if (!card) {
		return localize('claudeAgentRowWorking', "Working...");
	}
	switch (card.kind) {
		case 'file':
		case 'edit':
			return `${card.verb} ${basename(card.file ?? card.target)}`;
		case 'command':
		case 'search':
		case 'web':
			return `${card.verb} ${card.target}`;
		default:
			return card.verb;
	}
}

/**
 * Filters the rows, newest first, into day groups, then one group per
 * automation for the runs it started, the one that ran last first. Search
 * looks at the title, the workspace, the first prompt and the automation.
 */
export function groupClaudeAgentRows(inputs: readonly ClaudeAgentRowInput[], now: number, query: string, filter: ClaudeAgentsFilter, order: readonly string[] = []): ClaudeAgentRowGroup[] {
	const needle = query.trim().toLowerCase();
	const matches = inputs
		.filter(input => matchesFilter(input, filter))
		.filter(input => !needle || `${input.title} ${input.workspaceName ?? ''} ${input.turns[0]?.user.text ?? ''} ${input.automation?.name ?? ''} ${input.project?.name ?? ''}`.toLowerCase().includes(needle))
		.map(input => ({ input, row: claudeAgentRow(input, now) }))
		.sort((a, b) => b.row.updatedAt - a.row.updatedAt);
	const isDepartment = (input: ClaudeAgentRowInput) => !input.automation && !input.project && input.runTarget !== 'cloud' && !!input.turns[0] && !!claudeDepartmentSenderOf(input.turns[0].user.text);
	const rows = matches.filter(match => !match.input.automation && !match.input.project && !isDepartment(match.input)).map(match => match.row);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const startOfToday = today.getTime();
	const buckets: { id: ClaudeAgentRowGroup['id']; label: string; from: number }[] = [
		{ id: 'today', label: localize('claudeAgentsToday', "Today"), from: startOfToday },
		{ id: 'yesterday', label: localize('claudeAgentsYesterday', "Yesterday"), from: startOfToday - DAY },
		{ id: 'week', label: localize('claudeAgentsWeek', "Previous 7 Days"), from: startOfToday - 7 * DAY },
		{ id: 'older', label: localize('claudeAgentsOlder', "Older"), from: Number.NEGATIVE_INFINITY },
	];
	const groups: ClaudeAgentRowGroup[] = [];
	// Chats another project handed work to sit on top, the ones waiting on the user first (issue 1177, DL-118).
	const departments = matches.filter(match => isDepartment(match.input)).map(match => match.row);
	if (departments.length) {
		const waiting = departments.filter(row => row.state === 'waiting');
		groups.push({
			id: 'departments',
			label: localize('claudeAgentsDepartments', "Departments"),
			icon: Codicon.organization,
			badge: waiting.length || undefined,
			rows: [...waiting, ...departments.filter(row => row.state !== 'waiting')].sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || (b.handoffAt ?? b.updatedAt) - (a.handoffAt ?? a.updatedAt)),
			unread: departments.filter(row => row.unread).length || undefined,
		});
	}
	for (const bucket of buckets) {
		const taken = rows.filter(row => row.updatedAt >= bucket.from && !groups.some(group => group.rows.includes(row)));
		if (taken.length) {
			groups.push({ id: bucket.id, label: bucket.label, rows: taken });
		}
	}
	const projects = new Map<string, { label: string; icon: ThemeIcon; rows: ClaudeAgentRow[] }>();
	for (const { input, row } of matches) {
		if (input.project && !input.automation) {
			const group = projects.get(input.project.key) ?? { label: input.project.name, icon: Codicon.project, rows: [] };
			projects.set(input.project.key, group);
			group.rows.push(row);
		}
	}
	for (const [key, group] of projects) {
		groups.push({ id: `project:${key}`, ...group });
	}
	const runs = new Map<string, { label: string; icon: ThemeIcon; rows: ClaudeAgentRow[] }>();
	for (const { input, row } of matches) {
		if (input.automation) {
			const { key, name, icon } = input.automation;
			let group = runs.get(key);
			if (!group) {
				group = { label: name, icon, rows: [] };
				runs.set(key, group);
			}
			group.rows.push(row);
		}
	}
	for (const [key, group] of runs) {
		groups.push({ id: `automation:${key}`, ...group });
	}
	return order.length ? groups.map(group => ({ ...group, rows: applyClaudeAgentRowOrder(group.rows, order) })) : groups;
}

/**
 * Puts the rows the user placed in the order they left them (issue 977, DL-104).
 * Rows with no remembered place keep their recency order and stay above the
 * placed ones, so a new chat shows at the top of its group.
 */
export function applyClaudeAgentRowOrder(rows: readonly ClaudeAgentRow[], order: readonly string[]): ClaudeAgentRow[] {
	const placed = rows.filter(row => order.includes(row.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	return [...rows.filter(row => !order.includes(row.id)), ...placed];
}

/**
 * The remembered order after `movedId` moves before `beforeId` (or to the end
 * when that is undefined) among `groupIds`, the rows of one group as shown.
 * Only that group's ids change place; every other remembered id stays as it was.
 */
export function moveClaudeAgentRow(order: readonly string[], groupIds: readonly string[], movedId: string, beforeId: string | undefined): string[] {
	if (movedId === beforeId || !groupIds.includes(movedId)) {
		return [...order];
	}
	const rest = groupIds.filter(id => id !== movedId);
	const at = beforeId ? rest.indexOf(beforeId) : -1;
	rest.splice(at < 0 ? rest.length : at, 0, movedId);
	return [...order.filter(id => !groupIds.includes(id)), ...rest];
}

function matchesFilter(input: ClaudeAgentRowInput, filter: ClaudeAgentsFilter): boolean {
	const cloud = input.runTarget === 'cloud';
	switch (filter) {
		case 'local': return !cloud && !input.background && !input.importedFrom;
		case 'background': return !!input.background;
		case 'cloud': return cloud;
		default: return true;
	}
}

/** Where the agent pane lists its sessions: as tabs on top (the default) or also in the agents sidebar on the right (issue 98). */
export const CLAUDE_SESSION_LIST_LOCATION_SETTING = 'claude.agents.sessionListLocation';

/** Shows or hides the agents sidebar by flipping {@link CLAUDE_SESSION_LIST_LOCATION_SETTING}. */
export const CLAUDE_TOGGLE_AGENTS_SIDEBAR_COMMAND_ID = 'claude.toggleAgentsSidebar';

/** `top`: session tabs only. `side`: the agents sidebar too, when the pane is wide enough. */
export type ClaudeSessionListLocation = 'top' | 'side';

/** Reads the session list location from a raw setting value; anything but `side` is `top`. */
export function readClaudeSessionListLocation(value: unknown): ClaudeSessionListLocation {
	return value === 'side' ? 'side' : 'top';
}
