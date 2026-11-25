/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeWorktreeService } from '../../../../../platform/claude/common/claudeBackground.js';
import { ClaudeReviewResult, IClaudeRuntimeService } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_COMMIT_REVIEW_MARKER_OWNER } from '../../../../../platform/claude/common/claudeCommitReview.js';
import { ClaudeReviewRequest } from '../../../../../platform/claude/common/claudeReviewLoop.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileChangesEvent, IFileContent, IFileService, IFileSystemWatcher } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarker, IMarkerData, IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { INotificationHandle, IPromptChoice, IPromptOptions, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ClaudeCommitReview } from '../../browser/claudeCommitReview.js';
import { ClaudeCommitReviewState } from '../../browser/claudeCommitReviewState.js';

const ROOT = URI.file('/repo');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function reflogLine(old: string, next: string, action: string): string {
	return `${old} ${next} Klawly <klawly@example.com> 1760000000 +0000\t${action}\n`;
}

class RecordingNotifications extends TestNotificationService {
	readonly shown: string[] = [];
	override prompt(severity: Severity, message: string, choices: IPromptChoice[], options?: IPromptOptions): INotificationHandle {
		this.shown.push(message);
		return super.prompt(severity, message, choices, options);
	}
}

suite('Claude commit review (issue 502)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(setting: string, trusted = true) {
		const files = new Map<string, string>([
			['/repo/.git/logs/HEAD', reflogLine('0'.repeat(40), A, 'commit (initial): base')],
			['/repo/REVIEW.md', 'Check SQL.'],
		]);
		const requests: ClaudeReviewRequest[] = [];
		const markers: string[] = [];
		const notifications = new RecordingNotifications();
		const shown = notifications.shown;
		const fileService = {
			createWatcher: () => ({ onDidChange: Event.None as Event<FileChangesEvent>, dispose: () => { } }) as IFileSystemWatcher,
			readFile: async (resource: URI) => {
				const value = files.get(resource.path);
				if (value === undefined) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(value) } as IFileContent;
			},
		} as Partial<IFileService> as IFileService;
		const git = {
			commitDiff: async (root: string, sha: string) => `diff --git a/a.ts b/a.ts\n+${root} ${sha.slice(0, 7)}\n`,
		} as Partial<IClaudeWorktreeService> as IClaudeWorktreeService;
		const runtime = {
			reviewChanges: async (request: ClaudeReviewRequest): Promise<ClaudeReviewResult> => {
				requests.push(request);
				return {
					ok: true, event: {
						type: 'review.findings', sessionId: request.sessionId, reviewId: request.reviewId, findings: [
							{ file: 'src/a.ts', startLine: 3, endLine: 4, severity: 'high', category: 'bug' as const, title: 'Unchecked input', body: 'It reaches the query.' },
						],
					},
				};
			},
		} as Partial<IClaudeRuntimeService> as IClaudeRuntimeService;
		const markerService = {
			changeAll: (owner: string, data: { resource: URI; marker: IMarkerData }[]) => {
				markers.push(...data.map(({ resource, marker }) => `${owner} ${resource.path}:${marker.startLineNumber}-${marker.endLineNumber} ${marker.severity} ${marker.source} ${marker.message.split('\n')[0]}`));
			},
			read: () => [] as IMarker[],
		} as Partial<IMarkerService> as IMarkerService;
		const workspace = { getWorkspace: () => testWorkspace(ROOT) } as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const trust = { isWorkspaceTrusted: () => trusted } as Partial<IWorkspaceTrustManagementService> as IWorkspaceTrustManagementService;
		const commands = { executeCommand: async () => undefined } as Partial<ICommandService> as ICommandService;
		const languageFeatures = new LanguageFeaturesService();
		const textModels = { createModelReference: async () => { throw new Error('no model'); } } as Partial<ITextModelService> as ITextModelService;
		const contribution = store.add(new ClaudeCommitReview(fileService, workspace, new TestConfigurationService({ claude: { git: { reviewAfterCommit: setting } } }), trust, git, runtime, store.add(new ClaudeCommitReviewState(markerService, store.add(new InMemoryStorageService()))), notifications, commands, new NullLogService(), languageFeatures, textModels));
		// The constructor reads where the reflog starts.
		await new Promise(resolve => setTimeout(resolve, 0));
		const commit = async (action: string) => {
			files.set('/repo/.git/logs/HEAD', files.get('/repo/.git/logs/HEAD') + reflogLine(A, B, action));
			await contribution.check();
		};
		return { contribution, requests, markers, shown, commit };
	}

	test('a new commit is reviewed once, with the project notes, and its findings become markers', async () => {
		const { contribution, requests, markers, shown, commit } = await setup('deep');
		await contribution.check();
		await commit('commit: add query');
		await contribution.check();
		assert.deepStrictEqual({
			requests: requests.map(({ reviewId, cwd, model, instructions, diff }) => ({ reviewId, cwd, model, instructions, diff })),
			markers,
			shown,
		}, {
			requests: [{ reviewId: `commit-${B}`, cwd: ROOT.fsPath, model: 'opus', instructions: 'Check SQL.', diff: `diff --git a/a.ts b/a.ts\n+${ROOT.fsPath} bbbbbbb\n` }],
			markers: [`${CLAUDE_COMMIT_REVIEW_MARKER_OWNER} /repo/src/a.ts:3-4 8 Claude review bbbbbbb Unchecked input`],
			shown: ['Claude found 1 thing to look at in bbbbbbb.'],
		});
	});

	test('off, untrusted, and a checkout do not review', async () => {
		const off = await setup('off');
		await off.commit('commit: add query');
		const untrusted = await setup('quick', false);
		await untrusted.commit('commit: add query');
		const checkout = await setup('quick');
		await checkout.commit('checkout: moving from main to x');
		assert.deepStrictEqual([off.requests.length, untrusted.requests.length, checkout.requests.length], [0, 0, 0]);
	});
});
