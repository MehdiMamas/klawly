/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse } from '../../../base/common/json.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { CLAUDE_MANAGED_SETTINGS_FILE, CLAUDE_MANAGED_SETTINGS_FOLDER, claudeManagedDirectory } from './claudeManagedFiles.js';

/**
 * The Claude Code setting an administrator uses to turn off its bypass permissions
 * mode, which the Allow Everything level runs in (issue 694). Next to the SDK
 * adapter, this is the only file allowed to name that mode
 * (`claudeNoPermissionBypass.test.ts`).
 */
const CLAUDE_UNASKED_POLICY_KEY = 'disableBypassPermissionsMode';

/** True when one Claude Code settings object turns the mode off: `permissions.disableBypassPermissionsMode` is `"disable"`. */
export function claudeUnaskedDisabledBy(settings: unknown): boolean {
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
		return false;
	}
	const permissions = (settings as { permissions?: unknown }).permissions;
	if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
		return false;
	}
	return (permissions as Record<string, unknown>)[CLAUDE_UNASKED_POLICY_KEY] === 'disable';
}

/**
 * True when the organization's managed settings files turn the mode off: the
 * managed settings file or any fragment beside it. Claude Code enforces them
 * itself; Klawly reads them so the menu can say why Allow Everything asks.
 * A file that is missing or cannot be read turns nothing off.
 */
export async function claudeUnaskedDisabledByManagedFiles(files: Pick<IFileService, 'readFile' | 'resolve'>, os: OperatingSystem): Promise<boolean> {
	const managed = URI.file(claudeManagedDirectory(os));
	const candidates = [joinPath(managed, CLAUDE_MANAGED_SETTINGS_FILE)];
	try {
		const folder = await files.resolve(joinPath(managed, CLAUDE_MANAGED_SETTINGS_FOLDER));
		for (const child of folder.children ?? []) {
			if (!child.isDirectory && child.name.toLowerCase().endsWith('.json')) {
				candidates.push(child.resource);
			}
		}
	} catch {
		// No fragments folder.
	}
	const found = await Promise.all(candidates.map(async resource => {
		try {
			return claudeUnaskedDisabledBy(parse((await files.readFile(resource)).value.toString()));
		} catch {
			return false;
		}
	}));
	return found.some(disabled => disabled);
}
