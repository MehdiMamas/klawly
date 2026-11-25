/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IClaudeRuntimeService } from '../../../../platform/claude/common/claude.js';
import { CLAUDE_HOOK_SCOPES, CLAUDE_SETTINGS_FILES, ClaudeHookScope, parseClaudeSettings } from '../../../../platform/claude/common/claudeHooks.js';
import { CLAUDE_USER_LAYER_FILES, CLAUDE_USER_LAYER_FOLDER, claudeUserLayerLabel } from '../../../../platform/claude/common/claudeUserLayer.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { CLAUDE_POLICY_SETTINGS, CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, CLAUDE_SANDBOX_ENABLED_SETTING, claudeManagedSettings, ClaudeSandboxStatus, ClaudeSecuritySettings, readClaudeSecuritySettings } from '../../../../platform/claude/common/claudeSecuritySettings.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { markdownJsonBlock, markdownTable, registerPolicyDiagnosticsSection } from '../../../browser/actions/policyDiagnosticsMarkdown.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { claudeHookScopeLabel, claudeSandboxStatusBadge, claudeSandboxStatusText } from '../common/claudeSettingsPages.js';

/*
 * The Claude section of Developer: Policy Diagnostics (issue 432): the sandbox
 * Klawly asks Claude Code for, the permission rules in each Claude Code
 * settings file, and the managed settings Klawly received and passes on.
 */

/** One Claude Code settings file, as read for the report. */
export interface ClaudePolicySettingsFile {
	readonly scope: ClaudeHookScope;
	readonly label: string;
	/** Undefined when the file is not there. */
	readonly text: string | undefined;
}

/** What the Claude section reports on. */
export interface ClaudePolicyDiagnosticsInput {
	readonly security: ClaudeSecuritySettings;
	/** The policy value of each Claude setting a policy sets. */
	readonly policies: readonly { readonly key: string; readonly value: unknown }[];
	readonly sandboxStatus: ClaudeSandboxStatus | undefined;
	readonly files: readonly ClaudePolicySettingsFile[];
}

const CLAUDE_POLICY_DIAGNOSTICS_COMMAND = '_claude.policyDiagnostics';

function yesNo(value: boolean): string {
	return value ? localize('claudePolicyYes', "Yes") : localize('claudePolicyNo', "No");
}

function stringList(value: unknown): string {
	return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
}

function valueAt(settings: Record<string, unknown> | undefined, ...path: string[]): unknown {
	let value: unknown = settings;
	for (const key of path) {
		value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
	}
	return value;
}

/** The Claude section of the policy diagnostics report, in Markdown. */
export function claudePolicyDiagnostics(input: ClaudePolicyDiagnosticsInput): string {
	const { sandbox, managed } = input.security;
	let content = `## ${localize('claudePolicyTitle', "Claude")}\n\n`;

	content += `### ${localize('claudePolicySandbox', "Effective Sandbox")}\n\n`;
	const source = (managedValue: boolean | undefined) => managedValue !== undefined ? localize('claudePolicySourcePolicy', "Policy") : localize('claudePolicySourceSettings', "Settings");
	content += markdownTable([localize('claudePolicySetting', "Setting"), localize('claudePolicyValue', "Value"), localize('claudePolicySource', "Source")], [
		[CLAUDE_SANDBOX_ENABLED_SETTING, yesNo(sandbox.enabled), source(managed.sandboxEnabled)],
		[CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, yesNo(sandbox.autoAllowBash), source(undefined)],
		[CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, yesNo(sandbox.allowUnsandboxedCommands), source(managed.allowUnsandboxedCommands)],
		[CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, yesNo(sandbox.allowLocalBinding), source(undefined)],
		[localize('claudePolicyOnThisMachine', "On this machine"), claudeSandboxStatusBadge(input.sandboxStatus)?.label ?? localize('claudePolicyUnknown', "Unknown"), claudeSandboxStatusText(input.sandboxStatus)],
	]);
	content += (sandbox.enabled
		? localize('claudePolicySandboxOn', "Klawly asks Claude Code to sandbox Bash and to fail a turn when the sandbox cannot start.")
		: localize('claudePolicySandboxOff', "Klawly leaves the sandbox to Claude Code's own settings, listed below.")) + '\n\n';

	content += `### ${localize('claudePolicyRules', "Permission Rules by Source")}\n\n`;
	content += markdownTable([
		localize('claudePolicyRuleSource', "Source"),
		localize('claudePolicyRuleFile', "File"),
		localize('claudePolicyAllow', "Allow"),
		localize('claudePolicyAsk', "Ask"),
		localize('claudePolicyDeny', "Deny"),
		localize('claudePolicyAllowedDomains', "Sandbox Allowed Domains"),
		localize('claudePolicyDeniedDomains', "Sandbox Denied Domains"),
	], input.files.map(file => {
		const settings = file.text === undefined ? undefined : parseClaudeSettings(file.text);
		const state = file.text === undefined ? localize('claudePolicyNoFile', "(no file)") : settings ? '' : localize('claudePolicyBadFile', "(not valid JSON)");
		return [
			claudeHookScopeLabel(file.scope),
			state ? `${file.label} ${state}` : file.label,
			stringList(valueAt(settings, 'permissions', 'allow')),
			stringList(valueAt(settings, 'permissions', 'ask')),
			stringList(valueAt(settings, 'permissions', 'deny')),
			stringList(valueAt(settings, 'sandbox', 'network', 'allowedDomains')),
			stringList(valueAt(settings, 'sandbox', 'network', 'deniedDomains')),
		];
	}));
	content += localize('claudePolicyRulesScope', "Klawly reads the user, project and local settings files. Claude Code also applies its own managed-settings.json, its command line flags and the policy tier below; deny rules win over allow rules from any source.") + '\n\n';

	content += `### ${localize('claudePolicyManaged', "Managed Settings")}\n\n`;
	if (input.policies.length === 0) {
		content += localize('claudePolicyNoneReceived', "No policy sets a Claude setting.") + '\n\n';
	} else {
		content += markdownTable([localize('claudePolicyReceived', "Received Policy"), localize('claudePolicyValue', "Value")],
			input.policies.map(policy => [policy.key, typeof policy.value === 'string' ? policy.value : JSON.stringify(policy.value) ?? '']));
	}
	const applied = claudeManagedSettings(managed);
	content += localize('claudePolicyApplied', "Passed to Claude Code as its policy tier (managedSettings):") + '\n\n';
	content += applied ? markdownJsonBlock(applied) : localize('claudePolicyNoneApplied', "Nothing.") + '\n\n';
	content += localize('claudePolicyAppliedNote', "Claude Code keeps only the restrictive keys of this tier, and drops all of it when an IT-managed Claude Code tier exists on this machine unless that tier allows it.") + '\n\n';
	return content;
}

CommandsRegistry.registerCommand(CLAUDE_POLICY_DIAGNOSTICS_COMMAND, async accessor => {
	const configuration = accessor.get(IConfigurationService);
	const runtime = accessor.get(IClaudeRuntimeService);
	const fileService = accessor.get(IFileService);
	const workspace = accessor.get(IWorkspaceContextService);
	const paths = accessor.get(IPathService);
	const product = accessor.get(IProductService);
	const policyValue = (key: string) => configuration.inspect(key).policyValue;
	const folder = workspace.getWorkspace().folders[0];
	const [home, sandboxStatus] = await Promise.all([
		paths.userHome().catch(() => undefined),
		runtime.getSandboxStatus?.().catch(() => undefined),
	]);
	const files = await Promise.all(CLAUDE_HOOK_SCOPES.map(async (scope): Promise<ClaudePolicySettingsFile | undefined> => {
		const base = scope === 'user' ? home : folder?.uri;
		if (!base) {
			return undefined;
		}
		// Your settings for every project are Klawly's user layer, `~/.klawly/claude/settings.json` (issue 455).
		const path = scope === 'user' ? [product.dataFolderName, CLAUDE_USER_LAYER_FOLDER, CLAUDE_USER_LAYER_FILES.settings] : CLAUDE_SETTINGS_FILES[scope];
		const label = scope === 'user' ? claudeUserLayerLabel(product.dataFolderName, CLAUDE_USER_LAYER_FILES.settings) : path.join('/');
		try {
			return { scope, label, text: (await fileService.readFile(joinPath(base, ...path))).value.toString() };
		} catch {
			return { scope, label, text: undefined };
		}
	}));
	return claudePolicyDiagnostics({
		security: readClaudeSecuritySettings(key => configuration.getValue(key), policyValue),
		policies: CLAUDE_POLICY_SETTINGS.map(key => ({ key, value: policyValue(key) })).filter(policy => policy.value !== undefined),
		sandboxStatus,
		files: files.filter((file): file is ClaudePolicySettingsFile => !!file),
	});
});
registerPolicyDiagnosticsSection(CLAUDE_POLICY_DIAGNOSTICS_COMMAND);
