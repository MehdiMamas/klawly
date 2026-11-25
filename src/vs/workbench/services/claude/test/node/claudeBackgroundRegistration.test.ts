/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Claude background agent registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('background registration stays beside inline edit', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../');
		const services = readFileSync(join(root, 'src/vs/workbench/services/claude/electron-browser/claude.contribution.ts'), 'utf8');
		const ui = readFileSync(join(root, 'src/vs/workbench/contrib/claude/electron-browser/claude.contribution.ts'), 'utf8');
		const css = readFileSync(join(root, 'src/vs/workbench/contrib/claude/browser/media/claude.css'), 'utf8');
		assert.match(services, /registerSingleton\(IClaudeBackgroundAgentService/);
		assert.match(services, /registerSingleton\(IClaudeInlineEditService/);
		assert.match(ui, /registerClaudeBackground\(\)/);
		assert.match(ui, /registerClaudeInlineContributions\(\)/);
		assert.match(css, /\.claude-bg-agent\s*\{/);
		assert.match(css, /\.claude-inline\s*\{/);
		assert.match(css, /\.claude-new-problems\s*\{/);
		assert.doesNotMatch(services, /<<<<<<<|>>>>>>>/);
		assert.doesNotMatch(css, /<<<<<<<|>>>>>>>/);
	});
});
