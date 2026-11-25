/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { AgentReducerEvent, AgentViewState, EMPTY_AGENT_VIEW_STATE, reduceAgentState, SubagentViewModel, turnParts, TurnViewModel } from '../../../services/claude/common/claudeAgentState.js';
import { claudeSubagentKindLabel } from './claudeCommandMirror.js';

export type ClaudeChatOutlineKind = 'prompt' | 'plan' | 'todos' | 'edit' | 'subagent';

/**
 * One entry of a chat's outline (issue 433). Prompts are the top level; the
 * plan, to-do updates, file edits and subagents of a turn sit under its prompt,
 * and a subagent's own subagents under it.
 */
export interface ClaudeChatOutlineNode {
	/** Unique in the chat and stable while the chat grows. */
	readonly id: string;
	readonly kind: ClaudeChatOutlineKind;
	readonly label: string;
	readonly description?: string;
	/** The turn to scroll to. */
	readonly turnId: string;
	/** What to scroll to inside the turn: a tool card id or a subagent run id. Unset for the turn itself. */
	readonly targetId?: string;
	/** Position in the chat, depth first. */
	readonly order: number;
	readonly children: readonly ClaudeChatOutlineNode[];
}

const PROMPT_LABEL_MAX = 80;

/** The outline of a chat from its normalized events, in the order they came. */
export function claudeChatOutlineFromEvents(events: readonly AgentReducerEvent[]): ClaudeChatOutlineNode[] {
	return claudeChatOutline(events.reduce(reduceAgentState, EMPTY_AGENT_VIEW_STATE));
}

/** The outline of a chat from the view state its events reduce to. */
export function claudeChatOutline(state: AgentViewState): ClaudeChatOutlineNode[] {
	let order = 0;
	const runs = new Map(state.subagents.map(subagent => [subagent.run.id, subagent]));

	const subagentNode = (subagent: SubagentViewModel, turnId: string): ClaudeChatOutlineNode => {
		const own = order++;
		const children = state.subagents
			.filter(child => child.run.parentRunId === subagent.run.id)
			.map(child => subagentNode(child, turnId));
		return {
			id: `subagent:${subagent.run.id}`,
			kind: 'subagent',
			label: oneLine(subagent.run.description) || claudeSubagentKindLabel(subagent.run.agentType),
			description: claudeSubagentKindLabel(subagent.run.agentType),
			turnId,
			targetId: subagent.run.id,
			order: own,
			children,
		};
	};

	const turnNode = (turn: TurnViewModel, index: number): ClaudeChatOutlineNode => {
		const own = order++;
		const cards = new Map(turn.cards.map(card => [card.id, card]));
		const edited = new Set<string>();
		const children: ClaudeChatOutlineNode[] = [];
		for (const part of turnParts(turn)) {
			if (part.kind === 'plan' && turn.plan) {
				children.push({ id: `plan:${turn.id}:${part.id}`, kind: 'plan', label: localize('claudeOutlinePlan', "Plan"), description: oneLine(turn.plan.title) || undefined, turnId: turn.id, order: order++, children: [] });
			} else if (part.kind === 'tool') {
				const card = cards.get(part.id);
				if (card?.name === 'TodoWrite') {
					children.push({ id: `todos:${turn.id}:${card.id}`, kind: 'todos', label: localize('claudeOutlineTodos', "To-dos Updated"), turnId: turn.id, targetId: card.id, order: order++, children: [] });
				} else if (card?.kind === 'edit' && card.state !== 'failed') {
					// One entry per file a turn edits: the first edit is where it starts.
					const path = card.file ?? card.target;
					if (!edited.has(path)) {
						edited.add(path);
						children.push({ id: `edit:${turn.id}:${card.id}`, kind: 'edit', label: basename(path) || path, description: path, turnId: turn.id, targetId: card.id, order: order++, children: [] });
					}
				}
			} else if (part.kind === 'subagent') {
				const subagent = runs.get(part.id);
				if (subagent && !subagent.run.parentRunId) {
					children.push(subagentNode(subagent, turn.id));
				}
			}
		}
		return {
			id: `turn:${turn.id}`,
			kind: 'prompt',
			label: promptLabel(turn.user.text) || localize('claudeOutlineTurn', "Turn {0}", index + 1),
			description: localize('claudeOutlineTurn', "Turn {0}", index + 1),
			turnId: turn.id,
			order: own,
			children,
		};
	};

	return state.turns.map(turnNode);
}

/** Every node of `nodes` and their children, depth first. */
export function flattenClaudeChatOutline(nodes: readonly ClaudeChatOutlineNode[]): { readonly node: ClaudeChatOutlineNode; readonly depth: number }[] {
	const flat: { node: ClaudeChatOutlineNode; depth: number }[] = [];
	const visit = (node: ClaudeChatOutlineNode, depth: number) => {
		flat.push({ node, depth });
		for (const child of node.children) {
			visit(child, depth + 1);
		}
	};
	for (const node of nodes) {
		visit(node, 0);
	}
	return flat;
}

function promptLabel(text: string): string {
	const line = oneLine(text);
	return line.length > PROMPT_LABEL_MAX ? `${line.slice(0, PROMPT_LABEL_MAX - 1)}…` : line;
}

function oneLine(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim();
}
