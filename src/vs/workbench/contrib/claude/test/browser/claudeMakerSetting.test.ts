/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CLAUDE_MAKER_ACTIVE_SETTING } from '../../../../../platform/claude/common/claudeMakerPrompt.js';
import { claudeMakerConfigurationNode } from '../../browser/claudeMakerService.js';

suite('Klawly maker setting (issue 1515)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loading the maker service registers the key it writes, in every window', () => {
		// Other suites (configurationRegistry.test.ts, configurations.test.ts) empty the registry, so register the node again for this test (#1548).
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		registry.registerConfiguration(claudeMakerConfigurationNode);
		const property = registry.getConfigurationProperties()[CLAUDE_MAKER_ACTIVE_SETTING];
		registry.deregisterConfigurations([claudeMakerConfigurationNode]);
		assert.deepStrictEqual({ type: property?.type, scope: property?.scope, default: property?.default }, { type: 'boolean', scope: ConfigurationScope.APPLICATION, default: false });
	});
});
