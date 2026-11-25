/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../../services/environment/browser/environmentService.js';
import { LayoutStateKeys, LayoutStateModel } from '../../../../browser/layout.js';

suite('Claude agents window layout state', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(agentsLayout: boolean) {
		const store = disposables.add(new DisposableStore());
		const storage = store.add(new InMemoryStorageService());
		const config = new TestConfigurationService();
		const env = { args: { 'agents-layout': agentsLayout } } as unknown as IBrowserWorkbenchEnvironmentService;
		const model = store.add(new LayoutStateModel(storage, config, {} as IWorkspaceContextService, env));
		return { storage, config, model };
	}

	function hiddenKeysWritten(storage: InMemoryStorageService): string[] {
		return [StorageScope.WORKSPACE, StorageScope.PROFILE].flatMap(scope => storage.keys(scope, 0).concat(storage.keys(scope, 1)).filter(key => key.includes('hidden') || key.includes('Hidden')));
	}

	test('the Agents window leaves the saved layout and settings alone', () => {
		const { storage, config, model } = setup(true);
		model.setRuntimeValue(LayoutStateKeys.ACTIVITYBAR_HIDDEN, true);
		model.setRuntimeValue(LayoutStateKeys.SIDEBAR_HIDDEN, true);
		model.save(true, true);
		assert.deepStrictEqual({ written: hiddenKeysWritten(storage), activityBarSetting: config.getValue('workbench.activityBar.location') }, { written: [], activityBarSetting: undefined });
	});

	test('an IDE window still saves its layout', () => {
		const { storage, model } = setup(false);
		model.setRuntimeValue(LayoutStateKeys.SIDEBAR_HIDDEN, true);
		model.save(true, true);
		assert.ok(hiddenKeysWritten(storage).length > 0);
	});
});
