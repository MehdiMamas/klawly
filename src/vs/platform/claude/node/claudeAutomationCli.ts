/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { CLAUDE_AUTOMATIONS_FILE_NAME, CLAUDE_AUTOMATIONS_FOLDER, CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS, readClaudeAutomationsFile } from '../common/claudeAutomation.js';
import { parseClaudeAutomationCliArgs } from '../common/claudeAutomationCli.js';
import { ClaudePromptMessage, ClaudeQueryFactory } from './claudeQuery.js';

/** The tools a run from the system scheduler may use without being asked: reads only. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** What the headless runner needs from its surroundings; the terminal entry point passes the real ones. */
export interface ClaudeAutomationCliHost {
	readonly env: Readonly<Record<string, string>>;
	readonly home?: string;
	readonly queryFactory: ClaudeQueryFactory;
	readonly write: (text: string) => void;
	readonly writeError: (text: string) => void;
}

async function* promptOnce(text: string): AsyncGenerator<ClaudePromptMessage> {
	yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * `klawly automations run ...` (issue 463): the entry the Task Scheduler task or launchd agent starts
 * while Klawly is closed. Runs one `schedule` automation read-only, prints Claude's answer and
 * returns the exit code: 0 done, 1 failed, 2 wrong arguments.
 */
export async function runClaudeAutomationCli(args: readonly string[], host: ClaudeAutomationCliHost): Promise<number> {
	const parsed = parseClaudeAutomationCliArgs(args);
	if (typeof parsed === 'string') {
		host.writeError(parsed);
		return 2;
	}
	const home = host.home ?? homedir();
	const root = parsed.scope === 'user' ? home : parsed.folder!;
	const file = join(root, CLAUDE_AUTOMATIONS_FOLDER, CLAUDE_AUTOMATIONS_FILE_NAME);
	let text: string;
	try {
		text = await fs.readFile(file, 'utf8');
	} catch {
		host.writeError(`No automations file at ${file}.`);
		return 1;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		host.writeError(`${file} is not valid JSON.`);
		return 1;
	}
	const automation = readClaudeAutomationsFile(json, parsed.scope).automations.find(candidate => candidate.id === parsed.id);
	if (!automation) {
		host.writeError(`${file} has no automation "${parsed.id}".`);
		return 1;
	}
	if (!automation.enabled || !automation.runWhenClosed || automation.trigger.type !== 'schedule' || automation.permissionMode === 'agent') {
		host.writeError(`"${automation.name}" is not set to run when Klawly is closed.`);
		return 1;
	}
	const allowed = new Set(READ_ONLY_TOOLS);
	const refusal = 'A run while Klawly is closed can only read files.';
	try {
		const query = await host.queryFactory({
			prompt: promptOnce(automation.prompt),
			options: {
				cwd: root,
				allowedTools: READ_ONLY_TOOLS,
				maxTurns: automation.maxTurns ?? CLAUDE_AUTOMATION_DEFAULT_MAX_TURNS,
				maxBudgetUsd: automation.budgetUsd,
				model: automation.model,
				permissionMode: 'default',
				env: host.env,
				abortController: new AbortController(),
				canUseTool: async toolName => allowed.has(toolName) ? { behavior: 'allow' } : { behavior: 'deny', message: refusal },
				screenTool: async toolName => allowed.has(toolName) ? undefined : { decision: 'deny', message: refusal },
			},
		});
		let answer: string | undefined;
		let failure: string | undefined;
		try {
			for await (const message of query) {
				const result = message as { type?: unknown; subtype?: unknown; result?: unknown; errors?: readonly string[] };
				if (result.type === 'result') {
					if (result.subtype === 'success') {
						answer = typeof result.result === 'string' ? result.result : undefined;
					} else {
						failure = result.errors?.join('\n') || String(result.subtype);
					}
				}
			}
		} finally {
			query.close();
		}
		if (failure !== undefined) {
			host.writeError(`"${automation.name}" failed: ${failure}`);
			return 1;
		}
		host.write(answer ?? '');
		return 0;
	} catch (error) {
		host.writeError(`"${automation.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
