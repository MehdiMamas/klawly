/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, disposableWindowInterval, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ClaudeRuntimeState } from '../../../../platform/claude/common/claude.js';
import { ClaudeImportOffer, claudeImportOfferEditors, ClaudeInstallProgress, claudeInstallStatusLine, ClaudeSetupPhase, ClaudeSetupStep, claudeSetupSteps } from '../common/claudeRuntimeStatus.js';

/** What the setup card buttons do. The view pane forwards these to `IClaudeSetupService`. */
export interface ClaudeSetupCardActions {
	install(): void;
	/** The install Klawly watches now. Read every second for the live status line (issue 783). */
	installProgress(): ClaudeInstallProgress | undefined;
	retryInstall(): void;
	showInstaller(): void;
	cancelInstall(): void;
	redetect(): void;
	chooseLocation(): void;
	signIn(): void;
	cancelSignIn(): void;
	continueWithoutAI(): void;
	/** Opens the optional import from VS Code or Cursor. */
	importSettings(): void;
	/** The optional Sign In with GitHub step (issue 446). Left out once a GitHub account is the profile. */
	signInWithGitHub?(): void;
}

/**
 * Builds the setup card that replaces the composer while Claude is missing or
 * signed out (spec 6, 72; specimen 11). Shows probed state only. Returns the
 * control that should take focus first.
 */
export function renderClaudeSetupCard(parent: HTMLElement, phase: ClaudeSetupPhase, runtime: ClaudeRuntimeState | undefined, actions: ClaudeSetupCardActions, store: DisposableStore, markUri?: string, importOffer?: ClaudeImportOffer, install?: ClaudeInstallProgress): HTMLButtonElement | undefined {
	const root = append(parent, $('.claude-empty.claude-setup-view'));
	const headingId = `claude-setup-${generateUuid()}`;
	root.setAttribute('role', 'region');
	root.setAttribute('aria-labelledby', headingId);

	if (phase === 'waiting-sign-in') {
		const spinner = append(root, $(ThemeIcon.asCSSSelector(Codicon.loading) + '.codicon-modifier-spin.claude-setup-spinner'));
		spinner.setAttribute('aria-hidden', 'true');
		const heading = append(root, $('h2'));
		heading.id = headingId;
		heading.textContent = localize('claudeSetupWaitingTitle', "Finish signing in to Claude");
		const note = append(root, $('p'));
		note.setAttribute('role', 'status');
		note.textContent = localize('claudeSetupWaitingNote', "Complete the sign-in in the terminal and your browser. Klawly checks again when the sign-in ends or when you come back to this window.");
		const row = append(root, $('.claude-setup-actions.is-centered'));
		const check = button(row, '', localize('claudeSetupCheckAgain', "Check Again"), store, actions.redetect);
		button(row, '.is-ghost', localize('claudeSetupCancel', "Cancel"), store, actions.cancelSignIn);
		return check;
	}

	if (markUri) {
		const mark = append(root, $<HTMLImageElement>('img.mark'));
		mark.src = markUri;
		mark.alt = '';
	}
	const heading = append(root, $('h2'));
	heading.id = headingId;
	heading.textContent = phase === 'missing'
		? localize('claudeSetupMissingTitle', "Set up Claude to use the agent")
		: localize('claudeSetupSignInTitle', "Sign in to Claude");
	append(root, $('p.claude-setup-lede')).textContent = phase === 'missing'
		? localize('claudeSetupMissingLede', "The agent runs on Claude Code, installed on this computer.")
		: localize('claudeSetupSignInLede', "Your Claude account powers the agent and sets its usage limits.");

	const card = append(root, $('.claude-setup'));
	const list = append(card, $('ol.claude-steps'));
	list.setAttribute('aria-label', localize('claudeSetupSteps', "Setup steps"));
	for (const step of claudeSetupSteps(runtime, phase, importOffer, phase === 'missing' ? install : undefined)) {
		const live = renderStep(list, step);
		if (live) {
			// Elapsed time and download size, rewritten in place: a re-render each second would move focus.
			const update = () => {
				const progress = actions.installProgress();
				live.textContent = progress ? claudeInstallStatusLine(progress, Date.now()) : '';
			};
			update();
			store.add(disposableWindowInterval(getWindow(parent), update, 1000));
		}
	}

	const row = append(card, $('.claude-setup-actions.is-stacked'));
	let first: HTMLButtonElement;
	if (phase === 'missing' && install) {
		// Issue 783: while the installer runs, its terminal and a way out; once it stalls or fails, Retry leads.
		if (install.state === 'running') {
			first = button(row, '.is-primary', localize('claudeSetupShowInstaller', "Show Installer"), store, actions.showInstaller, Codicon.terminal);
		} else {
			first = button(row, '.is-primary', localize('claudeSetupRetryInstall', "Retry Install"), store, actions.retryInstall, Codicon.refresh);
			button(row, '', localize('claudeSetupShowInstaller', "Show Installer"), store, actions.showInstaller);
		}
		if (install.state === 'failed') {
			button(row, '', localize('claudeSetupDetectAgain', "Detect Again"), store, actions.redetect);
		} else {
			button(row, '', localize('claudeSetupCancelInstall', "Cancel Install"), store, actions.cancelInstall);
		}
	} else if (phase === 'missing') {
		first = button(row, '.is-primary', localize('claudeSetupInstall', "Install Claude Code"), store, actions.install, Codicon.cloudDownload);
		button(row, '', localize('claudeSetupDetectAgain', "Detect Again"), store, actions.redetect);
	} else {
		first = button(row, '.is-primary', localize('claudeSetupSignInButton', "Sign in to Claude"), store, actions.signIn, Codicon.signIn);
		button(row, '', localize('claudeSetupDetectAgain', "Detect Again"), store, actions.redetect);
	}
	if (phase === 'missing' && install?.state !== 'running') {
		const choose = append(card, $<HTMLButtonElement>('button.claude-file-link.claude-setup-link'));
		choose.type = 'button';
		choose.textContent = localize('claudeSetupChoose', "Choose Claude Code Location...");
		store.add(addDisposableListener(choose, EventType.CLICK, () => actions.chooseLocation()));
	}
	if (importOffer?.editors.length && !importOffer.done) {
		const importLink = append(card, $<HTMLButtonElement>('button.claude-file-link.claude-setup-link'));
		importLink.type = 'button';
		importLink.textContent = localize('claudeSetupImportLink', "Import settings from {0}...", claudeImportOfferEditors(importOffer));
		store.add(addDisposableListener(importLink, EventType.CLICK, () => actions.importSettings()));
	}
	if (actions.signInWithGitHub) {
		// Issue 446: optional, like the import. Skipping it is doing nothing; everything works signed out.
		const signInWithGitHub = actions.signInWithGitHub;
		const githubLink = append(card, $<HTMLButtonElement>('button.claude-file-link.claude-setup-link.claude-setup-github'));
		githubLink.type = 'button';
		githubLink.textContent = localize('claudeSetupGitHubLink', "Sign in with GitHub (optional)");
		store.add(addDisposableListener(githubLink, EventType.CLICK, () => signInWithGitHub()));
	}
	if (phase !== 'missing' || install?.state !== 'running') {
		button(root, '.is-ghost.is-small.claude-setup-skip', localize('claudeSetupWithoutAI', "Continue without AI"), store, actions.continueWithoutAI);
	}
	return first;
}

/** Renders one step. Returns the element for the live install line when the step has one. */
function renderStep(list: HTMLElement, step: ClaudeSetupStep): HTMLElement | undefined {
	const item = append(list, $(`li.claude-step.is-${step.state}`));
	item.setAttribute('data-step', step.id);
	const icon = step.state === 'done' ? Codicon.passFilled : step.state === 'error' ? Codicon.error : step.state === 'busy' ? Codicon.loading : Codicon.circleLargeOutline;
	append(item, $(ThemeIcon.asCSSSelector(icon) + (step.state === 'busy' ? '.codicon-modifier-spin' : ''))).setAttribute('aria-hidden', 'true');
	const body = append(item, $('div'));
	// State in words too, so it is never carried by the icon color alone.
	append(body, $('span.claude-sr-only')).textContent = step.state === 'done'
		? localize('claudeStepDone', "Done: ")
		: step.state === 'error'
			? localize('claudeStepProblem', "Problem: ")
			: step.state === 'busy'
				? localize('claudeStepBusy', "In progress: ")
				: localize('claudeStepTodo', "To do: ");
	append(body, $('span.t')).textContent = step.title;
	if (step.detail) {
		append(body, $('.d')).textContent = step.detail;
	}
	const live = step.live ? append(body, $('.d.claude-install-live')) : undefined;
	if (step.note) {
		append(body, $('.d.n')).textContent = step.note;
	}
	return live;
}

function button(parent: HTMLElement, classes: string, label: string, store: DisposableStore, run: () => void, icon?: ThemeIcon): HTMLButtonElement {
	const element = append(parent, $<HTMLButtonElement>('button.claude-btn' + classes));
	element.type = 'button';
	if (icon) {
		append(element, $(ThemeIcon.asCSSSelector(icon))).setAttribute('aria-hidden', 'true');
	}
	append(element, $('span')).textContent = label;
	store.add(addDisposableListener(element, EventType.CLICK, event => {
		event.preventDefault();
		run();
	}));
	return element;
}
