/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { KLAWLY_GUIDE_AGENT, KLAWLY_GUIDE_CONTEXT_LIMIT, klawlyGuideContext, klawlyGuidePrompt } from '../../common/claudeGuide.js';
import { KLAWLY_GUIDE_DOCS } from '../../common/klawlyGuideText.js';
import { KLAWLY_BUILTIN_AGENTS } from '../../node/claudeBuiltinAgents.js';

suite('Klawly guide (issue 524)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the guide carries FEATURES.md sections 1 to 4 as they are now (run npm run guide-bundle when this fails)', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
		const features = readFileSync(join(root, 'FEATURES.md'), 'utf8').replace(/\r\n/g, '\n');
		const expected = features.slice(features.indexOf('\n## 1.') + 1, features.indexOf('\n## 5.')).trim();
		assert.ok(KLAWLY_GUIDE_DOCS === expected, 'klawlyGuideText.ts is out of date with FEATURES.md: run npm run guide-bundle');
	});

	test('the klawly-guide subagent answers from those docs with no tools, and Ask About Klawly mentions it', () => {
		const guide = KLAWLY_BUILTIN_AGENTS[KLAWLY_GUIDE_AGENT];
		assert.deepStrictEqual({
			tools: guide.tools,
			model: guide.model,
			docs: guide.prompt.includes(KLAWLY_GUIDE_DOCS) && guide.prompt.includes('<klawly_documentation>'),
			writes: ['Write', 'Edit', 'Bash'].every(tool => guide.disallowedTools?.includes(tool)),
			prompt: klawlyGuidePrompt('  How do I\nreview changes? '),
		}, { tools: [], model: 'haiku', docs: true, writes: true, prompt: '@agent-klawly-guide How do I review changes?' });
	});

	test('the guide gets the settings and shortcuts at query start, capped, and nothing when there are none (issue 663)', () => {
		const text = klawlyGuideContext(
			[{ key: 'claude.b', description: ' Does\nb. ', defaultValue: true }, { key: 'claude.a', description: 'Does a.' }, { key: 'claude.none', description: ' ' }],
			[{ label: 'Find in Chat...', keys: 'Ctrl+F' }],
		);
		const long = klawlyGuideContext([{ key: 'claude.x', description: 'x'.repeat(KLAWLY_GUIDE_CONTEXT_LIMIT) }], []);
		assert.deepStrictEqual({
			text,
			capped: long.length <= KLAWLY_GUIDE_CONTEXT_LIMIT + '\n</klawly_window_facts>'.length && long.endsWith('</klawly_window_facts>'),
			empty: klawlyGuideContext([], []),
		}, {
			text: '<klawly_window_facts>\nSettings in this window (name, default, what it does):\n- claude.a: Does a.\n- claude.b (default true): Does b.\nKeyboard shortcuts in this window:\n- Find in Chat...: Ctrl+F\n</klawly_window_facts>',
			capped: true,
			empty: '',
		});
	});
});
