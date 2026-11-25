/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../base/common/hash.js';
import { localize } from '../../../nls.js';
import { ClaudeReviewRule, parseClaudeReviewConfig, removeClaudeReviewRule } from './claudeReviewConfig.js';
import { ClaudeReviewCategory, ClaudeReviewFinding } from './claudeReviewLoop.js';

/**
 * Learning from dismissed findings (issue 923). Every dismissal, Mark as
 * Intended and thumbs down is a signal counted per repository, category and
 * normalized title. When one kind of finding collects enough signals the
 * review offers a rule that stops flagging it. All of this is pure: the caller
 * stores the counters and writes the rule, after the person agrees.
 */

/** Why a finding was dismissed. */
export type ClaudeDismissReason = 'not-a-problem' | 'wont-fix-here' | 'too-nitpicky' | 'already-handled';

/** What a signal was: a dismiss reason, Mark as Intended, or a thumbs down. */
export type ClaudeReviewSignalKind = ClaudeDismissReason | 'intended' | 'thumbs-down';

export const CLAUDE_DISMISS_REASONS: readonly ClaudeDismissReason[] = ['not-a-problem', 'wont-fix-here', 'too-nitpicky', 'already-handled'];

/** Setting: how many dismissals of one kind of finding before the review offers to stop flagging it. */
export const CLAUDE_REVIEW_LEARN_AFTER_SETTING = 'claude.review.learnAfter';
export const CLAUDE_REVIEW_LEARN_AFTER_DEFAULT = 3;

/** Prefix of the ids of rules written by learning, so the settings list can find them. */
export const CLAUDE_LEARNED_RULE_PREFIX = 'learned-';

/** One counter: how often one kind of finding was dismissed in one repository. */
export interface ClaudeReviewSignalCounter {
	readonly repo: string;
	readonly category: ClaudeReviewCategory;
	/** Title lower-cased, without punctuation or quoted names, so reworded repeats still match. */
	readonly title: string;
	readonly count: number;
	/** The title as the reviewer last wrote it, for the offer and the rule. */
	readonly sample: string;
}

/** Problems that are never suppressed, however often they are dismissed. */
const NEVER_SUPPRESSED = /\b(?:security|secur|vulnerab|inject|xss|csrf|secret|credential|password|token|memory|leak|use[- ]after[- ]free|buffer|overflow|null|nullish|undefined|infinite|endless|unbounded|deadlock)\b/i;

/** Normalizes a finding title: lower case, quoted code and numbers dropped, single spaces. */
export function normalizeClaudeFindingTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, ' ')
		.replace(/\d+/g, ' ')
		.replace(/[^a-z\s-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** True for findings that must never be learned away: security, memory, null and infinite-loop problems. */
export function isNeverSuppressedClaudeFinding(finding: Pick<ClaudeReviewFinding, 'category' | 'title' | 'body'>): boolean {
	return finding.category === 'security' || NEVER_SUPPRESSED.test(finding.title) || NEVER_SUPPRESSED.test(finding.body);
}

function sameKind(counter: ClaudeReviewSignalCounter, repo: string, category: ClaudeReviewCategory, title: string): boolean {
	return counter.repo === repo && counter.category === category && counter.title === title;
}

/** Counts one signal; findings that are never suppressed are not counted at all. Returns new counters. */
export function recordClaudeReviewSignal(counters: readonly ClaudeReviewSignalCounter[], repo: string, finding: Pick<ClaudeReviewFinding, 'category' | 'title' | 'body'>): readonly ClaudeReviewSignalCounter[] {
	const title = normalizeClaudeFindingTitle(finding.title);
	if (!repo || !title || isNeverSuppressedClaudeFinding(finding)) {
		return counters;
	}
	const existing = counters.find(counter => sameKind(counter, repo, finding.category, title));
	if (!existing) {
		return [...counters, { repo, category: finding.category, title, count: 1, sample: finding.title.trim() }];
	}
	return counters.map(counter => counter === existing ? { ...counter, count: counter.count + 1, sample: finding.title.trim() } : counter);
}

/** Forgets a counter once its rule is written or the person declines, so the offer does not repeat. */
export function resetClaudeReviewSignal(counters: readonly ClaudeReviewSignalCounter[], repo: string, category: ClaudeReviewCategory, title: string): readonly ClaudeReviewSignalCounter[] {
	return counters.filter(counter => !sameKind(counter, repo, category, title));
}

/** The threshold from the setting; anything not a whole number of 1 or more falls back to the default. */
export function readClaudeLearnAfter(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : CLAUDE_REVIEW_LEARN_AFTER_DEFAULT;
}

/** The counters of one repository that reached the threshold, most dismissed first. */
export function suggestLearnedRules(counters: readonly ClaudeReviewSignalCounter[], repo: string, threshold: number = CLAUDE_REVIEW_LEARN_AFTER_DEFAULT): readonly ClaudeReviewSignalCounter[] {
	return counters
		.filter(counter => counter.repo === repo && counter.count >= threshold && !isNeverSuppressedClaudeFinding({ category: counter.category, title: counter.sample, body: '' }))
		.sort((a, b) => b.count - a.count);
}

/** The plain display name of a finding category (issue 1108). */
export function claudeReviewCategoryLabel(category: ClaudeReviewCategory): string {
	switch (category) {
		case 'security': return localize('claudeReviewCategorySecurity', "Security");
		case 'bug': return localize('claudeReviewCategoryBug', "Bug");
		case 'logic': return localize('claudeReviewCategoryLogic', "Logic");
		case 'performance': return localize('claudeReviewCategoryPerformance', "Performance");
		case 'style': return localize('claudeReviewCategoryStyle', "Style");
		case 'tests': return localize('claudeReviewCategoryTests', "Tests");
	}
}

/** The lower-case noun phrase for one kind of finding, written for the sentence of a learned rule (issue 1158). */
export function claudeReviewCategoryPhrase(category: ClaudeReviewCategory): string {
	switch (category) {
		case 'security': return localize('claudeReviewCategoryPhraseSecurity', "security findings");
		case 'bug': return localize('claudeReviewCategoryPhraseBug', "bug findings");
		case 'logic': return localize('claudeReviewCategoryPhraseLogic', "logic findings");
		case 'performance': return localize('claudeReviewCategoryPhrasePerformance', "performance findings");
		case 'style': return localize('claudeReviewCategoryPhraseStyle', "style findings");
		case 'tests': return localize('claudeReviewCategoryPhraseTests', "test findings");
	}
}

/** The rule that stops flagging one kind of finding, in the review.json rule format (issue 922). */
export function learnedClaudeReviewRule(counter: Pick<ClaudeReviewSignalCounter, 'category' | 'title' | 'sample'>): ClaudeReviewRule {
	const slug = counter.title.replace(/\s+/g, '-').slice(0, 48).replace(/-+$/, '');
	// The hash of the whole title keeps two long titles with the same first 48 characters apart (issue 1086).
	const suffix = (hash(`${counter.category}|${counter.title}`) >>> 0).toString(36);
	return {
		id: `${CLAUDE_LEARNED_RULE_PREFIX}${counter.category}-${slug}-${suffix}`,
		text: localize('claudeLearnedRuleText', "Do not flag {0} like \"{1}\": this project has dismissed them repeatedly.", claudeReviewCategoryPhrase(counter.category), counter.sample),
	};
}

/** True for a rule written by learning. */
export function isLearnedClaudeReviewRule(rule: Pick<ClaudeReviewRule, 'id'>): boolean {
	return rule.id.startsWith(CLAUDE_LEARNED_RULE_PREFIX);
}

/** The one sentence the review asks once a kind of finding reaches the threshold: the count and the question together (issue 1108). */
export function claudeLearnedRuleOffer(counter: Pick<ClaudeReviewSignalCounter, 'category' | 'sample' | 'count'>): string {
	return localize('claudeLearnedRuleOffer', "You dismissed \"{0}\" {1} times. Stop flagging it in this project?", counter.sample, counter.count);
}

/** The rules learning wrote into one review config file's text: the rows of the Learned Rules list (issue 1068). */
export function listLearnedClaudeReviewRules(text: string): readonly ClaudeReviewRule[] {
	return parseClaudeReviewConfig(text).config.rules.filter(isLearnedClaudeReviewRule);
}

/** The file text without one learned rule; any other rule, and a rule that is not learned, stays. */
export function removeLearnedClaudeReviewRule(text: string, id: string): string | undefined {
	return isLearnedClaudeReviewRule({ id }) ? removeClaudeReviewRule(text, id) : text;
}
