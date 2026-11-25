/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import product from '../../product/common/product.js';
import { ClaudeReadRule, CLAUDE_READ_RULES_FILE, mergeReadRules, parseReadRules, readRulesFromSettings } from '../common/claudeReadRules.js';
import { claudeUserLayerDirectory } from '../common/claudeUserLayer.js';

/** Project settings files that carry `Read(...)` deny entries. */
const PROJECT_SETTINGS_FILES: readonly string[] = ['settings.json', 'settings.local.json'];

interface CachedFile {
	readonly stamp: string;
	readonly text: string | undefined;
}

/**
 * Loads the files-Claude-cannot-read rules (issue 458): the user list and each
 * workspace folder's `.claude/settings*.json` deny entries. Files are re-read
 * only when their size or time changed, so the host can ask on every request.
 */
export class ClaudeReadRulesLoader {
	private readonly _files = new Map<string, CachedFile>();

	constructor(private readonly _options: { homeDirectory?: string; dataFolderName?: string } = {}) { }

	get homeDirectory(): string {
		return this._options.homeDirectory ?? homedir();
	}

	/** The user list's path, for the Settings UI and the explorer. */
	get userListPath(): string {
		return join(claudeUserLayerDirectory(this.homeDirectory, this._options.dataFolderName ?? product.dataFolderName ?? '.klawly'), CLAUDE_READ_RULES_FILE);
	}

	async load(workspaceFolders: readonly string[]): Promise<ClaudeReadRule[]> {
		const home = this.homeDirectory;
		const layers: ClaudeReadRule[][] = [];
		const userPath = this.userListPath;
		const userText = await this._read(userPath);
		layers.push(userText === undefined ? [] : parseReadRules(userText, { source: 'user', origin: userPath, home }));
		for (const folder of workspaceFolders) {
			for (const name of PROJECT_SETTINGS_FILES) {
				const path = join(folder, '.claude', name);
				const text = await this._read(path);
				if (text === undefined) {
					continue;
				}
				try {
					layers.push(readRulesFromSettings(JSON.parse(text), { source: 'project', origin: path, base: folder, home }));
				} catch {
					// A settings file that is not valid JSON has no rules to read.
				}
			}
		}
		return mergeReadRules(...layers);
	}

	private async _read(path: string): Promise<string | undefined> {
		let stamp: string;
		try {
			const info = await stat(path);
			stamp = `${info.mtimeMs}:${info.size}`;
		} catch {
			this._files.delete(path);
			return undefined;
		}
		const cached = this._files.get(path);
		if (cached?.stamp === stamp) {
			return cached.text;
		}
		let text: string | undefined;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			text = undefined;
		}
		this._files.set(path, { stamp, text });
		return text;
	}
}
