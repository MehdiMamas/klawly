/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { ISCMResource, ISCMResourceGroup, ISCMService } from '../../../scm/common/scm.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { actionTurnLabel } from '../../../../../platform/claude/common/claudePrompt.js';
import { EMPTY_AGENT_VIEW_STATE, reduceAgentState, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeDelegateCard } from '../../../../services/claude/common/claudeDelegationModel.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ReviewFile, TurnReview } from '../../../../services/claude/common/claudeReview.js';
import { ClaudeActionService } from '../../browser/claudeActionService.js';
import { ClaudeContextService } from '../../browser/claudeContextService.js';
import { commitMessageAfterRun, registerClaudeGitActions, runCommitAcceptedChanges } from '../../browser/claudeGitActions.js';
import { CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID } from '../../common/claudeViews.js';
import { ClaudeReviewCardController, renderClaudeChangesCard } from '../../browser/review/claudeChangesCard.js';

suite('Claude git actions', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('readGit uses the index for staged content and keeps names when the patch is filtered', async () => {
		const root = URI.file(isWindows ? 'C:\\repo' : '/repo');
		const file = URI.joinPath(root, 'a.ts');
		const other = URI.joinPath(root, 'b.ts');
		const untracked = URI.joinPath(root, 'notes.txt');
		const head = URI.from({ scheme: 'git', path: file.path, query: 'HEAD' });
		const index = URI.from({ scheme: 'git', path: file.path, query: 'index' });
		const texts = new Map<string, string>([
			[head.toString(), 'base'],
			[index.toString(), 'STAGED-LINE'],
			[file.toString(), 'WORKING-LINE'],
			[other.toString(), 'other-base'],
			[untracked.toString(), 'UNTRACKED-SECRET'],
		]);
		const indexGroup = group('index', 'Staged Changes');
		const workingGroup = group('workingTree', 'Changes');
		const untrackedGroup = group('untracked', 'Untracked');
		const provider = {
			groups: [indexGroup, workingGroup, untrackedGroup],
			historyProvider: { get: () => ({ historyItemRef: { get: () => ({ name: 'main', revision: 'abcdef1234567890' }) } }) },
			getOriginalResource: async () => null,
		};
		indexGroup.resources = [
			resource(file, indexGroup, head, index),
		];
		workingGroup.resources = [
			resource(file, workingGroup, index, file),
			resource(other, workingGroup, undefined, other),
		];
		untrackedGroup.resources = [
			resource(untracked, untrackedGroup),
		];
		const service = new ClaudeContextService(
			{ getModel: () => undefined } as unknown as IModelService,
			{} as ITextFileService,
			{ readFile: async (resource: URI) => ({ value: VSBuffer.fromString(required(texts, resource.toString())) }) } as unknown as IFileService,
			{ read: () => [] } as unknown as IMarkerService,
			{ getWorkspace: () => ({ folders: [{ uri: root }] }) } as unknown as IWorkspaceContextService,
			{} as IEditorService,
			{ repositories: [{ provider }] } as unknown as ISCMService,
			{ instances: [] } as unknown as ITerminalService,
			{} as IEnvironmentService,
			{} as IClaudeAgentService,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			{} as IPathService,
			{} as IProductService,
		);

		const staged = await service.resolve('', 'agent', [{ kind: 'git-diff', scope: 'staged' }]);
		const stagedGit = staged.attachments[0];
		assert.strictEqual(stagedGit.kind, 'git-diff');
		if (stagedGit.kind === 'git-diff') {
			assert.ok(stagedGit.patch.includes('STAGED-LINE'), stagedGit.patch);
			assert.ok(!stagedGit.patch.includes('WORKING-LINE'), stagedGit.patch);
			assert.ok(stagedGit.stat.includes('a.ts'), stagedGit.stat);
			assert.ok(stagedGit.stat.includes('staged: 1'), stagedGit.stat);
			assert.ok(!stagedGit.stat.includes('notes.txt'), stagedGit.stat);
		}

		const working = await service.resolve('', 'agent', [{ kind: 'git-diff', scope: 'working-tree', path: 'b.ts' }]);
		const workingGit = working.attachments[0];
		assert.strictEqual(workingGit.kind, 'git-diff');
		if (workingGit.kind === 'git-diff') {
			assert.ok(workingGit.patch.includes('other-base'), workingGit.patch);
			assert.ok(!workingGit.patch.includes('STAGED-LINE'), workingGit.patch);
			assert.ok(!workingGit.patch.includes('WORKING-LINE'), workingGit.patch);
			assert.ok(workingGit.stat.includes('b.ts'), workingGit.stat);
			assert.ok(!workingGit.stat.includes('a.ts\n') && !workingGit.stat.endsWith('a.ts'), workingGit.stat);
		}

		const all = await service.resolve('', 'agent', [{ kind: 'git-diff', scope: 'all' }]);
		const allGit = all.attachments[0];
		assert.strictEqual(allGit.kind, 'git-diff');
		if (allGit.kind === 'git-diff') {
			assert.ok(allGit.stat.includes('notes.txt'), allGit.stat);
			assert.ok(allGit.stat.includes('untracked: 1'), allGit.stat);
			assert.ok(!allGit.patch.includes('UNTRACKED-SECRET'), allGit.patch);
			assert.ok(allGit.patch.includes('WORKING-LINE'), allGit.patch);
		}
	});

	test('a staged file that is also modified says the staged content is unavailable', async () => {
		const root = URI.file(isWindows ? 'C:\\repo' : '/repo');
		const file = URI.joinPath(root, 'both.ts');
		const head = URI.from({ scheme: 'git', path: file.path, query: 'HEAD' });
		const indexGroup = group('index', 'Staged Changes');
		const workingGroup = group('workingTree', 'Changes');
		indexGroup.resources = [resource(file, indexGroup, head, file)];
		workingGroup.resources = [resource(file, workingGroup, head, file)];
		const service = new ClaudeContextService(
			{ getModel: () => undefined } as unknown as IModelService,
			{} as ITextFileService,
			{ readFile: async (resource: URI) => ({ value: VSBuffer.fromString(resource.toString()) }) } as unknown as IFileService,
			{ read: () => [] } as unknown as IMarkerService,
			{ getWorkspace: () => ({ folders: [{ uri: root }] }) } as IWorkspaceContextService,
			{} as IEditorService,
			{ repositories: [{ provider: { groups: [indexGroup, workingGroup], historyProvider: { get: () => undefined }, getOriginalResource: async () => null } }] } as unknown as ISCMService,
			{ instances: [] } as unknown as ITerminalService,
			{} as IEnvironmentService,
			{} as IClaudeAgentService,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			{} as IPathService,
			{} as IProductService,
		);
		const staged = await service.resolve('', 'agent', [{ kind: 'git-diff', scope: 'all' }]);
		const git = staged.attachments[0];
		assert.strictEqual(git.kind, 'git-diff');
		if (git.kind === 'git-diff') {
			assert.ok(git.patch.includes('(staged content unavailable)'), git.patch);
		}
	});

	test('explain diff and explain commit do not send when there is nothing to explain', async () => {
		const infos: string[] = [];
		const submitted: string[] = [];
		let resolves = 0;
		const session = { id: 's', mode: 'agent' as const, attachments: [] as [] };
		const agent = {
			getCurrentSession: () => session,
			createSession: () => session,
			submit: async (_id: string, text: string) => { submitted.push(text); },
		} as unknown as IClaudeAgentService;
		const service = new ClaudeActionService(
			agent,
			{
				resolve: async () => {
					resolves++;
					return {
						userText: '',
						mode: 'agent' as const,
						workspaceRoot: '/repo',
						attachments: [{ kind: 'git-diff' as const, scope: 'all' as const, stat: 'staged: 0\nworking: 0\nuntracked: 0', patch: '', truncated: false }],
						diagnostics: [],
						instructionFiles: [],
					};
				},
			} as unknown as ClaudeContextService,
			{} as IEditorService,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file(isWindows ? 'C:\\repo' : '/repo') }] }) } as IWorkspaceContextService,
			{ getValue: () => true } as unknown as IConfigurationService,
			{ info: (message: string) => infos.push(message), error: () => undefined } as unknown as INotificationService,
			new TestDialogService(),
		);
		await service.run({ id: 'explainDiff', source: 'menu', attachments: [] });
		await service.run({ id: 'explainCommit', source: 'menu', attachments: [] });
		assert.strictEqual(resolves, 0);
		assert.strictEqual(submitted.length, 0);
		assert.ok(infos.some(message => message.includes('Choose a changed file')));
		assert.ok(infos.some(message => message.includes('Choose a commit')));
		await service.run({ id: 'explainDiff', source: 'menu', attachments: [{ kind: 'git-diff', scope: 'working-tree' }] });
		await service.run({ id: 'reviewChanges', source: 'button', attachments: [{ kind: 'git-diff', scope: 'all' }] });
		assert.strictEqual(submitted.length, 0);
		assert.ok(infos.some(message => message.includes('nothing to explain')));
		assert.ok(infos.some(message => message.includes('no changes to review')));
	});

	test('generate commit message does not send when its diff is empty', async () => {
		const infos: string[] = [];
		const submitted: string[] = [];
		const session = { id: 's', mode: 'agent' as const, attachments: [] as [] };
		const service = new ClaudeActionService(
			{
				getCurrentSession: () => session,
				createSession: () => session,
				submit: async (_id: string, text: string) => { submitted.push(text); },
			} as unknown as IClaudeAgentService,
			{
				resolve: async () => ({
					userText: '',
					mode: 'agent' as const,
					workspaceRoot: '/repo',
					attachments: [{ kind: 'git-diff' as const, scope: 'working-tree' as const, stat: 'working: 0\nuntracked: 0', patch: '', truncated: false }],
					diagnostics: [],
					instructionFiles: [],
				}),
			} as unknown as ClaudeContextService,
			{} as IEditorService,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file(isWindows ? 'C:\\repo' : '/repo') }] }) } as IWorkspaceContextService,
			{ getValue: () => true } as unknown as IConfigurationService,
			{ info: (message: string) => infos.push(message), error: () => undefined } as unknown as INotificationService,
			new TestDialogService(),
		);
		await service.run({ id: 'generateCommitMessage', source: 'button', attachments: [{ kind: 'git-diff', scope: 'working-tree' }] });
		assert.deepStrictEqual({ submitted, infos }, { submitted: [], infos: ['There are no changes to commit.'] });
	});

	test('the /commit-message command writes the message for the uncommitted changes when nothing is staged (issue 748)', async () => {
		const infos: string[] = [];
		const submitted: string[] = [];
		const scopes: string[] = [];
		const session = { id: 's', mode: 'agent' as const, attachments: [] as [] };
		const service = new ClaudeActionService(
			{
				getCurrentSession: () => session,
				createSession: () => session,
				submit: async (_id: string, text: string) => { submitted.push(text); },
			} as unknown as IClaudeAgentService,
			{
				resolve: async (_text: string, _mode: string, attachments: readonly { kind: string; scope?: 'staged' | 'working-tree' }[]) => {
					const scope = attachments.find(attachment => attachment.kind === 'git-diff')?.scope ?? 'staged';
					scopes.push(scope);
					return {
						userText: '',
						mode: 'agent' as const,
						workspaceRoot: '/repo',
						attachments: [scope === 'staged'
							? { kind: 'git-diff' as const, scope, stat: 'staged: 0', patch: '', truncated: false }
							: { kind: 'git-diff' as const, scope, stat: 'working: 1\nuntracked: 0', patch: 'diff --git a/a.ts b/a.ts', truncated: false }],
						diagnostics: [],
						instructionFiles: [],
					};
				},
			} as unknown as ClaudeContextService,
			{} as IEditorService,
			{ getWorkspace: () => ({ folders: [{ uri: URI.file(isWindows ? 'C:\repo' : '/repo') }] }) } as IWorkspaceContextService,
			{ getValue: () => true } as unknown as IConfigurationService,
			{ info: (message: string) => infos.push(message), error: () => undefined } as unknown as INotificationService,
			new TestDialogService(),
		);
		await service.run({ id: 'generateCommitMessage', source: 'palette', attachments: [] });
		assert.deepStrictEqual({ scopes, submitted: submitted.length, infos }, { scopes: ['staged', 'working-tree'], submitted: 1, infos: [] });
	});

	test('commit message waits for a completed turn and ignores a lookalike label', async () => {
		const label = actionTurnLabel('generateCommitMessage', { kind: 'prompt', templateId: 'generate-commit-message' });
		const emitter = disposables.add(new Emitter<{ sessionId: string }>());
		let turns: TurnViewModel[] = [commitTurn('other', 'Generate commit message please', 'complete', 'feat: no')];
		const agent = {
			getCurrentSession: () => ({ id: 's' }),
			getViewState: () => ({ turns, subagents: [] }),
			onDidChangeViewState: emitter.event,
		} as unknown as IClaudeAgentService;
		assert.strictEqual(await commitMessageAfterRun(agent, undefined), undefined);

		turns = [commitTurn('t1', label, 'failed', 'feat: failed')];
		assert.strictEqual(await commitMessageAfterRun(agent, undefined), '');

		turns = [commitTurn('t2', label, 'running', '')];
		const cts = disposables.add(new CancellationTokenSource());
		const cancelled = commitMessageAfterRun(agent, cts.token);
		cts.cancel();
		assert.strictEqual(await cancelled, '');

		turns = [commitTurn('t3', label, 'running', '')];
		const pending = commitMessageAfterRun(agent, undefined);
		turns = [commitTurn('t3', label, 'complete', 'Note\n```\nfeat: from the fence\n```\n')];
		emitter.fire({ sessionId: 's' });
		assert.strictEqual(await pending, 'feat: from the fence');

		turns = [commitTurn('old', label, 'complete', '```\nfeat: old\n```')];
		assert.strictEqual(await commitMessageAfterRun(agent, undefined, new Set(['old'])), undefined);
	});

	test('commit message comes from the delegated chat when Auto delegated the turn (issue 966)', async () => {
		const label = actionTurnLabel('generateCommitMessage', { kind: 'prompt', templateId: 'generate-commit-message' });
		const card: ClaudeDelegateCard = {
			id: 'd1', parentSessionId: 's', parentTurnId: 't1', childSessionId: 'child', task: 'write the message', title: 'Commit message',
			modelLabel: 'Haiku', auto: true, state: 'running', children: [], startedAt: 1,
		};
		let state = reduceAgentState(EMPTY_AGENT_VIEW_STATE, { type: 'turn.submitted', turnId: 't1', text: label });
		state = reduceAgentState(state, { type: 'turn.delegate', card });
		const agent = {
			getCurrentSession: () => ({ id: 's' }),
			getViewState: () => state,
			onDidChangeViewState: Event.None,
		} as unknown as IClaudeAgentService;
		state = reduceAgentState(state, { type: 'turn.delegate', card: { ...card, state: 'done', result: 'Here you go:\n```\nfeat: from the delegate\n```', endedAt: 2 } });
		state = reduceAgentState(state, { type: 'turn.delegated', turnId: 't1', endedAt: 2 });
		assert.deepStrictEqual({ head: state.turns[0].assistantText, status: state.turns[0].status, message: await commitMessageAfterRun(agent, undefined) }, { head: '', status: 'complete', message: 'feat: from the delegate' });
	});

	test('commit accepted changes refuses a partial stage and reports command errors', async () => {
		const file = acceptedFile();
		const review: TurnReview = { sessionId: 's', turnId: 't', files: [file], cursor: 0 };
		const notices: string[] = [];
		const errors: string[] = [];
		const commands: string[] = [];
		await runCommitAcceptedChanges({
			review,
			stagedPaths: [file.uri.fsPath],
			workingPaths: [file.uri.fsPath],
			readText: async () => 'accepted',
			executeCommand: async () => undefined,
			stagedAfter: () => [],
			notify: message => notices.push(message),
			reportError: message => errors.push(message),
		});
		assert.ok(notices.some(message => message.includes('partly staged')));
		assert.strictEqual(commands.length, 0);

		await runCommitAcceptedChanges({
			review,
			stagedPaths: [],
			workingPaths: [file.uri.fsPath],
			readText: async () => 'accepted\nextra',
			executeCommand: async id => { commands.push(id); },
			stagedAfter: () => [file.uri.fsPath],
			notify: message => notices.push(message),
			reportError: message => errors.push(message),
		});
		assert.ok(notices.some(message => message.includes('not accepted')));
		assert.strictEqual(commands.length, 0);

		await runCommitAcceptedChanges({
			review,
			stagedPaths: [],
			workingPaths: [],
			readText: async () => 'accepted',
			executeCommand: async () => { throw new Error('stage exploded'); },
			stagedAfter: () => [file.uri.fsPath],
			notify: message => notices.push(message),
			reportError: message => errors.push(message),
		});
		assert.ok(errors.some(message => message.includes('stage exploded')));

		commands.length = 0;
		await runCommitAcceptedChanges({
			review,
			stagedPaths: [],
			workingPaths: [],
			readText: async () => 'accepted',
			executeCommand: async id => { commands.push(id); },
			stagedAfter: () => [],
			stageRefreshTimeoutMs: 0,
			notify: message => notices.push(message),
			reportError: message => errors.push(message),
		});
		assert.deepStrictEqual(commands, ['git.stageFile']);
		assert.ok(errors.some(message => message.includes('Staging did not include')));
	});

	test('commit accepted changes waits for a delayed staged refresh and stages a deletion', async () => {
		const file = acceptedFile();
		const review: TurnReview = { sessionId: 's', turnId: 't', files: [file], cursor: 0 };
		const commands: string[] = [];
		const errors: string[] = [];
		let staged: string[] = [];
		await runCommitAcceptedChanges({
			review,
			stagedPaths: [],
			workingPaths: [],
			readText: async () => 'accepted',
			executeCommand: async id => {
				commands.push(id);
				if (id === 'git.stageFile') {
					setTimeout(() => { staged = [file.uri.fsPath]; }, 30);
				}
			},
			stagedAfter: () => staged,
			stageRefreshTimeoutMs: 500,
			waitForStagedUpdate: timeoutMs => new Promise(resolve => {
				const started = Date.now();
				const tick = () => {
					if (staged.length > 0 || Date.now() - started >= timeoutMs) {
						resolve();
						return;
					}
					setTimeout(tick, 10);
				};
				tick();
			}),
			notify: () => undefined,
			reportError: message => errors.push(message),
		});
		assert.deepStrictEqual(commands, ['git.stageFile', 'git.commitStaged']);
		assert.deepStrictEqual(errors.slice(), []);

		const removed = deletedFile();
		const removedReview: TurnReview = { sessionId: 's', turnId: 't', files: [removed], cursor: 0 };
		commands.length = 0;
		await runCommitAcceptedChanges({
			review: removedReview,
			stagedPaths: [],
			workingPaths: [removed.uri.fsPath],
			readText: async () => undefined,
			executeCommand: async id => { commands.push(id); },
			stagedAfter: () => [removed.uri.fsPath],
			notify: () => undefined,
			reportError: message => errors.push(message),
		});
		assert.deepStrictEqual(commands, ['git.stageFile', 'git.commitStaged']);
		assert.deepStrictEqual(errors.slice(), []);

		const created = newFile();
		commands.length = 0;
		await runCommitAcceptedChanges({
			review: { sessionId: 's', turnId: 't', files: [created], cursor: 0 },
			stagedPaths: [],
			workingPaths: [created.uri.fsPath],
			readText: async () => 'hello',
			executeCommand: async id => { commands.push(id); },
			stagedAfter: () => [created.uri.fsPath],
			notify: () => undefined,
			reportError: message => errors.push(message),
		});
		assert.deepStrictEqual(commands, ['git.stageFile', 'git.commitStaged']);

		const inserted = insertOnlyFile();
		commands.length = 0;
		await runCommitAcceptedChanges({
			review: { sessionId: 's', turnId: 't', files: [inserted], cursor: 0 },
			stagedPaths: [],
			workingPaths: [inserted.uri.fsPath],
			readText: async () => 'a\nX\nb',
			executeCommand: async id => { commands.push(id); },
			stagedAfter: () => [inserted.uri.fsPath],
			notify: () => undefined,
			reportError: message => errors.push(message),
		});
		assert.deepStrictEqual(commands, ['git.stageFile', 'git.commitStaged']);
		assert.deepStrictEqual(errors.slice(), []);
	});

	test('the commit accepted changes button reports a rejected command', async () => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const store = disposables.add(new DisposableStore());
		const errors: string[] = [];
		let commits = 0;
		const controller: ClaudeReviewCardController = {
			get: () => undefined,
			openFile: () => undefined,
			acceptFile: () => undefined,
			rejectFile: () => undefined,
			acceptAll: () => undefined,
			rejectAll: () => undefined,
			reviewAll: () => undefined,
			openReview: () => undefined,
			resolve: () => undefined,
			commitAccepted: () => {
				commits++;
				return Promise.reject(new Error('stage failed'));
			},
			reportCommitError: message => errors.push(message),
		};
		renderClaudeChangesCard(parent, 'turn-1', { sessionId: 's', turnId: 'turn-1', files: [acceptedFile()], cursor: 0 }, controller, store);
		const button = [...parent.querySelectorAll('button')].find(candidate => candidate.textContent === 'Commit accepted changes');
		assert.ok(button);
		button.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(commits, 1);
		assert.deepStrictEqual(errors, ['stage failed']);
		parent.remove();
	});

	test('generate commit message finds the commit box repository, refuses a bad root, confirms a filled box, and a cancelled token writes nothing', async () => {
		if (!CommandsRegistry.getCommand(CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID)) {
			registerClaudeGitActions();
		}
		const label = actionTurnLabel('generateCommitMessage', { kind: 'prompt', templateId: 'generate-commit-message' });
		const root = URI.file(isWindows ? 'C:\\repo' : '/repo');
		const infos: string[] = [];
		const writes: string[] = [];
		let box = '';
		let turns: TurnViewModel[] = [commitTurn('old', label, 'complete', '```\nfeat: old\n```')];
		let sent = false;
		let produce = false;
		let produced = 0;
		const indexGroup = group('index', 'Staged Changes');
		const workingGroup = group('workingTree', 'Changes');
		const untrackedGroup = group('untracked', 'Untracked Changes');
		workingGroup.resources = [resource(URI.joinPath(root, 'a.ts'), workingGroup)];
		const scopes: string[] = [];
		const repository = {
			provider: { rootUri: root, providerId: 'git', groups: [indexGroup, workingGroup, untrackedGroup] },
			input: {
				get value() { return box; },
				setValue: (value: string) => { writes.push(value); box = value; },
			},
		};
		const confirmations: string[] = [];
		let confirmed = false;
		const services = new Map<unknown, unknown>();
		const otherRepository = { provider: { rootUri: URI.file(isWindows ? 'C:\\second' : '/second'), providerId: 'git' } };
		let repositories: object[] = [repository, otherRepository];
		services.set(ISCMService, {
			get repositories() { return repositories; },
			// Like the real service: a repository root is not a resource below that root (issue 316).
			getRepository: () => undefined,
		});
		services.set(IClaudeActionService, {
			run: async (req: { attachments: { scope?: string }[] }) => {
				sent = true;
				scopes.push(req.attachments[0]?.scope ?? '');
				if (!produce) {
					return;
				}
				produced++;
				turns = [...turns, commitTurn(`new-${produced}`, label, 'complete', '```\nfeat: new\n```')];
			},
		});
		services.set(IClaudeAgentService, {
			getCurrentSession: () => ({ id: 's' }),
			getViewState: () => ({ turns, subagents: [] }),
			onDidChangeViewState: () => ({ dispose() { } }),
		});
		services.set(INotificationService, { info: (message: string) => infos.push(message), error: () => undefined });
		services.set(IDialogService, {
			confirm: async (options: { message?: string }) => {
				confirmations.push(options.message ?? '');
				return { confirmed };
			},
		});
		services.set(IViewsService, { openView: async () => undefined });
		const accessor: ServicesAccessor = { get: id => services.get(id) as never };
		const command = CommandsRegistry.getCommand(CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID);
		assert.ok(command);

		await command.handler(accessor);
		await command.handler(accessor, URI.file(isWindows ? 'C:\\other' : '/other'));
		assert.strictEqual(sent, false);
		assert.strictEqual(writes.length, 0);
		assert.ok(infos.filter(message => message.includes('needs the Git repository')).length >= 2);

		repositories = [repository];
		await command.handler(accessor, URI.file(isWindows ? 'C:\\Repo' : '/repo'), [], CancellationToken.None);
		assert.strictEqual(sent, true);
		assert.strictEqual(infos.filter(message => message.includes('needs the Git repository')).length, 2);
		sent = false;
		await command.handler(accessor);
		assert.strictEqual(sent, true);
		assert.strictEqual(infos.filter(message => message.includes('needs the Git repository')).length, 2);

		box = 'draft';
		await command.handler(accessor, root);
		assert.strictEqual(sent, true);
		assert.strictEqual(writes.length, 0);
		assert.strictEqual(box, 'draft');

		produce = true;
		await command.handler(accessor, root);
		assert.ok(confirmations.some(message => message.includes('Replace the commit message')));
		assert.strictEqual(writes.length, 0);
		assert.strictEqual(box, 'draft');

		confirmed = true;
		await command.handler(accessor, root);
		assert.deepStrictEqual(writes, ['feat: new']);

		writes.length = 0;
		box = '';
		const cts = disposables.add(new CancellationTokenSource());
		cts.cancel();
		await command.handler(accessor, root, cts.token);
		assert.strictEqual(writes.length, 0);
		assert.strictEqual(box, '');
	});

	test('generate commit message uses staged changes first, else the uncommitted ones, and shows one notice when there is nothing (issue 748)', async () => {
		if (!CommandsRegistry.getCommand(CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID)) {
			registerClaudeGitActions();
		}
		const root = URI.file(isWindows ? 'C:\\repo' : '/repo');
		const indexGroup = group('index', 'Staged Changes');
		const workingGroup = group('workingTree', 'Changes');
		const untrackedGroup = group('untracked', 'Untracked Changes');
		const repository = { provider: { rootUri: root, providerId: 'git', groups: [indexGroup, workingGroup, untrackedGroup] }, input: { value: '', setValue: () => undefined } };
		const infos: string[] = [];
		const scopes: string[] = [];
		const services = new Map<unknown, unknown>();
		services.set(ISCMService, { repositories: [repository], getRepository: () => undefined });
		// Like the action service when the diff resolves empty: it explains and starts no turn.
		services.set(IClaudeActionService, {
			run: async (req: { attachments: { scope?: string }[] }) => {
				scopes.push(req.attachments[0]?.scope ?? '');
				infos.push('There are no changes to commit.');
			},
		});
		services.set(IClaudeAgentService, {
			getCurrentSession: () => ({ id: 's' }),
			getViewState: () => ({ turns: [], subagents: [] }),
			onDidChangeViewState: () => ({ dispose() { } }),
		});
		services.set(INotificationService, { info: (message: string) => infos.push(message), error: () => undefined });
		services.set(IDialogService, new TestDialogService());
		services.set(IViewsService, { openView: async () => undefined });
		const accessor: ServicesAccessor = { get: id => services.get(id) as never };
		const command = CommandsRegistry.getCommand(CLAUDE_GENERATE_COMMIT_MESSAGE_COMMAND_ID);
		assert.ok(command);

		await command.handler(accessor, root);
		untrackedGroup.resources = [resource(URI.joinPath(root, 'new.ts'), untrackedGroup)];
		await command.handler(accessor, root);
		workingGroup.resources = [resource(URI.joinPath(root, 'a.ts'), workingGroup)];
		indexGroup.resources = [resource(URI.joinPath(root, 'b.ts'), indexGroup)];
		await command.handler(accessor, root);
		assert.deepStrictEqual({ scopes, infos }, {
			scopes: ['working-tree', 'staged'],
			infos: ['There are no changes to commit.', 'There are no changes to commit.', 'There are no changes to commit.'],
		});
	});
});

function group(id: string, label: string): ISCMResourceGroup & { resources: ISCMResource[] } {
	return { id, label, resources: [] } as unknown as ISCMResourceGroup & { resources: ISCMResource[] };
}

function resource(uri: URI, resourceGroup: ISCMResourceGroup, original?: URI, modified?: URI): ISCMResource {
	return {
		sourceUri: uri,
		resourceGroup,
		multiDiffEditorOriginalUri: original,
		multiDiffEditorModifiedUri: modified,
	} as ISCMResource;
}

function required(texts: Map<string, string>, key: string): string {
	const text = texts.get(key);
	if (text === undefined) {
		throw new Error(`missing ${key}`);
	}
	return text;
}

function commitTurn(id: string, text: string, status: TurnViewModel['status'], assistantText: string): TurnViewModel {
	return {
		id,
		user: { text },
		assistantText,
		status,
		cards: [],
		changedFiles: [],
		permissions: [],
		segmentOpen: false,
		segmentStart: 0,
		steered: [],
	};
}

function newFile(): ReviewFile {
	const file = acceptedFile();
	return {
		...file,
		isNew: true,
		originalText: '',
		hunks: [{
			...file.hunks[0],
			originalText: '',
			modifiedText: 'hello',
		}],
	};
}

function insertOnlyFile(): ReviewFile {
	const file = acceptedFile();
	return {
		...file,
		originalText: 'a\nb',
		hunks: [{
			...file.hunks[0],
			originalStart: 2,
			originalText: '',
			modifiedText: 'X\n',
		}],
	};
}

function deletedFile(): ReviewFile {
	const file = acceptedFile();
	return {
		...file,
		originalText: 'gone',
		hunks: [{
			...file.hunks[0],
			originalText: 'gone',
			modifiedText: '',
		}],
	};
}

function acceptedFile(): ReviewFile {
	const uri = URI.file(isWindows ? 'C:\\repo\\a.ts' : '/repo/a.ts');
	return {
		uri,
		name: 'a.ts',
		directory: '',
		isNew: false,
		originalText: 'base',
		hunks: [{
			id: 'h1',
			uri,
			originalStart: 1,
			originalLength: 1,
			modifiedStart: 1,
			modifiedLength: 1,
			originalText: 'base',
			modifiedText: 'accepted',
			state: 'accepted',
			currentRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 9 } as ReviewFile['hunks'][number]['currentRange'],
		}],
		added: 1,
		removed: 1,
		state: 'accepted',
	};
}
