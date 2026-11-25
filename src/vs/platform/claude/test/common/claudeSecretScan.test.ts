/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentEnvelope, compileSubmission } from '../../common/claudePrompt.js';
import { redactClaudeSecrets } from '../../common/claudeSecretPatterns.js';
import { countEnvelopeSecrets, removeClaudeSecrets, removeEnvelopeSecrets, scanClaudeSecrets } from '../../common/claudeSecretScan.js';

// Fake credentials are joined at run time so repository secret scanners do not flag this file.
const join = (...parts: string[]) => parts.join('');
const FAKE = {
	awsTemporary: join('AS', 'IA', 'QWERTYUIOPASDFGH'),
	awsLongTerm: join('AK', 'IA', 'ZXCVBNMLKJHGFDSA'),
	githubOauth: join('gh', 'o_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
	githubUser: join('gh', 'u_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
	githubServer: join('gh', 's_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
	githubFineGrained: join('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnop'),
	slack: join('xo', 'xb-', '123456789012-1234567890123-abcdefABCDEF'),
	google: join('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
	stripe: join('sk', '_live_', '51HxYzAbCdEfGhIjKlMnOp'),
	stripeRestricted: join('rk', '_live_', '51HxYzAbCdEfGhIjKlMnOp'),
	openai: join('sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz0123'),
	anthropic: join('sk', '-ant-', 'api03-abcdefghijklmnop'),
};

function found(text: string): [string, string][] {
	return scanClaudeSecrets(text).map(span => [span.id, text.slice(span.start, span.end)]);
}

suite('Claude secret scanner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the common credential formats with their ranges', () => {
		const text = [
			`aws ${FAKE.awsTemporary} and ${FAKE.awsLongTerm}`,
			`github ${FAKE.githubOauth} ${FAKE.githubUser} ${FAKE.githubServer} ${FAKE.githubFineGrained}`,
			`slack ${FAKE.slack}`,
			`google ${FAKE.google}`,
			`stripe ${FAKE.stripe} ${FAKE.stripeRestricted}`,
			`openai ${FAKE.openai}`,
			`anthropic ${FAKE.anthropic}`,
			'db postgres://admin:s3cr3t-pa55@db.internal:5432/app',
			'ado Server=tcp:db;Database=app;User Id=sa;Password=Hunter2 rocks;Encrypt=true',
		].join('\n');
		assert.deepStrictEqual(found(text), [
			['aws-access-key', FAKE.awsTemporary],
			['aws-access-key', FAKE.awsLongTerm],
			['github-token', FAKE.githubOauth],
			['github-token', FAKE.githubUser],
			['github-token', FAKE.githubServer],
			['github-fine-grained-token', FAKE.githubFineGrained],
			['slack-token', FAKE.slack],
			['google-api-key', FAKE.google],
			['stripe-live-key', FAKE.stripe],
			['stripe-live-key', FAKE.stripeRestricted],
			['openai-style-key', FAKE.openai],
			['anthropic-key', FAKE.anthropic],
			['connection-string-url', 's3cr3t-pa55'],
			['connection-string-password', 'Hunter2 rocks'],
		]);
	});

	test('finds .env assignments and hides only the value', () => {
		const env = [
			'# local settings',
			'DATABASE_PASSWORD=correct horse battery',
			'export JWT_SECRET="quoted-value" # rotate monthly',
			'STRIPE_SECRET_KEY=\'single quoted\'',
			'GITHUB_TOKEN = plainvalue',
			'MAIL_PASS=letmein',
			'SERVICE_APIKEY=abc123',
		].join('\r\n');
		assert.deepStrictEqual(found(env), [
			['dotenv-assignment', 'correct horse battery'],
			['dotenv-assignment', 'quoted-value'],
			['dotenv-assignment', 'single quoted'],
			['dotenv-assignment', 'plainvalue'],
			['dotenv-assignment', 'letmein'],
			['dotenv-assignment', 'abc123'],
		]);
		assert.strictEqual(removeClaudeSecrets('export JWT_SECRET="quoted-value" # rotate monthly'), 'export JWT_SECRET="[redacted]" # rotate monthly');
	});

	test('false positives: ordinary code, placeholders and look-alikes are not reported', () => {
		const benign = [
			// Source code that names a secret but holds none.
			'const API_TOKEN = process.env.API_TOKEN;',
			'API_KEY = os.environ["API_KEY"]',
			'password: string;',
			'if (password == null) { return; }',
			'headers.Authorization = `Bearer ${token}`;',
			'Send a Bearer token in the header.',
			// Placeholders and empty values in .env files.
			'DB_PASSWORD=',
			'DB_PASSWORD=${DB_PASSWORD}',
			'API_KEY=<your-api-key>',
			'SECRET_KEY=changeme',
			'AUTH_TOKEN=xxxxxxxx',
			'SESSION_SECRET=None',
			// Names that are not secrets.
			'PWD=/home/me/project',
			'OLDPWD=/tmp',
			'SSH_KEY_PATH=~/.ssh/id_ed25519',
			'TOKEN_URL=https://auth.example.com/token',
			'NEXT_PUBLIC_STRIPE_KEY=pk_live_value',
			'PRIMARY=KEY',
			'TOKENIZER=whitespace',
			// URLs and connection strings without a password.
			'https://github.com/klawly/klawly.git',
			'http://localhost:3000/path@v2',
			'postgres://admin@db.internal/app',
			'postgres://admin:${DB_PASSWORD}@db.internal/app',
			'git@github.com:klawly/klawly.git',
			'Server=db;Integrated Security=true;',
			// Short or partial token shapes.
			'ghp_short',
			'AKIA123',
			'xoxb-1',
			'task-sk-abc and sk_test_value',
			'AIzaTooShort',
		];
		assert.deepStrictEqual(benign.filter(line => scanClaudeSecrets(line).length > 0), []);
	});

	test('overlapping matches count once and redaction agrees with the scanner', () => {
		const text = `ANTHROPIC_API_KEY=${FAKE.anthropic}\nAuthorization: Bearer ${FAKE.githubOauth}`;
		assert.deepStrictEqual(found(text).map(([id]) => id), ['anthropic-key', 'github-token']);
		assert.strictEqual(removeClaudeSecrets(text), 'ANTHROPIC_API_KEY=[redacted]\nAuthorization: Bearer [redacted]');
		assert.strictEqual(redactClaudeSecrets(text), 'ANTHROPIC_API_KEY=[redacted]\nAuthorization: Bearer [redacted]');
		assert.strictEqual(removeClaudeSecrets('nothing to see'), 'nothing to see');
	});

	test('counts and removes secrets in every bulk attachment, and leaves the request alone', () => {
		const envelope: AgentEnvelope = {
			userText: `keep ${FAKE.awsLongTerm} typed by the user`,
			mode: 'agent',
			workspaceRoot: '/repo',
			activeFile: { relativePath: 'src/app.ts', cursorLine: 1, selection: `key = "${FAKE.openai}"` },
			attachments: [
				{ kind: 'file', path: '.env', content: 'DB_PASSWORD=hunter2', unsaved: false, truncated: false },
				{ kind: 'file', path: 'src/missing.ts', unsaved: false, truncated: false },
				{ kind: 'selection', path: 'src/app.ts', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }, content: FAKE.slack, stale: false, truncated: false },
				{ kind: 'symbol', path: 'src/app.ts', name: 'connect', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }, content: 'mongodb://u:p4ss@host', truncated: false },
				{ kind: 'git-diff', scope: 'all', stat: '1 file', patch: `+STRIPE_SECRET_KEY=${FAKE.stripe}`, truncated: false },
				{ kind: 'terminal', title: 'bash', lines: `$ echo ${FAKE.githubOauth}`, truncated: false },
				{ kind: 'pasted-text', text: `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----`, lineCount: 3, truncated: false },
				{ kind: 'folder', path: 'src' },
				{ kind: 'diagnostics', items: [{ severity: 'error', message: `bad ${FAKE.google}` }] },
			],
			diagnostics: [],
			instructionFiles: [],
		};
		assert.strictEqual(countEnvelopeSecrets(envelope), 7);
		const cleaned = removeEnvelopeSecrets(envelope);
		assert.strictEqual(countEnvelopeSecrets(cleaned), 0);
		const compiled = compileSubmission(cleaned);
		for (const secret of [FAKE.openai, 'hunter2', FAKE.slack, 'p4ss', FAKE.stripe, FAKE.githubOauth, 'MIIEvQIBADANBg']) {
			assert.strictEqual(compiled.includes(secret), false, secret);
		}
		assert.ok(compiled.includes(`keep ${FAKE.awsLongTerm} typed by the user`));
		assert.ok(compiled.includes('-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----'));
		assert.deepStrictEqual(cleaned.attachments[1], envelope.attachments[1]);
		assert.deepStrictEqual(cleaned.attachments.slice(7), envelope.attachments.slice(7));
	});

	test('an active selection already sent as a chip is counted once', () => {
		const content = `token=${FAKE.githubServer}`;
		const envelope: AgentEnvelope = {
			userText: 'why',
			mode: 'agent',
			workspaceRoot: '/repo',
			activeFile: { relativePath: 'src/app.ts', cursorLine: 1, selection: content },
			attachments: [{ kind: 'selection', path: 'src/app.ts', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 }, content, stale: false, truncated: false }],
			diagnostics: [],
			instructionFiles: [],
		};
		assert.strictEqual(countEnvelopeSecrets(envelope), 1);
		const compiled = compileSubmission(removeEnvelopeSecrets(envelope));
		assert.strictEqual(compiled.includes(FAKE.githubServer), false);
		assert.strictEqual(compiled.split('token=[redacted]').length - 1, 1);
	});
});
