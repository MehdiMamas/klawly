/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CLAUDE_GIT_BRANCH_PREFIX_SETTING } from '../../../../../platform/claude/common/claudeGitSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { applyBackgroundAgent, assertIsolatedWorktree, backgroundBranchName, backgroundWorktreePath, BackgroundAgentTask, BackgroundConflict, BackgroundFileChange, commandStatus, IClaudeWorktreeService, isPathInside, normalizeRepoRoot, parseNumstat, pathsInDiff, worktreeAddArguments, worktreeApplyArguments } from '../../../../../platform/claude/common/claudeBackground.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../editor/common/editorService.js';
import { BeginClaudeRequest } from '../../../../../platform/claude/common/claude.js';
import { FakeClaudeRuntimeService } from '../../../../../platform/claude/common/fakeClaudeRuntimeService.js';
import { IOutputService } from '../../../output/common/output.js';
import { ClaudeAgentService, ClaudeAgentSession, IClaudeAgentService } from '../../common/claudeAgentService.js';
import { agentWorkspaceStubs } from './claudeAgentTestUtils.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, TurnViewModel } from '../../common/claudeAgentState.js';
import { ClaudeSessionSettings } from '../../../../../platform/claude/common/claudeSessionSettings.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { backgroundAgentCard } from '../../common/claudeBackgroundCards.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ClaudeBackgroundAgentService, IClaudeBackgroundPreview } from '../../common/claudeBackgroundAgent.js';
import { ClaudeWorkerRegistry } from '../../common/claudeWorkerRegistry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { CLAUDE_WORKTREES_MAX_SETTING, ClaudeWorktreeSetup, ClaudeWorktreeSetupResult } from '../../../../../platform/claude/common/claudeWorktreeSetup.js';
import { isWindows } from '../../../../../base/common/platform.js';

const PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';

class FakeGit implements IClaudeWorktreeService {
	declare readonly _serviceBrand: undefined;
	readonly ops: string[] = [];
	conflicts: BackgroundConflict[] = [];
	dirty = false;
	changesError = false;
	missing = false;

	async head(repoRoot: string): Promise<string> {
		this.ops.push(`head ${repoRoot}`);
		return 'abc123';
	}

	async add(_repoRoot: string, worktreePath: string, branchName: string, baseRef: string): Promise<void> {
		this.ops.push(`add ${worktreeAddArguments(branchName, worktreePath, baseRef).join(' ')}`);
	}

	async remove(_repoRoot: string, _worktreePath: string, _branchName: string, force?: boolean): Promise<void> {
		this.ops.push(force ? 'remove --force' : 'remove');
		if (this.missing) {
			throw new Error(`fatal: 'worktree' is not a working tree`);
		}
	}

	/** What setup ran (issue 511), and the command to fail, if any. */
	readonly setups: ClaudeWorktreeSetup[] = [];
	failSetup: string | undefined;

	async setup(_repoRoot: string, _worktreePath: string, setup: ClaudeWorktreeSetup): Promise<ClaudeWorktreeSetupResult> {
		this.setups.push(setup);
		this.ops.push('setup');
		const failed = setup.commands.find(command => command === this.failSetup);
		return failed
			? { copied: [], commands: [{ command: failed, exitCode: 1, output: 'npm ERR! missing script: ci' }], failed }
			: { copied: setup.copy.slice(), commands: setup.commands.map(command => ({ command, exitCode: 0, output: '' })) };
	}

	async hasChanges(): Promise<boolean> {
		this.ops.push('hasChanges');
		if (this.changesError) {
			throw new Error('status failed');
		}
		return this.dirty;
	}

	async diff(): Promise<string> {
		this.ops.push('diff');
		return this.patch;
	}

	async summarize(): Promise<{ filesChanged: number; added: number; removed: number }> {
		return { filesChanged: 1, added: 2, removed: 1 };
	}

	async readFilePair(_worktreePath: string, _baseRef: string, relativePath: string): Promise<BackgroundFileChange> {
		this.ops.push(`read ${relativePath}`);
		return { relativePath, originalText: 'old\n', modifiedText: 'new\n', existed: true };
	}

	async applyThreeWay(_workspaceRoot: string, patch: string): Promise<{ conflicts: readonly BackgroundConflict[] }> {
		this.ops.push(`apply ${worktreeApplyArguments().join(' ')} ${patch.includes('a.txt') ? 'a.txt' : 'empty'}`);
		return { conflicts: this.conflicts };
	}

	patch = PATCH;
}

class FakeAgent implements Partial<IClaudeAgentService> {
	readonly cwds: string[] = [];
	readonly stopped: string[] = [];
	readonly closed: string[] = [];
	failSubmit = false;
	hold: Promise<void> | undefined;
	private _serial = 0;
	private readonly _pinned = new Map<string, string>();
	private view: AgentViewState = EMPTY_AGENT_VIEW_STATE;
	private readonly _listeners = new Set<(event: { sessionId: string }) => void>();
	readonly onDidChangeViewState = (listener: (event: { sessionId: string }) => void) => {
		this._listeners.add(listener);
		return { dispose: () => { this._listeners.delete(listener); } };
	};

	createSession(): ClaudeAgentSession {
		this._serial++;
		return {
			id: `session-${this._serial}`,
			title: 'New Agent',
			mode: 'agent',
			draft: '',
			attachments: [],
			additionalDirectories: [],
			slashCommands: [],
			skills: [],
			commands: [],
			agents: [],
		};
	}

	readonly selected: string[] = [];
	readonly runOptions: string[] = [];

	selectSession(sessionId: string): void {
		this.selected.push(sessionId);
	}

	async setNextModel(sessionId: string, modelId: string): Promise<void> {
		this.runOptions.push(`${sessionId} model ${modelId}`);
	}

	getSessionSettings(): ClaudeSessionSettings {
		return { fastMode: true };
	}

	async setNextSettings(sessionId: string, settings: ClaudeSessionSettings): Promise<void> {
		this.runOptions.push(`${sessionId} settings ${JSON.stringify(settings)}`);
	}

	setSessionBudget(sessionId: string, maxBudgetUsd: number | undefined): void {
		this.runOptions.push(`${sessionId} budget ${maxBudgetUsd}`);
	}

	pinWorkingDirectory(sessionId: string, cwd: string): void {
		this._pinned.set(sessionId, cwd);
	}

	async submit(sessionId: string, _text: string, cwd: string): Promise<void> {
		if (this.hold) {
			await this.hold;
		}
		this.cwds.push(this._pinned.get(sessionId) ?? cwd);
		if (this.failSubmit) {
			throw new Error('submit failed');
		}
	}

	async retry(sessionId: string, cwd: string): Promise<void> {
		this.cwds.push(`retry ${this._pinned.get(sessionId) ?? cwd}`);
	}

	async buildPlan(sessionId: string, _turnId: string, _notes: string, cwd: string): Promise<void> {
		this.cwds.push(`build ${this._pinned.get(sessionId) ?? cwd}`);
	}

	async stop(sessionId: string): Promise<void> {
		this.stopped.push(sessionId);
	}

	closeSession(sessionId: string): void {
		this.closed.push(sessionId);
	}

	getViewState(): AgentViewState {
		return this.view;
	}

	emit(sessionId: string, state: AgentViewState): void {
		this.view = state;
		for (const listener of this._listeners) {
			listener({ sessionId });
		}
	}
}

function task(partial: Partial<BackgroundAgentTask> & Pick<BackgroundAgentTask, 'status'>): BackgroundAgentTask {
	return {
		id: 'id',
		sessionId: 'session',
		repoRoot: '/repo',
		baseRef: 'abc',
		worktreePath: '/user/worktrees/hash/id',
		branchName: 'agent/id',
		title: 'Upgrade to Next 15',
		filesChanged: 14,
		added: 120,
		removed: 14,
		testStatus: 'tests not run',
		conflicts: [],
		stopped: false,
		...partial,
	};
}

suite('Claude background agents', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const repo = join(process.cwd(), 'repo-not-created');
	const userData = join(process.cwd(), 'user-data-not-created');

	function create(options?: { max?: number; branchPrefix?: string; git?: FakeGit; agent?: FakeAgent; accepted?: boolean; confirmed?: boolean | (() => boolean); trusted?: boolean; maxWorktrees?: number; setupFile?: string }) {
		const git = options?.git ?? new FakeGit();
		const agent = options?.agent ?? new FakeAgent();
		const opened: { result?: URI; base?: URI }[] = [];
		const writes: string[] = [];
		const deleted: string[] = [];
		const confirms: string[] = [];
		const previewCalls: string[] = [];
		const preview: IClaudeBackgroundPreview = {
			_serviceBrand: undefined,
			show: async () => {
				previewCalls.push('show');
				return true;
			},
			openExternalPatch: async () => {
				previewCalls.push('preview');
				return { accepted: options?.accepted ?? true };
			},
		};
		const configuration = {
			getValue: (key: string) => key === CLAUDE_GIT_BRANCH_PREFIX_SETTING ? options?.branchPrefix : key === CLAUDE_WORKTREES_MAX_SETTING ? options?.maxWorktrees : options?.max ?? 2,
		} as unknown as IConfigurationService;
		const workspace = {
			getWorkspace: () => ({ folders: [{ uri: URI.file(repo) }] }),
		} as unknown as IWorkspaceContextService;
		const editor = {
			openEditor: async (input: { result?: { resource: URI }; base?: { resource: URI } }) => {
				opened.push({ result: input.result?.resource, base: input.base?.resource });
				return undefined;
			},
		} as unknown as IEditorService;
		const files = {
			createFolder: async () => undefined,
			writeFile: async (resource: URI, _content: VSBuffer) => {
				writes.push(resource.fsPath);
			},
			del: async (resource: URI) => {
				deleted.push(resource.fsPath);
			},
			readFile: async (resource: URI) => {
				if (options?.setupFile === undefined || !resource.fsPath.endsWith('worktree-setup.json')) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(options.setupFile) };
			},
		} as unknown as IFileService;
		const dialog = {
			confirm: async (confirmation: { message: string }) => {
				confirms.push(confirmation.message);
				const confirmed = typeof options?.confirmed === 'function' ? options.confirmed() : (options?.confirmed ?? true);
				return { confirmed };
			},
		} as unknown as IDialogService;
		const registry = store.add(new ClaudeWorkerRegistry(store.add(new InMemoryStorageService())));
		const service = store.add(new ClaudeBackgroundAgentService(
			userData,
			git,
			agent as unknown as IClaudeAgentService,
			preview,
			configuration,
			workspace,
			editor,
			files,
			dialog,
			{ isWorkspaceTrusted: () => options?.trusted ?? true } as unknown as IWorkspaceTrustManagementService,
			registry,
		));
		return { service, registry, git, agent, opened, writes, deleted, confirms, previewCalls };
	}

	test('issue 835: a background task is recorded as a run in the worker registry', async () => {
		const { service, registry } = create({});
		await service.start('runs the tests');
		assert.deepStrictEqual(registry.all().map(run => [run.number, run.kind, run.name === 'runs the tests' || run.name.length > 0]), [['1', 'background', true]]);
	});

	test('issue 511: a trusted project sets up each new worktree first, a failed setup stops the start, and the worktree cap holds', async () => {
		const setupFile = JSON.stringify({ copy: ['.env*'], setup: { default: ['npm ci'], win32: ['npm.cmd ci'] } });
		const ok = create({ setupFile, max: 5 });
		await ok.service.start('runs the tests');
		const untrusted = create({ setupFile, trusted: false, max: 5 });
		await untrusted.service.start('runs the tests');
		const failing = new FakeGit();
		const setupCommand = isWindows ? 'npm.cmd ci' : 'npm ci';
		failing.failSetup = setupCommand;
		const broken = create({ setupFile, git: failing, max: 5 });
		const failure = await broken.service.start('runs the tests').then(() => 'started', (error: Error) => error.message);
		const capped = create({ maxWorktrees: 1, max: 5 });
		await capped.service.start('first');
		const overCap = await capped.service.start('second').then(() => 'started', (error: Error) => error.message);
		assert.deepStrictEqual({
			setups: ok.git.setups,
			untrusted: untrusted.git.setups.length,
			failure,
			failedTasks: broken.service.getTasks().length,
			removedAfterFailure: failing.ops.includes('remove --force'),
			overCap,
		}, {
			setups: [{ copy: ['.env*'], commands: [setupCommand] }],
			untrusted: 0,
			failure: `Worktree setup failed at "${setupCommand}":\nnpm ERR! missing script: ci`,
			failedTasks: 0,
			removedAfterFailure: true,
			overCap: 'This repository has 1 background agent worktrees, the most allowed. Run Klawly: Clean Up Worktrees or delete an agent first.',
		});
	});

	test('issue 511: Clean Up Worktrees deletes finished agents with nothing to apply and keeps the rest', async () => {
		const git = new FakeGit();
		const { service, agent } = create({ git, max: 5 });
		const done = await service.start('done');
		await service.start('still running');
		agent.emit(done.sessionId, view('complete'));
		const result = await service.cleanUp();
		assert.deepStrictEqual({ result, left: service.getTasks().map(task => task.title) }, { result: { removed: 1, kept: 0 }, left: ['still running'] });
	});

	test('two agents use different worktrees and that cwd', async () => {
		const { service, agent, git } = create();
		const first = await service.start('first agent');
		const second = await service.start('second agent');
		assert.notStrictEqual(first.worktreePath, second.worktreePath);
		assert.notStrictEqual(first.id, second.id);
		assert.strictEqual(first.worktreePath, backgroundWorktreePath(userData, repo, first.id));
		assert.strictEqual(second.worktreePath, backgroundWorktreePath(userData, repo, second.id));
		assert.strictEqual(first.branchName, backgroundBranchName(first.id));
		assert.strictEqual(isPathInside(repo, first.worktreePath), false);
		assert.strictEqual(isPathInside(repo, second.worktreePath), false);
		assert.deepStrictEqual(agent.cwds, [first.worktreePath, second.worktreePath]);
		assert.ok(git.ops.some(op => op.startsWith('add worktree add -b agent/')));
		await assert.rejects(() => service.start('third'), /limited to 2/);
		assert.strictEqual(agent.cwds.length, 2);
	});

	test('run options set the task id, title, model, effort and budget, and can leave the selection alone', async () => {
		const { service, agent } = create({ max: 4 });
		const started = await service.start(' Fix the bug ', { taskId: 'compare-abc-1', title: 'Opus, High: Fix the bug', modelId: 'opus', effort: 'high', maxBudgetUsd: 1.5, select: false });
		assert.deepStrictEqual({
			id: started.id,
			title: started.title,
			branch: started.branchName,
			options: agent.runOptions,
			selected: agent.selected,
		}, {
			id: 'compare-abc-1',
			title: 'Opus, High: Fix the bug',
			branch: 'agent/compare-abc-1',
			options: ['session-1 model opus', 'session-1 settings {"fastMode":true,"effort":"high"}', 'session-1 budget 1.5'],
			selected: [],
		});
		await assert.rejects(() => service.start('again', { taskId: 'compare-abc-1' }), /cannot start/);
		await assert.rejects(() => service.start('bad', { taskId: '../escape' }), /cannot start/);
	});

	test('the branch prefix setting names the branch; one git would refuse falls back to agent/', async () => {
		const named = create({ branchPrefix: 'alex' });
		const refused = create({ branchPrefix: '--force' });
		const first = await named.service.start('named agent');
		const second = await refused.service.start('refused agent');
		assert.deepStrictEqual([first.branchName, second.branchName], [`alex/${first.id}`, `agent/${second.id}`]);
		assert.ok(named.git.ops.some(op => op.startsWith(`add worktree add -b alex/${first.id}`)));
	});

	test('apply is diff, then preview, then three-way, and a decline does not apply', async () => {
		const git = new FakeGit();
		const declined = create({ git, accepted: false });
		const started = await declined.service.start('agent');
		await declined.service.apply(started.id);
		assert.deepStrictEqual(declined.previewCalls, ['preview']);
		assert.strictEqual(git.ops.some(op => op.startsWith('apply ')), false);
		assert.strictEqual(git.ops.some(op => op.includes('copy')), false);

		git.ops.length = 0;
		declined.previewCalls.length = 0;
		git.conflicts = [{ relativePath: 'a.txt', base: 'base\n', ours: 'main\n', theirs: 'agent\n' }];
		const accepted = create({ git, accepted: true });
		const again = await accepted.service.start('agent two');
		const result = await accepted.service.apply(again.id);
		assert.deepStrictEqual(accepted.previewCalls, ['preview']);
		assert.strictEqual(result.applied, true);
		assert.strictEqual(result.conflicts.length, 1);
		assert.ok(git.ops.indexOf('diff') < git.ops.findIndex(op => op.startsWith('apply ')));
		assert.ok(git.ops.some(op => op.startsWith('apply apply --3way ')));
		assert.ok(accepted.opened[0]?.result);
		assert.ok(accepted.opened[0]?.base);
		assert.strictEqual(isPathInside(again.repoRoot, accepted.opened[0]!.result!.fsPath), true);
		assert.strictEqual(isPathInside(userData, accepted.opened[0]!.base!.fsPath), true);
		assert.ok(accepted.writes.every(path => isPathInside(userData, path)));
		assert.ok(accepted.writes.every(path => !isPathInside(again.worktreePath, path)));
		assert.strictEqual(git.ops.some(op => op.includes('copy')), false);
	});

	test('review opens the diff and does not apply', async () => {
		const { service, git, previewCalls } = create();
		const started = await service.start('agent');
		git.ops.length = 0;
		await service.review(started.id);
		assert.deepStrictEqual(previewCalls, ['show']);
		assert.strictEqual(git.ops.some(op => op.startsWith('apply ')), false);
	});

	test('cards show files, tests, open, review, apply, and stop or delete', () => {
		const running = backgroundAgentCard(task({ status: 'running' }));
		assert.deepStrictEqual(running.actions.map(action => action.action), ['apply', 'review', 'open', 'stop']);
		assert.strictEqual(running.facts[1].text, '14 files');
		assert.strictEqual(running.facts[2].text, 'tests not run');

		const done = backgroundAgentCard(task({ status: 'complete', testStatus: 'npm test exited 0' }));
		assert.strictEqual(done.actions.find(action => action.action === 'apply')?.label, 'Review & apply');
		assert.ok(done.actions.some(action => action.action === 'delete'));
		assert.strictEqual(done.facts[2].text, 'npm test exited 0');
		assert.strictEqual(done.actions.some(action => action.action === 'stop'), false);

		const conflicted = backgroundAgentCard(task({
			status: 'complete',
			conflicts: [{ relativePath: 'a.txt', base: '', ours: '', theirs: '' }],
		}));
		assert.strictEqual(conflicted.actions[0].action, 'resolve');
		assert.strictEqual(conflicted.actions[0].label, 'Resolve in merge editor');
		assert.strictEqual(conflicted.badge, '1 conflict');
	});

	test('the apply helper never copies a worktree', async () => {
		const order: string[] = [];
		let appliedPatch = '';
		const result = await applyBackgroundAgent({
			diff: async () => {
				order.push('diff');
				return 'patch';
			},
			openExternalPatch: async patch => {
				order.push('preview');
				assert.strictEqual(patch, 'patch');
				return { accepted: true };
			},
			applyPatch: async patch => {
				order.push('apply');
				appliedPatch = patch;
				return { conflicts: [{ relativePath: 'a.txt', base: '', ours: '', theirs: '' }] };
			},
			openConflicts: async conflicts => {
				order.push('merge');
				assert.strictEqual(conflicts.length, 1);
				assert.strictEqual(conflicts[0].relativePath, 'a.txt');
			},
		});
		assert.deepStrictEqual(order, ['diff', 'preview', 'apply', 'merge']);
		assert.strictEqual(result.applied, true);
		assert.strictEqual(appliedPatch, 'patch');
		const skipped = await applyBackgroundAgent({
			diff: async () => 'patch',
			openExternalPatch: async () => ({ accepted: false }),
			applyPatch: async () => {
				order.push('apply-after-decline');
				return { conflicts: [] };
			},
			openConflicts: async () => undefined,
		});
		assert.strictEqual(skipped.applied, false);
		assert.strictEqual(order.includes('apply-after-decline'), false);
	});

	test('repo paths compare without a trailing separator', () => {
		assert.strictEqual(normalizeRepoRoot(join(repo, '')), normalizeRepoRoot(repo));
	});

	test('a second submit, retry, and build stay in the worktree', async () => {
		const runtime = store.add(new FakeClaudeRuntimeService(pinnedFixtures(), { stepDelayMs: 20 }));
		const begins: string[] = [];
		const originalBegin = runtime.begin.bind(runtime);
		runtime.begin = async (request: BeginClaudeRequest) => {
			begins.push(request.cwd);
			const fixture = request.prompt.includes('Add expiry') ? 'plan-answer' : 'plain-answer';
			return originalBegin({ ...request, fixture });
		};
		const agent = store.add(new ClaudeAgentService(runtime, pinnedOutput(), ...agentWorkspaceStubs()));
		const { service } = create({ agent: agent as unknown as FakeAgent, max: 4 });
		const pending = service.start('first agent');
		await until(() => begins.length >= 1 && service.getTasks().length === 1 && agent.getViewState(service.getTasks()[0].sessionId).turns[0]?.assistantText.includes('Partial') === true);
		const started = service.getTasks()[0];
		await service.stop(started.id);
		await pending;
		assert.strictEqual(begins[0], started.worktreePath);

		const before = agent.getViewState(started.sessionId).turns.length;
		const second = agent.submit(started.sessionId, 'again', repo);
		await until(() => {
			const turns = agent.getViewState(started.sessionId).turns;
			return turns.length > before && turns.at(-1)?.assistantText.includes('Partial') === true;
		});
		await agent.stop(started.sessionId);
		await second;
		assert.strictEqual(begins[1], started.worktreePath);

		await agent.retry(started.sessionId, repo);
		await agent.stop(started.sessionId);
		assert.strictEqual(begins[2], started.worktreePath);

		agent.setMode(started.sessionId, 'plan');
		await agent.submit(started.sessionId, 'Add expiry', repo);
		await until(() => agent.getViewState(started.sessionId).turns.at(-1)?.plan !== undefined);
		const planTurn = agent.getViewState(started.sessionId).turns.at(-1)!;
		const maps = agent as unknown as { _paneToRuntime: Map<string, string>; _runtimeToPane: Map<string, string> };
		const runtimeId = maps._paneToRuntime.get(started.sessionId);
		maps._paneToRuntime.delete(started.sessionId);
		if (runtimeId) {
			maps._runtimeToPane.delete(runtimeId);
		}
		await agent.buildPlan(started.sessionId, planTurn.id, 'keep the API', repo);
		assert.ok(begins.length >= 4);
		assert.ok(begins.every(cwd => cwd === started.worktreePath));
	});

	test('the background service pins follow-up calls to the worktree', async () => {
		const { service, agent } = create();
		const started = await service.start('first agent');
		await agent.submit(started.sessionId, 'follow up', repo);
		await agent.retry(started.sessionId, repo);
		await agent.buildPlan(started.sessionId, 'turn', 'notes', repo);
		assert.deepStrictEqual(agent.cwds, [
			started.worktreePath,
			started.worktreePath,
			`retry ${started.worktreePath}`,
			`build ${started.worktreePath}`,
		]);
	});

	test('a starting task is not reserved twice, and a failed start removes the worktree', async () => {
		let release: () => void = () => undefined;
		const hold = new Promise<void>(resolve => { release = resolve; });
		const agent = new FakeAgent();
		agent.hold = hold;
		const { service } = create({ max: 2, agent });
		const first = service.start('one');
		await until(() => service.getTasks().length === 1);
		assert.strictEqual(service.canStart(), true);
		const second = service.start('two');
		await until(() => service.getTasks().length === 2);
		assert.strictEqual(service.canStart(), false);
		release();
		await first;
		await second;
		assert.strictEqual(service.getTasks().length, 2);

		const failing = new FakeAgent();
		failing.failSubmit = true;
		const failed = create({ agent: failing });
		await assert.rejects(() => failed.service.start('boom'), /submit failed/);
		assert.ok(failed.git.ops.includes('hasChanges'));
		assert.ok(failed.git.ops.includes('remove --force'));
		assert.strictEqual(failed.service.getTasks().length, 0);
		assert.strictEqual(failed.agent.closed.length, 1);

		const dirtyGit = new FakeGit();
		dirtyGit.dirty = true;
		const dirtyAgent = new FakeAgent();
		dirtyAgent.failSubmit = true;
		const dirty = create({ agent: dirtyAgent, git: dirtyGit });
		await assert.rejects(() => dirty.service.start('boom'), /submit failed/);
		assert.strictEqual(dirty.git.ops.includes('remove --force'), false);
		assert.strictEqual(dirty.git.ops.includes('remove'), false);
		assert.strictEqual(dirty.service.getTasks()[0]?.status, 'failed');
		assert.deepStrictEqual(dirty.agent.closed, []);
	});

	test('stop marks the agent failed and ignores a later completion', async () => {
		const { service, agent } = create();
		const started = await service.start('agent');
		await service.stop(started.id);
		const stopped = service.getTasks()[0];
		assert.strictEqual(stopped.status, 'failed');
		assert.strictEqual(stopped.stopped, true);
		assert.deepStrictEqual(agent.stopped, [started.sessionId]);
		agent.emit(started.sessionId, view('complete'));
		assert.strictEqual(service.getTasks()[0].status, 'failed');
	});

	test('delete asks before removing a dirty worktree and clears scratch folders', async () => {
		let allow = false;
		const dirty = create({ confirmed: () => allow });
		dirty.git.dirty = true;
		const started = await dirty.service.start('agent');
		await dirty.service.delete(started.id);
		assert.strictEqual(dirty.confirms.length, 1);
		assert.strictEqual(dirty.git.ops.includes('remove'), false);
		assert.strictEqual(dirty.git.ops.includes('remove --force'), false);
		assert.strictEqual(dirty.service.getTasks().length, 1);

		allow = true;
		dirty.git.ops.length = 0;
		await dirty.service.delete(started.id);
		assert.ok(dirty.git.ops.includes('remove --force'));
		assert.strictEqual(dirty.service.getTasks().length, 0);
		assert.ok(dirty.deleted.some(path => isPathInside(join(userData, 'worktrees', 'preview', started.id), path) || path.includes(`${started.id}`)));
		assert.ok(dirty.deleted.some(path => path.includes('preview')));
		assert.ok(dirty.deleted.some(path => path.includes('merge')));
		assert.ok(dirty.agent.closed.includes(started.sessionId));

		const clean = create();
		const other = await clean.service.start('clean');
		clean.git.ops.length = 0;
		await clean.service.delete(other.id);
		assert.deepStrictEqual(clean.confirms, []);
		assert.ok(clean.git.ops.includes('remove'));
		assert.strictEqual(clean.git.ops.includes('remove --force'), false);

		const gone = create({ confirmed: true });
		gone.git.changesError = true;
		gone.git.missing = true;
		const missing = await gone.service.start('missing');
		await gone.service.delete(missing.id);
		assert.strictEqual(gone.service.getTasks().length, 0);
		assert.ok(gone.agent.closed.includes(missing.sessionId));
	});

	test('syncFromAgent follows the turn, including command status', async () => {
		const { service, agent } = create();
		const started = await service.start('agent');
		agent.emit(started.sessionId, view('running', {
			permissions: [{ id: 'p', toolName: 'Bash', canRemember: true, state: 'pending' }],
		}));
		assert.strictEqual(service.getTasks()[0].status, 'waiting');

		agent.emit(started.sessionId, view('running', {
			cards: [shellCard('running')],
		}));
		assert.strictEqual(service.getTasks()[0].status, 'running');
		assert.strictEqual(service.getTasks()[0].testStatus, 'npm test running');

		agent.emit(started.sessionId, view('complete', {
			cards: [shellCard('success', 0)],
		}));
		await until(() => service.getTasks()[0].filesChanged === 1);
		assert.strictEqual(service.getTasks()[0].status, 'complete');
		assert.strictEqual(service.getTasks()[0].testStatus, 'npm test exited 0');
		assert.strictEqual(service.getTasks()[0].added, 2);

		agent.emit(started.sessionId, view('failed'));
		assert.strictEqual(service.getTasks()[0].status, 'failed');
	});

	test('diff paths, numstat, command status, and worktree isolation', () => {
		assert.deepStrictEqual(pathsInDiff([
			'diff --git a/src/a.txt b/src/a.txt',
			'diff --git "a/my file.txt" "b/my file.txt"',
			'diff --git a/../etc/passwd b/../etc/passwd',
			'diff --git a/C:/Windows/x b/C:/Windows/x',
		].join('\n')), ['src/a.txt', 'my file.txt']);
		assert.deepStrictEqual(parseNumstat('1\t2\tsrc/a.txt\n-\t-\tbin.dat\n3\t0\t../etc/passwd\n'), {
			filesChanged: 2,
			added: 1,
			removed: 2,
		});
		assert.strictEqual(commandStatus([]), 'tests not run');
		assert.strictEqual(commandStatus([{ command: 'npm test', state: 'running' }]), 'npm test running');
		assert.strictEqual(commandStatus([{ category: 'shell', state: 'success' }]), 'tests not run');
		assert.strictEqual(commandStatus([{ command: 'npm test', state: 'success', exitCode: 1 }]), 'npm test exited 1');

		assert.throws(() => assertIsolatedWorktree(repo, 'relative', []), /not absolute/);
		assert.throws(() => assertIsolatedWorktree(repo, join(repo, 'inside'), []), /main workspace/);
		const worktree = join(userData, 'wt');
		assert.throws(() => assertIsolatedWorktree(repo, worktree, [worktree]), /already using/);
		assert.doesNotThrow(() => assertIsolatedWorktree(repo, worktree, [join(userData, 'other')]));
	});

});

function view(status: TurnViewModel['status'], extra?: Partial<TurnViewModel>): AgentViewState {
	return {
		turns: [{
			id: 'turn-1',
			user: { text: 'do it' },
			assistantText: '',
			status,
			cards: extra?.cards ?? [],
			changedFiles: [],
			permissions: extra?.permissions ?? [],
			segmentOpen: false,
			segmentStart: 0,
			steered: [],
		}],
		subagents: [],
	};
}

function shellCard(state: 'running' | 'success', exitCode?: number): TurnViewModel['cards'][number] {
	return {
		id: 'card',
		name: 'Bash',
		category: 'shell',
		kind: 'command',
		label: 'npm test',
		verb: 'Ran',
		target: 'npm test',
		command: 'npm test',
		lines: [],
		droppedLines: 0,
		streamedChars: 0,
		state,
		exitCode,
	};
}

const PLAN_ANSWER = '# Add expiry\\n\\nReject expired coupons.\\n\\n1. Check `expiresAt` in `src/coupon.ts`\\n2. Add tests';

function pinnedFixtures(): Map<string, string> {
	return new Map([
		['plain-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			'{"type":"assistant.delta","sessionId":"$session","text":"Partial "}',
		].join('\n')],
		['plan-answer', [
			'{"type":"session.started","sessionId":"$session"}',
			`{"type":"assistant.completed","sessionId":"$session","text":"${PLAN_ANSWER}"}`,
			'{"type":"session.completed","sessionId":"$session"}',
		].join('\n')],
	]);
}

function pinnedOutput(): IOutputService {
	return {
		_serviceBrand: undefined,
		getChannel: () => ({ append: () => undefined }),
	} as unknown as IOutputService;
}

async function until(read: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (read()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail('timed out');
}
