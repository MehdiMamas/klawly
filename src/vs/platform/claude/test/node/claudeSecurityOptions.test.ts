/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_MANAGED_SETTINGS_SETTING, CLAUDE_OTEL_ENDPOINT_SETTING, CLAUDE_OTEL_HEADERS_SETTING, CLAUDE_OTEL_PROTOCOL_SETTING, CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING, CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING, CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING, CLAUDE_SANDBOX_ENABLED_SETTING, readClaudeSecuritySettings } from '../../common/claudeSecuritySettings.js';
import { claudeCliSettings } from '../../node/claudeCliArgs.js';
import { claudeSandboxFailureMessage, claudeSecurityOptions } from '../../node/claudeSecurityOptions.js';

suite('claudeSecurityOptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function read(values: Record<string, unknown>, policies: Record<string, unknown> = {}) {
		return readClaudeSecuritySettings(key => values[key], key => policies[key]);
	}

	test('sets nothing while every setting is at its default', () => {
		assert.deepStrictEqual([claudeSecurityOptions(undefined), claudeSecurityOptions(read({}))], [{ env: {} }, { env: {} }]);
	});

	test('maps the sandbox settings, failing a turn whose sandbox cannot start', () => {
		const options = claudeSecurityOptions(read({
			[CLAUDE_SANDBOX_ENABLED_SETTING]: true,
			[CLAUDE_SANDBOX_AUTO_ALLOW_BASH_SETTING]: false,
			[CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING]: false,
			[CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING]: true,
		}));
		const off = claudeSecurityOptions(read({ [CLAUDE_SANDBOX_ALLOW_LOCAL_BINDING_SETTING]: true }));
		assert.deepStrictEqual({ options, off }, {
			options: {
				sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, network: { allowLocalBinding: true } },
				env: {},
			},
			off: { env: {} },
		});
	});

	test('adds the sandbox denyRead only when the sandbox is on (issue 458)', () => {
		const on = claudeSecurityOptions(read({ [CLAUDE_SANDBOX_ENABLED_SETTING]: true }), ['~/.ssh']);
		const off = claudeSecurityOptions(read({}), ['~/.ssh']);
		assert.deepStrictEqual([on.sandbox?.filesystem, off.sandbox], [{ denyRead: ['~/.ssh'] }, undefined]);
	});

	test('adds the read deny rules to the flag settings beside the user own (issue 458)', () => {
		const settings = claudeCliSettings({ userSettings: { permissions: { deny: ['WebFetch'] } }, readDenyRules: ['Read(**/.env)'] } as unknown as Parameters<typeof claudeCliSettings>[0]);
		assert.deepStrictEqual((settings?.permissions as { deny?: string[] } | undefined)?.deny, ['WebFetch', 'Read(**/.env)']);
	});

	test('hands the policy settings and sandbox locks to Claude Code as managed settings', () => {
		const settings = { permissions: { deny: ['WebFetch(domain:example.com)'] }, sandbox: { network: { allowedDomains: ['github.com'] } } };
		const security = read({ [CLAUDE_SANDBOX_ENABLED_SETTING]: true }, {
			[CLAUDE_SANDBOX_ENABLED_SETTING]: true,
			[CLAUDE_SANDBOX_ALLOW_UNSANDBOXED_SETTING]: false,
			[CLAUDE_MANAGED_SETTINGS_SETTING]: JSON.stringify(settings),
		});
		const options = claudeSecurityOptions(security);
		assert.deepStrictEqual({ managed: security.managed, managedSettings: options.managedSettings, policyText: settings.sandbox }, {
			managed: { sandboxEnabled: true, allowUnsandboxedCommands: false, settings },
			managedSettings: {
				permissions: { deny: ['WebFetch(domain:example.com)'] },
				sandbox: { network: { allowedDomains: ['github.com'] }, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
			},
			policyText: { network: { allowedDomains: ['github.com'] } },
		});
	});

	test('ignores a managed settings policy that is not a settings object', () => {
		const managed = ['not json', '[1]', '{}', 42].map(value => read({}, { [CLAUDE_MANAGED_SETTINGS_SETTING]: value }).managed);
		assert.deepStrictEqual(managed, [{}, {}, {}, {}]);
	});

	test('exports telemetry only to an http or https endpoint', () => {
		const env = (endpoint: string, headers = '') => claudeSecurityOptions(read({
			[CLAUDE_OTEL_ENDPOINT_SETTING]: endpoint,
			[CLAUDE_OTEL_PROTOCOL_SETTING]: 'nonsense',
			[CLAUDE_OTEL_HEADERS_SETTING]: headers,
		})).env;
		assert.deepStrictEqual([env(' http://localhost:4317 ', 'Authorization=Bearer x'), env('localhost:4317'), env('')], [
			{
				CLAUDE_CODE_ENABLE_TELEMETRY: '1',
				OTEL_METRICS_EXPORTER: 'otlp',
				OTEL_LOGS_EXPORTER: 'otlp',
				OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
				OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
				OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer x',
			},
			{},
			{},
		]);
	});

	test('explains a sandbox that cannot start, per platform', () => {
		assert.deepStrictEqual([
			claudeSandboxFailureMessage('Sandbox unavailable: bwrap not found', 'linux'),
			claudeSandboxFailureMessage('sandbox is not supported here', 'win32'),
			claudeSandboxFailureMessage('Rate limit reached', 'linux'),
			claudeSandboxFailureMessage('The sandbox ran the command', 'darwin'),
		], [
			'The sandbox is on but cannot start on this machine, so Claude ran nothing. Install bubblewrap and socat, or turn off Sandbox in Klawly Settings > Agents. Claude Code said: Sandbox unavailable: bwrap not found',
			'The sandbox is on but cannot start on this machine, so Claude ran nothing. Run /sandbox in Claude Code to see what it needs, or turn off Sandbox in Klawly Settings > Agents. Claude Code said: sandbox is not supported here',
			undefined,
			undefined,
		]);
	});
});
