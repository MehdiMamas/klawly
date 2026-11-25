/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { buildCompletionPrompt, CLAUDE_AUTOCOMPLETE_PREFIX_CHARS, completionCacheKey, completionLatencyPercentiles, contentChangeRecentEdits, formatClaudeTabLatency, inlineInsertText, isSecretCompletionSurface, isSkippedCompletionScheme, isStaleCompletion, nextEditPreviewRange, nextTextAfterContentChanges, parseCompletionText, resolveNextEditTarget } from '../../common/claudeAutocomplete.js';
import { readClaudeAutocompleteDebounceMs, readClaudeAutocompleteEnabled, readClaudeAutocompleteModel } from '../../common/claudeConfiguration.js';

suite('Claude autocomplete', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a stale version, cursor, or cancellation is not applied', () => {
		const request = { versionId: 4, lineNumber: 2, column: 8 };
		assert.strictEqual(isStaleCompletion(request, request, false), false);
		assert.strictEqual(isStaleCompletion(request, { ...request, versionId: 5 }, false), true);
		assert.strictEqual(isStaleCompletion(request, { ...request, column: 9 }, false), true);
		assert.strictEqual(isStaleCompletion(request, { ...request, lineNumber: 3 }, false), true);
		assert.strictEqual(isStaleCompletion(request, request, true), true);
	});

	test('cache key follows the file, cursor, and nearby text', () => {
		const position = { lineNumber: 2, column: 4 };
		const key = completionCacheKey('file', position, 'near');
		assert.strictEqual(key, completionCacheKey('file', position, 'near'));
		assert.notStrictEqual(key, completionCacheKey('file-changed', position, 'near'));
		assert.notStrictEqual(key, completionCacheKey('file', { lineNumber: 2, column: 5 }, 'near'));
		assert.notStrictEqual(key, completionCacheKey('file', position, 'other'));
	});

	test('password and secret surfaces are skipped', () => {
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/src/app.ts', lineText: 'const value = 1;' }), false);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/src/secretary.ts', lineText: 'const name = 1;' }), false);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'dotenv', uriPath: '/repo/src/app.ts', lineText: 'NAME=1' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/.env', lineText: 'NAME=1' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/.env.local', lineText: 'NAME=1' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/secrets.ts', lineText: 'export {}' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/id_rsa', lineText: '' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/cert.pem', lineText: '' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/src/app.ts', lineText: 'const password = "x";' }), true);
		assert.strictEqual(isSecretCompletionSurface({ languageId: 'typescript', uriPath: '/repo/src/app.ts', lineText: 'api_key: "x"' }), true);
	});

	test('plain text is kept and a fenced or cross-file reply is not inserted here', () => {
		assert.deepStrictEqual(parseCompletionText('const value = 1;'), { kind: 'inline', text: 'const value = 1;' });
		assert.deepStrictEqual(parseCompletionText('```ts\nconst value = 1;\n```\n'), { kind: 'inline', text: 'const value = 1;' });
		const next = parseCompletionText('NEXT receipt.ts:21\nconst total = 1;\n');
		assert.strictEqual(next?.kind, 'next');
		assert.strictEqual(next?.path, 'receipt.ts');
		assert.strictEqual(next?.line, 21);
		assert.strictEqual(next?.text, 'const total = 1;');
		assert.strictEqual(parseCompletionText('NEXT not-a-target'), undefined);
		assert.strictEqual(parseCompletionText('   \n'), undefined);
		assert.strictEqual(inlineInsertText({ kind: 'inline', insertText: 'const value = 1;' }), 'const value = 1;');
		assert.strictEqual(inlineInsertText({
			kind: 'next-edit',
			target: URI.file('/repo/receipt.ts'),
			line: 21,
			preview: 'const total = 1;',
			fileName: 'receipt.ts',
			anchor: { lineNumber: 1, column: 1 },
		}), undefined);
	});

	test('a next edit stays inside a workspace folder', () => {
		const root = URI.file('/repo');
		const current = URI.joinPath(root, 'src/app.ts');
		const inside = resolveNextEditTarget('receipt.ts', [root], current);
		assert.ok(inside);
		assert.strictEqual(isEqualOrParent(inside!, root), true);
		assert.strictEqual(inside!.path.endsWith('/receipt.ts'), true);

		const absoluteInside = resolveNextEditTarget(URI.joinPath(root, 'src/a.ts').fsPath, [root], current);
		assert.ok(absoluteInside);
		assert.strictEqual(isEqualOrParent(absoluteInside!, root), true);

		assert.strictEqual(resolveNextEditTarget('../secret.ts', [root], current), undefined);
		assert.strictEqual(resolveNextEditTarget('src/../../secret.ts', [root], current), undefined);
		assert.strictEqual(resolveNextEditTarget(URI.file('/other/secret.ts').fsPath, [root], current), undefined);
		assert.strictEqual(resolveNextEditTarget('https://example.com/a.ts', [root], current), undefined);
		assert.strictEqual(resolveNextEditTarget('untitled:Untitled-1', [root], current), undefined);
		assert.strictEqual(resolveNextEditTarget('src/a.ts', [], current), undefined);

		const remote = URI.from({ scheme: 'vscode-remote', authority: 'ssh', path: '/workspace' });
		const remoteFile = URI.joinPath(remote, 'src/a.ts');
		const remoteTarget = resolveNextEditTarget('src/a.ts', [remote], remoteFile);
		assert.ok(remoteTarget);
		assert.strictEqual(remoteTarget!.scheme, 'vscode-remote');
		assert.strictEqual(resolveNextEditTarget(URI.file('/tmp/a.ts').toString(), [remote], remoteFile), undefined);
	});

	test('a document edit keeps the replaced text and the new text', () => {
		const edits = contentChangeRecentEdits('file:///repo/src/app.ts', 'const old = 1;\n', [{
			range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 10 },
			rangeOffset: 6,
			rangeLength: 3,
			text: 'next',
		}]);
		assert.strictEqual(edits.length, 1);
		assert.strictEqual(edits[0].before, 'old');
		assert.strictEqual(edits[0].after, 'next');
		assert.strictEqual(edits[0].range.startColumn, 7);
		const next = nextTextAfterContentChanges('const old = 1;\n', [{
			range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 10 },
			rangeOffset: 6,
			rangeLength: 3,
			text: 'next',
		}, {
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
			rangeOffset: 0,
			rangeLength: 0,
			text: 'X',
		}]);
		assert.strictEqual(next, 'Xconst next = 1;\n');
	});

	test('input surfaces are skipped', () => {
		assert.strictEqual(isSkippedCompletionScheme(Schemas.vscodeSourceControl), true);
		assert.strictEqual(isSkippedCompletionScheme(Schemas.commentsInput), true);
		assert.strictEqual(isSkippedCompletionScheme(Schemas.vscodeChatInput), true);
		assert.strictEqual(isSkippedCompletionScheme(Schemas.vscodeInteractiveInput), true);
		assert.strictEqual(isSkippedCompletionScheme(Schemas.outputChannel), true);
		assert.strictEqual(isSkippedCompletionScheme(Schemas.file), false);
	});

	test('a cross-file preview replaces the target line', () => {
		assert.deepStrictEqual(nextEditPreviewRange(21, 16), {
			startLineNumber: 21,
			startColumn: 1,
			endLineNumber: 21,
			endColumn: 16,
		});
	});

	test('latency text names P50 and P95', () => {
		assert.ok(formatClaudeTabLatency(undefined).includes('samples=0'));
		const line = formatClaudeTabLatency({ p50: 40, p95: 90, count: 8 });
		assert.ok(line.includes('p50=40ms'));
		assert.ok(line.includes('p95=90ms'));
		assert.ok(line.includes('samples=8'));
	});

	test('the prompt is small and asks for replacement text only', () => {
		const prompt = buildCompletionPrompt({
			languageId: 'typescript',
			prefix: 'p'.repeat(CLAUDE_AUTOCOMPLETE_PREFIX_CHARS + 50),
			suffix: 's'.repeat(50),
			recentEdits: [{
				uri: 'file:///repo/src/app.ts',
				before: '',
				after: 'recent-token',
				range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
				ageMs: 12,
			}],
			relatedSnippets: [],
		});
		assert.ok(prompt.includes('You are an IDE inline completion engine.'));
		assert.ok(prompt.includes('Return only the exact text that should be inserted/replaced.'));
		assert.ok(prompt.includes('Do not explain.'));
		assert.ok(prompt.includes('Do not wrap in Markdown.'));
		assert.ok(prompt.includes('recent-token'));
		assert.ok(prompt.includes('NEXT <relative-path>:<line>'));
		assert.strictEqual(prompt.includes('p'.repeat(CLAUDE_AUTOCOMPLETE_PREFIX_CHARS + 50)), false);
		assert.ok(prompt.includes('p'.repeat(CLAUDE_AUTOCOMPLETE_PREFIX_CHARS)));
	});

	test('Tab can be disabled and debounce stays inside 100 to 500 ms', () => {
		assert.strictEqual(readClaudeAutocompleteEnabled(undefined), true);
		assert.strictEqual(readClaudeAutocompleteEnabled(false), false);
		assert.strictEqual(readClaudeAutocompleteModel(''), undefined);
		assert.strictEqual(readClaudeAutocompleteModel(' haiku '), 'haiku');
		assert.strictEqual(readClaudeAutocompleteDebounceMs(undefined), 300);
		assert.strictEqual(readClaudeAutocompleteDebounceMs(0), 100);
		assert.strictEqual(readClaudeAutocompleteDebounceMs(900), 500);
		assert.strictEqual(readClaudeAutocompleteDebounceMs(160), 160);
	});

	test('latency reports P50 and P95', () => {
		const samples = Array.from({ length: 100 }, (_value, index) => index + 1);
		const stats = completionLatencyPercentiles(samples);
		assert.strictEqual(stats?.p50, 50);
		assert.strictEqual(stats?.p95, 95);
		assert.strictEqual(completionLatencyPercentiles([]), undefined);
	});
});
