/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The built-in subagent that answers how Klawly works from its own docs (issue 524). */
export const KLAWLY_GUIDE_AGENT = 'klawly-guide';

/** What Ask About Klawly sends: the subagent mention, as the `/` menu inserts it, then the question. */
export function klawlyGuidePrompt(question: string): string {
	return `@agent-${KLAWLY_GUIDE_AGENT} ${question.replace(/\s+/g, ' ').trim()}`;
}

/** One Klawly setting the guide can describe. */
export interface KlawlyGuideSetting {
	readonly key: string;
	readonly description: string;
	readonly defaultValue?: unknown;
}

/** One shortcut the guide can name. */
export interface KlawlyGuideKeybinding {
	readonly label: string;
	readonly keys: string;
}

/** The most characters of window facts sent with a question (issue 663). */
export const KLAWLY_GUIDE_CONTEXT_LIMIT = 16000;

/**
 * The settings and shortcuts of this window, as the text sent to the guide with a question
 * (issue 663). They live in the window, not in FEATURES.md, so the guide gets them at query
 * start. Capped so a long list never crowds out the question.
 */
export function klawlyGuideContext(settings: readonly KlawlyGuideSetting[], keybindings: readonly KlawlyGuideKeybinding[]): string {
	const settingLines = settings
		.filter(setting => setting.description.trim())
		.map(setting => {
			const fallback = setting.defaultValue === undefined ? '' : ` (default ${JSON.stringify(setting.defaultValue)})`;
			return `- ${setting.key}${fallback}: ${setting.description.replace(/\s+/g, ' ').trim()}`;
		})
		.sort();
	const keyLines = keybindings.map(binding => `- ${binding.label}: ${binding.keys}`).sort();
	if (!settingLines.length && !keyLines.length) {
		return '';
	}
	const text = [
		'<klawly_window_facts>',
		'Settings in this window (name, default, what it does):',
		...settingLines,
		'Keyboard shortcuts in this window:',
		...keyLines,
		'</klawly_window_facts>',
	].join('\n');
	return text.length <= KLAWLY_GUIDE_CONTEXT_LIMIT ? text : `${text.slice(0, KLAWLY_GUIDE_CONTEXT_LIMIT)}\n</klawly_window_facts>`;
}
