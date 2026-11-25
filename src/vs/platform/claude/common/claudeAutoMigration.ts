/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What the user had set before Auto became one switch (issue 1221). Each field is the raw user value, undefined when never set. */
export interface ClaudeOldAutoSettings {
	/** `claude.models.auto`: off, cost, balance or intelligence. */
	readonly modelsAuto: unknown;
	/** `claude.agent.defaultPermissionMode`: the Auto permission level is `auto`. */
	readonly permissionMode: unknown;
	/** `claude.review.autoKeep`: off, thisChat or always. */
	readonly autoKeep: unknown;
	/** `claude.models.default`: a model the user picked by hand. */
	readonly defaultModel: unknown;
}

/**
 * The value `claude.auto.enabled` should take once, from the old Auto settings.
 * Any old Auto setting on turns Auto on; otherwise a model picked by hand stays
 * manual (off). Undefined means keep the default and write nothing.
 */
export function migrateClaudeAutoEnabled(old: ClaudeOldAutoSettings): boolean | undefined {
	const modelsAuto = old.modelsAuto === 'cost' || old.modelsAuto === 'balance' || old.modelsAuto === 'intelligence';
	const permissionAuto = old.permissionMode === 'auto';
	const autoKeep = old.autoKeep === 'thisChat' || old.autoKeep === 'always';
	if (modelsAuto || permissionAuto || autoKeep) {
		return true;
	}
	if (typeof old.defaultModel === 'string' && old.defaultModel.trim() !== '') {
		return false;
	}
	return undefined;
}
