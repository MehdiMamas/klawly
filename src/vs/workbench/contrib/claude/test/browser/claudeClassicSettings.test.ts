/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getCommonlyUsedData } from '../../../preferences/browser/settingsLayout.js';
import { ISetting, ISettingsGroup } from '../../../../services/preferences/common/preferences.js';

suite('Claude classic Settings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Commonly Used lists the editor and file basics in order, with no Copilot or chat entries', () => {
		const keys = [
			'editor.fontSize', 'editor.formatOnSave', 'files.autoSave', 'GitHub.copilot-chat.manageExtension', 'editor.defaultFormatter',
			'editor.fontFamily', 'editor.wordWrap', 'chat.agent.maxRequests', 'files.exclude', 'workbench.colorTheme', 'editor.tabSize',
			'editor.mouseWheelZoom', 'editor.formatOnPaste', 'editor.renderWhitespace', 'editor.cursorStyle', 'editor.insertSpaces',
			'workbench.editor.enablePreview',
		];
		const group = { sections: [{ settings: keys.map(key => ({ key }) as ISetting) }] } as ISettingsGroup;
		assert.deepStrictEqual(getCommonlyUsedData([group]).settings?.map(setting => setting.key), [
			'files.autoSave',
			'editor.fontSize',
			'editor.fontFamily',
			'editor.tabSize',
			'editor.renderWhitespace',
			'editor.cursorStyle',
			'editor.insertSpaces',
			'editor.wordWrap',
			'files.exclude',
			'workbench.editor.enablePreview',
		]);
	});
});
