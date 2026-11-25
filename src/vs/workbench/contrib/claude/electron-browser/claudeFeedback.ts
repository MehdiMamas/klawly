/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { toAction } from '../../../../base/common/actions.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { process } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ClaudeRuntimeState, IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING, CLAUDE_MODELS_DEFAULT_SETTING, CLAUDE_MODELS_EFFORT_SETTING } from '../../../../platform/claude/common/claudeConfiguration.js';
import { IClaudeFeedbackService } from '../../../../platform/claude/common/claudeFeedbackRelay.js';
import { CLAUDE_PROTOCOL_VERSION } from '../../../../platform/claude/common/claudeProtocol.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ByteSize, IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';
import { IKlawlyAccountService } from '../../../services/claude/common/klawlyAccount.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ClaudeFeedbackDrafts } from '../browser/feedback/claudeFeedbackDrafts.js';
import { ClaudeFeedbackForm, IClaudeFeedbackStatus, shrinkClaudeFeedbackImage } from '../browser/feedback/claudeFeedbackForm.js';
import { buildClaudeDiagnosticsFiles, scrubClaudeDiagnosticsText } from '../common/claudeDiagnosticsExport.js';
import { claudeFeedbackPrefillDraft, ClaudeFeedbackPrefill, buildClaudeFeedbackPayload, CLAUDE_SEND_FEEDBACK_COMMAND_ID, ClaudeFeedbackDraft, ClaudeFeedbackImage, claudeFeedbackImageName, ClaudeFeedbackSendError, ClaudeFeedbackText, claudeFeedbackErrorLines, claudeFeedbackIssueNumber, ClaudeFeedbackBannedError, ClaudeFeedbackSignInError, KLAWLY_FEEDBACK_DEFAULT_ENDPOINT, KLAWLY_FEEDBACK_ENABLED_SETTING, KLAWLY_FEEDBACK_ENDPOINT_SETTING, KLAWLY_FEEDBACK_LOG_BUDGET, tailClaudeFeedbackLog } from '../common/claudeFeedback.js';
import { autoSendClaudeFeedback, claudeFeedbackAutoSendDelay } from '../common/claudeFeedbackAutoSend.js';
import { KLAWLY_CATEGORY } from '../common/claudeViews.js';
import { runKlawlyGitHubSignIn } from '../browser/klawlyProfile.js';
import { readAgentLog } from './claudeDiagnosticsExport.js';

const FEEDBACK_STATUS_ENTRY_ID = 'klawly.feedback';

/** The form that is open, so a second click focuses it instead of opening another. */
const openForm = new MutableDisposable<ClaudeFeedbackForm>();

/**
 * The Feedback item on the right of the status bar, just left of the notifications
 * bell (issue 444). Shown while `klawly.feedback.enabled` is on.
 */
export class ClaudeFeedbackStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyFeedbackStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._register(this._configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(KLAWLY_FEEDBACK_ENABLED_SETTING)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		if (this._configuration.getValue(KLAWLY_FEEDBACK_ENABLED_SETTING) === false) {
			this._entry.clear();
			return;
		}
		if (!this._entry.value) {
			this._entry.value = this._statusbar.addEntry({
				name: localize('klawlyFeedbackStatusName', "Send Feedback"),
				text: '$(feedback)',
				ariaLabel: localize('klawlyFeedbackStatusAria', "Send Feedback"),
				tooltip: localize('klawlyFeedbackStatusTooltip', "Send Feedback to the Klawly Team"),
				command: CLAUDE_SEND_FEEDBACK_COMMAND_ID,
			}, FEEDBACK_STATUS_ENTRY_ID, StatusbarAlignment.RIGHT, -Number.MAX_SAFE_INTEGER);
		}
	}
}

const AUTO_SEND_LOCK_KEY = 'klawly.feedback.autosend.lock';
const AUTO_SEND_LOCK_MS = 2 * 60_000;
const AUTO_SEND_START_DELAY_MS = 30_000;

/**
 * Sends the reports kept after a failed send on its own: once shortly after startup, then
 * again after 5 minutes, 30 minutes and hourly while any remain. One window at a time, through a
 * storage lock. A ban or a missing GitHub sign-in stops it for this session; the form shows why.
 */
export class ClaudeFeedbackAutoSendContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyFeedbackAutoSend';

	private readonly _timer = this._register(new MutableDisposable());
	private _attempt = 0;

	constructor(
		@IInstantiationService private readonly _instantiation: IInstantiationService,
		@IStorageService private readonly _storage: IStorageService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this.schedule(AUTO_SEND_START_DELAY_MS);
	}

	private schedule(delay: number): void {
		const handle = setTimeout(() => this.run(), delay);
		this._timer.value = { dispose: () => clearTimeout(handle) };
	}

	private async run(): Promise<void> {
		const drafts = new ClaudeFeedbackDrafts(this._storage);
		if (drafts.unsent.length === 0) {
			return;
		}
		// The form open on a kept report, or another window sending, means try again later.
		const lock = Number(this._storage.get(AUTO_SEND_LOCK_KEY, StorageScope.APPLICATION) ?? 0);
		let outcome: 'done' | 'retry' | 'stop' = 'retry';
		if (!openForm.value && Date.now() - lock > AUTO_SEND_LOCK_MS) {
			this._storage.store(AUTO_SEND_LOCK_KEY, String(Date.now()), StorageScope.APPLICATION, StorageTarget.MACHINE);
			try {
				outcome = await autoSendClaudeFeedback(drafts.unsent, {
					send: draft => this._instantiation.invokeFunction(sendFeedback, draft, () => { }),
					remove: id => drafts.removeUnsent(id),
					keep: entry => drafts.saveUnsent(entry),
					onSent: (entry, number) => this._notifications.info(localize('klawlyFeedbackKeptSent', "Your kept report \"{0}\" was sent (report #{1}).", entry.draft.title, number)),
					log: message => this._log.info(message),
				});
			} finally {
				this._storage.remove(AUTO_SEND_LOCK_KEY, StorageScope.APPLICATION);
			}
		}
		if (outcome !== 'stop' && outcome !== 'done' && !this._store.isDisposed) {
			this.schedule(claudeFeedbackAutoSendDelay(this._attempt++));
		}
	}
}

/**
 * Claude called `klawly_feedback` (issue 1174): the window that owns the chat opens Send Feedback
 * with Claude's text in it. Nothing is sent from here; the user's own Send click does that.
 */
export class ClaudeFeedbackToolContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.klawlyFeedbackTool';

	constructor(
		@IClaudeAgentService agent: IClaudeAgentService,
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@ICommandService commands: ICommandService,
	) {
		super();
		if (runtime.onDidRequestFeedback) {
			this._register(runtime.onDidRequestFeedback(request => {
				if (agent.getSessions().some(session => agent.getRuntimeSessionId(session.id) === request.sessionId)) {
					void commands.executeCommand(CLAUDE_SEND_FEEDBACK_COMMAND_ID, undefined, { kind: request.kind, title: request.title, description: request.description } satisfies ClaudeFeedbackPrefill);
				}
			}));
		}
	}
}

/** Klawly: Send Feedback, from the status bar, the command palette and the Help menu. */
export function registerClaudeFeedback(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: CLAUDE_SEND_FEEDBACK_COMMAND_ID,
				title: { ...localize2('klawlySendFeedback', "Send Feedback"), original: 'Send Feedback (Report Issue, Report a Bug, Report a Problem)' },
				category: KLAWLY_CATEGORY,
				f1: true,
				menu: { id: MenuId.MenubarHelpMenu, group: '3_feedback', order: 0 },
			});
		}

		/** `unsentId` opens a report whose send failed (issue 735); without it the kept draft or a fresh report opens. `prefill` is Claude's text from `klawly_feedback` (issue 1174); it only fills the form, the user sends. */
		async run(accessor: ServicesAccessor, unsentId?: unknown, prefill?: ClaudeFeedbackPrefill): Promise<void> {
			if (openForm.value) {
				return;
			}
			const nativeHost = accessor.get(INativeHostService);
			const layout = accessor.get(ILayoutService);
			const instantiation = accessor.get(IInstantiationService);
			const commands = accessor.get(ICommandService);
			const storage = accessor.get(IStorageService);
			const profile = accessor.get(IKlawlyAccountService);
			const configuration = accessor.get(IConfigurationService);
			const feedbackService = accessor.get(IClaudeFeedbackService);
			// Who is signed in and whether that account is banned, from the relay (issue 949).
			const getStatus = async (): Promise<IClaudeFeedbackStatus> => {
				const session = await profile.getSessionSilently();
				if (!session) {
					return {};
				}
				const login = profile.account?.login ?? session.account.label;
				try {
					const status = await feedbackService.getStatus(feedbackEndpoint(configuration), session.accessToken);
					switch (status.kind) {
						case 'ok': return { login: status.login };
						case 'banned': return { login: status.ban.login, ban: status.ban };
						case 'login_required': return {};
						case 'unavailable': return { login };
					}
				} catch {
					return { login };
				}
			};
			// The same sign-in as the Accounts menu (issue 446).
			const signIn = async () => await instantiation.invokeFunction(runKlawlyGitHubSignIn) ? await getStatus() : {};
			const switchAccount = async () => {
				await profile.signOut();
				return signIn();
			};

			const drafts = new ClaudeFeedbackDrafts(storage);
			const unsent = drafts.unsent.find(entry => entry.id === unsentId);
			const kept = unsent?.draft ?? drafts.draft;
			// A fresh report starts with the window as the tester saw it; a kept one keeps its own images.
			const screenshot = kept && !prefill ? undefined : await captureWindow(nativeHost);
			const draft = prefill ? claudeFeedbackPrefillDraft(prefill, kept, kept ? undefined : screenshot) : kept;
			if (openForm.value) {
				return;
			}
			// Reports that did not send stay reachable from the form, even after a restart.
			const others = drafts.unsent.filter(entry => entry !== unsent);
			const latest = others.at(-1);
			const notice = !unsent && latest ? {
				text: others.length === 1
					? localize('klawlyFeedbackUnsentOne', "A report you sent earlier did not go through.")
					: localize('klawlyFeedbackUnsentMany', "{0} reports you sent earlier did not go through.", others.length),
				label: localize('klawlyFeedbackOpenUnsent', "Open It"),
				run: () => {
					form.close('closed');
					commands.executeCommand(CLAUDE_SEND_FEEDBACK_COMMAND_ID, latest.id);
				},
			} : undefined;
			const keep = (kept: ClaudeFeedbackDraft) => unsent ? drafts.saveUnsent({ ...unsent, draft: kept }) : drafts.saveDraft(kept);
			const form = instantiation.createInstance(ClaudeFeedbackForm, layout.activeContainer, {
				screenshot,
				draft,
				error: unsent ? { message: unsent.error, attachment: unsent.attachment } : undefined,
				notice,
				submit: report => { instantiation.invokeFunction(sendFeedbackInBackground, report); },
				getStatus,
				signIn,
				switchAccount,
			});
			openForm.value = form;
			// Quitting with the form open keeps what it holds (issue 739).
			const saveOnQuit = storage.onWillSaveState(() => keep(form.getDraft()));
			form.onDidClose(({ reason, draft: closed }) => {
				saveOnQuit.dispose();
				if (reason === 'closed') {
					keep(closed);
				} else if (unsent) {
					drafts.removeUnsent(unsent.id);
				} else {
					drafts.saveDraft(undefined);
				}
				if (openForm.value === form) {
					openForm.clearAndLeak();
				}
			});
		}
	});
}

async function captureWindow(nativeHost: INativeHostService): Promise<ClaudeFeedbackImage | undefined> {
	try {
		// The main process encodes the window as JPEG (issue 698).
		const jpeg = await nativeHost.getScreenshot();
		if (!jpeg) {
			return undefined;
		}
		const image = await shrinkClaudeFeedbackImage(mainWindow, jpeg.buffer, 'image/jpeg');
		return { ...image, name: claudeFeedbackImageName('screenshot', image.type) };
	} catch {
		return undefined;
	}
}

/**
 * Sends a report while the tester goes on working (issue 735): progress in a notification,
 * thanks when it is filed. A report that fails is kept with the reason, and the error
 * notification opens it again so nothing the tester wrote is lost.
 */
export async function sendFeedbackInBackground(accessor: ServicesAccessor, report: ClaudeFeedbackDraft): Promise<void> {
	const progress = accessor.get(IProgressService);
	const notifications = accessor.get(INotificationService);
	const commands = accessor.get(ICommandService);
	const instantiation = accessor.get(IInstantiationService);
	const drafts = new ClaudeFeedbackDrafts(accessor.get(IStorageService));
	try {
		const number = await progress.withProgress({
			location: ProgressLocation.Notification,
			title: localize('klawlyFeedbackSending', "Sending feedback: {0}", report.title),
		}, progress => instantiation.invokeFunction(sendFeedback, report, size => progress.report({ message: localize('klawlyFeedbackSendingSize', "Uploading {0}", ByteSize.formatSize(size)) })));
		notifications.info(localize('klawlyFeedbackSent', "Thanks! Your feedback was sent to the Klawly team (report #{0}).", number));
	} catch (error) {
		if (error instanceof ClaudeFeedbackBannedError) {
			// Not kept to send again: the form opens on the ban panel instead.
			notifications.notify({
				severity: Severity.Error,
				message: error.message,
				actions: {
					primary: [toAction({ id: 'klawly.feedback.openBan', label: localize('klawlyFeedbackSeeBan', "See Details"), run: () => commands.executeCommand(CLAUDE_SEND_FEEDBACK_COMMAND_ID) })],
				},
			});
			return;
		}
		const id = generateUuid();
		const message = error instanceof ClaudeFeedbackSendError ? error.message : localize('klawlyFeedbackFailed', "Could not send: {0}", error instanceof Error ? error.message : String(error));
		drafts.saveUnsent({ id, draft: report, error: message, attachment: error instanceof ClaudeFeedbackSendError ? error.attachment : undefined });
		notifications.notify({
			severity: Severity.Error,
			message: localize('klawlyFeedbackNotSent', "{0} Your report \"{1}\" is kept, so you can send it again.", message, report.title),
			actions: {
				primary: [toAction({ id: 'klawly.feedback.openUnsent', label: localize('klawlyFeedbackOpenReport', "Open Report"), run: () => commands.executeCommand(CLAUDE_SEND_FEEDBACK_COMMAND_ID, id) })],
			},
		});
	}
}

/** Builds the report, posts it to the relay and returns the new issue number. */
export async function sendFeedback(accessor: ServicesAccessor, result: ClaudeFeedbackDraft, onSize: (bytes: number) => void): Promise<number> {
	const log = accessor.get(ILogService);
	const started = performance.now();
	const feedback = accessor.get(IClaudeFeedbackService);
	const configuration = accessor.get(IConfigurationService);
	// The accessor is only valid until the first await, so every service is taken here.
	const account = accessor.get(IKlawlyAccountService);
	const instantiation = accessor.get(IInstantiationService);
	const diagnostics = result.includeDiagnostics ? await instantiation.invokeFunction(collectDiagnostics) : undefined;
	const collected = performance.now();
	const payload = buildClaudeFeedbackPayload({
		kind: result.kind,
		title: result.title,
		description: result.description,
		system: diagnostics?.system,
		errors: diagnostics?.errors,
		images: result.images,
		texts: diagnostics?.texts ?? [],
	});
	// The relay files the report under the GitHub account the token belongs to (issue 949).
	const token = (await account.getSessionSilently())?.accessToken;
	if (!token) {
		throw new ClaudeFeedbackSignInError(localize('klawlyFeedbackSignInFirst', "Sign in to GitHub to send feedback, then send the report again."));
	}
	// Posted from the shared process: the relay answers no CORS preflight (issue 538).
	const body = JSON.stringify(payload);
	onSize(body.length);
	const posted = performance.now();
	const number = claudeFeedbackIssueNumber(await feedback.send(feedbackEndpoint(configuration), body, token));
	log.info(`[feedback] diagnostics ${Math.round(collected - started)} ms, payload ${body.length} bytes, post ${Math.round(performance.now() - posted)} ms`);
	return number;
}

function feedbackEndpoint(configuration: IConfigurationService): string {
	return configuration.getValue<string>(KLAWLY_FEEDBACK_ENDPOINT_SETTING) || KLAWLY_FEEDBACK_DEFAULT_ENDPOINT;
}

interface CollectedDiagnostics {
	readonly system: readonly (readonly [string, string])[];
	readonly errors: readonly string[];
	readonly texts: readonly ClaudeFeedbackText[];
}

/**
 * System info and redacted logs: the diagnostics export files (versions, `claude.*`
 * settings, event types, Claude Agent output) and the tails of this window's
 * renderer log, the main log and the shared process log. Credential files are never read.
 */
async function collectDiagnostics(accessor: ServicesAccessor): Promise<CollectedDiagnostics> {
	const product = accessor.get(IProductService);
	const nativeHost = accessor.get(INativeHostService);
	const runtime = accessor.get(IClaudeRuntimeService);
	const configuration = accessor.get(IConfigurationService);
	const output = accessor.get(IOutputService);
	const textModels = accessor.get(ITextModelService);
	const paths = accessor.get(IPathService);
	const files = accessor.get(IFileService);
	const environment = accessor.get(INativeWorkbenchEnvironmentService);

	const home = (await paths.userHome()).fsPath;
	const homes = [home, home.replace(/\\/g, '/')];
	const share = Math.floor(KLAWLY_FEEDBACK_LOG_BUDGET / 4);
	const readLog = async (resource: URI) => {
		try {
			const contents = (await files.readFile(resource)).value.toString();
			return tailClaudeFeedbackLog(scrubClaudeDiagnosticsText(contents, homes), share);
		} catch {
			return '';
		}
	};
	// The runtime state, the agent log, the OS and the three log files do not depend on each other: read them together (issue 943).
	const [runtimeResult, agentLog, os, renderer, main, shared] = await Promise.all([
		runtime.getRuntimeState().then(value => ({ state: value as ClaudeRuntimeState | undefined, error: undefined as string | undefined }), (error: unknown) => ({ state: undefined, error: error instanceof Error ? error.message : String(error) })),
		readAgentLog(output, textModels).catch(() => ''),
		nativeHost.getOSProperties(),
		readLog(environment.logFile),
		readLog(joinPath(environment.logsHome, 'main.log')),
		readLog(joinPath(environment.logsHome, 'sharedprocess.log')),
	]);
	const state = runtimeResult.state;
	const runtimeError = runtimeResult.error;
	const exported = buildClaudeDiagnosticsFiles({
		generatedAt: new Date().toISOString(),
		product: { nameLong: product.nameLong, version: product.version, commit: product.commit, date: product.date, quality: product.quality },
		protocolVersion: CLAUDE_PROTOCOL_VERSION,
		runtime: state,
		runtimeError,
		os: { type: os.type, release: os.release, arch: os.arch },
		configuration: configuration.getValue('claude'),
		log: agentLog,
		homeDirectories: homes,
	});
	const exportedText = (path: string) => exported.find(file => file.path === path)?.contents ?? '';

	const setting = (key: string) => {
		const value = configuration.getValue(key);
		return typeof value === 'string' && value ? value : 'default';
	};
	const versions = process.versions;
	const system: [string, string][] = [
		['Klawly', `${product.version}${product.commit ? ` (${product.commit.slice(0, 8)})` : ''}`],
		['Built', product.date ?? 'unknown'],
		['OS', `${os.type} ${os.release} ${os.arch}`],
		['Electron', `${versions.electron ?? '?'} · Chromium ${versions.chrome ?? '?'} · Node ${versions.node ?? '?'}`],
		['Claude Code', state ? `${state.version ?? 'unknown'}${state.installed === false ? ' (not installed)' : ''}` : `unavailable: ${scrubClaudeDiagnosticsText(runtimeError ?? 'unknown', homes)}`],
		['Signed in', state ? (state.authenticated ? (state.authMode ?? 'yes') : 'no') : 'unknown'],
		['Model', `${setting(CLAUDE_MODELS_DEFAULT_SETTING)} · effort ${setting(CLAUDE_MODELS_EFFORT_SETTING)}`],
		['Permission mode', setting(CLAUDE_AGENT_DEFAULT_PERMISSION_MODE_SETTING)],
		['Locale', language],
	];

	return {
		system,
		errors: claudeFeedbackErrorLines([exportedText('errors.log'), renderer].join('\n')),
		texts: [
			{ name: 'claude-agent.log', contents: tailClaudeFeedbackLog(exportedText('claude-agent.log'), share) },
			{ name: 'renderer.log', contents: renderer },
			{ name: 'main.log', contents: main },
			{ name: 'sharedprocess.log', contents: shared },
			{ name: 'claude-settings.json', contents: exportedText('configuration.json') },
			{ name: 'claude-events.json', contents: exportedText('events.json') },
		],
	};
}
