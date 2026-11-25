/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { CLAUDE_USER_LAYER_FOLDER } from '../../../../../platform/claude/common/claudeUserLayer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ClaudeCreateDraft, ClaudeCreatedFile, ClaudeCreateKind, ClaudeCreateScope, claudeCreateContent, claudeCreatePath, claudeCreatePathLabel, claudeCreatePrompt, ClaudeRuleFile, readClaudeRulePaths } from '../../common/claudeCustomizeCreate.js';

/** How deep Customize looks into `rules/` folders: Claude Code reads them recursively. */
const RULE_DEPTH = 4;

/**
 * The files behind Customize's Add Skill, Add Subagent, Add Command and Add
 * Rule forms (issue 500): where each scope's `.claude` folder is, writing a new
 * file in Claude Code's format, and listing the `.claude/rules` files.
 */
export class ClaudeCustomizeFiles {

	/** The project's `.claude` folder and Klawly's user layer, whether or not they exist yet. */
	private readonly _roots = new Map<ClaudeCreateScope, URI>();
	/** Rule and created files by the id their rows carry. */
	private readonly _files = new Map<string, URI>();
	private _rules: readonly ClaudeRuleFile[] = [];
	private _created: readonly ClaudeCreatedFile[] = [];

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _paths: IPathService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IProductService private readonly _product: IProductService,
	) { }

	get rules(): readonly ClaudeRuleFile[] {
		return this._rules;
	}

	get created(): readonly ClaudeCreatedFile[] {
		return this._created;
	}

	/** The scopes a new file can go in: the project when a folder is open, and Klawly's user layer, `~/.klawly/claude` (issue 455). */
	get scopes(): ClaudeCreateScope[] {
		return (['project', 'user'] as const).filter(scope => this._roots.has(scope));
	}

	/** The file a row's `file` names. */
	resource(id: string | undefined): URI | undefined {
		return id ? this._files.get(id) : undefined;
	}

	/**
	 * Finds the project's `.claude` folder and the user layer, and reads the rules in them.
	 * With `useClaudeCode` on, Claude Code's own `~/.claude/rules` is listed too, read only (issue 807).
	 */
	async refresh(useClaudeCode = false): Promise<void> {
		const folder = this._workspace.getWorkspace().folders[0];
		const home = await this._paths.userHome().catch(() => undefined);
		this._roots.clear();
		if (folder) {
			this._roots.set('project', joinPath(folder.uri, '.claude'));
		}
		if (home) {
			// Klawly never writes `~/.claude`: what you save for every project goes in its own user layer.
			this._roots.set('user', joinPath(home, this._product.dataFolderName, CLAUDE_USER_LAYER_FOLDER));
		}
		const folders: [ClaudeRuleFile['scope'], URI][] = [...this._roots].map(([scope, root]) => [scope, joinPath(root, 'rules')]);
		if (home && useClaudeCode) {
			folders.push(['claudeCode', joinPath(home, '.claude', 'rules')]);
		}
		const found = await Promise.all(folders.map(([scope, folder]) => this.findRules(scope, folder, '', 0)));
		this._rules = found.flat();
		for (const rule of this._rules) {
			this._files.set(rule.id, URI.parse(rule.id));
		}
	}

	private async findRules(scope: ClaudeRuleFile['scope'], folder: URI, prefix: string, depth: number): Promise<ClaudeRuleFile[]> {
		const stat = await this._fileService.resolve(folder).catch(() => undefined);
		const rules: ClaudeRuleFile[] = [];
		for (const child of stat?.children ?? []) {
			if (child.isDirectory && depth < RULE_DEPTH) {
				rules.push(...await this.findRules(scope, child.resource, `${prefix}${child.name}/`, depth + 1));
			} else if (child.isFile && child.name.toLowerCase().endsWith('.md')) {
				const text = await this._fileService.readFile(child.resource).then(content => content.value.toString(), () => '');
				rules.push({ id: child.resource.toString(), name: `${prefix}${child.name.slice(0, -3)}`, scope, paths: readClaudeRulePaths(text) });
			}
		}
		return rules.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Writes the new file in Claude Code's format and returns it. Throws when
	 * the scope has no folder or a file of that name is already there, so
	 * nothing is overwritten.
	 */
	async create(kind: ClaudeCreateKind, draft: ClaudeCreateDraft): Promise<URI> {
		const root = this._roots.get(draft.scope);
		if (!root) {
			throw new Error(localize('claudeCreateNoFolder', "Open a folder to save it in the project."));
		}
		const name = draft.name.trim();
		const resource = joinPath(root, ...claudeCreatePath(kind, name));
		if (await this._fileService.exists(resource)) {
			throw new Error(localize('claudeCreateExists', "{0} already exists. Pick another name, or open the file from the list.", claudeCreatePathLabel(kind, draft.scope, name, this._product.dataFolderName)));
		}
		await this._fileService.createFile(resource, VSBuffer.fromString(claudeCreateContent(kind, draft)), { overwrite: false });
		const id = resource.toString();
		this._files.set(id, resource);
		if (kind !== 'rules') {
			this._created = [...this._created.filter(created => !(created.kind === kind && created.name === name)), { kind, name, description: draft.description.trim(), scope: draft.scope, id }];
		}
		return resource;
	}

	/** Starts a new chat with the prompt that asks Claude to write the file. The caller shows the chat. */
	startChat(kind: ClaudeCreateKind, draft: ClaudeCreateDraft): void {
		this._agent.createSession({ draft: claudeCreatePrompt(kind, draft, this._product.dataFolderName) });
	}
}
