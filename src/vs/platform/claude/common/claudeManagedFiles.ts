/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem } from '../../../base/common/platform.js';

/** Claude Code's managed settings file, which an organization's administrator deploys. */
export const CLAUDE_MANAGED_SETTINGS_FILE = 'managed-settings.json';

/** The folder of managed settings fragments Claude Code merges after {@link CLAUDE_MANAGED_SETTINGS_FILE}, in name order. */
export const CLAUDE_MANAGED_SETTINGS_FOLDER = 'managed-settings.d';

/** The managed memory file Claude Code loads before every other CLAUDE.md. */
export const CLAUDE_MANAGED_MEMORY_FILE = 'CLAUDE.md';

/**
 * The system folder Claude Code reads its managed settings and managed
 * CLAUDE.md from. Only an administrator can write there.
 */
export function claudeManagedDirectory(os: OperatingSystem): string {
	switch (os) {
		case OperatingSystem.Windows: return 'C:\\Program Files\\ClaudeCode';
		case OperatingSystem.Macintosh: return '/Library/Application Support/ClaudeCode';
		default: return '/etc/claude-code';
	}
}
