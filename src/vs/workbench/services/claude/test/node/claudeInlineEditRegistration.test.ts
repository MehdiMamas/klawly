/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Claude inline edit registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('inline edit stays registered beside diagnostics', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../');
		const contribution = readFileSync(join(root, 'src/vs/workbench/contrib/claude/electron-browser/claude.contribution.ts'), 'utf8');
		const css = readFileSync(join(root, 'src/vs/workbench/contrib/claude/browser/media/claude.css'), 'utf8');
		assert.match(contribution, /registerClaudeInlineContributions\(\)/);
		assert.match(contribution, /registerClaudeDiagnosticsActions\(\)/);
		assert.match(contribution, /CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING/);
		assert.match(contribution, /CLAUDE_DIAGNOSTICS_AUTO_VERIFY_SETTING/);
		assert.match(css, /\.claude-inline-inserted(,[^{]*)?\s*\{/);
		assert.match(css, /\.claude-new-problems\s*\{/);
		assert.match(css, /\.claude-new-problems \.claude-btn\s*\{[^}]*margin-left:\s*auto;\s*\}/);
	});

	test('Escape Rejects Inline Edits and Browser Preview start off, as the prototype draws them (#175)', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../');
		const contribution = readFileSync(join(root, 'src/vs/workbench/contrib/claude/electron-browser/claude.contribution.ts'), 'utf8');
		const defaults = ['CLAUDE_INLINE_REJECT_ON_ESCAPE_SETTING', 'CLAUDE_PREVIEW_ENABLED_SETTING'].map(key => new RegExp(`\\[${key}\\]: \\{[^}]*default: (?<value>\\w+),`).exec(contribution)?.groups?.value);
		assert.deepStrictEqual(defaults, ['false', 'false']);
	});
});
