/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseClaudeSettings } from './claudeHooks.js';

/**
 * Hook events Klawly runs itself (issue 514), for its own AI surfaces that run
 * outside Claude Code's loop. They live in the same Claude settings files and
 * use Claude Code's hook format and contract. Claude Code ignores them.
 */
export const CLAUDE_KLAWLY_HOOK_EVENTS = ['KlawlyTabRead', 'KlawlyInlineEdit', 'KlawlyWorkspaceOpen'] as const;

export type ClaudeKlawlyHookEvent = typeof CLAUDE_KLAWLY_HOOK_EVENTS[number];

/** What Klawly asks its hooks about. Each event's fields reach the hook on stdin in snake_case. */
export type ClaudeKlawlyHookRequest =
	/** Before Tab sends a file's text to Claude. A denial skips the file. */
	| { readonly event: 'KlawlyTabRead'; readonly cwd: string; readonly filePath: string }
	/** Before an inline edit sends the file and the instruction, and after the edit is in the file. A denial before blocks the edit. */
	| { readonly event: 'KlawlyInlineEdit'; readonly cwd: string; readonly phase: 'before' | 'after'; readonly filePath: string; readonly instruction: string }
	/** Once a trusted workspace opens, per folder. */
	| { readonly event: 'KlawlyWorkspaceOpen'; readonly cwd: string; readonly folders: readonly string[] };

/** How one hook ended. `denied` blocks the action; `failed` and `timedOut` fail open unless the hook sets `failClosed`. */
export type ClaudeKlawlyHookOutcome = 'allowed' | 'denied' | 'failed' | 'timedOut' | 'skipped';

export interface ClaudeKlawlyHookRun {
	readonly command: string;
	readonly outcome: ClaudeKlawlyHookOutcome;
	/** The deny reason, error, or the hook's `systemMessage` or plain stdout. */
	readonly message?: string;
	readonly durationMs: number;
}

export interface ClaudeKlawlyHookResult {
	readonly allowed: boolean;
	/** Why the first denying hook denied. */
	readonly reason?: string;
	/** Every hook that ran or was skipped, in settings order. Empty when the event has none. */
	readonly runs: readonly ClaudeKlawlyHookRun[];
}

/** A command hook on a Klawly event, as Claude Code's settings describe it. */
export interface ClaudeKlawlyHookSpec {
	readonly type: string;
	readonly command: string;
	/** Exec form: `command` runs directly with these arguments, no shell. */
	readonly args?: readonly string[];
	readonly shell?: 'bash' | 'powershell';
	/** Seconds. */
	readonly timeout?: number;
	/** Klawly's switch: a timeout, crash or exit code other than 0 and 2 denies instead of allowing. */
	readonly failClosed: boolean;
}

/** Seconds a hook may run when it sets no `timeout`. Tab waits on its hooks, so it gets a short one. */
export function claudeKlawlyHookDefaultTimeout(event: ClaudeKlawlyHookEvent): number {
	return event === 'KlawlyTabRead' ? 5 : 60;
}

/**
 * The hooks on `event` across the settings files, in file order. Identical
 * hooks run once, and `disableAllHooks` in any file turns them all off, as in
 * Claude Code. These events take no matcher, so a group's matcher is ignored.
 */
export function collectClaudeKlawlyHooks(settingsTexts: readonly string[], event: ClaudeKlawlyHookEvent): ClaudeKlawlyHookSpec[] {
	const specs: ClaudeKlawlyHookSpec[] = [];
	const seen = new Set<string>();
	for (const text of settingsTexts) {
		const settings = parseClaudeSettings(text);
		if (settings?.disableAllHooks === true) {
			return [];
		}
		const hooks = settings?.hooks;
		const groups = hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? (hooks as Record<string, unknown>)[event] : undefined;
		if (!Array.isArray(groups)) {
			continue;
		}
		for (const group of groups) {
			const list = group && typeof group === 'object' ? (group as Record<string, unknown>).hooks : undefined;
			if (!Array.isArray(list)) {
				continue;
			}
			for (const hook of list) {
				const spec = toSpec(hook);
				const key = spec && JSON.stringify([spec.type, spec.command, spec.args, spec.shell]);
				if (spec && key && !seen.has(key)) {
					seen.add(key);
					specs.push(spec);
				}
			}
		}
	}
	return specs;
}

function toSpec(hook: unknown): ClaudeKlawlyHookSpec | undefined {
	if (!hook || typeof hook !== 'object') {
		return undefined;
	}
	const value = hook as Record<string, unknown>;
	if (typeof value.type !== 'string') {
		return undefined;
	}
	const command = value.type === 'command' ? value.command : value.type;
	if (typeof command !== 'string' || !command.trim()) {
		return undefined;
	}
	const args = Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string') ? value.args as string[] : undefined;
	const timeout = typeof value.timeout === 'number' && value.timeout > 0 ? value.timeout : undefined;
	const shell = value.shell === 'bash' || value.shell === 'powershell' ? value.shell : undefined;
	return { type: value.type, command, args, shell, timeout, failClosed: value.failClosed === true };
}

/** The JSON a hook reads on stdin: Claude Code's common fields and the event's own. */
export function claudeKlawlyHookInput(request: ClaudeKlawlyHookRequest): Record<string, unknown> {
	const common = { hook_event_name: request.event, cwd: request.cwd };
	switch (request.event) {
		case 'KlawlyTabRead': return { ...common, file_path: request.filePath };
		case 'KlawlyInlineEdit': return { ...common, phase: request.phase, file_path: request.filePath, instruction: request.instruction };
		case 'KlawlyWorkspaceOpen': return { ...common, workspace_folders: request.folders };
	}
}

/** How a hook process ended. */
export interface ClaudeKlawlyHookExit {
	/** Undefined when the process could not start or was killed. */
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	/** Why the process could not start. */
	readonly error?: string;
}

/**
 * Claude Code's contract: exit 2 denies with stderr as the reason; exit 0
 * uses stdout, where JSON may deny through `continue: false`, `decision:
 * "block"` or `hookSpecificOutput.permissionDecision: "deny"`; any other end
 * is a non-blocking error. Klawly's `failClosed` makes errors and timeouts deny.
 */
export function decideClaudeKlawlyHook(spec: ClaudeKlawlyHookSpec, exit: ClaudeKlawlyHookExit): { readonly outcome: ClaudeKlawlyHookOutcome; readonly message?: string } {
	const stderr = exit.stderr.trim();
	if (exit.timedOut) {
		return { outcome: spec.failClosed ? 'denied' : 'timedOut', message: `timed out after ${spec.timeout ?? 'the default'} seconds` };
	}
	if (exit.exitCode === 2) {
		return { outcome: 'denied', message: stderr || 'denied by the hook (exit code 2)' };
	}
	if (exit.exitCode !== 0) {
		const message = exit.error ?? (stderr || `exit code ${exit.exitCode ?? 'unknown'}`);
		return { outcome: spec.failClosed ? 'denied' : 'failed', message };
	}
	const stdout = exit.stdout.trim();
	const json = stdout.startsWith('{') ? parseOutput(stdout) : undefined;
	if (!json) {
		return { outcome: 'allowed', message: stdout || undefined };
	}
	const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput as Record<string, unknown> : undefined;
	if (json.continue === false) {
		return { outcome: 'denied', message: text(json.stopReason) ?? text(json.reason) ?? 'denied by the hook' };
	}
	if (json.decision === 'block') {
		return { outcome: 'denied', message: text(json.reason) ?? 'denied by the hook' };
	}
	if (specific?.permissionDecision === 'deny') {
		return { outcome: 'denied', message: text(specific.permissionDecisionReason) ?? text(json.reason) ?? 'denied by the hook' };
	}
	return { outcome: 'allowed', message: text(json.systemMessage) };
}

function parseOutput(stdout: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(stdout);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** All hooks' runs folded into one answer: any denial denies. */
export function combineClaudeKlawlyHookRuns(runs: readonly ClaudeKlawlyHookRun[]): ClaudeKlawlyHookResult {
	const denied = runs.find(run => run.outcome === 'denied');
	return denied ? { allowed: false, reason: denied.message, runs } : { allowed: true, runs };
}
