/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { AgentMode, ContextAttachment, GitDiffScope } from '../../../../platform/claude/common/claudeContext.js';
import { GitContext, summarizeGitContext, summarizeGitHistory } from '../../../../platform/claude/common/claudeGit.js';
import { ContextReaders, formatLineAlignedDiff, resolveContextEnvelope } from '../../../../platform/claude/common/claudeContextResolve.js';
import { klawlyPlanDirectory } from '../../../../platform/claude/common/claudePlanFiles.js';
import { ActiveFileContext, AgentEnvelope, CLAUDE_ATTACHMENT_CHAR_LIMIT, compileSubmission, DiagnosticSummary, ResolvedAttachment } from '../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IClaudeContextService } from '../../../services/claude/common/claudeContextService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT } from '../../../../platform/claude/common/claudeChatReference.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../scm/common/scm.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { claudeHistoryRange } from './claudeGitHistory.js';
import { imageMimeForName, isImageName } from '../common/claudeImageAttachments.js';

const MAX_MARKERS = 50;
const MAX_GIT_FILES = 40;

export class ClaudeContextService implements IClaudeContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IModelService private readonly _models: IModelService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IFileService private readonly _files: IFileService,
		@IMarkerService private readonly _markers: IMarkerService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IEditorService private readonly _editors: IEditorService,
		@ISCMService private readonly _scm: ISCMService,
		@ITerminalService private readonly _terminals: ITerminalService,
		@IEnvironmentService private readonly _environment: IEnvironmentService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IPathService private readonly _paths: IPathService,
		@IProductService private readonly _product: IProductService,
	) { }

	resolve(userText: string, mode: AgentMode, attachments: readonly ContextAttachment[], sessionId?: string): Promise<AgentEnvelope> {
		return resolveContextEnvelope(userText, mode, attachments, this.readers(), sessionId);
	}

	async preview(userText: string, mode: AgentMode, attachments: readonly ContextAttachment[], sessionId?: string): Promise<string> {
		return compileSubmission(await this.resolve(userText, mode, attachments, sessionId));
	}

	async storeImage(bytes: Uint8Array, mime: string, name?: string): Promise<ContextAttachment> {
		const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'png';
		const uri = URI.joinPath(this._environment.userRoamingDataHome, 'claude-attachments', `${generateUuid()}.${ext}`);
		await this._files.createFolder(URI.joinPath(this._environment.userRoamingDataHome, 'claude-attachments'));
		await this._files.writeFile(uri, VSBuffer.wrap(bytes));
		return { kind: 'image', localUri: uri.toString(), ...(name ? { name } : {}) };
	}

	async copyExternalFile(uri: URI): Promise<ContextAttachment> {
		const name = uri.path.split('/').pop() || 'file';
		if (isImageName(name)) {
			const bytes = await this._files.readFile(uri);
			return this.storeImage(bytes.value.buffer, imageMimeForName(name), name);
		}
		const read = await this.readDisk(uri);
		const text = read?.content ?? '';
		return { kind: 'pasted-text', id: generateUuid(), text, lineCount: text.split('\n').length };
	}

	private async readChat(attachment: Extract<ContextAttachment, { kind: 'chat' }>, composerSessionId?: string): Promise<ResolvedAttachment> {
		const configured = this._configuration.getValue<number>(CLAUDE_CHAT_REFERENCE_SUMMARY_SETTING);
		const summaryChars = typeof configured === 'number' && configured > 0 ? configured : CLAUDE_CHAT_REFERENCE_SUMMARY_DEFAULT;
		const sessionId = composerSessionId ?? this._agent.getCurrentSession()?.id;
		if (!sessionId) {
			return { kind: 'chat', sessionId: attachment.sessionId, reference: { title: attachment.title ?? attachment.sessionId, sessionId: attachment.sessionId, turnStart: 1, turnEnd: attachment.asOfTurn, asOfTurn: attachment.asOfTurn, path: '', summary: '', scope: attachment.scope, deleted: true, otherWorkspace: false } };
		}
		const reference = await this._agent.prepareChatReference(sessionId, attachment, summaryChars);
		return { kind: 'chat', sessionId: attachment.sessionId, reference, large: (reference.fullTranscript ?? '').length > summaryChars };
	}

	private readers(): ContextReaders {
		return {
			relativePath: uri => this.relativePath(URI.parse(uri)),
			readText: uri => this.readText(URI.parse(uri)),
			readMarkers: (uri, severity) => Promise.resolve(this.readMarkers(uri ? URI.parse(uri) : undefined, severity)),
			readGit: (scope, path) => this.readGit(scope, path),
			readTerminal: (terminalId, lines) => Promise.resolve(this.readTerminal(terminalId, lines)),
			activeEditor: () => this.activeEditor(),
			workspaceRoot: () => this.workspaceRoot(),
			planFolder: async () => klawlyPlanDirectory((await this._paths.userHome()).fsPath, this._product.dataFolderName),
			readChat: (attachment, composerSessionId) => this.readChat(attachment, composerSessionId),
		};
	}

	private relativePath(uri: URI): string {
		return workspaceRelativePath(uri, this._workspace);
	}

	private workspaceRoot(): string {
		return this._workspace.getWorkspace().folders.find(folder => folder.uri.scheme === 'file')?.uri.fsPath ?? '';
	}

	private async readText(uri: URI): Promise<{ content: string; languageId?: string; versionId?: number; unsaved: boolean } | undefined> {
		const model = this._models.getModel(uri);
		if (model) {
			return {
				content: model.getValue(),
				languageId: model.getLanguageId(),
				versionId: model.getVersionId(),
				unsaved: this._textFiles.isDirty(uri),
			};
		}
		return this.readDisk(uri);
	}

	private async readDisk(uri: URI): Promise<{ content: string; languageId?: string; versionId?: number; unsaved: boolean } | undefined> {
		try {
			const file = await this._files.readFile(uri, { limits: { size: CLAUDE_ATTACHMENT_CHAR_LIMIT * 4 } });
			if (file.value.buffer.includes(0)) {
				return undefined;
			}
			return { content: file.value.toString(), unsaved: false };
		} catch {
			return undefined;
		}
	}

	private readMarkers(uri: URI | undefined, severity: readonly number[] | undefined): DiagnosticSummary[] {
		const severities = severity && severity.length > 0 ? severity.reduce((mask, value) => mask | value, 0) : undefined;
		const markers = this._markers.read({ resource: uri, severities, take: MAX_MARKERS });
		return markers.slice(0, MAX_MARKERS).map(marker => ({
			path: this.relativePath(marker.resource),
			severity: MarkerSeverity.toString(marker.severity) || String(marker.severity),
			message: marker.message,
			line: marker.startLineNumber,
		}));
	}

	private async readGit(scope: GitDiffScope, path?: string, ref?: string): Promise<{ stat: string; patch: string; truncated: boolean }> {
		if (scope === 'branch' || scope === 'commit') {
			return this.readGitHistory(scope, path, ref);
		}
		const staged: ISCMResource[] = [];
		const working: ISCMResource[] = [];
		const untracked: string[] = [];
		let branch: string | undefined;
		let head: string | undefined;
		for (const repository of this._scm.repositories) {
			const ref = repository.provider.historyProvider.get()?.historyItemRef.get();
			branch ??= ref?.name;
			head ??= ref?.revision ?? ref?.id;
			for (const group of repository.provider.groups) {
				const kind = gitGroupKind(group.id, group.label);
				if (scope === 'staged' && kind !== 'staged') {
					continue;
				}
				if (scope === 'working-tree' && kind === 'staged') {
					continue;
				}
				for (const resource of group.resources) {
					if (!this.matchesGitPath(resource, path)) {
						continue;
					}
					if (kind === 'untracked') {
						untracked.push(this.relativePath(resource.sourceUri));
					} else if (kind === 'staged') {
						staged.push(resource);
					} else {
						working.push(resource);
					}
				}
			}
		}
		const stagedShown = staged.slice(0, MAX_GIT_FILES);
		const workingShown = working.slice(0, MAX_GIT_FILES);
		const workingUris = new Set(working.map(resource => resource.sourceUri.toString()));
		const context: GitContext = {
			branch,
			head,
			stagedPaths: staged.map(resource => this.relativePath(resource.sourceUri)),
			workingPaths: working.map(resource => this.relativePath(resource.sourceUri)),
			stagedPatch: await this.gitPatch(stagedShown, this.repositoryFor(stagedShown[0]), 'staged', workingUris),
			workingPatch: await this.gitPatch(workingShown, this.repositoryFor(workingShown[0]), 'working', workingUris),
			untrackedPaths: untracked,
		};
		const summary = summarizeGitContext(context);
		return {
			stat: summary.stat,
			patch: summary.patch,
			truncated: summary.truncated || staged.length > stagedShown.length || working.length > workingShown.length,
		};
	}

	/** A branch diff or one commit: the before and after sides come from the SCM history provider. */
	private async readGitHistory(scope: 'branch' | 'commit', path: string | undefined, ref: string | undefined): Promise<{ stat: string; patch: string; truncated: boolean }> {
		const range = await claudeHistoryRange(this._scm, scope, ref, CancellationToken.None);
		if (!range) {
			return { stat: scope === 'branch' ? 'branch: no base to compare with' : `commit ${ref ?? ''}: not found`.trim(), patch: '', truncated: false };
		}
		const changes = range.changes.filter(entry => !path || entry.uri.toString() === path || entry.uri.fsPath === path || this.relativePath(entry.uri) === path);
		const shown = changes.slice(0, MAX_GIT_FILES);
		const parts: string[] = [];
		let used = 0;
		for (const { uri, change } of shown) {
			if (used > CLAUDE_ATTACHMENT_CHAR_LIMIT) {
				parts.push('…');
				break;
			}
			const before = change.originalUri ? await this.readText(change.originalUri) : undefined;
			const after = change.modifiedUri ? await this.readText(change.modifiedUri) : undefined;
			const relative = this.relativePath(uri);
			if (!after?.content && !before?.content) {
				parts.push(relative);
				continue;
			}
			const body = formatLineAlignedDiff(relative, before?.content ?? '', after?.content ?? '');
			parts.push(body);
			used += body.length;
		}
		const summary = summarizeGitHistory({ header: range.header, paths: changes.map(entry => this.relativePath(entry.uri)), patch: parts.join('\n') });
		return { ...summary, truncated: summary.truncated || changes.length > shown.length };
	}

	private matchesGitPath(resource: ISCMResource, path: string | undefined): boolean {
		if (!path) {
			return true;
		}
		return resource.sourceUri.toString() === path
			|| resource.sourceUri.fsPath === path
			|| this.relativePath(resource.sourceUri) === path;
	}

	private repositoryFor(resource: ISCMResource | undefined): ISCMRepository | undefined {
		if (!resource) {
			return undefined;
		}
		for (const repository of this._scm.repositories) {
			if (repository.provider === resource.resourceGroup.provider) {
				return repository;
			}
		}
		return undefined;
	}

	private async gitPatch(resources: readonly ISCMResource[], repository: ISCMRepository | undefined, side: 'staged' | 'working', workingUris: ReadonlySet<string>): Promise<string> {
		if (resources.length === 0) {
			return '';
		}
		const parts: string[] = [];
		let used = 0;
		for (const resource of resources) {
			if (used > CLAUDE_ATTACHMENT_CHAR_LIMIT) {
				return `${parts.join('\n')}\n…`;
			}
			const path = this.relativePath(resource.sourceUri);
			const afterUri = this.gitAfterUri(resource, side, workingUris);
			if (!afterUri) {
				parts.push(`${path} (staged content unavailable)`);
				continue;
			}
			const beforeUri = resource.multiDiffEditorOriginalUri ?? (repository ? await repository.provider.getOriginalResource(resource.sourceUri) : null);
			const before = beforeUri ? await this.readText(beforeUri) : undefined;
			const after = await this.readText(afterUri);
			if (!after?.content && !before?.content) {
				parts.push(path);
				continue;
			}
			const body = formatLineAlignedDiff(path, before?.content ?? '', after?.content ?? '');
			parts.push(body);
			used += body.length;
		}
		return parts.join('\n');
	}

	/**
	 * Staged patches use the index side of the resource. The working-tree file
	 * is the after side only for working-group resources, and for a staged
	 * resource that is not also modified in the working tree.
	 */
	private gitAfterUri(resource: ISCMResource, side: 'staged' | 'working', workingUris: ReadonlySet<string>): URI | undefined {
		if (side === 'working') {
			return resource.sourceUri;
		}
		const modified = resource.multiDiffEditorModifiedUri;
		if (modified && modified.toString() !== resource.sourceUri.toString()) {
			return modified;
		}
		if (workingUris.has(resource.sourceUri.toString())) {
			return undefined;
		}
		return modified ?? resource.sourceUri;
	}

	private readTerminal(terminalId: number, lines: number): { title: string; text: string; truncated: boolean } | undefined {
		const instance = this._terminals.instances.find(candidate => candidate.instanceId === terminalId);
		if (!instance) {
			return undefined;
		}
		const xterm = instance.xterm;
		if (!xterm) {
			return { title: instance.title || 'Terminal', text: '', truncated: false };
		}
		const wanted = Math.max(1, Math.min(lines, 200));
		const reversed: string[] = [];
		for (const line of xterm.getBufferReverseIterator()) {
			reversed.push(line);
			if (reversed.length > wanted) {
				break;
			}
		}
		const truncated = reversed.length > wanted;
		const text = reversed.slice(0, wanted).reverse().join('\n');
		return { title: instance.title || 'Terminal', text, truncated };
	}

	private activeEditor(): ActiveFileContext | undefined {
		const control = this._editors.activeTextEditorControl;
		if (!isCodeEditor(control)) {
			return undefined;
		}
		const model = control.getModel();
		const position = control.getPosition();
		if (!model || !position) {
			return undefined;
		}
		const selection = control.getSelection();
		const selected = selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined;
		return {
			relativePath: this.relativePath(model.uri),
			cursorLine: position.lineNumber,
			selection: selected,
		};
	}
}

export function isInsideWorkspace(uri: URI, workspace: IWorkspaceContextService): boolean {
	return workspace.getWorkspace().folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(uri, folder.uri));
}

export function workspaceRelativePath(uri: URI, workspace: IWorkspaceContextService): string {
	for (const folder of workspace.getWorkspace().folders) {
		if (extUriBiasedIgnorePathCase.isEqualOrParent(uri, folder.uri)) {
			return extUriBiasedIgnorePathCase.relativePath(folder.uri, uri) || uri.fsPath;
		}
	}
	return uri.fsPath;
}

function gitGroupKind(id: string, label: string): 'staged' | 'untracked' | 'working' {
	const text = `${id} ${label}`.toLowerCase();
	if (text.includes('index') || text.includes('staged')) {
		return 'staged';
	}
	if (text.includes('untracked')) {
		return 'untracked';
	}
	return 'working';
}
