/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CLAUDE_SECRET_PATTERNS, findClaudeSecretSpans, redactClaudeSecrets } from '../../common/claudeSecretPatterns.js';

const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu\n';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

suite('Claude secret patterns', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('PEM private key bodies are removed and the armor lines stay', () => {
		const text = `key:\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}-----END RSA PRIVATE KEY-----\ndone`;
		assert.strictEqual(redactClaudeSecrets(text), 'key:\n-----BEGIN RSA PRIVATE KEY-----[redacted]-----END RSA PRIVATE KEY-----\ndone');
		const kinds = ['PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'];
		for (const kind of kinds) {
			const redacted = redactClaudeSecrets(`-----BEGIN ${kind}-----\n${PEM_BODY}-----END ${kind}-----`);
			assert.strictEqual(redacted.includes('MIIEvQ'), false, kind);
		}
	});

	test('a PEM block cut off before its END line is redacted to the end of the text', () => {
		assert.strictEqual(redactClaudeSecrets(`log -----BEGIN PRIVATE KEY-----\n${PEM_BODY}`), 'log -----BEGIN PRIVATE KEY-----[redacted]');
	});

	test('JWTs are redacted wherever they appear', () => {
		assert.strictEqual(redactClaudeSecrets(`token=${JWT}`), 'token=[redacted]');
		assert.strictEqual(redactClaudeSecrets(`cookie ${JWT}; Path=/`), 'cookie [redacted]; Path=/');
	});

	test('look-alikes are left alone', () => {
		const benign = [
			'-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----',
			'-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----',
			'eyJhbGciOiJIUzI1NiJ9 is a header alone',
			'version 1.2.3 and task-sk-abc',
			'the password field is required',
		];
		assert.deepStrictEqual(benign.map(redactClaudeSecrets), benign);
	});

	test('the shared list names every pattern once and reports where each secret sits', () => {
		const ids = CLAUDE_SECRET_PATTERNS.map(entry => entry.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		for (const entry of CLAUDE_SECRET_PATTERNS) {
			assert.ok(entry.pattern.global && entry.pattern.hasIndices, entry.id);
		}
		const text = 'Authorization: Bearer abc.def and API_KEY=hunter2';
		const spans = CLAUDE_SECRET_PATTERNS.flatMap(entry => findClaudeSecretSpans(text, entry));
		assert.deepStrictEqual(spans.map(span => [span.id, text.slice(span.start, span.end)]), [
			['bearer-token', 'abc.def'],
			['key-value', 'hunter2'],
		]);
	});
});
