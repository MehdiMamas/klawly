/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CLAUDE_AUTOMATIONS_ENABLED_SETTING, CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING } from '../common/claudeAutomation.js';

/**
 * The argument the login item starts Klawly with. The scheduler lives in the workbench window,
 * so a window must exist: the main process opens it minimized instead of in front.
 */
export const CLAUDE_BACKGROUND_START_ARG = '--background-start';

/** The launchd label and the file names of the login item. */
export const CLAUDE_LOGIN_ITEM_ID = 'dev.klawly.automations-login';

export interface IClaudeLoginItemElectron {
	setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
}

export interface IClaudeLoginItemFiles {
	write(path: string, content: string): void;
	remove(path: string): void;
}

export interface IClaudeLoginHelperDeps {
	readonly platform: NodeJS.Platform;
	/** The Klawly executable the login item starts. */
	readonly execPath: string;
	readonly homeDir: string;
	/** Electron's `app`, used where it can pass the argument (Windows). */
	readonly electron: IClaudeLoginItemElectron;
	readonly files: IClaudeLoginItemFiles;
}

/** Quotes one value for an XDG `Exec` line. */
function desktopExecQuote(value: string): string {
	return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The macOS LaunchAgent that starts Klawly at login. */
export function launchAgentPlist(execPath: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${CLAUDE_LOGIN_ITEM_ID}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(execPath)}</string>
		<string>${CLAUDE_BACKGROUND_START_ARG}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`;
}

/** The Linux XDG autostart entry that starts Klawly at login. */
export function autostartDesktopEntry(execPath: string): string {
	return `[Desktop Entry]
Type=Application
Name=Klawly (automations)
Comment=Runs Klawly automations in the background
Exec=${desktopExecQuote(execPath)} ${CLAUDE_BACKGROUND_START_ARG}
X-GNOME-Autostart-enabled=true
Terminal=false
`;
}

/**
 * Turns the run-at-login setting into the per-user login item of the OS. Windows uses Electron's
 * `setLoginItemSettings`, which passes arguments there. On macOS Electron cannot pass arguments to
 * a login item, so a LaunchAgent in `~/Library/LaunchAgents` is used; Linux has no Electron
 * support, so an XDG autostart file in `~/.config/autostart` is used.
 */
export class ClaudeLoginHelper {

	constructor(private readonly deps: IClaudeLoginHelperDeps) { }

	/** The login item exists only when both automations and run-at-login are on. */
	applySettings(getValue: (key: string) => unknown): void {
		this.apply(getValue(CLAUDE_AUTOMATIONS_ENABLED_SETTING) === true && getValue(CLAUDE_AUTOMATIONS_RUN_AT_LOGIN_SETTING) === true);
	}

	/** Registers the login item when `enabled`, removes it otherwise. Safe to call repeatedly. */
	apply(enabled: boolean): void {
		const { platform, execPath, homeDir, electron, files } = this.deps;
		switch (platform) {
			case 'win32':
				electron.setLoginItemSettings({ openAtLogin: enabled, path: execPath, args: enabled ? [CLAUDE_BACKGROUND_START_ARG] : [] });
				break;
			case 'darwin': {
				const path = `${homeDir}/Library/LaunchAgents/${CLAUDE_LOGIN_ITEM_ID}.plist`;
				if (enabled) {
					files.write(path, launchAgentPlist(execPath));
				} else {
					files.remove(path);
				}
				break;
			}
			case 'linux': {
				const path = `${homeDir}/.config/autostart/${CLAUDE_LOGIN_ITEM_ID}.desktop`;
				if (enabled) {
					files.write(path, autostartDesktopEntry(execPath));
				} else {
					files.remove(path);
				}
				break;
			}
		}
	}
}
