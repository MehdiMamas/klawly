/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_WINDOWS_QUERY_ARGS, claudeLaunchdLabel, claudeLaunchdPlist, claudeWindowsDeleteArgs, claudeWindowsTaskBelongsTo, claudeWindowsTaskNames, claudeWindowsTasks, ClaudeOsScheduleAutomation } from '../common/claudeAutomationOsSchedule.js';

/**
 * Registers an automation with the operating system's scheduler (issue 463) so
 * it runs while Klawly is closed. Process spawning stays here, in the node
 * layer; the commands come from the pure builders and `host` runs them.
 */
export interface ClaudeOsSchedulerHost {
	readonly platform: 'win32' | 'darwin' | string;
	/** The Klawly executable the entry starts. */
	readonly executable: string;
	/** Runs a command and returns its output; rejects when it exits non-zero. */
	exec(command: string, args: readonly string[]): Promise<string>;
	/** The user's launchd agents folder, `~/Library/LaunchAgents`. */
	readonly launchAgentsDir: string;
	/** Where a launchd run writes its output. */
	readonly logPath: string;
	writeFile(path: string, content: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
}

export type ClaudeOsRegisterResult = { readonly registered: true } | { readonly registered: false; readonly reason: string };

function launchdPath(host: ClaudeOsSchedulerHost, automation: Pick<ClaudeOsScheduleAutomation, 'id' | 'scope' | 'folder'>): string {
	return `${host.launchAgentsDir}/${claudeLaunchdLabel(automation)}.plist`;
}

/** Puts the automation's schedule on the OS scheduler, replacing any entry it had. */
export async function registerClaudeOsSchedule(host: ClaudeOsSchedulerHost, automation: ClaudeOsScheduleAutomation): Promise<ClaudeOsRegisterResult> {
	if (host.platform === 'win32') {
		const result = claudeWindowsTasks(automation, host.executable);
		if ('unsupported' in result) {
			return { registered: false, reason: result.unsupported };
		}
		await unregisterClaudeOsSchedule(host, automation);
		for (const task of result.tasks) {
			await host.exec('schtasks', task.createArgs);
		}
		return { registered: true };
	}
	if (host.platform === 'darwin') {
		const result = claudeLaunchdPlist(automation, host.executable, host.logPath);
		if ('unsupported' in result) {
			return { registered: false, reason: result.unsupported };
		}
		const path = launchdPath(host, automation);
		await unregisterClaudeOsSchedule(host, automation);
		await host.writeFile(path, result.plist);
		await host.exec('launchctl', ['load', '-w', path]);
		return { registered: true };
	}
	return { registered: false, reason: 'The system scheduler is only supported on Windows and macOS.' };
}

/** Takes every OS entry of the automation away; nothing to remove is fine. */
export async function unregisterClaudeOsSchedule(host: ClaudeOsSchedulerHost, automation: Pick<ClaudeOsScheduleAutomation, 'id' | 'scope' | 'folder'>): Promise<void> {
	if (host.platform === 'win32') {
		const names = claudeWindowsTaskNames(await host.exec('schtasks', CLAUDE_WINDOWS_QUERY_ARGS).catch(() => ''));
		for (const name of names.filter(name => claudeWindowsTaskBelongsTo(name, automation))) {
			await host.exec('schtasks', claudeWindowsDeleteArgs(name)).catch(() => undefined);
		}
	} else if (host.platform === 'darwin') {
		const path = launchdPath(host, automation);
		await host.exec('launchctl', ['unload', path]).catch(() => undefined);
		await host.deleteFile(path).catch(() => undefined);
	}
}

/**
 * Brings the OS in step with the automations: an enabled, opted-in `schedule`
 * automation is registered; every other automation, and a deleted one, has its
 * entries removed. `previous` names the automations that may have entries.
 * Returns why each automation that could not be registered was not.
 */
export async function syncClaudeOsSchedules(host: ClaudeOsSchedulerHost, wanted: readonly ClaudeOsScheduleAutomation[], previous: readonly Pick<ClaudeOsScheduleAutomation, 'id' | 'scope' | 'folder'>[]): Promise<{ readonly id: string; readonly reason: string }[]> {
	const failed: { id: string; reason: string }[] = [];
	const keep = new Set(wanted.map(automation => `${automation.scope}:${automation.folder ?? ''}:${automation.id}`));
	for (const old of previous) {
		if (!keep.has(`${old.scope}:${old.folder ?? ''}:${old.id}`)) {
			await unregisterClaudeOsSchedule(host, old);
		}
	}
	for (const automation of wanted) {
		const result = await registerClaudeOsSchedule(host, automation).catch(error => ({ registered: false as const, reason: error instanceof Error ? error.message : String(error) }));
		if (!result.registered) {
			failed.push({ id: automation.id, reason: result.reason });
		}
	}
	return failed;
}
