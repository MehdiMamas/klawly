/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_USER_LAYER_FILES, CLAUDE_USER_LAYER_FOLDER } from '../../../../../platform/claude/common/claudeUserLayer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

/** What Import from Claude Code can copy: Claude Code's memory file, rules, skills, subagents and commands (issue 807). */
export type ClaudeImportKind = 'memory' | 'rules' | 'skills' | 'subagents' | 'commands';

/** One thing in `~/.claude` that can be copied into Klawly's user layer. */
export interface ClaudeImportEntry {
	readonly kind: ClaudeImportKind;
	/** Where it is under `~/.claude` and where it goes under `~/.klawly/claude`. */
	readonly path: readonly string[];
	/** The name people know it by, such as `frontend/react` or `review`. */
	readonly name: string;
	/** The target is there already: copying skips it, so nothing of yours is overwritten. */
	readonly exists: boolean;
}

/** What a copy did: what it wrote, and what it left alone because the target was there. */
export interface ClaudeImportResult {
	readonly copied: readonly ClaudeImportEntry[];
	readonly skipped: readonly ClaudeImportEntry[];
}

export function claudeImportKindLabel(kind: ClaudeImportKind): string {
	switch (kind) {
		case 'memory': return localize('claudeImportMemory', "Memory");
		case 'rules': return localize('claudeImportRule', "Rule");
		case 'skills': return localize('claudeImportSkill', "Skill");
		case 'subagents': return localize('claudeImportSubagent', "Subagent");
		case 'commands': return localize('claudeImportCommand', "Command");
	}
}

const RULE_DEPTH = 4;

/**
 * Copies files from Claude Code's `~/.claude` into Klawly's own user layer
 * (issue 807). The source is only ever read: nothing under `~/.claude` is
 * moved, changed or deleted, and a target that exists is never overwritten.
 */
export class ClaudeCodeImporter {

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IProductService private readonly _product: IProductService,
	) { }

	private async roots(): Promise<{ source: URI; target: URI } | undefined> {
		const home = await this._paths.userHome().catch(() => undefined);
		return home ? { source: joinPath(home, '.claude'), target: joinPath(home, this._product.dataFolderName, CLAUDE_USER_LAYER_FOLDER) } : undefined;
	}

	/** What `~/.claude` holds that can be copied, with whether Klawly's user layer has it already. */
	async scan(): Promise<ClaudeImportEntry[]> {
		const roots = await this.roots();
		if (!roots) {
			return [];
		}
		const entries: ClaudeImportEntry[] = [];
		const add = async (kind: ClaudeImportKind, path: readonly string[], name: string) => {
			entries.push({ kind, path, name, exists: await this._fileService.exists(joinPath(roots.target, ...path)) });
		};
		if (await this._fileService.exists(joinPath(roots.source, CLAUDE_USER_LAYER_FILES.rules))) {
			await add('memory', [CLAUDE_USER_LAYER_FILES.rules], CLAUDE_USER_LAYER_FILES.rules);
		}
		const markdown = async (kind: ClaudeImportKind, folder: string, depth: number, prefix: string[]): Promise<void> => {
			const stat = await this._fileService.resolve(joinPath(roots.source, folder, ...prefix)).catch(() => undefined);
			for (const child of [...(stat?.children ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
				if (child.isDirectory && depth < RULE_DEPTH && kind === 'rules') {
					await markdown(kind, folder, depth + 1, [...prefix, child.name]);
				} else if (child.isFile && child.name.toLowerCase().endsWith('.md')) {
					await add(kind, [folder, ...prefix, child.name], [...prefix, child.name.slice(0, -3)].join('/'));
				}
			}
		};
		await markdown('rules', 'rules', 0, []);
		await markdown('subagents', 'agents', 0, []);
		await markdown('commands', 'commands', 0, []);
		const skills = await this._fileService.resolve(joinPath(roots.source, 'skills')).catch(() => undefined);
		for (const child of [...(skills?.children ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
			if (child.isDirectory) {
				await add('skills', ['skills', child.name], child.name);
			}
		}
		return entries;
	}

	/** Copies the entries that are not in the user layer yet. Never writes to `~/.claude`. */
	async copy(entries: readonly ClaudeImportEntry[]): Promise<ClaudeImportResult> {
		const roots = await this.roots();
		const copied: ClaudeImportEntry[] = [];
		const skipped: ClaudeImportEntry[] = [];
		for (const entry of entries) {
			const target = roots && !entry.path.some(segment => segment === '..' || segment === '') ? joinPath(roots.target, ...entry.path) : undefined;
			if (!roots || !target || await this._fileService.exists(target)) {
				skipped.push(entry);
				continue;
			}
			await this._fileService.copy(joinPath(roots.source, ...entry.path), target, false);
			copied.push(entry);
		}
		return { copied, skipped };
	}

	/** The summary a notification shows after a copy. */
	static summary(result: ClaudeImportResult, folderLabel: string): string {
		if (result.copied.length === 0) {
			return localize('claudeImportNothing', "Nothing was copied. {0} already has all of it, and Klawly never overwrites your files.", folderLabel);
		}
		return result.skipped.length
			? localize('claudeImportSome', "Copied {0} to {1}. Left {2} that {1} already has. Claude Code's files were not changed.", result.copied.length, folderLabel, result.skipped.length)
			: localize('claudeImportAll', "Copied {0} to {1}. Claude Code's files were not changed.", result.copied.length, folderLabel);
	}
}
