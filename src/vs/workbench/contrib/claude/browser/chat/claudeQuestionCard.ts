/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getActiveElement, hide, isHTMLInputElement, isHTMLTextAreaElement, show } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ClaudeElicitationAnswer } from '../../../../../platform/claude/common/claudeElicitation.js';
import { ClaudeQuestion, ClaudeQuestionOption } from '../../../../../platform/claude/common/claudeQuestion.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ElicitationEntry } from '../../../../services/claude/common/claudeAgentState.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { ClaudeElicitationResponder } from './claudeElicitationCard.js';
import { appendClaudeKbd, claudeEnterKeyLabel } from './claudeKbd.js';
import '../media/claudeQuestion.css';

/** One question on the card: its option buttons, the Other field and what is chosen. */
interface QuestionView {
	readonly question: ClaudeQuestion;
	readonly element: HTMLElement;
	/** The option buttons, Other last. */
	readonly buttons: readonly HTMLButtonElement[];
	readonly chosen: Set<string>;
	other: boolean;
	readonly otherRow: HTMLElement;
	readonly otherInput: InputBox;
	/** The "Add a Note" link, and the field it opens in its place. */
	readonly noteLink: HTMLButtonElement;
	readonly noteRow: HTMLElement;
	readonly noteInput: InputBox;
	/** The answer as the SDK reads it, or `undefined` while there is none. */
	answer(): string | readonly string[] | undefined;
}

/**
 * Questions from Claude in the timeline (issue 477), in the permission card
 * family: Claude's `AskUserQuestion` asks one to four questions with
 * two to four options each. Options are rows with their description; a
 * multi-select question shows checkboxes; Other opens a text field; an option
 * with a preview shows it beside the list. One single-choice question answers
 * on the pick (DL-51); otherwise Submit sends every answer in one reply.
 * A question can carry a note, and Reply Instead sends text in place of any
 * answer, for when Claude asked the wrong thing; Claude reads both and goes
 * on. Number keys pick in the focused question, arrows move, Enter sends and
 * Escape closes an open reply field, then declines, so the turn never waits
 * on a dismissed card.
 */
export class ClaudeQuestionCards {

	constructor(
		@IContextViewService private readonly _contextView: IContextViewService,
		@INotificationService private readonly _notifications: INotificationService,
	) { }

	/** Draws the entry: a card while it waits, then the answers as records. Returns the focus target of a pending card. */
	render(parent: HTMLElement, entry: ElicitationEntry, store: DisposableStore, respond: ClaudeElicitationResponder): (() => void) | undefined {
		const questions = entry.questions ?? [];
		if (entry.state !== 'pending') {
			this.renderRecord(parent, entry, questions);
			return undefined;
		}
		const card = append(parent, $('.claude-permission.claude-question'));
		card.setAttribute('role', 'alertdialog');
		card.tabIndex = -1;
		const title = questions.length > 1
			? localize('claudeQuestionTitleMany', "Claude Has {0} Questions", questions.length)
			: localize('claudeQuestionTitleOne', "Claude Has a Question");
		card.setAttribute('aria-label', title);
		const head = append(card, $('.claude-permission-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.question)));
		append(head, $('span.claude-permission-title')).textContent = title;

		const prefix = `claude-question-${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		const views = questions.map((question, index) => this.renderQuestion(card, question, `${prefix}-${index}`, store));
		const instant = questions.length === 1 && !questions[0].multiSelect;

		const actions = append(card, $('.claude-permission-actions'));
		const submit = this.button(actions, '.is-primary', localize('claudeQuestionSubmit', "Submit"), 'accept', claudeEnterKeyLabel(), 'Enter');
		const replyButton = this.button(actions, '.is-ghost.claude-question-reply-open', localize('claudeQuestionReplyInstead', "Reply Instead..."));
		const decline = this.button(actions, '.is-ghost', localize('claudeQuestionDecline', "Decline"), 'decline', 'esc', 'Escape');
		const hint = append(actions, $('span.claude-question-hint'));
		hint.textContent = localize('claudeQuestionHint', "Numbers choose, arrows move");

		// Reply Instead swaps the action row for a text field, for when Claude asked the wrong thing (DL-51).
		const replyRow = append(card, $('.claude-question-reply'));
		hide(replyRow);
		const replyInput = store.add(new InputBox(replyRow, this._contextView, {
			ariaLabel: localize('claudeQuestionReplyAria', "Your reply to Claude"),
			placeholder: localize('claudeQuestionReplyPlaceholder', "Tell Claude what you mean or what to do instead"),
			flexibleHeight: true,
			flexibleMaxHeight: 120,
			inputBoxStyles: defaultInputBoxStyles,
		}));
		const replyActions = append(replyRow, $('.claude-permission-actions'));
		const replySend = this.button(replyActions, '.is-primary.claude-question-reply-send', localize('claudeQuestionReplySend', "Send"), undefined, claudeEnterKeyLabel(), 'Enter');
		const replyCancel = this.button(replyActions, '.is-ghost.claude-question-reply-cancel', localize('claudeQuestionReplyCancel', "Cancel"), undefined, 'esc', 'Escape');
		replySend.disabled = true;
		const replying = () => replyRow.style.display !== 'none';
		const openReply = () => {
			hide(actions);
			show(replyRow);
			replyInput.focus();
		};
		const closeReply = () => {
			hide(replyRow);
			show(actions);
			replyButton.focus();
		};
		const sendReply = () => {
			const reply = replyInput.value.trim();
			if (!reply) {
				replyInput.focus();
				return;
			}
			this.answer(card, entry.id, { action: 'accept', reply }, respond);
		};
		store.add(replyInput.onDidChange(() => replySend.disabled = !replyInput.value.trim()));
		store.add(addDisposableListener(replyButton, EventType.CLICK, () => openReply()));
		store.add(addDisposableListener(replySend, EventType.CLICK, () => sendReply()));
		store.add(addDisposableListener(replyCancel, EventType.CLICK, () => closeReply()));

		const complete = () => views.every(view => view.answer() !== undefined);
		const update = () => {
			submit.disabled = !complete();
			for (const view of views) {
				view.element.classList.toggle('is-answered', view.answer() !== undefined);
			}
		};
		const send = () => {
			if (!complete()) {
				views.find(view => view.answer() === undefined)?.buttons[0]?.focus();
				return;
			}
			const content: Record<string, string | readonly string[]> = {};
			const notes: Record<string, string> = {};
			for (const view of views) {
				content[view.question.question] = view.answer()!;
				const note = view.noteInput.value.trim();
				if (note) {
					notes[view.question.question] = note;
				}
			}
			this.answer(card, entry.id, { action: 'accept', content, ...(Object.keys(notes).length ? { notes } : {}) }, respond);
		};
		const decide = () => this.answer(card, entry.id, { action: 'decline' }, respond);

		/** Picks or toggles one option (the last index is Other). */
		const pick = (view: QuestionView, index: number) => {
			const isOther = index === view.question.options.length;
			if (view.question.multiSelect) {
				if (isOther) {
					view.other = !view.other;
				} else {
					const label = view.question.options[index].label;
					if (!view.chosen.delete(label)) {
						view.chosen.add(label);
					}
				}
			} else {
				view.chosen.clear();
				view.other = isOther;
				if (!isOther) {
					view.chosen.add(view.question.options[index].label);
				}
			}
			view.buttons.forEach((button, buttonIndex) => {
				const on = buttonIndex === view.question.options.length ? view.other : view.chosen.has(view.question.options[buttonIndex].label);
				button.classList.toggle('is-chosen', on);
				button.setAttribute('aria-checked', String(on));
			});
			if (view.other) {
				show(view.otherRow);
				if (isOther) {
					view.otherInput.focus();
				}
			} else {
				hide(view.otherRow);
			}
			update();
			if (isOther || view.question.multiSelect) {
				return;
			}
			if (instant) {
				send();
				return;
			}
			// A pick moves on to the next question that still needs one.
			views.find(next => next !== view && next.answer() === undefined)?.buttons[0]?.focus();
		};

		/** A note opens in place of its link; an empty one closes back to it. */
		const openNote = (view: QuestionView) => {
			hide(view.noteLink);
			show(view.noteRow);
			view.noteInput.focus();
		};
		const leaveNote = (view: QuestionView) => {
			if (view.noteInput.value.trim()) {
				view.buttons[0]?.focus();
				return;
			}
			hide(view.noteRow);
			show(view.noteLink);
			view.noteLink.focus();
		};

		for (const view of views) {
			view.buttons.forEach((button, index) => store.add(addDisposableListener(button, EventType.CLICK, () => pick(view, index))));
			store.add(view.otherInput.onDidChange(() => update()));
			store.add(addDisposableListener(view.noteLink, EventType.CLICK, () => openNote(view)));
		}
		store.add(addDisposableListener(submit, EventType.CLICK, () => send()));
		store.add(addDisposableListener(decline, EventType.CLICK, () => decide()));

		/** The question the keys act on: the focused one, else the first without an answer. */
		const active = () => {
			const focused = getActiveElement();
			return views.find(view => focused && view.element.contains(focused)) ?? views.find(view => view.answer() === undefined) ?? views[0];
		};
		store.add(addDisposableListener(card, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const typing = isHTMLInputElement(event.target) || isHTMLTextAreaElement(event.target);
			const inNote = views.find(view => view.noteInput.inputElement === event.target);
			const handled = () => {
				event.preventDefault();
				event.stopPropagation();
			};
			if (event.key === 'Escape') {
				handled();
				// Escape closes what is open before it declines the card.
				if (replying()) {
					closeReply();
				} else if (inNote) {
					leaveNote(inNote);
				} else {
					decide();
				}
				return;
			}
			if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
				handled();
				if (replying()) {
					if (event.target === replyCancel) {
						closeReply();
					} else {
						sendReply();
					}
					return;
				}
				if (event.target === replyButton) {
					openReply();
					return;
				}
				const note = views.find(view => view.noteLink === event.target);
				if (note) {
					openNote(note);
					return;
				}
				const view = active();
				const index = view ? view.buttons.indexOf(event.target as HTMLButtonElement) : -1;
				// Enter on a single-choice option picks it; anywhere else it sends.
				if (view && index >= 0 && !view.question.multiSelect && !(event.ctrlKey || event.metaKey)) {
					pick(view, index);
					if (!instant && index < view.question.options.length && complete()) {
						send();
					}
				} else if (event.target === decline) {
					decide();
				} else {
					send();
				}
				return;
			}
			if (typing || replying() || event.ctrlKey || event.metaKey || event.altKey) {
				return;
			}
			const view = active();
			if (!view) {
				return;
			}
			if (/^[1-9]$/.test(event.key)) {
				const index = Number(event.key) - 1;
				if (index < view.buttons.length) {
					handled();
					view.buttons[index].focus();
					pick(view, index);
				}
				return;
			}
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				handled();
				const current = view.buttons.indexOf(event.target as HTMLButtonElement);
				const step = event.key === 'ArrowDown' ? 1 : -1;
				const next = current < 0 ? (step > 0 ? 0 : view.buttons.length - 1) : (current + step + view.buttons.length) % view.buttons.length;
				view.buttons[next].focus();
			}
		}));

		update();
		return () => (views[0]?.buttons[0] ?? card).focus();
	}

	/** One question: its chip and text, the option rows and the preview beside them. */
	private renderQuestion(card: HTMLElement, question: ClaudeQuestion, id: string, store: DisposableStore): QuestionView {
		const element = append(card, $('.claude-question-item'));
		element.setAttribute('role', 'group');
		const ask = append(element, $('.claude-question-ask'));
		ask.id = `${id}-text`;
		element.setAttribute('aria-labelledby', ask.id);
		if (question.header) {
			append(ask, $('span.claude-question-header')).textContent = question.header;
		}
		append(ask, $('span.claude-question-text')).textContent = question.question;
		if (question.multiSelect) {
			append(ask, $('span.claude-question-multi')).textContent = localize('claudeQuestionMulti', "Choose one or more.");
		}

		const previews = question.options.some(option => option.preview);
		const body = append(element, $('.claude-question-body'));
		body.classList.toggle('has-preview', previews);
		const list = append(body, $('.claude-question-options'));
		list.setAttribute('role', question.multiSelect ? 'group' : 'radiogroup');
		list.setAttribute('aria-labelledby', ask.id);
		const role = question.multiSelect ? 'checkbox' : 'radio';
		const buttons: HTMLButtonElement[] = question.options.map((option, index) => this.option(list, role, index, option.label, option.description));
		buttons.push(this.option(list, role, question.options.length, localize('claudeQuestionOther', "Other"), localize('claudeQuestionOtherDescription', "Type your own answer.")));
		buttons[buttons.length - 1].classList.add('is-other');

		const otherRow = append(list, $('.claude-question-other'));
		hide(otherRow);
		const otherInput = store.add(new InputBox(otherRow, this._contextView, {
			ariaLabel: localize('claudeQuestionOtherAria', "Your answer to: {0}", question.question),
			placeholder: localize('claudeQuestionOtherPlaceholder', "Type your answer"),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		if (previews) {
			this.renderPreview(body, question.options, buttons, store);
		}

		// A note is a link until it is wanted, so the card stays one click for the common case (DL-51).
		const noteLink = append(element, $<HTMLButtonElement>('button.claude-question-note-link'));
		noteLink.type = 'button';
		append(noteLink, $(ThemeIcon.asCSSSelector(Codicon.note)));
		append(noteLink, $('span')).textContent = localize('claudeQuestionAddNote', "Add a Note");
		const noteRow = append(element, $('.claude-question-note'));
		hide(noteRow);
		const noteInput = store.add(new InputBox(noteRow, this._contextView, {
			ariaLabel: localize('claudeQuestionNoteAria', "Note for Claude on: {0}", question.question),
			placeholder: localize('claudeQuestionNotePlaceholder', "Add a note for Claude, sent with your answer"),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		const view: QuestionView = {
			question,
			element,
			buttons,
			chosen: new Set<string>(),
			other: false,
			otherRow,
			otherInput,
			noteLink,
			noteRow,
			noteInput,
			answer: () => {
				const typed = view.other ? otherInput.value.trim() : '';
				if (question.multiSelect) {
					const labels = question.options.map(option => option.label).filter(label => view.chosen.has(label));
					const all = typed ? [...labels, typed] : labels;
					return all.length > 0 && !(view.other && !typed) ? all : undefined;
				}
				return view.other ? (typed || undefined) : [...view.chosen][0];
			},
		};
		return view;
	}

	/** The preview pane: it shows the focused or hovered option, else the chosen one, else the first with a preview. */
	private renderPreview(body: HTMLElement, options: readonly ClaudeQuestionOption[], buttons: readonly HTMLButtonElement[], store: DisposableStore): void {
		const pane = append(body, $('.claude-question-preview'));
		const label = append(pane, $('.claude-question-preview-label'));
		const code = append(pane, $('pre'));
		pane.setAttribute('aria-live', 'polite');
		const showOption = (index: number) => {
			const option = options[index] ?? options.find(candidate => candidate.preview);
			label.textContent = option?.label ?? '';
			code.textContent = option?.preview ?? localize('claudeQuestionNoPreview', "No preview for this option.");
			code.classList.toggle('is-empty', !option?.preview);
		};
		const resting = () => {
			const chosen = buttons.findIndex((button, index) => index < options.length && button.classList.contains('is-chosen'));
			showOption(chosen >= 0 ? chosen : options.findIndex(option => option.preview));
		};
		buttons.forEach((button, index) => {
			if (index >= options.length) {
				return;
			}
			store.add(addDisposableListener(button, EventType.FOCUS, () => showOption(index)));
			store.add(addDisposableListener(button, EventType.MOUSE_ENTER, () => showOption(index)));
			store.add(addDisposableListener(button, EventType.MOUSE_LEAVE, () => resting()));
			store.add(addDisposableListener(button, EventType.CLICK, () => showOption(index)));
		});
		resting();
	}

	/** One option row: its number key, label and description. */
	private option(list: HTMLElement, role: 'radio' | 'checkbox', index: number, label: string, description: string): HTMLButtonElement {
		const element = append(list, $<HTMLButtonElement>('button.claude-question-option'));
		element.type = 'button';
		element.setAttribute('role', role);
		element.setAttribute('aria-checked', 'false');
		element.dataset.index = String(index);
		append(element, $(ThemeIcon.asCSSSelector(role === 'checkbox' ? Codicon.check : Codicon.circleFilled) + '.claude-question-mark'));
		const text = append(element, $('span.claude-question-option-text'));
		append(text, $('span.claude-question-label')).textContent = label;
		if (description) {
			append(text, $('span.claude-question-description')).textContent = description;
		}
		if (index < 9) {
			appendClaudeKbd(element, String(index + 1)).setAttribute('aria-hidden', 'true');
			element.setAttribute('aria-keyshortcuts', String(index + 1));
		}
		return element;
	}

	private button(actions: HTMLElement, className: string, label: string, choice?: ClaudeElicitationAnswer['action'], key?: string, ariaKey?: string): HTMLButtonElement {
		const element = append(actions, $<HTMLButtonElement>('button.claude-btn' + className));
		element.type = 'button';
		if (choice) {
			element.dataset.choice = choice;
		}
		append(element, $('span.label')).textContent = label;
		if (key && ariaKey) {
			const hint = append(element, $('span.claude-kbd'));
			hint.setAttribute('aria-hidden', 'true');
			append(hint, $('kbd')).textContent = key;
			element.setAttribute('aria-keyshortcuts', ariaKey);
		}
		return element;
	}

	/** The answered card: one line per question with the choice, or one line saying how it ended. */
	private renderRecord(parent: HTMLElement, entry: ElicitationEntry, questions: readonly ClaudeQuestion[]): void {
		const records = append(parent, $('.claude-question-record'));
		if (entry.state === 'accepted' && entry.reply) {
			const record = append(records, $('.claude-permission-record.is-reply'));
			append(record, $(ThemeIcon.asCSSSelector(Codicon.reply) + '.is-allowed'));
			const subject = append(record, $('span.subject'));
			subject.textContent = localize('claudeQuestionReplied', "Replied: {0}", entry.reply);
			subject.title = entry.reply;
			return;
		}
		if (entry.state === 'accepted' && entry.answers) {
			for (const question of questions) {
				const record = append(records, $('.claude-permission-record'));
				append(record, $(ThemeIcon.asCSSSelector(Codicon.pass) + '.is-allowed'));
				const subject = append(record, $('span.subject'));
				subject.textContent = question.header || question.question;
				subject.title = question.question;
				const chosen = append(record, $('span.claude-question-chosen'));
				chosen.textContent = entry.answers[question.question] ?? '';
				const note = entry.notes?.[question.question];
				if (note) {
					const noted = append(chosen, $('span.claude-question-noted'));
					noted.textContent = localize('claudeQuestionNoted', "Note: {0}", note);
					chosen.title = note;
				}
			}
			return;
		}
		const record = append(records, $('.claude-permission-record'));
		append(record, $(ThemeIcon.asCSSSelector(entry.state === 'accepted' ? Codicon.pass : Codicon.circleSlash) + (entry.state === 'accepted' ? '.is-allowed' : '.is-denied')));
		append(record, $('span.subject')).textContent = questions.length > 1
			? localize('claudeQuestionRecordMany', "{0} questions from Claude", questions.length)
			: questions[0]?.question ?? entry.message;
		append(record, $('span.outcome')).textContent = entry.state === 'accepted'
			? localize('claudeQuestionOutcomeAnswered', "answered")
			: entry.state === 'declined'
				? localize('claudeQuestionOutcomeDeclined', "declined")
				: entry.source === 'timeout'
					? localize('claudeQuestionOutcomeTimeout', "timed out")
					: localize('claudeQuestionOutcomeCancelled', "cancelled");
	}

	private answer(card: HTMLElement, id: string, answer: ClaudeElicitationAnswer, respond: ClaudeElicitationResponder): void {
		// eslint-disable-next-line no-restricted-syntax
		const buttons = [...card.querySelectorAll('button')].filter(element => !element.disabled);
		if (buttons.length === 0) {
			return;
		}
		buttons.forEach(element => element.disabled = true);
		respond(id, answer).catch(error => {
			buttons.forEach(element => element.disabled = false);
			this._notifications.error(redactSecrets(error instanceof Error ? error.message : String(error)));
		});
	}
}
