/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ClaudeRuntimeState } from '../../../../../platform/claude/common/claude.js';
import { CLAUDE_DATA_USAGE_URL, CLAUDE_PRIVACY_SETTINGS_URL, claudePrivacyAccount } from '../../common/claudePrivacy.js';
import { claudeSettingsPages, searchClaudeSettings } from '../../common/claudeSettingsPages.js';

suite('Klawly settings: privacy page', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function signedIn(authMode: ClaudeRuntimeState['authMode']): ClaudeRuntimeState {
		return { installed: true, authenticated: true, version: '2.1.0', authMode };
	}

	test('each account type names its terms and links to its own data settings', () => {
		const rows = [
			claudePrivacyAccount(signedIn('claude-account'), { live: true, account: { plan: 'max' } }),
			claudePrivacyAccount(signedIn('claude-account'), { live: true, account: { plan: 'team' } }),
			claudePrivacyAccount(signedIn('claude-account'), undefined),
			claudePrivacyAccount(signedIn('api-key'), undefined),
			claudePrivacyAccount(signedIn('bedrock'), undefined),
			claudePrivacyAccount(signedIn('vertex'), undefined),
			claudePrivacyAccount({ installed: true, authenticated: false }, undefined),
		];
		assert.deepStrictEqual(rows.map(row => [row.label, row.link?.url]), [
			['Claude Max Plan', CLAUDE_PRIVACY_SETTINGS_URL],
			['Claude Team Plan', CLAUDE_DATA_USAGE_URL],
			['Claude Account', CLAUDE_PRIVACY_SETTINGS_URL],
			['API Key', CLAUDE_DATA_USAGE_URL],
			['Amazon Bedrock', 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html'],
			['Google Vertex AI', 'https://cloud.google.com/vertex-ai/generative-ai/docs/data-governance'],
			['Signed out', undefined],
		]);
	});

	test('the page sits after Agents, holds the privacy toggles once, and search finds it', () => {
		const pages = claudeSettingsPages();
		const keys = pages.flatMap(page => page.sections.flatMap(section => section.rows.map(row => row.key))).filter(key => key === 'claude.telemetry.enabled' || key === 'claude.security.scanAttachmentsForSecrets');
		assert.deepStrictEqual({
			order: pages.map(page => page.id),
			keys,
			search: searchClaudeSettings(pages, 'training').map(match => `${match.page.id}/${match.row.id}`),
		}, {
			order: ['general', 'plan', 'agents', 'auto', 'privacy', 'models', 'git', 'customize', 'tab', 'beta'],
			keys: ['claude.telemetry.enabled', 'claude.security.scanAttachmentsForSecrets'],
			search: ['privacy/privacyAccount'],
		});
	});
});
