/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { IClaudeSetupService } from '../../browser/claudeSetup.js';
import { ClaudeImportOffer, ClaudeInstallProgress, claudeSetupPhase, ClaudeSetupPhase } from '../../common/claudeRuntimeStatus.js';

/** Setup service double whose state a test sets. Records the actions it was asked for. */
export class TestClaudeSetupService implements IClaudeSetupService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;
	readonly calls: string[] = [];
	waiting = false;
	importOffer: ClaudeImportOffer | undefined;
	githubOffer = false;
	installProgress: ClaudeInstallProgress | undefined;

	constructor(public runtime: ClaudeRuntimeState | undefined) { }

	get phase(): ClaudeSetupPhase {
		return claudeSetupPhase(this.runtime, this.waiting);
	}

	set(runtime: ClaudeRuntimeState | undefined, waiting = false): void {
		this.runtime = runtime;
		this.waiting = waiting;
		this._onDidChange.fire();
	}

	async redetect(): Promise<ClaudeRuntimeState | undefined> { this.calls.push('redetect'); return this.runtime; }
	async install(): Promise<void> { this.calls.push('install'); }
	async retryInstall(): Promise<void> { this.calls.push('retryInstall'); }
	showInstaller(): void { this.calls.push('showInstaller'); }
	cancelInstall(): void { this.calls.push('cancelInstall'); }
	async chooseLocation(): Promise<void> { this.calls.push('chooseLocation'); }
	async signIn(): Promise<void> { this.calls.push('signIn'); }
	async addAccount(): Promise<void> { this.calls.push('addAccount'); }
	cancelSignIn(): void { this.calls.push('cancelSignIn'); }
	async continueWithoutAI(): Promise<void> { this.calls.push('continueWithoutAI'); }
	async importSettings(): Promise<void> { this.calls.push('importSettings'); }
	async signInWithGitHub(): Promise<void> { this.calls.push('signInWithGitHub'); }

	dispose(): void {
		this._onDidChange.dispose();
	}
}

/** A setup service that reports a signed-in runtime, so the pane keeps its composer. */
export function readySetupService(): IClaudeSetupService {
	return {
		_serviceBrand: undefined,
		onDidChange: Event.None,
		runtime: { installed: true, authenticated: true, version: 'test' },
		phase: 'ready',
		redetect: async () => undefined,
		install: async () => undefined,
		installProgress: undefined,
		retryInstall: async () => undefined,
		showInstaller: () => undefined,
		cancelInstall: () => undefined,
		chooseLocation: async () => undefined,
		signIn: async () => undefined,
		addAccount: async () => undefined,
		cancelSignIn: () => undefined,
		continueWithoutAI: async () => undefined,
		importOffer: undefined,
		importSettings: async () => undefined,
		githubOffer: false,
		signInWithGitHub: async () => undefined,
	};
}
