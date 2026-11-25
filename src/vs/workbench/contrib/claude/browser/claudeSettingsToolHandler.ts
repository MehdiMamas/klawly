/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_SETTINGS_FIND_LIMIT, ClaudeSettingInfo, ClaudeSettingsToolRequest, ClaudeSettingsToolResult, isClaudeBlockedSetting } from '../../../../platform/claude/common/claudeSettingsTool.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IClaudeAgentService } from '../../../services/claude/common/claudeAgentService.js';

/** The registry the settings tools read; injected so a test passes its own. */
export type ClaudeSettingsSchema = () => Readonly<Record<string, IConfigurationPropertySchema>>;

const registrySchema: ClaudeSettingsSchema = () => Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();

/**
 * Answers Klawly's settings tools (issue 525) for the chats this window owns:
 * `find` lists matching settings with their description and value; `set`
 * changes one at user or workspace scope, after the user approved the
 * permission card. A blocked setting, an unknown key or a value of the wrong
 * type is refused with the reason, so Claude can tell the user.
 */
export class ClaudeSettingsToolHandler extends Disposable {
	constructor(
		private readonly _schema: ClaudeSettingsSchema,
		@IClaudeRuntimeService private readonly _runtime: IClaudeRuntimeService,
		@IClaudeAgentService private readonly _agent: IClaudeAgentService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		const onRequest = this._runtime.onDidRequestSettings;
		if (onRequest) {
			this._register(onRequest(request => void this.handle(request)));
		}
	}

	private async handle(request: ClaudeSettingsToolRequest): Promise<void> {
		// Another window owns the session: it answers.
		if (!this._agent.getSessions().some(session => this._agent.getRuntimeSessionId(session.id) === request.sessionId)) {
			return;
		}
		let result: ClaudeSettingsToolResult;
		try {
			result = request.action === 'find' ? this.find(request.query) : await this.set(request.key, request.value, request.scope);
		} catch (error) {
			result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
		}
		await this._runtime.resolveSettingsRequest?.(request.sessionId, request.requestId, result);
	}

	private find(query: string): ClaudeSettingsToolResult {
		const words = query.toLowerCase().split(/[\s.]+/).filter(word => word.length > 0);
		const matches: { readonly key: string; readonly schema: IConfigurationPropertySchema; readonly score: number }[] = [];
		for (const [key, schema] of Object.entries(this._schema())) {
			if (schema.deprecationMessage || schema.markdownDeprecationMessage || schema.included === false) {
				continue;
			}
			const name = key.toLowerCase();
			const text = `${name} ${describe(schema).toLowerCase()}`;
			if (words.length === 0 || !words.every(word => text.includes(word))) {
				continue;
			}
			matches.push({ key, schema, score: words.filter(word => name.includes(word)).length });
		}
		matches.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
		const settings = matches.slice(0, CLAUDE_SETTINGS_FIND_LIMIT).map(({ key, schema }): ClaudeSettingInfo => ({
			key,
			description: describe(schema),
			value: this._configuration.getValue(key),
			default: schema.default,
			...(typeof schema.type === 'string' ? { type: schema.type } : {}),
			...(schema.enum ? { allowed: schema.enum } : {}),
			...(isClaudeBlockedSetting(key) ? { blocked: true as const } : {}),
		}));
		return { kind: 'found', settings };
	}

	private async set(key: string, value: unknown, scope: 'user' | 'workspace'): Promise<ClaudeSettingsToolResult> {
		const schema = this._schema()[key];
		if (!schema) {
			return { kind: 'refused', message: `There is no setting ${key}. Use klawly_settings_find for the exact key.` };
		}
		if (isClaudeBlockedSetting(key)) {
			return { kind: 'refused', message: `${key} controls permissions, trust or what leaves the machine, so Claude cannot change it. Ask the user to change it in Settings.` };
		}
		const problem = valueProblem(schema, value);
		if (problem) {
			return { kind: 'refused', message: `${key} ${problem}` };
		}
		if (scope === 'workspace') {
			if (this._workspace.getWorkbenchState() === WorkbenchState.EMPTY) {
				return { kind: 'refused', message: 'No folder is open, so there are no workspace settings. Use user scope.' };
			}
			if (schema.scope === ConfigurationScope.APPLICATION || schema.scope === ConfigurationScope.MACHINE) {
				return { kind: 'refused', message: `${key} applies to every window, so it can only be a user setting.` };
			}
		}
		const previous = this._configuration.getValue(key);
		await this._configuration.updateValue(key, value, scope === 'workspace' ? ConfigurationTarget.WORKSPACE : ConfigurationTarget.USER);
		return { kind: 'set', key, previous, value, scope };
	}
}

/** Instantiates the handler once the window is up, so it hears requests. */
export class ClaudeSettingsToolContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.claudeSettingsTool';

	constructor(
		@IClaudeRuntimeService runtime: IClaudeRuntimeService,
		@IClaudeAgentService agent: IClaudeAgentService,
		@IConfigurationService configuration: IConfigurationService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this._register(new ClaudeSettingsToolHandler(registrySchema, runtime, agent, configuration, workspace));
	}
}

function describe(schema: IConfigurationPropertySchema): string {
	return (schema.description ?? schema.markdownDescription ?? '').replace(/\s+/g, ' ').trim();
}

/** Why `value` does not fit the setting's type, or undefined when it does. */
function valueProblem(schema: IConfigurationPropertySchema, value: unknown): string | undefined {
	if (schema.enum && !schema.enum.includes(value)) {
		return `takes one of ${JSON.stringify(schema.enum)}.`;
	}
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	if (types.length === 0) {
		return undefined;
	}
	const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
	const fits = types.some(type => type === actual || (type === 'number' && actual === 'integer'));
	if (!fits) {
		return `takes a ${types.join(' or ')}, not ${JSON.stringify(value)}.`;
	}
	if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
		return `must be at least ${schema.minimum}.`;
	}
	if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) {
		return `must be at most ${schema.maximum}.`;
	}
	return undefined;
}
