/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

/** Every folder that holds Claude code (master plan section 74). */
const CLAUDE_FOLDERS = [
	'src/vs/platform/claude',
	'src/vs/workbench/services/claude',
	'src/vs/workbench/contrib/claude',
	'src/vs/workbench/contrib/claudeBackground',
];

/**
 * Files that may name `ITelemetryService`, each with its reason. Naming it is not
 * sending: these only pass it to an upstream base class that requires it.
 */
const TELEMETRY_SERVICE_ALLOWED = new Map([
	['src/vs/workbench/contrib/claude/browser/claudeCanvasEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/claudePreviewEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/claudeSplitEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/chat/claudeAgentEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/plan/claudePlanEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/review/claudeReviewEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claude/browser/settings/claudeSettingsEditor.ts', 'the EditorPane constructor takes it'],
	['src/vs/workbench/contrib/claudeBackground/browser/claudeComparisonEditor.ts', 'the EditorPane constructor takes it'],
]);

function claudeSources(): { path: string; text: string }[] {
	const sources: { path: string; text: string }[] = [];
	for (const folder of CLAUDE_FOLDERS) {
		for (const entry of readdirSync(join(REPO, folder), { recursive: true, encoding: 'utf8' })) {
			const path = `${folder}/${entry.replace(/\\/g, '/')}`;
			if (/\.(?:ts|js|mjs)$/.test(path) && !/\/test\//.test(path)) {
				sources.push({ path, text: readFileSync(join(REPO, path), 'utf8') });
			}
		}
	}
	return sources;
}

suite('Claude telemetry stays off', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('no Claude code path calls ITelemetryService.publicLog*', () => {
		const sources = claudeSources();
		assert.ok(sources.length > 100, `only ${sources.length} Claude sources found under ${REPO}`);
		assert.deepStrictEqual(sources.filter(source => /\bpublicLog\w*/.test(source.text)).map(source => source.path), []);
		const naming = sources.filter(source => /\bITelemetryService\b/.test(source.text)).map(source => source.path);
		assert.deepStrictEqual(naming, [...TELEMETRY_SERVICE_ALLOWED.keys()]);
	});

	test('product.json keeps product telemetry off', () => {
		const text = readFileSync(join(REPO, 'product.json'), 'utf8');
		const product = JSON.parse(text);
		assert.strictEqual(product.enableTelemetry, false);
		assert.strictEqual(product.aiConfig, undefined);
		assert.strictEqual(/events\.data\.microsoft\.com|applicationinsights|vortex\.data|dc\.services\.visualstudio\.com/i.test(text), false);
	});

	test('claude.telemetry.enabled is registered with default false', () => {
		const contribution = readFileSync(join(REPO, 'src/vs/workbench/contrib/claude/electron-browser/claude.contribution.ts'), 'utf8');
		assert.match(contribution, /\[CLAUDE_TELEMETRY_ENABLED_SETTING\]: \{\s*type: 'boolean',\s*scope: ConfigurationScope\.APPLICATION,\s*default: false,/);
		const configuration = readFileSync(join(REPO, 'src/vs/platform/claude/common/claudeConfiguration.ts'), 'utf8');
		assert.match(configuration, /CLAUDE_TELEMETRY_ENABLED_SETTING = 'claude\.telemetry\.enabled'/);
	});
});
