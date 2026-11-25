/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { CodeActionContext } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING, CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING, CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DiagnosticSummary } from '../../../../../platform/claude/common/claudePrompt.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AgentViewState, EMPTY_AGENT_VIEW_STATE, TurnViewModel } from '../../../../services/claude/common/claudeAgentState.js';
import { ClaudeAgentSession, ClaudeAgentSessionChange, IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IClaudeCheckpointService } from '../../../../services/claude/common/claudeCheckpointService.js';
import { DIAGNOSTIC_SEND_LIMIT } from '../../../../services/claude/common/claudeDiagnostics.js';
import { ToolCardModel } from '../../../../services/claude/common/claudeToolCards.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { Marker, ResourceMarkers } from '../../../markers/browser/markersModel.js';
import { ClaudeFixProblemsCodeActionProvider, resolveFixProblems } from '../../browser/claudeDiagnosticsActions.js';
import { ClaudeDiagnosticsService } from '../../browser/claudeDiagnosticsService.js';
import { ClaudeTimelineCallbacks, ClaudeTimelineRenderer } from '../../browser/chat/claudeTimelineRenderer.js';
import { CLAUDE_FIX_PROBLEMS_COMMAND_ID } from '../../common/claudeViews.js';
import { silentTendService } from './claudeGitHubTestUtils.js';
import { IClaudeTendPullRequestService } from '../../browser/chat/claudeTendPullRequest.js';

const FILE = 'file:///repo/src/a.ts';

suite('Claude diagnostics gestures', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IClaudeTendPullRequestService, silentTendService());
	});

	test('the new-problems row sends that turn when Fix Problems is clicked', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const fixed: string[] = [];
		const problems = [summary('old'), summary('fresh')];
		const renderer = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks({
			problems: {
				get: () => problems,
				fix: turnId => fixed.push(turnId),
			},
		})));
		renderer.render(view(turn('t1', 'complete')));
		assert.ok(root.textContent?.includes('2 new problems'));
		const button = root.querySelector('.claude-new-problems button');
		assert.ok(button instanceof HTMLButtonElement);
		assert.strictEqual(button.textContent, 'Fix Problems with Agent');
		button.click();
		assert.deepStrictEqual(fixed, ['t1']);

		renderer.render(view(turn('t1', 'complete')));
		const one = [summary('only')];
		renderer.render(view(turn('t2', 'complete')));
		const again = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks({
			problems: { get: () => one, fix: () => undefined },
		})));
		root.replaceChildren();
		again.render(view(turn('t2', 'complete')));
		assert.ok(root.textContent?.includes('1 new problem'));
		assert.strictEqual(root.textContent?.includes('2 new problems'), false);
	});

	test('Fix this error on a failed command card sends that card', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		store.add({ dispose: () => root.remove() });
		const cards: ToolCardModel[] = [];
		const failed = commandCard();
		const renderer = store.add(instantiationService.createInstance(ClaudeTimelineRenderer, root, callbacks({
			fixCommandError: card => cards.push(card),
		})));
		renderer.render(view({ ...turn('t1', 'complete'), cards: [failed] }));
		// A finished command folds to its row; Fix this error is in the opened card's footer.
		root.querySelector<HTMLButtonElement>('[data-tool-id="bash-1"] button.claude-tool-row')?.click();
		const button = root.querySelector('button.claude-fix-error');
		assert.ok(button instanceof HTMLButtonElement);
		assert.strictEqual(button.textContent, 'Fix this error');
		button.click();
		assert.strictEqual(cards.length, 1);
		assert.strictEqual(cards[0].command, 'npm test');
		assert.strictEqual(cards[0].exitCode, 1);
	});

	test('the lightbulb offers Fix Problems for markers in the selection', () => {
		const resource = URI.parse(FILE);
		const inside = marker(resource, 'Type mismatch', 12);
		const outside = marker(resource, 'Elsewhere', 2);
		let agentEnabled = true;
		const provider = new ClaudeFixProblemsCodeActionProvider({
			read: () => [inside, outside],
		} as unknown as IMarkerService, workspace(), () => agentEnabled);
		const list = provider.provideCodeActions(model(resource), new Range(12, 1, 12, 8), {} as CodeActionContext, CancellationToken.None);
		assert.ok(list);
		assert.strictEqual(list.actions.length, 1);
		assert.strictEqual(list.actions[0].title, 'Fix Problems with Agent');
		assert.strictEqual(list.actions[0].command?.id, CLAUDE_FIX_PROBLEMS_COMMAND_ID);
		const sent = list.actions[0].command?.arguments?.[0] as DiagnosticSummary[];
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].message, 'Type mismatch');
		assert.strictEqual(sent[0].line, 12);
		assert.strictEqual(provider.provideCodeActions(model(resource), new Range(40, 1, 40, 2), {} as CodeActionContext, CancellationToken.None), undefined);
		// claude.agent.enabled off: no lightbulb, even on a marker.
		agentEnabled = false;
		assert.strictEqual(provider.provideCodeActions(model(resource), new Range(12, 1, 12, 8), {} as CodeActionContext, CancellationToken.None), undefined);
	});

	test('Fix Problems caps selected markers, the active editor, and every marker', () => {
		const resource = URI.parse(FILE);
		const many = Array.from({ length: DIAGNOSTIC_SEND_LIMIT + 5 }, (_value, index) => marker(resource, `e${index}`, index + 1));
		const infos: string[] = [];
		const notifications = { info: (message: string) => infos.push(message) };
		const group = new ResourceMarkers('group', resource);
		group.set(resource, many.map((item, index) => new Marker(String(index), item)));
		const selected = resolveFixProblems(accessor(new Map<unknown, unknown>([
			[INotificationService, notifications],
			[IViewsService, { getActiveViewWithId: () => ({ getFocusedSelectedElements: () => [group], getAllResourceMarkers: () => [] }) }],
			[IWorkspaceContextService, workspace()],
		])), undefined);
		assert.strictEqual(selected.length, DIAGNOSTIC_SEND_LIMIT);
		assert.strictEqual(selected[0].message, 'e0');
		assert.strictEqual(infos.length, 1);
		assert.ok(infos[0].includes(String(DIAGNOSTIC_SEND_LIMIT)));
		assert.ok(infos[0].includes(String(many.length)));

		const filters: { resource?: URI }[] = [];
		const editorMarkers = many.map((item, index) => marker(resource, `editor${index}`, index + 1));
		const everywhere = [marker(resource, 'everywhere', 1)];
		const editorResult = resolveFixProblems(accessor(new Map<unknown, unknown>([
			[INotificationService, notifications],
			[IViewsService, { getActiveViewWithId: () => null }],
			[IWorkspaceContextService, workspace()],
			[IEditorService, { activeEditor: { resource } }],
			[IMarkerService, {
				read: (filter?: { resource?: URI }) => {
					filters.push(filter ?? {});
					return filter?.resource ? editorMarkers : everywhere;
				},
			}],
		])), undefined);
		assert.strictEqual(editorResult.length, DIAGNOSTIC_SEND_LIMIT);
		assert.strictEqual(editorResult[0].message, 'editor0');
		assert.strictEqual(filters.at(-1)?.resource?.toString(), resource.toString());

		const allResult = resolveFixProblems(accessor(new Map<unknown, unknown>([
			[INotificationService, notifications],
			[IViewsService, { getActiveViewWithId: () => null }],
			[IWorkspaceContextService, workspace()],
			[IEditorService, { activeEditor: undefined }],
			[IMarkerService, {
				read: (filter?: { resource?: URI }) => {
					filters.push(filter ?? {});
					return many;
				},
			}],
		])), undefined);
		assert.strictEqual(allResult.length, DIAGNOSTIC_SEND_LIMIT);
		assert.strictEqual(allResult[0].message, 'e0');
		assert.strictEqual(filters.at(-1)?.resource, undefined);
		assert.strictEqual(infos.length, 3);
	});
});

suite('Claude diagnostics service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('historical completed turns do not settle, and a turn seen running does', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			host.states.set('s1', view(turn('old', 'complete', [FILE])));
			const reads: string[] = [];
			const service = local.add(createService(host, reads, { auto: false }));
			await flush();
			assert.deepStrictEqual(reads, []);
			assert.strictEqual(service.getProblems('old'), undefined);
			host.states.set('s1', view(turn('live', 'running')));
			host.fireView();
			host.states.set('s1', view(turn('live', 'complete', [FILE])));
			host.markers = [marker(URI.parse(FILE), 'fresh', 12)];
			host.fireView();
			await until(() => service.getProblems('live') !== undefined);
			assert.deepStrictEqual(reads, ['live']);
			assert.ok((service.getProblems('live') ?? []).length > 0);
		} finally {
			local.dispose();
		}
	});

	test('a turn that completes after startup settles once, and an empty file list is retried once', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			const reads: string[] = [];
			let lookups = 0;
			host.originals = () => {
				lookups++;
				return lookups === 1 ? [] : [{ uri: FILE, capturedAs: 'write' }];
			};
			const service = local.add(createService(host, reads, { auto: false }));
			host.states.set('s1', view(turn('late', 'complete')));
			host.fireView();
			await until(() => service.getProblems('late') !== undefined);
			assert.deepStrictEqual(reads, ['late', 'late']);
			await flush();
			assert.deepStrictEqual(reads, ['late', 'late']);
			assert.deepStrictEqual(service.getProblems('late'), []);
		} finally {
			local.dispose();
		}
	});

	test('auto-verify applies the chain baseline only to the turn the fix action starts', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			host.markers = [marker(URI.parse(FILE), 'old', 1)];
			host.states.set('s1', view(turn('t1', 'running')));
			const reads: string[] = [];
			const service = local.add(createService(host, reads, {
				auto: true,
				cycles: 2,
				run: async () => {
					host.states.set('s1', view(turn('t1', 'complete', [FILE]), turn('fix', 'running')));
					host.fireView();
				},
			}));
			host.markers = [marker(URI.parse(FILE), 'old', 1), marker(URI.parse(FILE), 'fresh', 12)];
			host.states.set('s1', view(turn('t1', 'complete', [FILE])));
			host.fireView();
			await until(() => host.runs === 1);
			host.states.set('s1', view(turn('t1', 'complete', [FILE]), turn('fix', 'complete', [FILE])));
			host.fireView();
			await until(() => service.getProblems('fix') !== undefined);
			assert.deepStrictEqual(service.getProblems('fix')?.map(item => item.message), ['fresh']);
		} finally {
			local.dispose();
		}
	});

	test('a fix that resolves without starting a turn leaves the next user turn on a fresh baseline', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			host.markers = [marker(URI.parse(FILE), 'old', 1)];
			host.states.set('s1', view(turn('t1', 'running')));
			const service = local.add(createService(host, [], {
				auto: true,
				cycles: 2,
				run: async () => undefined,
			}));
			host.markers = [marker(URI.parse(FILE), 'old', 1), marker(URI.parse(FILE), 'fresh', 12)];
			host.states.set('s1', view(turn('t1', 'complete', [FILE])));
			host.fireView();
			await until(() => host.runs === 1);
			await flush();
			host.states.set('s1', view(turn('t1', 'complete', [FILE]), turn('user', 'running')));
			host.fireView();
			host.markers = [marker(URI.parse(FILE), 'old', 1), marker(URI.parse(FILE), 'fresh', 12), marker(URI.parse(FILE), 'another', 20)];
			host.states.set('s1', view(turn('t1', 'complete', [FILE]), turn('user', 'complete', [FILE])));
			host.fireView();
			await until(() => service.getProblems('user') !== undefined);
			assert.deepStrictEqual(service.getProblems('user')?.map(item => item.message), ['another']);
			assert.strictEqual(host.runs, 2);
		} finally {
			local.dispose();
		}
	});

	test('a rejected fix and a session change leave the next user turn on a fresh baseline', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			host.markers = [marker(URI.parse(FILE), 'old', 1)];
			host.states.set('s1', view(turn('t1', 'running')));
			let rejectRun: (error: Error) => void = () => undefined;
			const service = local.add(createService(host, [], {
				auto: true,
				cycles: 2,
				run: () => new Promise((_resolve, reject) => { rejectRun = reject; }),
			}));
			host.markers = [marker(URI.parse(FILE), 'old', 1), marker(URI.parse(FILE), 'fresh', 12)];
			host.states.set('s1', view(turn('t1', 'complete', [FILE])));
			host.fireView();
			await until(() => host.runs === 1);
			host.sessions = [{ id: 's2' }];
			host.current = host.sessions[0];
			host.states.set('s2', EMPTY_AGENT_VIEW_STATE);
			host.fireSession('selected');
			rejectRun(new Error('fix failed'));
			await flush();
			host.states.set('s2', view(turn('user', 'running')));
			host.fireView();
			host.markers = [marker(URI.parse(FILE), 'old', 1), marker(URI.parse(FILE), 'fresh', 12), marker(URI.parse(FILE), 'another', 20)];
			host.states.set('s2', view(turn('user', 'complete', [FILE])));
			host.fireView();
			await until(() => service.getProblems('user') !== undefined);
			assert.deepStrictEqual(service.getProblems('user')?.map(item => item.message), ['another']);
		} finally {
			local.dispose();
		}
	});

	test('closing a session drops its turn state', async () => {
		const local = new DisposableStore();
		try {
			const host = local.add(new DiagnosticHost());
			const service = local.add(createService(host, [], { auto: false }));
			host.states.set('s1', view(turn('t1', 'running')));
			host.fireView();
			host.markers = [marker(URI.parse(FILE), 'fresh', 12)];
			host.states.set('s1', view(turn('t1', 'complete', [FILE])));
			host.fireView();
			await until(() => service.getProblems('t1')?.length === 1);
			host.sessions = [];
			host.current = undefined;
			host.fireSession('closed');
			assert.strictEqual(service.getProblems('t1'), undefined);
			host.sessions = [{ id: 's2' }];
			host.current = host.sessions[0];
			host.states.set('s2', EMPTY_AGENT_VIEW_STATE);
			host.fireSession('selected');
			host.markers = [];
			host.states.set('s2', view(turn('t1', 'running')));
			host.fireView();
			host.markers = [marker(URI.parse(FILE), 'revived', 4)];
			host.states.set('s2', view(turn('t1', 'complete', [FILE])));
			host.fireView();
			await until(() => service.getProblems('t1') !== undefined);
			assert.deepStrictEqual(service.getProblems('t1')?.map(item => item.message), ['revived']);
		} finally {
			local.dispose();
		}
	});
});

class DiagnosticHost {
	sessions: { id: string }[] = [{ id: 's1' }];
	current: { id: string } | undefined = this.sessions[0];
	states = new Map<string, AgentViewState>([['s1', EMPTY_AGENT_VIEW_STATE]]);
	markers: IMarker[] = [];
	runs = 0;
	originals: () => readonly { uri: string; capturedAs: 'write' }[] = () => [{ uri: FILE, capturedAs: 'write' }];
	readonly viewEmitter = new Emitter<{ sessionId: string }>();
	readonly sessionEmitter = new Emitter<ClaudeAgentSessionChange>();
	readonly markerEmitter = new Emitter<readonly URI[]>();

	constructor() { }

	dispose(): void {
		this.viewEmitter.dispose();
		this.sessionEmitter.dispose();
		this.markerEmitter.dispose();
	}

	fireView(): void {
		this.viewEmitter.fire({ sessionId: this.current?.id ?? 's1' });
	}

	fireSession(reason: ClaudeAgentSessionChange['reason']): void {
		this.sessionEmitter.fire({
			reason,
			session: this.current as ClaudeAgentSession | undefined,
			sessions: this.sessions as ClaudeAgentSession[],
		});
	}
}

function createService(host: DiagnosticHost, reads: string[], options: {
	auto: boolean;
	cycles?: number;
	run?: () => Promise<void>;
}): ClaudeDiagnosticsService {
	const agent = {
		onDidChangeViewState: host.viewEmitter.event,
		onDidChangeSession: host.sessionEmitter.event,
		getCurrentSession: () => host.current as ClaudeAgentSession | undefined,
		getSessions: () => host.sessions as ClaudeAgentSession[],
		getViewState: (sessionId: string) => host.states.get(sessionId) ?? EMPTY_AGENT_VIEW_STATE,
	} as unknown as IClaudeAgentService;
	const markers = {
		onMarkerChanged: host.markerEmitter.event,
		read: () => host.markers,
	} as unknown as IMarkerService;
	const configuration = {
		getValue: (key: string) => {
			if (key === CLAUDE_DIAGNOSTICS_SETTLE_MS_SETTING) {
				return 0;
			}
			if (key === CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING) {
				return options.auto;
			}
			if (key === CLAUDE_DIAGNOSTICS_MAX_CYCLES_SETTING) {
				return options.cycles ?? 1;
			}
			return undefined;
		},
	} as unknown as IConfigurationService;
	const checkpoints = {
		readCheckpointOriginals: async (_sessionId: string, turnId: string) => {
			reads.push(turnId);
			return host.originals();
		},
	} as unknown as IClaudeCheckpointService;
	const actions = {
		run: async () => {
			host.runs++;
			await options.run?.();
		},
	} as unknown as IClaudeActionService;
	return new ClaudeDiagnosticsService(agent, markers, configuration, workspace(), checkpoints, actions);
}

function workspace(): IWorkspaceContextService {
	return {
		getWorkspace: () => ({ folders: [{ uri: URI.parse('file:///repo') }] }),
	} as unknown as IWorkspaceContextService;
}

function accessor(services: Map<unknown, unknown>): ServicesAccessor {
	return {
		get<T>(id: unknown): T {
			return services.get(id) as T;
		},
	} as ServicesAccessor;
}

function model(resource: URI): ITextModel {
	return { uri: resource } as ITextModel;
}

function marker(resource: URI, message: string, line: number): IMarker {
	return {
		owner: 'test',
		resource,
		severity: MarkerSeverity.Error,
		message,
		source: 'ts',
		code: '2322',
		startLineNumber: line,
		startColumn: 1,
		endLineNumber: line,
		endColumn: 4,
	};
}

function summary(message: string): DiagnosticSummary {
	return { uri: FILE, path: 'src/a.ts', severity: 'error', line: 1, column: 1, source: 'ts', code: '1', message };
}

function turn(id: string, status: TurnViewModel['status'], changedFiles: string[] = []): TurnViewModel {
	return {
		id,
		user: { text: 'Edit the file' },
		assistantText: '',
		status,
		cards: [],
		changedFiles,
		permissions: [],
		segmentOpen: false,
		segmentStart: 0,
		steered: [],
	};
}

function view(...turns: TurnViewModel[]): AgentViewState {
	return { turns, subagents: [] };
}

function commandCard(): ToolCardModel {
	return {
		id: 'bash-1',
		name: 'Bash',
		category: 'shell',
		kind: 'command',
		label: 'Bash',
		verb: 'Ran',
		target: 'npm test',
		command: 'npm test',
		cwd: '/repo',
		exitCode: 1,
		lines: ['FAIL src/a.test.ts'],
		droppedLines: 0,
		streamedChars: 0,
		state: 'failed',
		error: 'exit 1',
	};
}

function callbacks(extra: Partial<ClaudeTimelineCallbacks>): ClaudeTimelineCallbacks {
	return {
		retry: () => undefined,
		build: async () => undefined,
		respondPermission: async () => undefined,
		openSubagent: () => undefined,
		stopSubagent: () => undefined,
		copyCommand: () => undefined,
		openInTerminal: () => undefined,
		rerunCommand: () => undefined,
		openCommandLog: () => undefined,
		...extra,
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 30; i++) {
		if (check()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('timed out');
}
