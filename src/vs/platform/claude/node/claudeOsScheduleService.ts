/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { ClaudeOsScheduleAutomation, claudeOsOwner } from '../common/claudeAutomationOsSchedule.js';
import { ClaudeOsScheduleFailure, ClaudeOsScheduleOwner, IClaudeOsScheduleService } from '../common/claudeAutomationOsScheduleService.js';
import { ClaudeOsSchedulerHost, syncClaudeOsSchedules } from './claudeAutomationOsScheduler.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';

const APPLICATION_NAME = 'klawly';
const REGISTRY_FILE = 'claude-os-schedules.json';

type Identity = Pick<ClaudeOsScheduleAutomation, 'id' | 'scope' | 'folder'>;

/** The launcher that runs `klawly <command>` in a terminal, which is what a scheduled entry starts. */
export function claudeOsLauncher(platform: string, execPath: string, appRoot: string, applicationName: string): string {
	return platform === 'win32' ? join(dirname(execPath), 'bin', `${applicationName}.cmd`) : join(appRoot, 'bin', applicationName);
}

/** Runs a command to completion; rejects with its message when it exits non-zero. */
export function execClaudeOs(command: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, [...args], { windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout));
	});
}

/** Hosts the OS scheduler registrar in the shared process; spawning stays here, out of the UI. */
export class ClaudeOsScheduleService implements IClaudeOsScheduleService {
	declare readonly _serviceBrand: undefined;

	private readonly host: ClaudeOsSchedulerHost;
	private readonly registryPath: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(@INativeEnvironmentService environment: INativeEnvironmentService) {
		this.registryPath = join(environment.userDataPath, REGISTRY_FILE);
		this.host = {
			platform: process.platform,
			executable: claudeOsLauncher(process.platform, process.execPath, environment.appRoot, APPLICATION_NAME),
			exec: execClaudeOs,
			launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
			logPath: join(environment.userDataPath, 'logs', 'automations-closed.log'),
			writeFile: async (path, content) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, content, 'utf8'); },
			deleteFile: path => fs.rm(path, { force: true }),
		};
	}

	sync(owners: readonly ClaudeOsScheduleOwner[], wanted: readonly ClaudeOsScheduleAutomation[]): Promise<readonly ClaudeOsScheduleFailure[]> {
		const run = this.queue.then(() => this.doSync(owners, wanted));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async doSync(owners: readonly ClaudeOsScheduleOwner[], wanted: readonly ClaudeOsScheduleAutomation[]): Promise<readonly ClaudeOsScheduleFailure[]> {
		const mine = new Set(owners.map(claudeOsOwner));
		const stored = await this.readRegistry();
		const failures = await syncClaudeOsSchedules(this.host, wanted, stored.filter(entry => mine.has(claudeOsOwner(entry))));
		const kept = stored.filter(entry => !mine.has(claudeOsOwner(entry)));
		// A failed registration may have left a partial entry, so keep it listed to clean up next time.
		const next = [...kept, ...wanted.map(({ id, scope, folder }) => ({ id, scope, folder }))];
		await this.writeRegistry(next);
		return failures;
	}

	private async readRegistry(): Promise<Identity[]> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.registryPath, 'utf8'));
			return Array.isArray(parsed) ? parsed.filter((entry): entry is Identity => !!entry && typeof entry.id === 'string' && (entry.scope === 'user' || entry.scope === 'workspace')) : [];
		} catch {
			return [];
		}
	}

	private async writeRegistry(entries: readonly Identity[]): Promise<void> {
		await fs.mkdir(dirname(this.registryPath), { recursive: true });
		await fs.writeFile(this.registryPath, JSON.stringify(entries), 'utf8');
	}
}
