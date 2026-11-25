/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PolicyCategory } from '../../../base/common/policy.js';
import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { CLAUDE_MANAGED_SETTINGS_SETTING, CLAUDE_OTEL_ENDPOINT_SETTING, CLAUDE_OTEL_HEADERS_SETTING, CLAUDE_OTEL_PROTOCOL_SETTING, CLAUDE_OTEL_PROTOCOLS, CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, CLAUDE_SANDBOX_ENABLED_SETTING } from './claudeSecuritySettings.js';

/*
 * The sandbox, telemetry export and policy settings (issue 432). Registered here,
 * not in the workbench contribution, so the shared process that starts Claude
 * Code knows the policies and applies them to these settings too.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'claude',
	order: 100,
	title: localize('claudeSecurityConfigurationTitle', "AI / Claude"),
	type: 'object',
	properties: {
		[CLAUDE_SANDBOX_ENABLED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeSandboxEnabled', "Run the commands Claude starts in Claude Code's sandbox, which limits what they can read, write and reach on the network. Network and file rules are Claude Code permission rules. If the sandbox cannot start on this machine (on Linux it needs bubblewrap and socat), the turn fails instead of running commands unsandboxed."),
			policy: {
				name: 'ClaudeSandboxEnabled',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.141',
				localization: {
					description: {
						key: 'claudeSandboxEnabled.policy',
						value: localize('claudeSandboxEnabled.policy', "Run the commands Claude starts in Klawly in Claude Code's sandbox."),
					}
				},
			},
		},
		[CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeSandboxAutoAllowBash', "While the sandbox is on, run sandboxed commands without asking. Commands that need to leave the sandbox still ask."),
		},
		[CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: true,
			description: localize('claudeSandboxAllowUnsandboxed', "While the sandbox is on, let Claude ask to run a command outside it. Off makes every command run sandboxed."),
			policy: {
				name: 'ClaudeSandboxAllowUnsandboxedCommands',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.141',
				localization: {
					description: {
						key: 'claudeSandboxAllowUnsandboxed.policy',
						value: localize('claudeSandboxAllowUnsandboxed.policy', "Let Claude in Klawly ask to run a command outside the sandbox. Set to false to make every command run sandboxed."),
					}
				},
			},
		},
		[CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING]: {
			type: 'boolean',
			scope: ConfigurationScope.APPLICATION,
			default: false,
			description: localize('claudeSandboxAllowLocalBinding', "While the sandbox is on, let sandboxed commands listen on local ports, for example a dev server."),
		},
		[CLAUDE_OTEL_ENDPOINT_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			description: localize('claudeOtelEndpoint', "An OpenTelemetry (OTLP) collector to export Claude Code's metrics and events to, for example http://localhost:4317. Empty exports nothing. Klawly passes it to Claude Code through its telemetry environment variables. It exports even while Klawly's telemetry setting is off: that setting covers Anthropic's telemetry, not your collector."),
		},
		[CLAUDE_OTEL_PROTOCOL_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			enum: [...CLAUDE_OTEL_PROTOCOLS],
			default: 'http/protobuf',
			description: localize('claudeOtelProtocol', "The OTLP protocol the collector speaks."),
		},
		[CLAUDE_OTEL_HEADERS_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			default: '',
			ignoreSync: true,
			description: localize('claudeOtelHeaders', "Headers sent to the collector, as key=value pairs separated by commas, for example Authorization=Bearer token. They are stored in your settings file."),
		},
		[CLAUDE_MANAGED_SETTINGS_SETTING]: {
			type: 'object',
			scope: ConfigurationScope.APPLICATION,
			default: {},
			included: false,
			description: localize('claudeManagedSettings', "Claude Code settings an organization applies to every Claude session in Klawly. Only a policy sets this."),
			policy: {
				name: 'ClaudeManagedSettings',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.141',
				localization: {
					description: {
						key: 'claudeManagedSettings.policy',
						value: localize('claudeManagedSettings.policy', "Claude Code settings, as JSON, applied to every Claude session in Klawly. Claude Code keeps only restrictive keys such as permissions.deny and sandbox locks, and ignores them when Claude Code's own managed settings exist unless those allow it."),
					}
				},
			},
		},
	},
});
