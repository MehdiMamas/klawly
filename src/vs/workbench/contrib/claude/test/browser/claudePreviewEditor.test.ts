/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClaudeActionService } from '../../../../../platform/claude/common/claudeActions.js';
import { CLAUDE_AGENT_ENABLED_SETTING } from '../../../../../platform/claude/common/claudeConfiguration.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IClaudeAgentService } from '../../../../services/claude/common/claudeAgentService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IWebviewService } from '../../../webview/browser/webview.js';
import { IClaudePreviewAttachmentService } from '../../browser/claudePreviewAttachments.js';
import { IClaudePreviewCapture } from '../../browser/claudePreviewCapture.js';
import { ClaudePreviewEditor } from '../../browser/claudePreviewEditor.js';

/** Webview double: the preview mounts it and listens to it, nothing more. */
class FakeWebview extends Disposable {
	readonly onMessage = Event.None;
	mountTo(): void { }
	postMessage(): Promise<boolean> {
		return Promise.resolve(true);
	}
}

suite('Claude preview editor', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the buttons that hand something to the agent hide while claude.agent.enabled is off', () => {
		const instantiation = workbenchInstantiationService(undefined, store);
		const configuration = new TestConfigurationService({ [CLAUDE_AGENT_ENABLED_SETTING]: false });
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(IWebviewService, { createWebviewElement: () => new FakeWebview() } as unknown as IWebviewService);
		instantiation.stub(IClaudePreviewCapture, {} as IClaudePreviewCapture);
		instantiation.stub(IClaudePreviewAttachmentService, {} as IClaudePreviewAttachmentService);
		instantiation.stub(IClaudeAgentService, {} as IClaudeAgentService);
		instantiation.stub(IClaudeActionService, {} as IClaudeActionService);
		instantiation.stub(IViewsService, {} as IViewsService);
		const editor = store.add(instantiation.createInstance(ClaudePreviewEditor, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		editor.create(parent);
		const hidden = () => [...parent.querySelectorAll<HTMLButtonElement>('button.claude-preview-button')].filter(button => button.hidden).map(button => button.textContent);
		const off = hidden();
		configuration.setUserConfiguration(CLAUDE_AGENT_ENABLED_SETTING, true);
		configuration.onDidChangeConfigurationEmitter.fire({
			source: ConfigurationTarget.USER,
			affectedKeys: new Set([CLAUDE_AGENT_ENABLED_SETTING]),
			change: { keys: [CLAUDE_AGENT_ENABLED_SETTING], overrides: [] },
			affectsConfiguration: (key: string) => key === CLAUDE_AGENT_ENABLED_SETTING,
		});
		assert.deepStrictEqual({ off, on: hidden() }, {
			off: ['Add screenshot to Agent', 'Add console errors to Agent', 'Draw on Preview and Add to Agent', 'Add selected element to Agent', 'Fix with Agent'],
			on: [],
		});
	});
});
