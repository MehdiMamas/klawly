/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseClaudeCron } from './claudeAutomation.js';

/**
 * Entries for the operating system's own scheduler (issue 463): Windows Task
 * Scheduler (`schtasks`) and macOS launchd. They start Klawly's headless
 * entry for one automation while no Klawly window is open. Everything here is
 * pure; the node registrar runs the commands.
 */

/** The most OS entries one automation may need; a cron that expands to more is not supported. */
export const CLAUDE_OS_SCHEDULE_MAX_ENTRIES = 24;

/** What the OS entry needs to know about one automation. */
export interface ClaudeOsScheduleAutomation {
	readonly id: string;
	readonly scope: 'user' | 'workspace';
	readonly cron: string;
	/** The workspace folder of a workspace-scope automation. */
	readonly folder?: string;
}

type ClaudeOsIdentity = Pick<ClaudeOsScheduleAutomation, 'id' | 'scope' | 'folder'>;

/** One fire time of the schedule. An absent list means every value of that field. */
export interface ClaudeOsScheduleSpec {
	readonly minutes?: readonly number[];
	readonly hours?: readonly number[];
	/** 0 is Sunday. */
	readonly weekdays?: readonly number[];
	readonly monthDays?: readonly number[];
	readonly months?: readonly number[];
}

export type ClaudeOsScheduleSpecResult = { readonly spec: ClaudeOsScheduleSpec } | { readonly unsupported: string };

/** Reads a cron expression into the fields an OS scheduler can express. */
export function claudeOsScheduleSpec(cronExpression: string): ClaudeOsScheduleSpecResult {
	const cron = parseClaudeCron(cronExpression);
	if (!cron) {
		return { unsupported: 'The schedule is not a valid cron expression.' };
	}
	if (!cron.anyDay && !cron.anyWeekday) {
		return { unsupported: 'A schedule that limits both the day of the month and the day of the week cannot be registered with the system scheduler.' };
	}
	const sorted = (values: ReadonlySet<number>, size: number): number[] | undefined => values.size >= size ? undefined : [...values].sort((a, b) => a - b);
	return {
		spec: {
			minutes: sorted(cron.minutes, 60),
			hours: sorted(cron.hours, 24),
			weekdays: cron.anyWeekday ? undefined : sorted(cron.weekdays, 7),
			monthDays: cron.anyDay ? undefined : sorted(cron.days, 31),
			months: sorted(cron.months, 12),
		}
	};
}

/** A short stable hash for the folder a workspace automation belongs to. */
function folderHash(folder: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < folder.length; index++) {
		hash ^= folder.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** Names the automation's owner in OS entry names: `user`, or `ws` and a hash of the folder. */
export function claudeOsOwner(automation: Pick<ClaudeOsScheduleAutomation, 'scope' | 'folder'>): string {
	return automation.scope === 'user' ? 'user' : `ws${folderHash(automation.folder ?? '')}`;
}

/** The command line of the headless entry for this automation, after the Klawly executable. */
export function claudeOsLaunchArgs(automation: ClaudeOsIdentity): string[] {
	const args = ['automations', 'run', '--scope', automation.scope, '--id', automation.id];
	if (automation.scope === 'workspace' && automation.folder) {
		args.push('--folder', automation.folder);
	}
	return args;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

// ---- Windows Task Scheduler ----

/** The folder of Klawly's tasks in Task Scheduler. */
export const CLAUDE_WINDOWS_TASK_FOLDER = '\\Klawly\\';

/** One `schtasks /Create` for a task of the automation. */
export interface ClaudeWindowsTask {
	readonly name: string;
	readonly createArgs: readonly string[];
}

export type ClaudeWindowsTasksResult = { readonly tasks: readonly ClaudeWindowsTask[] } | { readonly unsupported: string };

const WINDOWS_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Quotes one argument for a Windows command line. */
export function claudeWindowsQuote(value: string): string {
	return !value || /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** The base name shared by every task of one automation: `\Klawly\automation-<owner>-<id>`. */
export function claudeWindowsTaskBase(automation: ClaudeOsIdentity): string {
	return `${CLAUDE_WINDOWS_TASK_FOLDER}automation-${claudeOsOwner(automation)}-${automation.id}`;
}

/** Whether `taskName` is one task of this automation: the base, `-` and a number. */
export function claudeWindowsTaskBelongsTo(taskName: string, automation: ClaudeOsIdentity): boolean {
	const prefix = `${claudeWindowsTaskBase(automation)}-`;
	return taskName.startsWith(prefix) && /^\d+$/.test(taskName.slice(prefix.length));
}

/**
 * The `schtasks /Create` commands for an automation's schedule. Task Scheduler
 * has no cron: a daily or weekly time, a monthly day, every N minutes or every
 * hour. Several times in a day become several tasks.
 */
export function claudeWindowsTasks(automation: ClaudeOsScheduleAutomation, executable: string): ClaudeWindowsTasksResult {
	const parsed = claudeOsScheduleSpec(automation.cron);
	if ('unsupported' in parsed) {
		return parsed;
	}
	const { minutes, hours, weekdays, monthDays, months } = parsed.spec;
	if (months) {
		return { unsupported: 'Task Scheduler cannot limit a schedule to some months.' };
	}
	const command = [executable, ...claudeOsLaunchArgs(automation)].map(claudeWindowsQuote).join(' ');
	const base = claudeWindowsTaskBase(automation);
	const make = (parts: readonly (readonly string[])[]): ClaudeWindowsTasksResult => {
		if (parts.length > CLAUDE_OS_SCHEDULE_MAX_ENTRIES) {
			return { unsupported: `The schedule needs ${parts.length} system tasks; the most is ${CLAUDE_OS_SCHEDULE_MAX_ENTRIES}.` };
		}
		return {
			tasks: parts.map((schedule, index) => {
				const name = `${base}-${index + 1}`;
				return { name, createArgs: ['/Create', '/TN', name, '/TR', command, ...schedule, '/F'] };
			})
		};
	};
	// Every minute, every hour, or every N minutes.
	if (!hours && !weekdays && !monthDays) {
		if (!minutes) {
			return make([['/SC', 'MINUTE', '/MO', '1']]);
		}
		if (minutes.length === 1) {
			return make([['/SC', 'HOURLY', '/MO', '1', '/ST', `00:${pad(minutes[0])}`]]);
		}
		const step = minutes[1] - minutes[0];
		if (minutes[0] === 0 && 60 % step === 0 && minutes.length === 60 / step && minutes.every((value, index) => value === index * step)) {
			return make([['/SC', 'MINUTE', '/MO', String(step)]]);
		}
		return { unsupported: 'Task Scheduler cannot repeat an uneven set of minutes every hour.' };
	}
	if (!hours || !minutes) {
		return { unsupported: 'Task Scheduler needs fixed hours and minutes for a schedule that is limited to some days.' };
	}
	const days = monthDays
		? ['/SC', 'MONTHLY', '/D', monthDays.join(',')]
		: weekdays ? ['/SC', 'WEEKLY', '/D', weekdays.map(day => WINDOWS_DAYS[day]).join(',')] : ['/SC', 'DAILY'];
	const times = hours.flatMap(hour => minutes.map(minute => `${pad(hour)}:${pad(minute)}`));
	return make(times.map(time => [...days, '/ST', time]));
}

/** `schtasks /Delete` for one task. */
export function claudeWindowsDeleteArgs(taskName: string): string[] {
	return ['/Delete', '/TN', taskName, '/F'];
}

/** `schtasks /Query` listing every task name, to find Klawly's. */
export const CLAUDE_WINDOWS_QUERY_ARGS: readonly string[] = ['/Query', '/FO', 'CSV', '/NH'];

/** Klawly's task names from the CSV `schtasks /Query` prints. */
export function claudeWindowsTaskNames(csv: string): string[] {
	const names: string[] = [];
	for (const line of csv.split(/\r?\n/)) {
		const match = /^"(?<name>\\Klawly\\[^"]*)"/.exec(line);
		if (match?.groups) {
			names.push(match.groups.name);
		}
	}
	return names;
}

// ---- macOS launchd ----

/** The launchd label of the automation: `com.klawly.automation.<owner>.<id>`. */
export function claudeLaunchdLabel(automation: ClaudeOsIdentity): string {
	return `com.klawly.automation.${claudeOsOwner(automation)}.${automation.id}`;
}

export type ClaudeLaunchdPlistResult = { readonly label: string; readonly plist: string } | { readonly unsupported: string };

function xml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The launchd agent for an automation: `StartCalendarInterval` dictionaries
 * (a field left out matches every value, as `*` does). `logPath` receives the
 * run's output.
 */
export function claudeLaunchdPlist(automation: ClaudeOsScheduleAutomation, executable: string, logPath: string): ClaudeLaunchdPlistResult {
	const parsed = claudeOsScheduleSpec(automation.cron);
	if ('unsupported' in parsed) {
		return parsed;
	}
	const { minutes, hours, weekdays, monthDays, months } = parsed.spec;
	const expand = (key: string, values: readonly number[] | undefined, into: Record<string, number>[]): Record<string, number>[] =>
		values ? into.flatMap(dict => values.map(value => ({ ...dict, [key]: value }))) : into;
	let dicts: Record<string, number>[] = [{}];
	dicts = expand('Month', months, dicts);
	dicts = expand('Day', monthDays, dicts);
	dicts = expand('Weekday', weekdays, dicts);
	dicts = expand('Hour', hours, dicts);
	dicts = expand('Minute', minutes, dicts);
	const limit = CLAUDE_OS_SCHEDULE_MAX_ENTRIES * 60;
	if (dicts.length > limit) {
		return { unsupported: `The schedule needs ${dicts.length} launchd entries; the most is ${limit}.` };
	}
	const label = claudeLaunchdLabel(automation);
	const strings = [executable, ...claudeOsLaunchArgs(automation)].map(value => `\t\t<string>${xml(value)}</string>`).join('\n');
	const intervals = dicts.map(dict => {
		const entries = Object.entries(dict).map(([key, value]) => `\t\t\t<key>${key}</key>\n\t\t\t<integer>${value}</integer>`).join('\n');
		return entries ? `\t\t<dict>\n${entries}\n\t\t</dict>` : '\t\t<dict/>';
	}).join('\n');
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array>
${strings}
	</array>
	<key>StartCalendarInterval</key>
	<array>
${intervals}
	</array>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${xml(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logPath)}</string>
</dict>
</plist>
`;
	return { label, plist };
}
