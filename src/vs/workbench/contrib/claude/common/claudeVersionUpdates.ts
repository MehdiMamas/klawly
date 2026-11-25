/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { CLAUDE_PROTOCOL_VERSION } from '../../../../platform/claude/common/claudeProtocol.js';
import { formatReleaseVersion } from '../../../../platform/claude/common/claudeRelease.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { DisablementReason, State, StateType } from '../../../../platform/update/common/update.js';

/** What the Check for Updates button does when pressed; undefined means it is disabled. */
export type ClaudeUpdateAction = 'check' | 'download' | 'install' | 'restart';

/** The Check for Updates row in plain words (issue 833, DL-87): the state, the one button and whether it can be pressed. */
export interface ClaudeUpdateRow {
	readonly status: string;
	readonly button: string;
	readonly action: ClaudeUpdateAction | undefined;
	/** The state is still moving, so the row announces it politely. */
	readonly busy: boolean;
	/** A download is running: the row shows an indeterminate bar, never a made-up percentage (issue 1580, DL-87). */
	readonly progress: boolean;
}

/** Maps the update service's state to the row; it adds no update logic of its own. */
export function claudeUpdateRow(state: State): ClaudeUpdateRow {
	const check = localize('claudeUpdateCheck', "Check for Updates");
	switch (state.type) {
		case StateType.Disabled:
			return { status: claudeUpdatesDisabledReason(state.reason), button: check, action: undefined, busy: false, progress: false };
		case StateType.Uninitialized:
		case StateType.Cancelling:
			return { status: localize('claudeUpdateStarting', "Getting ready..."), button: check, action: undefined, busy: true, progress: false };
		case StateType.CheckingForUpdates:
			return { status: localize('claudeUpdateChecking', "Checking..."), button: check, action: undefined, busy: true, progress: false };
		case StateType.Idle:
			if (state.error) {
				return { status: localize('claudeUpdateFailed', "Couldn't check: {0}", state.error), button: localize('claudeUpdateTryAgain', "Try Again"), action: 'check', busy: false, progress: false };
			}
			return {
				status: state.notAvailable ? localize('claudeUpdateUpToDate', "Up to date") : localize('claudeUpdateNotChecked', "Not checked yet in this session"),
				button: check, action: 'check', busy: false, progress: false,
			};
		case StateType.AvailableForDownload:
			return { status: localize('claudeUpdateAvailable', "A new version is available"), button: localize('claudeUpdateDownload', "Update"), action: 'download', busy: false, progress: false };
		case StateType.Downloading:
		case StateType.Overwriting:
			return { status: localize('claudeUpdateDownloading', "Downloading..."), button: check, action: undefined, busy: true, progress: true };
		case StateType.Downloaded:
			return { status: localize('claudeUpdateDownloaded', "Downloaded, ready to install"), button: localize('claudeUpdateInstall', "Install Update"), action: 'install', busy: false, progress: false };
		case StateType.Updating:
			return { status: localize('claudeUpdateInstalling', "Installing..."), button: check, action: undefined, busy: true, progress: false };
		case StateType.Ready:
			return { status: localize('claudeUpdateReady', "Ready: restart to finish updating"), button: localize('claudeUpdateRestart', "Restart to Update"), action: 'restart', busy: false, progress: false };
		case StateType.Restarting:
			return { status: localize('claudeUpdateRestarting', "Restarting..."), button: check, action: undefined, busy: true, progress: false };
	}
}

/** Why this build never checks, in words a tester can act on. */
export function claudeUpdatesDisabledReason(reason: DisablementReason): string {
	switch (reason) {
		case DisablementReason.NotBuilt:
			return localize('claudeUpdatesNotBuilt', "Updates are off in a build run from source");
		case DisablementReason.ManuallyDisabled:
			return localize('claudeUpdatesManual', "Updates are turned off in Update: Mode");
		case DisablementReason.Policy:
			return localize('claudeUpdatesPolicy', "Updates are turned off by your organization");
		case DisablementReason.RunningAsAdmin:
			return localize('claudeUpdatesAdmin', "Updates are off while Klawly runs as administrator");
		case DisablementReason.MissingConfiguration:
		case DisablementReason.InvalidConfiguration:
			return localize('claudeUpdatesConfig', "Updates are off: this build has no update feed set up");
		case DisablementReason.DisabledByEnvironment:
		default:
			return localize('claudeUpdatesEnvironment', "Updates are turned off in this environment");
	}
}

/** The Version row: the version testers know, and the commit and build date in smaller text. */
export function claudeVersionRow(product: Pick<IProductService, 'version' | 'klawlyRelease' | 'commit' | 'date'>): { readonly title: string; readonly detail: string } {
	return {
		title: formatReleaseVersion(product.version, product.klawlyRelease),
		detail: localize('claudeVersionDetail', "Commit {0} · Built {1}", product.commit ? product.commit.slice(0, 8) : localize('claudeVersionUnknown', "unknown"), product.date ? product.date.slice(0, 10) : localize('claudeVersionUnknown2', "unknown")),
	};
}

/** What Copy puts on the clipboard: the About dialog's lines that need no native host, for bug reports. */
export function claudeVersionCopyText(product: Pick<IProductService, 'version' | 'klawlyRelease' | 'commit' | 'upstreamCommit' | 'date' | 'target'>): string {
	const version = formatReleaseVersion(product.version, product.klawlyRelease);
	return [
		`Version: ${product.target ? `${version} (${product.target} setup)` : version}`,
		`Commit: ${product.commit || 'Unknown'}`,
		`Upstream: ${product.upstreamCommit || 'Unknown'}`,
		`Date: ${product.date || 'Unknown'}`,
		`Claude protocol: ${CLAUDE_PROTOCOL_VERSION}`,
	].join('\n');
}
