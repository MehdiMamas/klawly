/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { AgentFailureKind } from '../../../../platform/claude/common/claudeProtocol.js';
import { AgentViewState, hasPendingElicitation, permissionsForTimeline } from '../../../services/claude/common/claudeAgentState.js';
import { claudeAccountActions } from './claudeAccountActions.js';
import { ClaudeUsageRowPart } from './claudeUsageRow.js';

/** Official Claude Code install guide. Opened by Install Claude Code. */
export const CLAUDE_CODE_INSTALL_DOCS_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup';

/** The official Claude Code installer, run as an argument array in a visible terminal. */
export interface ClaudeInstallerCommand {
	readonly executable: string;
	readonly args: readonly string[];
	/** What the user is shown before it runs. */
	readonly display: string;
}

/**
 * Official per-user installer for each OS. It installs into the user's home
 * folder and never asks for administrator rights.
 *
 * `standIn` is for the fake runtime (`claude.agent.runtime: fake`) that tests and
 * screenshots use: a command that downloads nothing, prints one line, waits
 * {@link CLAUDE_STAND_IN_INSTALL_SECONDS} and fails, so the setup card goes
 * through installing, stalled and failed without a real install (issue 797).
 */
export function claudeInstallerCommand(os: OperatingSystem, standIn = false): ClaudeInstallerCommand {
	if (standIn) {
		const line = 'Klawly test installer: this downloads nothing and fails on purpose.';
		const script = os === OperatingSystem.Windows
			? `Write-Output '${line}'; Start-Sleep -Seconds ${CLAUDE_STAND_IN_INSTALL_SECONDS}; exit 1`
			: `echo '${line}'; sleep ${CLAUDE_STAND_IN_INSTALL_SECONDS}; exit 1`;
		return os === OperatingSystem.Windows
			? { executable: 'powershell.exe', args: ['-NoProfile', '-Command', script], display: script }
			: { executable: '/bin/bash', args: ['-c', script], display: script };
	}
	if (os === OperatingSystem.Windows) {
		const script = 'irm https://claude.ai/install.ps1 | iex';
		return { executable: 'powershell.exe', args: ['-NoProfile', '-Command', script], display: script };
	}
	const script = 'curl -fsSL https://claude.ai/install.sh | bash';
	return { executable: '/bin/bash', args: ['-c', script], display: script };
}

/** How often Klawly looks at a running install: the download's size, and every few looks, Claude Code itself. */
export const CLAUDE_INSTALL_POLL_MS = 2000;

/** An install with no progress for this long is shown as stalled, with Retry (issue 783). */
export const CLAUDE_INSTALL_STALL_MS = 3 * 60 * 1000;

/** How long the fake runtime's stand-in installer runs before it fails (issue 797). */
export const CLAUDE_STAND_IN_INSTALL_SECONDS = 40;

/** The stand-in installer counts as stalled after this, so a screenshot sees that state too. */
export const CLAUDE_STAND_IN_INSTALL_STALL_MS = 15 * 1000;

/**
 * A run of the official installer that Klawly watches (issue 783). The installer
 * downloads a few hundred MB and prints nothing until it is done, so the card
 * shows what Klawly can see instead: the download's size and the time it has run.
 */
export interface ClaudeInstallProgress {
	/**
	 * `running` until Claude Code is found or the installer ends. `stalled` after
	 * {@link CLAUDE_INSTALL_STALL_MS} without progress; the installer keeps running.
	 * `failed` when it ended and Claude Code was still not found.
	 */
	readonly state: 'running' | 'stalled' | 'failed';
	/** When the installer started, in ms since the epoch. */
	readonly startedAt: number;
	/** Bytes the installer has downloaded so far. Undefined until its download file appears. */
	readonly downloadedBytes?: number;
	/** The download is done and the installer is setting Claude Code up. */
	readonly settingUp?: boolean;
	/** The installer's exit code, once it ended. */
	readonly exitCode?: number;
}

/** `0:42`, `12:05`, `1:02:03`. */
export function formatClaudeInstallElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total / 60) % 60;
	const seconds = String(total % 60).padStart(2, '0');
	return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The live line under the install step: what the installer is doing, and for how long. */
export function claudeInstallStatusLine(progress: ClaudeInstallProgress, now: number): string {
	const elapsed = formatClaudeInstallElapsed(now - progress.startedAt);
	if (progress.settingUp) {
		return localize('claudeInstallSettingUp', "Setting up Claude Code · {0}", elapsed);
	}
	if (progress.downloadedBytes !== undefined) {
		return localize('claudeInstallDownloaded', "Downloaded {0} MB · {1}", Math.round(progress.downloadedBytes / (1024 * 1024)), elapsed);
	}
	return localize('claudeInstallStarting', "Starting the download · {0}", elapsed);
}

/**
 * Where onboarding stands (spec 6, 72). `checking` means no probe has answered
 * yet: the pane keeps the composer and shows no setup card.
 */
export type ClaudeSetupPhase = 'checking' | 'missing' | 'signed-out' | 'waiting-sign-in' | 'ready';

/** Only real, probed state. A sign-in in progress never counts as signed in. */
export function claudeSetupPhase(runtime: ClaudeRuntimeState | undefined, waitingForSignIn: boolean): ClaudeSetupPhase {
	if (!runtime) {
		return 'checking';
	}
	if (!runtime.installed) {
		return 'missing';
	}
	if (!runtime.authenticated) {
		return waitingForSignIn ? 'waiting-sign-in' : 'signed-out';
	}
	return 'ready';
}

/** True when the Agent pane shows the setup card instead of the composer. */
export function claudeSetupBlocksComposer(phase: ClaudeSetupPhase): boolean {
	return phase === 'missing' || phase === 'signed-out' || phase === 'waiting-sign-in';
}

export interface ClaudeSetupStep {
	readonly id: 'runtime' | 'sign-in' | 'import';
	/** `busy` while the installer runs (issue 783). */
	readonly state: 'done' | 'todo' | 'busy' | 'error';
	readonly title: string;
	readonly detail?: string;
	/** Text the runtime reported, such as a version warning. Shown as is. */
	readonly note?: string;
	/** The card shows the install's live status line ({@link claudeInstallStatusLine}) under this step. */
	readonly live?: boolean;
}

/**
 * The optional Import step of onboarding. Present only when VS Code or Cursor
 * is installed on this computer.
 */
export interface ClaudeImportOffer {
	/** Display names of the installed editors, such as `VS Code`. */
	readonly editors: readonly string[];
	/** An import already finished in this profile. */
	readonly done: boolean;
}

/** `VS Code or Cursor`, or the one installed editor. */
export function claudeImportOfferEditors(offer: ClaudeImportOffer): string {
	return offer.editors.length > 1
		? localize('claudeImportEditorsOr', "{0} or {1}", offer.editors.slice(0, -1).join(', '), offer.editors[offer.editors.length - 1])
		: offer.editors[0] ?? '';
}

/**
 * The checklist on the setup card. Onboarding steps are listed here in order;
 * the optional Import step comes last and only when an editor was found.
 */
export function claudeSetupSteps(runtime: ClaudeRuntimeState | undefined, phase: ClaudeSetupPhase, importOffer?: ClaudeImportOffer, install?: ClaudeInstallProgress): readonly ClaudeSetupStep[] {
	const steps = claudeRequiredSetupSteps(runtime, phase, install);
	if (!importOffer?.editors.length) {
		return steps;
	}
	return [...steps, {
		id: 'import',
		state: importOffer.done ? 'done' : 'todo',
		title: importOffer.done
			? localize('claudeSetupImported', "Settings imported")
			: localize('claudeSetupImport', "Import from {0} (optional)", claudeImportOfferEditors(importOffer)),
		detail: importOffer.done ? undefined : localize('claudeSetupImportDetail', "Bring over your settings, keybindings, snippets and extensions. You see a preview before anything changes."),
	}];
}

function claudeRequiredSetupSteps(runtime: ClaudeRuntimeState | undefined, phase: ClaudeSetupPhase, install: ClaudeInstallProgress | undefined): readonly ClaudeSetupStep[] {
	const signIn: ClaudeSetupStep = {
		id: 'sign-in',
		state: phase === 'ready' ? 'done' : 'todo',
		title: phase === 'ready' ? localize('claudeSetupSignedIn', "Signed in") : localize('claudeSetupSignIn', "Sign in"),
		detail: phase === 'ready' ? undefined : localize('claudeSetupSignInDetail', "Uses the official Claude sign-in. It opens in a terminal and your browser; come back here when done."),
		note: phase === 'signed-out' ? runtime?.error : undefined,
	};
	if (install && runtime && !runtime.installed) {
		return [claudeInstallStep(install), signIn];
	}
	if (!runtime || !runtime.installed) {
		return [{
			id: 'runtime',
			state: runtime ? 'error' : 'todo',
			title: localize('claudeSetupNotFound', "Claude Code not found"),
			detail: localize('claudeSetupNotFoundDetail', "Install it, or point Klawly to an existing install. Installed it already? Choose its location, or restart Klawly."),
			note: runtime?.error,
		}, signIn];
	}
	return [{
		id: 'runtime',
		state: 'done',
		title: runtime.version ? localize('claudeSetupFound', "Claude Code {0} found", runtime.version) : localize('claudeSetupFoundNoVersion', "Claude Code found"),
		detail: runtime.binaryPath,
	}, signIn];
}

/** The runtime step while Klawly watches the installer (issue 783). */
function claudeInstallStep(install: ClaudeInstallProgress): ClaudeSetupStep {
	if (install.state === 'failed') {
		return {
			id: 'runtime',
			state: 'error',
			title: localize('claudeInstallFailedTitle', "Claude Code was not installed"),
			detail: install.exitCode !== undefined
				? localize('claudeInstallFailedCode', "The installer stopped with exit code {0}. Its output stays in the Install Claude Code terminal. Check your internet connection, then retry.", install.exitCode)
				: localize('claudeInstallFailed', "The installer stopped. Its output stays in the Install Claude Code terminal. Check your internet connection, then retry."),
		};
	}
	if (install.state === 'stalled') {
		return {
			id: 'runtime',
			state: 'error',
			title: localize('claudeInstallStalledTitle', "The install is not making progress"),
			detail: localize('claudeInstallStalled', "Nothing has changed for {0} minutes. A slow or dropped connection is the usual cause. The installer keeps running; retry to start it again.", CLAUDE_INSTALL_STALL_MS / 60000),
			live: true,
		};
	}
	return {
		id: 'runtime',
		state: 'busy',
		title: localize('claudeInstallRunningTitle', "Installing Claude Code"),
		detail: localize('claudeInstallRunning', "The installer downloads a few hundred MB and shows no progress of its own, so this can take several minutes on a slow connection. Klawly picks up Claude Code as soon as it is installed."),
		live: true,
	};
}

/** Status bar states (spec 47). */
export type ClaudeStatusKind = 'ready' | 'working' | 'needs-approval' | 'sign-in' | 'limit-reached' | 'runtime-missing';

/** What the agent sessions are doing, reduced to what the status bar needs. */
export interface ClaudeAgentActivity {
	readonly running: boolean;
	/** A permission, or an MCP form or sign-in, waits for the user. */
	readonly pendingPermission: boolean;
	/** Failure kind of the current session's last turn, when it failed. */
	readonly lastFailureKind?: AgentFailureKind;
}

/**
 * Running and pending approval cover every open session, including requests
 * from subagents and MCP forms or sign-ins. The failure comes from the current session's last turn only.
 */
export function claudeAgentActivity(sessions: readonly AgentViewState[], current: AgentViewState | undefined): ClaudeAgentActivity {
	let running = false;
	let pendingPermission = false;
	for (const state of sessions) {
		for (const turn of state.turns) {
			if (turn.status === 'running') {
				running = true;
			}
			if (permissionsForTimeline(turn, state.subagents, undefined).some(entry => entry.state === 'pending') || hasPendingElicitation(turn)) {
				pendingPermission = true;
			}
		}
	}
	const last = current?.turns.at(-1);
	return { running, pendingPermission, lastFailureKind: last?.status === 'failed' ? last.failure?.kind : undefined };
}

/**
 * One state for the status bar item. Undefined until the runtime has answered
 * a probe and nothing is running, so the item never claims a state it does not know.
 */
export function claudeStatusKind(runtime: ClaudeRuntimeState | undefined, activity: ClaudeAgentActivity): ClaudeStatusKind | undefined {
	if (runtime && !runtime.installed) {
		return 'runtime-missing';
	}
	if (runtime && !runtime.authenticated) {
		return 'sign-in';
	}
	if (activity.pendingPermission) {
		return 'needs-approval';
	}
	if (activity.running) {
		return 'working';
	}
	if (!runtime) {
		return undefined;
	}
	if (activity.lastFailureKind === 'usage-limit') {
		return 'limit-reached';
	}
	if (activity.lastFailureKind === 'auth') {
		return 'sign-in';
	}
	return 'ready';
}

/**
 * True when a failed turn's banner offers Open Claude Status. Those are the
 * failures the status menu can explain or act on: sign-in, install, version,
 * usage limit and connection. A tool or workspace failure is not about Claude itself.
 */
export function claudeFailureOffersStatus(kind: AgentFailureKind | undefined): boolean {
	switch (kind) {
		case 'auth':
		case 'runtime-missing':
		case 'runtime-version':
		case 'usage-limit':
		case 'network':
			return true;
		default:
			return false;
	}
}

export interface ClaudeStatusPresentation {
	/** Codicon id, with `~spin` for an animated one. */
	readonly icon: string;
	readonly label: string;
	readonly ariaLabel: string;
	readonly tooltip: string;
	/** Matches the status bar entry kinds. The label and icon carry the meaning too. */
	readonly kind: 'standard' | 'warning' | 'error';
}

export function claudeStatusPresentation(kind: ClaudeStatusKind): ClaudeStatusPresentation {
	const make = (icon: string, label: string, tooltip: string, entryKind: ClaudeStatusPresentation['kind']): ClaudeStatusPresentation => ({
		icon,
		label,
		tooltip,
		kind: entryKind,
		ariaLabel: localize('claudeStatusAria', "{0}. {1} Opens the Claude status menu.", label, tooltip),
	});
	switch (kind) {
		case 'ready':
			return make('sparkle', localize('claudeStatusReady', "Claude: Ready"), localize('claudeStatusReadyTip', "Claude Code is installed and signed in."), 'standard');
		case 'working':
			return make('loading~spin', localize('claudeStatusWorking', "Claude: Working"), localize('claudeStatusWorkingTip', "An agent turn is running."), 'standard');
		case 'needs-approval':
			return make('shield', localize('claudeStatusApproval', "Claude: Needs approval"), localize('claudeStatusApprovalTip', "The agent is waiting for your approval or input in the Agent pane."), 'warning');
		case 'sign-in':
			return make('sign-in', localize('claudeStatusSignIn', "Claude: Sign in"), localize('claudeStatusSignInTip', "Claude Code is not signed in."), 'warning');
		case 'limit-reached':
			return make('error', localize('claudeStatusLimit', "Claude: Limit reached"), localize('claudeStatusLimitTip', "Claude reported that its usage limit was reached."), 'error');
		case 'runtime-missing':
			return make('circle-slash', localize('claudeStatusMissing', "Claude: Runtime missing"), localize('claudeStatusMissingTip', "Claude Code was not found."), 'error');
	}
}

export type ClaudeStatusMenuAction = 'open-agent' | 'settings' | 'redetect' | 'sign-in' | 'install' | 'logs' | 'switch-account' | 'log-out';

export interface ClaudeStatusMenu {
	/** Facts the runtime reported, such as the plan windows Claude Code gave. Never a quota or a value the runtime did not give. */
	readonly info: readonly { readonly label: string; readonly detail?: string }[];
	readonly actions: readonly { readonly id: ClaudeStatusMenuAction; readonly label: string; readonly icon: string }[];
}

/** Rows for the status menu. `modelLabel` is the current session's model, when one was picked. */
export function claudeStatusMenu(runtime: ClaudeRuntimeState | undefined, kind: ClaudeStatusKind | undefined, modelLabel: string | undefined, usage: readonly ClaudeUsageRowPart[] = []): ClaudeStatusMenu {
	const info: { label: string; detail?: string }[] = [];
	if (!runtime) {
		info.push({ label: localize('claudeMenuChecking', "Claude Code: checking...") });
	} else if (runtime.installed) {
		info.push({
			label: runtime.version ? localize('claudeMenuVersion', "Claude Code {0}", runtime.version) : localize('claudeMenuInstalled', "Claude Code installed"),
			detail: runtime.binaryPath,
		});
		info.push({ label: runtime.authenticated ? authLabel(runtime.authMode) : localize('claudeMenuSignedOut', "Not signed in") });
	} else {
		info.push({ label: localize('claudeMenuNotFound', "Claude Code not found"), detail: runtime.error });
	}
	info.push({ label: modelLabel ? localize('claudeMenuModel', "Model: {0}", modelLabel) : localize('claudeMenuModelDefault', "Model: Claude Code default") });
	if (usage.length > 0 && runtime?.authenticated) {
		const reset = usage.find(part => part.resetsAt !== undefined);
		const resetsAt = reset?.resetsAt;
		info.push({
			label: localize('claudeMenuPlanUsage', "Plan usage: {0}", usage.map(part => localize('claudeMenuPlanUsagePart', "{0} {1}%", part.name, part.percent)).join(', ')),
			detail: reset && resetsAt !== undefined ? localize('claudeMenuPlanUsageReset', "{0} resets {1}", reset.name, fromNow(resetsAt, true)) : undefined,
		});
	}
	if (kind === 'limit-reached') {
		info.push({ label: localize('claudeMenuLimit', "Usage: Claude reported that the usage limit was reached") });
	}

	const actions: { id: ClaudeStatusMenuAction; label: string; icon: string }[] = [
		{ id: 'open-agent', label: localize('claudeMenuOpenAgent', "Open Agent"), icon: 'sparkle' },
		{ id: 'settings', label: localize('claudeMenuSettings', "Claude Settings"), icon: 'settings-gear' },
		{ id: 'redetect', label: localize('claudeMenuRedetect', "Re-detect Runtime"), icon: 'refresh' },
	];
	if (runtime && !runtime.installed) {
		actions.push({ id: 'install', label: localize('claudeMenuInstall', "Install Claude Code"), icon: 'cloud-download' });
	} else if (runtime && !runtime.authenticated) {
		actions.push({ id: 'sign-in', label: localize('claudeMenuSignIn', "Sign In"), icon: 'sign-in' });
	} else if (claudeAccountActions(runtime)?.enabled) {
		// Issue 536. An API key, cloud or managed sign-in gets neither: Claude Code's log out does not reach it.
		actions.push({ id: 'switch-account', label: localize('claudeMenuSwitch', "Switch Account..."), icon: 'arrow-swap' });
		actions.push({ id: 'log-out', label: localize('claudeMenuLogOut', "Log Out"), icon: 'sign-out' });
	}
	actions.push({ id: 'logs', label: localize('claudeMenuLogs', "Open Logs"), icon: 'output' });
	return { info, actions };
}

function authLabel(mode: ClaudeRuntimeState['authMode']): string {
	switch (mode) {
		case 'claude-account': return localize('claudeMenuAuthAccount', "Signed in with a Claude account");
		case 'api-key': return localize('claudeMenuAuthKey', "Signed in with an API key");
		case 'enterprise': return localize('claudeMenuAuthEnterprise', "Signed in through an enterprise provider");
		case 'bedrock': return localize('claudeMenuAuthBedrock', "Signed in through Amazon Bedrock");
		case 'vertex': return localize('claudeMenuAuthVertex', "Signed in through Google Vertex AI");
		default: return localize('claudeMenuAuthSignedIn', "Signed in");
	}
}
