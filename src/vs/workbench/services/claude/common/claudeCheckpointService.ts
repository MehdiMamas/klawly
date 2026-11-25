/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createFileServiceCheckpointStorage } from '../../../../platform/claude/common/claudeCheckpointFileStorage.js';
import { CheckpointDirtyBuffer, fsPathFromCheckpointUri, mergeTurnCheckpoints, TurnCheckpoint } from '../../../../platform/claude/common/claudeCheckpoints.js';
import { locateGitRepository, parseGitIndex, relativeGitPath } from '../../../../platform/claude/common/claudeGit.js';
import { restoreCheckpointContents } from '../../../../platform/claude/common/claudeCheckpointRestore.js';
import { ClaudeCheckpointStore } from '../../../../platform/claude/common/claudeCheckpointStore.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { ITextFileService } from '../../textfile/common/textfiles.js';

export const IClaudeCheckpointService = createDecorator<IClaudeCheckpointService>('claudeCheckpointService');

export interface IClaudeCheckpointService {
	readonly _serviceBrand: undefined;
	/** Unsaved file-scheme buffers, captured before a turn starts. */
	captureDirtyBuffers(): Promise<readonly CheckpointDirtyBuffer[]>;
	/**
	 * Restores a checkpoint saved for this IDE session. A confirmation lists user
	 * edits that would be overwritten. Returns false when the user declines or
	 * the checkpoint is not on disk.
	 */
	restore(sessionId: string, checkpointId: string): Promise<boolean>;
	/**
	 * Text captured for each file on a turn checkpoint. `text` is empty both when
	 * the file did not exist and when it existed but was empty. `existed` is
	 * false only when the checkpoint hash is null. The review collector decides
	 * which of these are edits.
	 */
	readCheckpointOriginals(sessionId: string, turnId: string): Promise<readonly CheckpointOriginal[]>;
	/**
	 * Each file an agent wrote in these turns (oldest first), with its text before
	 * the first of them and its text now: the open editor's, else the disk's (issue 702).
	 */
	readTurnsChanges(sessionId: string, turnIds: readonly string[]): Promise<readonly CheckpointChange[]>;
	/**
	 * The file paths other chats' turns wrote since this chat's turn began (issue 1054):
	 * the files a rewind of this chat may undo even though another chat also changed them.
	 */
	readOtherChatPaths(sessionId: string, turnId: string, otherSessionIds: readonly string[]): Promise<ReadonlySet<string>>;
	/**
	 * The turns helper (delegated) chats ran since this chat's turn began, per helper, oldest
	 * first (issue 1406): the turns a rewind of this chat's turn undoes with it.
	 */
	readHelperTurnIds(sessionId: string, turnId: string, helperSessionIds: readonly string[]): Promise<readonly CheckpointHelperTurns[]>;
	/** The git HEAD recorded when this turn began, if the folder was a repository (issue 1054). */
	readTurnGitHead(sessionId: string, turnId: string): Promise<string | undefined>;
	/**
	 * Puts every file an agent wrote in these turns back as it was before the first
	 * of them (issue 702). A confirmation lists user edits that would be overwritten.
	 * Returns false when the user declines; true also when no turn wrote a file.
	 */
	restoreTurns(sessionId: string, turnIds: readonly string[], onlyUris?: readonly string[]): Promise<boolean>;
}

/** A file an agent changed over a run of turns: its text before them and now. */
export interface CheckpointChange {
	readonly uri: string;
	readonly existed: boolean;
	readonly originalText: string;
	/** Empty when the file is gone. */
	readonly currentText: string;
}

/** The turns one helper chat ran that a rewind of its parent's turn also undoes. */
export interface CheckpointHelperTurns {
	readonly sessionId: string;
	readonly turnIds: readonly string[];
}

export interface CheckpointOriginal {
	readonly uri: string;
	readonly text: string;
	/**
	 * False when `hash` was null: the file was not on disk before the turn.
	 * An existing empty file still has a hash, so this stays true.
	 */
	readonly existed: boolean;
	readonly capturedAs?: 'buffer' | 'write';
	readonly afterHash?: string | null;
	/**
	 * File bytes after the approved write. Absent when that blob was not stored.
	 * `''` means the write removed the file.
	 */
	readonly afterText?: string;
}

export class ClaudeCheckpointService extends Disposable implements IClaudeCheckpointService {
	declare readonly _serviceBrand: undefined;

	private readonly _checkpoints: ClaudeCheckpointStore;
	private _indexReadError: string | undefined;

	/** Set when restore could see a recorded index blob but could not read the index. */
	gitIndexReadError(): string | undefined {
		return this._indexReadError;
	}

	constructor(
		userDataPath: string,
		private readonly _files: IFileService,
		private readonly _textFiles: ITextFileService,
		private readonly _dialogs: IDialogService,
		private readonly _checkpointsEnabled: () => boolean = () => true,
		private readonly _log: (message: string) => void = () => undefined,
	) {
		super();
		this._checkpoints = new ClaudeCheckpointStore(userDataPath, createFileServiceCheckpointStorage(_files), { log: message => this._log(message) });
	}

	async captureDirtyBuffers(): Promise<readonly CheckpointDirtyBuffer[]> {
		if (!this._checkpointsEnabled()) {
			return [];
		}
		const buffers: CheckpointDirtyBuffer[] = [];
		for (const model of this._textFiles.files.models) {
			if (!model.isResolved() || model.resource.scheme !== Schemas.file || !model.isDirty()) {
				continue;
			}
			buffers.push({ path: model.resource.fsPath, text: model.textEditorModel.getValue() });
		}
		return buffers;
	}

	async restore(sessionId: string, checkpointId: string): Promise<boolean> {
		const checkpoint = await this._checkpoints.readCheckpoint(sessionId, checkpointId);
		if (!checkpoint) {
			return false;
		}
		return this.restoreCheckpoint(checkpoint, localize('claudeRestoreCheckpoint', "Restore this checkpoint?"));
	}

	async restoreTurns(sessionId: string, turnIds: readonly string[], onlyUris?: readonly string[]): Promise<boolean> {
		const checkpoint = await this.readTurnsCheckpoint(sessionId, turnIds);
		if (!checkpoint) {
			return true;
		}
		if (onlyUris) {
			// Per-file choice (issue 818): only the picked files go back.
			const picked = new Set(onlyUris);
			checkpoint.files = checkpoint.files.filter(file => picked.has(file.uri));
			if (checkpoint.files.length === 0) {
				return true;
			}
		}
		return this.restoreCheckpoint(checkpoint, localize('claudeRewindOverwrite', "Overwrite the later edits to these files too?"));
	}

	async readTurnsChanges(sessionId: string, turnIds: readonly string[]): Promise<readonly CheckpointChange[]> {
		const checkpoint = await this.readTurnsCheckpoint(sessionId, turnIds);
		if (!checkpoint) {
			return [];
		}
		const changes: CheckpointChange[] = [];
		for (const file of checkpoint.files) {
			const originalText = file.hash ? new TextDecoder().decode(await this._checkpoints.readBlob(file.hash)) : '';
			changes.push({ uri: file.uri, existed: !!file.hash, originalText, currentText: await this.currentText(file.uri) });
		}
		return changes;
	}

	async readOtherChatPaths(sessionId: string, turnId: string, otherSessionIds: readonly string[]): Promise<ReadonlySet<string>> {
		const since = (await this._checkpoints.readCheckpoint(sessionId, turnId))?.createdAt;
		const paths = new Set<string>();
		if (since === undefined) {
			return paths;
		}
		for (const otherId of otherSessionIds) {
			if (otherId === sessionId) {
				continue;
			}
			for (const checkpoint of await this._checkpoints.listCheckpoints(otherId)) {
				if (checkpoint.createdAt >= since) {
					for (const file of checkpoint.files) {
						paths.add(URI.parse(file.uri).fsPath);
					}
				}
			}
		}
		return paths;
	}

	async readHelperTurnIds(sessionId: string, turnId: string, helperSessionIds: readonly string[]): Promise<readonly CheckpointHelperTurns[]> {
		const since = (await this._checkpoints.readCheckpoint(sessionId, turnId))?.createdAt;
		const helpers: CheckpointHelperTurns[] = [];
		if (since === undefined) {
			return helpers;
		}
		for (const helperId of helperSessionIds) {
			if (helperId === sessionId) {
				continue;
			}
			const turnIds = (await this._checkpoints.listCheckpoints(helperId))
				.filter(checkpoint => checkpoint.createdAt >= since && checkpoint.files.length > 0)
				.sort((a, b) => a.createdAt - b.createdAt)
				.map(checkpoint => checkpoint.turnId);
			if (turnIds.length > 0) {
				helpers.push({ sessionId: helperId, turnIds });
			}
		}
		return helpers;
	}

	async readTurnGitHead(sessionId: string, turnId: string): Promise<string | undefined> {
		return (await this._checkpoints.readCheckpoint(sessionId, turnId))?.gitHead;
	}

	/** The checkpoints of these turns that are on disk, merged into one. */
	private async readTurnsCheckpoint(sessionId: string, turnIds: readonly string[]): Promise<TurnCheckpoint | undefined> {
		const checkpoints: TurnCheckpoint[] = [];
		for (const turnId of turnIds) {
			const checkpoint = await this._checkpoints.readCheckpoint(sessionId, turnId);
			if (checkpoint) {
				checkpoints.push(checkpoint);
			}
		}
		return mergeTurnCheckpoints(checkpoints);
	}

	/** An open editor's text, unsaved edits included; else the file on disk; empty when it is gone. */
	private async currentText(uri: string): Promise<string> {
		const resource = URI.parse(uri);
		const model = this._textFiles.files.models.find(candidate => candidate.isResolved() && candidate.resource.toString() === resource.toString());
		if (model?.isResolved()) {
			return model.textEditorModel.getValue();
		}
		try {
			return (await this._files.readFile(resource)).value.toString();
		} catch {
			return '';
		}
	}

	private async restoreCheckpoint(checkpoint: TurnCheckpoint, message: string): Promise<boolean> {
		const documents = [];
		for (const model of this._textFiles.files.models) {
			if (!model.isResolved() || model.resource.scheme !== Schemas.file) {
				continue;
			}
			const resolved = model;
			documents.push({
				uri: resolved.resource.toString(),
				getText: () => resolved.textEditorModel.getValue(),
				isDirty: () => resolved.isDirty(),
				replaceText: (value: string) => replaceCheckpointText(resolved.textEditorModel, value),
				revert: () => resolved.revert({ force: true }),
				close: async () => {
					try {
						await resolved.revert({ force: true });
					} catch {
						// The file is already gone.
					}
					resolved.dispose();
				},
			});
		}
		const result = await restoreCheckpointContents({
			checkpoint,
			documents,
			readBlob: hash => this._checkpoints.readBlob(hash),
			readDisk: async uri => {
				const resource = URI.parse(uri);
				if (!await this._files.exists(resource)) {
					return null;
				}
				return (await this._files.readFile(resource)).value.buffer;
			},
			indexBlobs: await this.currentIndexBlobs(checkpoint),
			writeDisk: async (uri, bytes) => {
				// A file an agent changed on an SSH host is restored there, through its `claude-remote:` provider.
				const parsed = URI.parse(uri);
				const resource = parsed.scheme === Schemas.file ? URI.file(fsPathFromCheckpointUri(uri)) : parsed;
				if (bytes === null) {
					if (await this._files.exists(resource)) {
						await this._files.del(resource);
					}
					return;
				}
				await this._files.writeFile(resource, VSBuffer.wrap(bytes));
			},
			confirm: async conflicts => {
				const listed = conflicts.map(conflict => conflict.label).join('\n');
				const answer = await this._dialogs.confirm({
					type: 'warning',
					message,
					detail: localize('claudeRestoreCheckpointDetail', "These files changed after the checkpoint and will be overwritten:\n\n{0}", listed),
					primaryButton: localize('claudeRestoreCheckpointButton', "Restore"),
				});
				return answer.confirmed;
			},
		});
		return result === 'restored';
	}

	/**
	 * Staged blob ids for files whose snapshot recorded the index. Missing when
	 * the index cannot be read. Restore still does not write the index.
	 */
	private async currentIndexBlobs(checkpoint: TurnCheckpoint): Promise<ReadonlyMap<string, string | null> | undefined> {
		if (!checkpoint.files.some(file => file.indexBlob !== undefined)) {
			return undefined;
		}
		const start = checkpoint.files.find(file => file.indexBlob !== undefined);
		if (!start) {
			return undefined;
		}
		const located = await locateGitRepository(fsPathFromCheckpointUri(start.uri), path => this.readGitText(path));
		if (!located) {
			return undefined;
		}
		let parsed: Map<string, string> | undefined;
		try {
			parsed = parseGitIndex((await this._files.readFile(URI.file(join(located.gitDir, 'index')))).value.buffer);
		} catch {
			this.rememberIndexError('Git index could not be read.');
			return undefined;
		}
		if (!parsed) {
			this.rememberIndexError('Git index could not be parsed.');
			return undefined;
		}
		this.rememberIndexError(undefined);
		const blobs = new Map<string, string | null>();
		for (const file of checkpoint.files) {
			if (file.indexBlob === undefined) {
				continue;
			}
			const rel = relativeGitPath(located.workTree, fsPathFromCheckpointUri(file.uri));
			if (!rel) {
				continue;
			}
			blobs.set(file.uri, parsed.get(rel) ?? null);
		}
		return blobs;
	}

	private rememberIndexError(message: string | undefined): void {
		this._indexReadError = message;
		if (message) {
			this._log(message);
		}
	}

	private async readGitText(path: string): Promise<string | undefined> {
		try {
			return (await this._files.readFile(URI.file(path))).value.toString();
		} catch {
			return undefined;
		}
	}

	async readCheckpointOriginals(sessionId: string, turnId: string): Promise<readonly CheckpointOriginal[]> {
		const checkpoint = await this._checkpoints.readCheckpoint(sessionId, turnId);
		if (!checkpoint) {
			return [];
		}
		const originals: CheckpointOriginal[] = [];
		for (const file of checkpoint.files) {
			let text = '';
			if (file.hash) {
				text = new TextDecoder().decode(await this._checkpoints.readBlob(file.hash));
			}
			let afterText: string | undefined;
			if (file.afterHash === null) {
				afterText = '';
			} else if (file.afterHash) {
				try {
					afterText = new TextDecoder().decode(await this._checkpoints.readBlob(file.afterHash));
				} catch {
					afterText = undefined;
				}
			}
			originals.push({
				uri: file.uri,
				text,
				// A missing or null hash is a file that was not there. Empty contents still have a hash.
				existed: file.hash !== undefined && file.hash !== null,
				capturedAs: file.capturedAs,
				afterHash: file.afterHash,
				afterText,
			});
		}
		return originals;
	}
}

/** One undo stop around a whole-document replace. `applyEdits` does not enter the undo stack. */
export function replaceCheckpointText(model: ITextModel, value: string): void {
	model.pushStackElement();
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
	model.pushStackElement();
}
