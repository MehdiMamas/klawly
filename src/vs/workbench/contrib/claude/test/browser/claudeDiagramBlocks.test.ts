/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IChatOutputRendererService } from '../../../chat/browser/chatOutputItemRenderer.js';
import { CLAUDE_CHAT_DIAGRAMS_SETTING, ClaudeDiagramBlocks } from '../../browser/chat/claudeDiagramBlocks.js';

const CHART = JSON.stringify({ type: 'bar', title: 'Tests', labels: ['Mon', 'Tue'], series: [{ name: 'seconds', values: [18, 15] }] });

suite('Claude diagram blocks', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('finished chart and Mermaid fences draw; streaming fences, unknown fences and the setting off stay code', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const configuration = new TestConfigurationService({ [CLAUDE_CHAT_DIAGRAMS_SETTING]: true });
		const rendered: string[] = [];
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(IChatOutputRendererService, {
			hasCodeBlockRenderer: (language: string) => language === 'mermaid',
			renderCodeBlock: async (language: string, data: Uint8Array) => {
				rendered.push(`${language}: ${new TextDecoder().decode(data)}`);
				throw new Error('no webview in tests');
			},
		});
		const blocks = instantiationService.createInstance(ClaudeDiagramBlocks);
		const renders = store.add(new DisposableStore());

		const chart = blocks.render('chart', `${CHART}\n`, false, renders)!;
		const mermaid = blocks.render('mermaid', 'flowchart TD\n  A --> B\n', false, renders)!;
		const kept = [
			blocks.render('chart', CHART, true, renders),
			blocks.render('chart', '{"type": "pie"}', false, renders),
			blocks.render('typescript', 'const a = 1;', false, renders),
		];
		await timeout(0);
		const toggle = chart.querySelector<HTMLElement>('.claude-icon-btn')!;
		toggle.click();
		await configuration.setUserConfiguration(CLAUDE_CHAT_DIAGRAMS_SETTING, false);

		assert.deepStrictEqual({
			chart: [chart.querySelector('.path')?.textContent, chart.querySelectorAll('rect.mark').length, chart.querySelector('.claude-chart-title')?.textContent],
			toggled: [toggle.getAttribute('aria-pressed'), chart.querySelector<HTMLElement>('.claude-diagram-view')!.hidden, chart.querySelector<HTMLElement>('.claude-diagram-source')!.hidden],
			mermaid: [mermaid.querySelector('.path')?.textContent, mermaid.querySelector('.claude-diagram-view')!.classList.contains('is-failed')],
			rendered,
			kept,
			off: blocks.render('chart', CHART, false, renders),
		}, {
			chart: ['Chart', 2, 'Tests'],
			toggled: ['true', true, false],
			mermaid: ['Mermaid', true],
			rendered: ['mermaid: flowchart TD\n  A --> B'],
			kept: [undefined, undefined, undefined],
			off: undefined,
		});
	});
});
