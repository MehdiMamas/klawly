/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ClaudeInstructionSource } from '../../../../platform/claude/common/claudeAgentsFiles.js';
import { redactSecrets } from './claudeAgentLog.js';
import { AgentReducerEvent } from './claudeAgentState.js';

export type InspectorFilter = 'all' | 'input' | 'output' | 'tool' | 'permission' | 'error';

export interface InspectorRow {
	readonly index: number;
	readonly kind: 'normalized' | 'raw';
	readonly label: string;
	readonly summary: string;
	readonly json: string;
}

export interface InspectorSource {
	readonly events: readonly AgentReducerEvent[];
	readonly rawMessages: readonly unknown[];
	readonly retainRaw: boolean;
	readonly filter: InspectorFilter;
}

/** Ordered inspector rows. Raw SDK messages appear only when retention is on. */
export function buildInspectorRows(source: InspectorSource): readonly InspectorRow[] {
	const rows: InspectorRow[] = [];
	for (const event of source.events) {
		if (!matchesFilter(event, source.filter)) {
			continue;
		}
		rows.push({
			index: rows.length,
			kind: 'normalized',
			label: labelFor(event),
			summary: summaryFor(event),
			json: redactSecrets(JSON.stringify(event)),
		});
	}
	if (source.retainRaw && (source.filter === 'all' || source.filter === 'output')) {
		for (const message of source.rawMessages) {
			let json: string;
			try {
				json = redactSecrets(JSON.stringify(message));
			} catch {
				json = localize('claudeInspectorUnreadable', "[unreadable]");
			}
			rows.push({
				index: rows.length,
				kind: 'raw',
				label: localize('claudeInspectorRaw', "Raw SDK message"),
				summary: localize('claudeInspectorRawSummary', "SDK message retained for debugging"),
				json,
			});
		}
	}
	return rows;
}

export function inspectorFilterLabel(filter: InspectorFilter): string {
	switch (filter) {
		case 'all': return localize('claudeInspectorFilterAll', "All");
		case 'input': return localize('claudeInspectorFilterInput', "Input");
		case 'output': return localize('claudeInspectorFilterOutput', "Output");
		case 'tool': return localize('claudeInspectorFilterTool', "Tools");
		case 'permission': return localize('claudeInspectorFilterPermission', "Permissions");
		case 'error': return localize('claudeInspectorFilterError', "Errors");
		default: return filter;
	}
}

export function inspectorJson(rows: readonly InspectorRow[]): string {
	return JSON.stringify(rows.map(row => ({ kind: row.kind, label: row.label, summary: row.summary, event: parseInspectorEvent(row.json) })), undefined, 2);
}

function parseInspectorEvent(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return json;
	}
}

function matchesFilter(event: AgentReducerEvent, filter: InspectorFilter): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'input':
			return event.type === 'turn.submitted' || event.type === 'session.started';
		case 'output':
			return event.type === 'assistant.delta' || event.type === 'assistant.completed' || event.type === 'thinking.delta';
		case 'tool':
			return event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed' || event.type === 'subagent.started' || event.type === 'subagent.finished';
		case 'permission':
			return event.type === 'permission.requested' || event.type === 'permission.resolved';
		case 'error':
			return event.type === 'session.failed' || event.type === 'turn.failed' || (event.type === 'tool.completed' && !event.result.ok);
		default:
			return true;
	}
}

function labelFor(event: AgentReducerEvent): string {
	switch (event.type) {
		case 'turn.submitted': return localize('claudeInspectorSent', "Sent");
		case 'assistant.delta':
		case 'assistant.completed': return localize('claudeInspectorAssistant', "Assistant");
		case 'thinking.delta': return localize('claudeInspectorThinking', "Thinking");
		case 'tool.started':
		case 'tool.updated':
		case 'tool.completed': return localize('claudeInspectorTool', "Tool");
		case 'permission.requested':
		case 'permission.resolved': return localize('claudeInspectorPermission', "Permission");
		case 'session.failed':
		case 'turn.failed': return localize('claudeInspectorError', "Error");
		case 'subagent.started':
		case 'subagent.finished': return localize('claudeInspectorSubagent', "Subagent");
		default: return event.type;
	}
}

function summaryFor(event: AgentReducerEvent): string {
	switch (event.type) {
		case 'turn.submitted':
			return clip(event.text);
		case 'assistant.delta':
		case 'assistant.completed':
		case 'thinking.delta':
			return localize('claudeInspectorChars', "{0} characters", event.text.length);
		case 'tool.started':
			return `${event.call.name} | ${event.call.category}`;
		case 'tool.updated':
			return event.callId;
		case 'tool.completed':
			return event.result.ok ? event.callId : localize('claudeInspectorToolFailed', "{0} failed", event.callId);
		case 'permission.requested':
			return event.request.toolName;
		case 'permission.resolved':
			return `${event.outcome.toolName} | ${event.outcome.decision}`;
		case 'session.failed':
		case 'turn.failed':
			return clip(event.message);
		case 'subagent.started':
			return `${event.run.agentType}: ${clip(event.run.description)}`;
		case 'subagent.finished':
			return `${event.runId} | ${event.state}`;
		case 'session.started':
			return withInstructionSources(event.model ? event.model : event.type, event.instructions);
		default:
			return event.type;
	}
}

/** Says what Klawly passed besides Claude Code's own files: AGENTS.md or `.agents/skills` (issue 499). */
function withInstructionSources(summary: string, sources: readonly ClaudeInstructionSource[] | undefined): string {
	const labels = new Set((sources ?? []).map(source => source.kind === 'agentsSkills' ? localize('claudeInspectorFromAgentsSkills', "from .agents/skills") : localize('claudeInspectorFromAgentsMd', "from AGENTS.md")));
	return labels.size ? `${summary} | ${[...labels].join(', ')}` : summary;
}

function clip(text: string): string {
	const clean = redactSecrets(text).replace(/\s+/g, ' ').trim();
	return clean.length > 160 ? `${clean.slice(0, 160)}...` : clean;
}
