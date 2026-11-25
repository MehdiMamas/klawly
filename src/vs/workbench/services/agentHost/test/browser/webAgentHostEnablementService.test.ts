/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY } from '../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { CLAUDE_AGENTS_WINDOW_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeAgentHost.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IManagedSettingsService, NullManagedSettingsService } from '../../../../../platform/policy/common/copilotManagedSettings.js';
import { IWorkbenchEnvironmentService } from '../../../environment/common/environmentService.js';
import { WebAgentHostEnablementService } from '../../browser/webAgentHostEnablementService.js';

suite('WebAgentHostEnablementService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function getEnablement(options: {
		readonly remoteAuthority?: string;
		readonly agentsWindowEnabled?: boolean;
	}): {
		readonly enabled: boolean;
		readonly contextKey: boolean | undefined;
	} {
		const instantiationService = disposables.add(new TestInstantiationService());
		const configurationService = new TestConfigurationService({
			[CLAUDE_AGENTS_WINDOW_ENABLED_SETTING]: options.agentsWindowEnabled ?? true,
		});
		const contextKeyService = disposables.add(new MockContextKeyService());
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(IManagedSettingsService, new NullManagedSettingsService());
		instantiationService.stub(IWorkbenchEnvironmentService, { remoteAuthority: options.remoteAuthority });

		const service = disposables.add(instantiationService.createInstance(WebAgentHostEnablementService));
		return {
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
		};
	}

	test('enables Agent Host for web with a remote extension host', () => {
		assert.deepStrictEqual(getEnablement({ remoteAuthority: 'ssh-remote+test' }), {
			enabled: true,
			contextKey: true,
		});
	});

	test('disables Agent Host for serverless web', () => {
		assert.deepStrictEqual(getEnablement({}), {
			enabled: false,
			contextKey: false,
		});
	});

	// Klawly: the Agent Host follows the Agents window setting, not Copilot's AI disablement (issue 617).
	test('stays off in web with a remote extension host while the Agents window setting is off', () => {
		assert.deepStrictEqual(getEnablement({ remoteAuthority: 'ssh-remote+test', agentsWindowEnabled: false }), {
			enabled: false,
			contextKey: false,
		});
	});
});
