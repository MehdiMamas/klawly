/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { BackgroundAgentCard, BackgroundCardAction, BackgroundCardButton } from '../../../services/claude/common/claudeBackgroundCards.js';

const ICONS = {
	loading: Codicon.loading,
	pass: Codicon.pass,
	error: Codicon.error,
	'git-merge': Codicon.gitMerge,
	shield: Codicon.shield,
	'repo-forked': Codicon.repoForked,
	files: Codicon.files,
	beaker: Codicon.beaker,
} as const;

/** Native status card. The specimen's class names are rebuilt with DOM helpers. */
export function renderBackgroundAgentCard(parent: HTMLElement, card: BackgroundAgentCard, store: DisposableStore, run: (action: BackgroundCardAction) => void): HTMLElement {
	const root = append(parent, $('.claude-bg-agent'));
	root.setAttribute('role', 'article');
	root.setAttribute('aria-label', card.title);
	const top = append(root, $('.top'));
	const icon = card.spin ? ThemeIcon.modify(ICONS[card.icon], 'spin') : ICONS[card.icon];
	append(top, $(`span${ThemeIcon.asCSSSelector(icon)}`));
	const title = append(top, $('span.title'));
	title.textContent = card.title;
	const badge = append(top, $(`span.claude-badge.is-${card.badgeKind}`));
	if (card.icon === 'shield') {
		append(badge, $(`span${ThemeIcon.asCSSSelector(Codicon.shield)}`));
	}
	append(badge, $('span')).textContent = card.badge;
	const facts = append(root, $('.facts'));
	for (const fact of card.facts) {
		const item = append(facts, $('span'));
		const factIcon = ICONS[fact.icon as keyof typeof ICONS];
		if (factIcon) {
			append(item, $(`span${ThemeIcon.asCSSSelector(factIcon)}`));
		}
		append(item, $('span')).textContent = fact.text;
		if ((fact.added ?? 0) > 0 || (fact.removed ?? 0) > 0) {
			const stat = append(item, $('span.claude-diffstat'));
			const added = append(stat, $('span.add'));
			added.textContent = `+${fact.added ?? 0}`;
			const removed = append(stat, $('span.del'));
			removed.textContent = `-${fact.removed ?? 0}`;
		}
	}
	const actions = append(root, $('.actions'));
	for (const button of card.actions) {
		appendAction(actions, button, store, run);
	}
	return root;
}

function appendAction(parent: HTMLElement, button: BackgroundCardButton, store: DisposableStore, run: (action: BackgroundCardAction) => void): void {
	const classes = ['claude-btn', 'is-small'];
	if (button.primary) {
		classes.push('is-primary');
	} else {
		classes.push('is-ghost');
	}
	if (button.danger) {
		classes.push('is-danger');
	}
	const element = append(parent, $<HTMLButtonElement>(`button.${classes.join('.')}`));
	element.type = 'button';
	if (button.action === 'stop') {
		append(element, $(`span${ThemeIcon.asCSSSelector(Codicon.debugStop)}`));
	}
	append(element, $('span')).textContent = button.label;
	store.add(addDisposableListener(element, EventType.CLICK, event => {
		event.preventDefault();
		run(button.action);
	}));
}
