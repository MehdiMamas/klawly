/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IClaudeWorktreeService } from '../../../../platform/claude/common/claudeBackground.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CLAUDE_LINE_ATTRIBUTION_SETTING, IClaudeAttributionService } from '../../../services/claude/common/claudeAttribution.js';
import { CLAUDE_ATTRIBUTION_GIT_NOTES_SETTING, carryAttributionNote, ClaudeAttributionNote, ClaudeNoteFile, decodeAttributionNote, encodeAttributionNote, noteFileFromRecord, recordFromNoteFile } from '../../../services/claude/common/claudeAttributionNote.js';

/** Changes to the reflog that come close together are read once. */
const REFLOG_DELAY_MS = 1000;
/** A rebase of a long branch writes many lines at once; the newest ones are read. */
const MAX_NEW_LINES = 50;

/** What the reflog line of a new commit says it was. */
export function readReflogCommit(line: string): { readonly sha: string; readonly rewrite: boolean } | undefined {
	const match = /^[0-9a-f]{40,64} (?<sha>[0-9a-f]{40,64}) [^\t]*\t(?<action>[^:]+): ?/.exec(line.trim());
	const action = match?.groups?.action;
	if (!match?.groups || !action) {
		return undefined;
	}
	if (action === 'commit (amend)' || action.startsWith('cherry-pick') || action === 'rebase (pick)' || action === 'rebase (continue)') {
		return { sha: match.groups.sha, rewrite: true };
	}
	return action === 'commit' || action === 'commit (initial)' || action === 'commit (merge)' ? { sha: match.groups.sha, rewrite: false } : undefined;
}

function textLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/**
 * Line attribution in git notes (issue 961). Opt in, in a trusted workspace, with line attribution on: each commit
 * gets a note in refs/notes/klawly holding the line ranges Claude wrote in the files it changed, and a file opened
 * with no local record takes its marks from the newest note that covers it. The note is local: nothing pushes it.
 * An amend, rebase or cherry-pick keeps the old note for the files whose content is identical, and drops the rest.
 */
export class ClaudeAttributionNotes extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeAttributionNotes';

	private readonly _check = this._register(new RunOnceScheduler(() => void this._queue.queue(() => this.check()), REFLOG_DELAY_MS));
	private readonly _queue = new Sequencer();
	private readonly _root: URI | undefined;
	/** How many reflog lines were read, so each line is handled once. */
	private _lines: number | undefined;
	private readonly _read = new Set<string>();

	constructor(
		@IFileService private readonly _files: IFileService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
		@IClaudeWorktreeService private readonly _git: IClaudeWorktreeService,
		@IClaudeAttributionService private readonly _attribution: IClaudeAttributionService,
		@IEditorService private readonly _editors: IEditorService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._root = workspace.getWorkspace().folders.find(folder => folder.uri.scheme === Schemas.file)?.uri;
		if (!this._root) {
			return;
		}
		const watcher = this._register(this._files.createWatcher(this.reflog(), { recursive: false, excludes: [] }));
		this._register(watcher.onDidChange(() => this._check.schedule()));
		this._register(this._editors.onDidActiveEditorChange(() => void this._queue.queue(() => this.adoptActive())));
		// What the reflog says now is the starting point: only commits made from here on get a note.
		void this.readReflog().then(lines => this._lines ??= lines.length);
	}

	private active(): URI | undefined {
		const on = this._configuration.getValue<boolean>(CLAUDE_ATTRIBUTION_GIT_NOTES_SETTING) === true
			&& this._configuration.getValue<boolean>(CLAUDE_LINE_ATTRIBUTION_SETTING) === true;
		return on && this._trust.isWorkspaceTrusted() && this._git.writeAttributionNote ? this._root : undefined;
	}

	/** Reads the reflog now (tests call it; the watcher schedules it). */
	async check(): Promise<void> {
		const lines = await this.readReflog();
		const from = this._lines ?? lines.length;
		this._lines = lines.length;
		const root = this.active();
		if (!root) {
			return;
		}
		for (const line of lines.slice(Math.max(from, lines.length - MAX_NEW_LINES))) {
			const commit = readReflogCommit(line);
			if (commit) {
				await this.noteCommit(root, commit.sha, commit.rewrite);
			}
		}
	}

	private async noteCommit(root: URI, sha: string, rewrite: boolean): Promise<void> {
		const git = this._git;
		if (!git.commitFiles || !git.showCommitFile || !git.readAttributionNote || !git.writeAttributionNote) {
			return;
		}
		try {
			const files: { [path: string]: ClaudeNoteFile } = Object.create(null);
			for (const path of await git.commitFiles(root.fsPath, sha)) {
				const record = this._attribution.recordFor(joinPath(root, path));
				const text = record ? await git.showCommitFile(root.fsPath, sha, path) : undefined;
				const file = text === undefined ? undefined : noteFileFromRecord(record, textLines(text));
				if (file) {
					files[path] = file;
				}
			}
			let note: ClaudeAttributionNote | undefined = Object.keys(files).length > 0 ? { v: 1, files } : undefined;
			const original = rewrite && git.notedOriginal && git.commitFileId ? await git.notedOriginal(root.fsPath, sha) : undefined;
			if (original) {
				const old = decodeAttributionNote(await git.readAttributionNote(root.fsPath, original));
				const ids = new Map<string, boolean>();
				for (const path of old ? Object.keys(old.files) : []) {
					ids.set(path, !!(await git.commitFileId!(root.fsPath, sha, path)) && await git.commitFileId!(root.fsPath, sha, path) === await git.commitFileId!(root.fsPath, original, path));
				}
				const carried = old && carryAttributionNote(old, path => ids.get(path) === true);
				if (carried) {
					note = { v: 1, files: { ...carried.files, ...note?.files } };
				}
			}
			if (note) {
				await git.writeAttributionNote(root.fsPath, sha, encodeAttributionNote(note));
			}
		} catch (error) {
			this._log.warn(`[claude] attribution note: not written for ${sha.slice(0, 7)}`, error);
		}
	}

	/** The open file has no record here: take it from the newest commit's note that covers the file. */
	private async adoptActive(): Promise<void> {
		const root = this.active();
		const resource = this._editors.activeEditor?.resource;
		const git = this._git;
		if (!root || !resource || resource.scheme !== Schemas.file || this._read.has(resource.toString()) || this._attribution.recordFor(resource)
			|| !git.lastCommitTouching || !git.readAttributionNote || !git.showCommitFile) {
			return;
		}
		const path = relativePath(root, resource);
		if (!path) {
			return;
		}
		this._read.add(resource.toString());
		try {
			const sha = await git.lastCommitTouching(root.fsPath, path);
			const note = sha ? decodeAttributionNote(await git.readAttributionNote(root.fsPath, sha)) : undefined;
			const file = note?.files[path];
			const text = file && sha ? await git.showCommitFile(root.fsPath, sha, path) : undefined;
			if (file && text !== undefined) {
				this._attribution.adoptRecord(resource, recordFromNoteFile(file, textLines(text), Date.now()));
			}
		} catch (error) {
			this._log.warn('[claude] attribution note: not read', error);
		}
	}

	private reflog(): URI {
		return joinPath(this._root!, '.git', 'logs', 'HEAD');
	}

	private async readReflog(): Promise<string[]> {
		try {
			return (await this._files.readFile(this.reflog())).value.toString().split(/\r?\n/).filter(line => line.trim());
		} catch {
			return [];
		}
	}
}
