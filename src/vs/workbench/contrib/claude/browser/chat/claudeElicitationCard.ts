/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { hasKey } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import { ClaudeElicitationAnswer, ClaudeElicitationContent, ClaudeElicitationField, ClaudeElicitationProblem, ClaudeElicitationValue, claudeElicitationForm, claudeElicitationHostDiffers, parseClaudeElicitationJson, validateClaudeElicitationField, validateClaudeElicitationForm } from '../../../../../platform/claude/common/claudeElicitation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ElicitationEntry } from '../../../../services/claude/common/claudeAgentState.js';
import { redactSecrets } from '../../../../services/claude/common/claudeAgentLog.js';
import { screenClaudeElicitationSecrets } from '../../common/claudeSecretGuard.js';
import '../media/claudeElicitation.css';

/** Sends the user's answer to a pending MCP form or sign-in. Rejects when the request has ended. */
export type ClaudeElicitationResponder = (id: string, answer: ClaudeElicitationAnswer) => Promise<void>;

/** One field on the card: reads its widget and shows its problem. */
interface FieldView {
	readonly field: ClaudeElicitationField;
	read(): ClaudeElicitationValue | undefined;
	focus(): void;
	showProblem(problem: ClaudeElicitationProblem | undefined): void;
}

/**
 * MCP form and sign-in cards in the timeline (issue 428), in the permission
 * card family: same border, head and action row. A form draws one widget per
 * field of the server's schema, or one JSON field when the schema is a shape MCP
 * does not allow. A sign-in names the server and the full host the link opens,
 * and warns when that host is not the server's own. Submit is the only primary
 * button (DL-09); fields are 26px and buttons 24px (DL-06); hairlines, no shadow
 * (DL-07). Escape declines; Ctrl+Enter submits a form.
 */
export class ClaudeElicitationCards {

	constructor(
		@IOpenerService private readonly _opener: IOpenerService,
		@IDialogService private readonly _dialogs: IDialogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IContextViewService private readonly _contextView: IContextViewService,
		@IHoverService private readonly _hover: IHoverService,
		@INotificationService private readonly _notifications: INotificationService,
	) { }

	/** Draws the entry: a card while it waits, then one record line. Returns the focus target of a pending card. */
	render(parent: HTMLElement, entry: ElicitationEntry, store: DisposableStore, respond: ClaudeElicitationResponder): (() => void) | undefined {
		if (entry.state !== 'pending') {
			this.renderRecord(parent, entry);
			return undefined;
		}
		const card = append(parent, $('.claude-permission.claude-elicitation'));
		card.setAttribute('role', 'alertdialog');
		card.tabIndex = -1;
		const messageId = `claude-elicitation-${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		card.setAttribute('aria-describedby', messageId);

		const head = append(card, $('.claude-permission-head'));
		append(head, $(ThemeIcon.asCSSSelector(Codicon.plug)));
		const title = entry.title ?? (entry.mode === 'url'
			? localize('claudeElicitationUrlTitle', "Continue in Your Browser")
			: localize('claudeElicitationFormTitle', "Input Requested"));
		append(head, $('span.claude-permission-title')).textContent = title;
		const server = append(head, $('span.claude-elicitation-server'));
		server.textContent = entry.server;
		server.setAttribute('aria-label', localize('claudeElicitationServerLabel', "MCP server: {0}", entry.server));
		card.setAttribute('aria-label', localize('claudeElicitationCardLabel', "{0} asks: {1}", entry.server, title));

		const message = append(card, $('.claude-elicitation-message'));
		message.id = messageId;
		message.textContent = entry.message;

		return entry.mode === 'url' ? this.renderUrl(card, entry, store, respond) : this.renderForm(card, entry, store, respond);
	}

	/** A settled request as one line, like a decided permission. */
	renderRecord(parent: HTMLElement, entry: ElicitationEntry): void {
		const record = append(parent, $('.claude-permission-record.claude-elicitation-record'));
		const done = entry.state === 'accepted';
		append(record, $(ThemeIcon.asCSSSelector(done ? (entry.mode === 'url' && !entry.completed ? Codicon.linkExternal : Codicon.pass) : Codicon.circleSlash) + (done ? '.is-allowed' : '.is-denied')));
		if (entry.mode === 'url' && entry.completed) {
			append(record, $('span.subject')).textContent = localize('claudeElicitationSignedIn', "Signed in to {0}", entry.server);
			return;
		}
		append(record, $('span.subject')).textContent = entry.title ?? entry.message;
		append(record, $('span.outcome')).textContent = describeElicitationOutcome(entry);
	}

	private renderForm(card: HTMLElement, entry: ElicitationEntry, store: DisposableStore, respond: ClaudeElicitationResponder): () => void {
		const form = entry.schema ? claudeElicitationForm(entry.schema) : { kind: 'fields' as const, fields: [] };
		const body = append(card, $('.claude-elicitation-fields'));
		let collect: () => ClaudeElicitationContent | undefined;
		let focusFirst: () => void;
		if (form.kind === 'fields') {
			const views = form.fields.map(field => this.renderField(body, entry, field, store));
			let tried = false;
			const check = () => {
				const values: Record<string, ClaudeElicitationValue | undefined> = {};
				for (const view of views) {
					values[view.field.key] = view.read();
				}
				const result = validateClaudeElicitationForm(form.fields, values);
				const problems: Readonly<Record<string, ClaudeElicitationProblem>> = hasKey(result, { problems: true }) ? result.problems : {};
				for (const view of views) {
					view.showProblem(problems[view.field.key]);
				}
				return result;
			};
			// Problems show after the first Submit, then follow each change.
			const recheck = () => {
				if (tried) {
					for (const view of views) {
						view.showProblem(validateClaudeElicitationField(view.field, view.read()));
					}
				}
			};
			for (const type of [EventType.INPUT, EventType.CHANGE, EventType.CLICK, EventType.KEY_UP]) {
				store.add(addDisposableListener(body, type, recheck));
			}
			collect = () => {
				tried = true;
				const result = check();
				if (hasKey(result, { problems: true })) {
					views.find(view => result.problems[view.field.key])?.focus();
					return undefined;
				}
				return result.content;
			};
			focusFirst = () => views.length > 0 ? views[0].focus() : submit.focus();
		} else {
			const field = append(body, $('.claude-elicitation-field'));
			const label = append(field, $('label.claude-elicitation-label'));
			label.textContent = localize('claudeElicitationJsonLabel', "Answer as JSON");
			const input = store.add(new InputBox(append(field, $('.claude-elicitation-json')), this._contextView, {
				ariaLabel: localize('claudeElicitationJsonAria', "Answer to {0} as JSON", entry.server),
				flexibleHeight: true,
				flexibleMaxHeight: 160,
				inputBoxStyles: defaultInputBoxStyles,
			}));
			input.value = '{}';
			append(field, $('.claude-elicitation-hint')).textContent = localize('claudeElicitationJsonHint', "This form cannot be shown as fields. Enter a JSON object of text, numbers, true or false, or lists of text.");
			const problem = append(field, $('.claude-elicitation-problem'));
			problem.setAttribute('aria-live', 'polite');
			collect = () => {
				const parsed = parseClaudeElicitationJson(input.value);
				const invalid = hasKey(parsed, { problem: true });
				field.classList.toggle('is-invalid', invalid);
				input.inputElement.setAttribute('aria-invalid', String(invalid));
				problem.textContent = '';
				if (hasKey(parsed, { problem: true })) {
					append(problem, $(ThemeIcon.asCSSSelector(Codicon.error)));
					append(problem, $('span')).textContent = parsed.problem === 'syntax'
						? localize('claudeElicitationJsonSyntax', "This is not valid JSON.")
						: localize('claudeElicitationJsonShape', "Enter a JSON object of text, numbers, true or false, or lists of text.");
					input.focus();
					return undefined;
				}
				return parsed.content;
			};
			focusFirst = () => input.focus();
		}

		const actions = append(card, $('.claude-permission-actions'));
		const submit = this.button(actions, '.is-primary', localize('claudeElicitationSubmit', "Submit"), 'accept');
		const decline = this.button(actions, '.is-ghost', localize('claudeElicitationDecline', "Decline"), 'decline');
		const note = append(card, $('.claude-permission-footer.claude-elicitation-note'));
		append(note, $(ThemeIcon.asCSSSelector(Codicon.lock)));
		append(note, $('span')).textContent = localize('claudeElicitationNote', "Your answer goes to {0}. It is checked for secrets before it is sent.", entry.server);

		const send = async () => {
			const content = collect();
			if (!content) {
				return;
			}
			const screened = await screenClaudeElicitationSecrets(content, entry.server, this._dialogs, this._configuration);
			if (screened) {
				this.answer(card, entry.id, { action: 'accept', content: screened }, respond);
			}
		};
		store.add(addDisposableListener(submit, EventType.CLICK, () => send()));
		store.add(addDisposableListener(decline, EventType.CLICK, () => this.answer(card, entry.id, { action: 'decline' }, respond)));
		store.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.answer(card, entry.id, { action: 'decline' }, respond);
			} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				event.stopPropagation();
				send();
			}
		}));
		return focusFirst;
	}

	private renderField(parent: HTMLElement, entry: ElicitationEntry, field: ClaudeElicitationField, store: DisposableStore): FieldView {
		const row = append(parent, $('.claude-elicitation-field'));
		const fieldId = `claude-elicitation-${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${field.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		const label = append(row, $(field.kind === 'boolean' ? 'span.claude-elicitation-label' : 'label.claude-elicitation-label'));
		label.id = `${fieldId}-label`;
		append(label, $('span')).textContent = field.title;
		if (field.required) {
			const marker = append(label, $('span.claude-elicitation-required'));
			marker.textContent = '*';
			marker.setAttribute('aria-hidden', 'true');
			store.add(this._hover.setupDelayedHover(marker, { content: localize('claudeElicitationRequired', "Required") }));
		}
		const ariaLabel = field.required ? localize('claudeElicitationRequiredAria', "{0} (required)", field.title) : field.title;

		let read: () => ClaudeElicitationValue | undefined;
		let focus: () => void;
		let invalidTarget: HTMLElement;
		switch (field.kind) {
			case 'text':
			case 'number': {
				const input = store.add(new InputBox(append(row, $('.claude-elicitation-input')), this._contextView, { ariaLabel, inputBoxStyles: defaultInputBoxStyles }));
				input.inputElement.id = fieldId;
				label.setAttribute('for', fieldId);
				if (field.defaultValue !== undefined) {
					input.value = String(field.defaultValue);
				}
				read = () => field.kind === 'number' ? parseNumber(input.value) : (input.value === '' ? undefined : input.value);
				focus = () => input.focus();
				invalidTarget = input.inputElement;
				break;
			}
			case 'boolean': {
				// The checkbox carries its own label, so the row reads as one control.
				label.remove();
				row.classList.add('is-check');
				const box = store.add(new Checkbox(ariaLabel, field.defaultValue ?? false, defaultCheckboxStyles));
				row.appendChild(box.domNode);
				const text = append(row, $('span.claude-elicitation-check-label'));
				text.textContent = field.title;
				store.add(addDisposableListener(text, EventType.CLICK, () => { box.checked = !box.checked; }));
				read = () => box.checked;
				focus = () => box.focus();
				invalidTarget = box.domNode;
				break;
			}
			case 'enum': {
				// The first row means no answer, so a required field without a default asks to be chosen.
				const options = [{ text: localize('claudeElicitationChoose', "Choose an Option") }, ...field.options.map(option => ({ text: option.label }))];
				const initial = field.defaultValue === undefined ? 0 : field.options.findIndex(option => option.value === field.defaultValue) + 1;
				const select = store.add(new SelectBox(options, initial, this._contextView, defaultSelectBoxStyles, { ariaLabel }));
				const host = append(row, $('.claude-elicitation-select'));
				select.render(host);
				let index = initial;
				store.add(select.onDidSelect(selected => { index = selected.index; }));
				read = () => index > 0 ? field.options[index - 1].value : undefined;
				focus = () => select.focus();
				invalidTarget = host;
				break;
			}
			case 'multiEnum': {
				const group = append(row, $('.claude-elicitation-options'));
				group.setAttribute('role', 'group');
				group.setAttribute('aria-labelledby', label.id);
				const boxes = field.options.map(option => {
					const item = append(group, $('.claude-elicitation-option'));
					const box = store.add(new Checkbox(option.label, field.defaultValue?.includes(option.value) ?? false, defaultCheckboxStyles));
					item.appendChild(box.domNode);
					const text = append(item, $('span'));
					text.textContent = option.label;
					store.add(addDisposableListener(text, EventType.CLICK, () => { box.checked = !box.checked; }));
					return { option, box };
				});
				read = () => {
					const chosen = boxes.filter(candidate => candidate.box.checked).map(candidate => candidate.option.value);
					return chosen.length > 0 ? chosen : undefined;
				};
				focus = () => boxes[0]?.box.focus();
				invalidTarget = group;
				break;
			}
		}
		if (field.description) {
			append(row, $('.claude-elicitation-hint')).textContent = field.description;
		}
		const problem = append(row, $('.claude-elicitation-problem'));
		problem.setAttribute('aria-live', 'polite');
		return {
			field,
			read,
			focus,
			showProblem: found => {
				row.classList.toggle('is-invalid', !!found);
				invalidTarget.setAttribute('aria-invalid', String(!!found));
				problem.textContent = '';
				if (found) {
					append(problem, $(ThemeIcon.asCSSSelector(Codicon.error)));
					append(problem, $('span')).textContent = describeElicitationProblem(found);
				}
			},
		};
	}

	private renderUrl(card: HTMLElement, entry: ElicitationEntry, store: DisposableStore, respond: ClaudeElicitationResponder): () => void {
		const meta = append(card, $<HTMLDListElement>('dl.claude-permission-meta'));
		const row = (label: string, value: string, className = '') => {
			append(meta, $('dt')).textContent = label;
			const cell = append(meta, $('dd' + className));
			cell.textContent = value;
			return cell;
		};
		if (entry.url && entry.urlHost) {
			// The whole host, never a shortened one: it is what the user decides on.
			const host = row(localize('claudeElicitationOpens', "Opens"), entry.urlHost, '.claude-elicitation-host');
			store.add(this._hover.setupDelayedHover(host, { content: entry.url }));
		}
		if (entry.serverHost) {
			row(localize('claudeElicitationServer', "Server"), entry.serverHost);
		}
		if (!meta.firstChild) {
			meta.remove();
		}
		if (!entry.url) {
			const warning = append(card, $('.claude-elicitation-warning'));
			append(warning, $(ThemeIcon.asCSSSelector(Codicon.warning)));
			append(warning, $('span')).textContent = localize('claudeElicitationNotWeb', "The link is not a web address, so Klawly will not open it.");
		} else if (claudeElicitationHostDiffers(entry.urlHost, entry.serverHost)) {
			const warning = append(card, $('.claude-elicitation-warning'));
			warning.setAttribute('role', 'note');
			append(warning, $(ThemeIcon.asCSSSelector(Codicon.warning)));
			append(warning, $('span')).textContent = localize('claudeElicitationHostDiffers', "This link is not on the server's host. Open it only if you expect {0} to sign you in there.", entry.server);
		}

		const actions = append(card, $('.claude-permission-actions'));
		const url = entry.url;
		const open = url ? this.button(actions, '.is-primary', localize('claudeElicitationOpen', "Open in Browser"), 'accept') : undefined;
		if (open && url) {
			append(open, $(ThemeIcon.asCSSSelector(Codicon.linkExternal)));
			store.add(addDisposableListener(open, EventType.CLICK, async () => {
				// The link opens outside Klawly; the server says when the sign-in finished.
				// The string keeps the link exactly as the server sent it; a parsed URI would re-encode its query.
				const opened = await this._opener.open(url, { openExternal: true, fromUserGesture: true });
				if (opened) {
					this.answer(card, entry.id, { action: 'accept' }, respond);
				}
			}));
		}
		const decline = this.button(actions, '.is-ghost', localize('claudeElicitationDecline', "Decline"), 'decline');
		store.add(addDisposableListener(decline, EventType.CLICK, () => this.answer(card, entry.id, { action: 'decline' }, respond)));
		store.add(addDisposableListener(card, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.answer(card, entry.id, { action: 'decline' }, respond);
			}
		}));
		return () => (open ?? decline).focus();
	}

	private button(actions: HTMLElement, className: string, label: string, choice: ClaudeElicitationAnswer['action']): HTMLButtonElement {
		const element = append(actions, $<HTMLButtonElement>('button.claude-btn' + className));
		element.type = 'button';
		element.dataset.choice = choice;
		append(element, $('span.label')).textContent = label;
		return element;
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

function parseNumber(text: string): ClaudeElicitationValue | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	const value = Number(trimmed);
	// Text that is not a number goes through as text, so validation names it.
	return Number.isFinite(value) ? value : trimmed;
}

/** The inline message under a field, worded from the common model's problem code. */
function describeElicitationProblem(problem: ClaudeElicitationProblem): string {
	switch (problem.code) {
		case 'required': return localize('claudeElicitationProblemRequired', "This field is required.");
		case 'type': return localize('claudeElicitationProblemType', "Enter a valid value.");
		case 'integer': return localize('claudeElicitationProblemInteger', "Enter a whole number.");
		case 'format': return describeElicitationFormat(problem.format);
		case 'minLength': return localize('claudeElicitationProblemMinLength', "Enter at least {0} characters.", problem.limit);
		case 'maxLength': return localize('claudeElicitationProblemMaxLength', "Enter at most {0} characters.", problem.limit);
		case 'minimum': return localize('claudeElicitationProblemMinimum', "Enter {0} or more.", problem.limit);
		case 'maximum': return localize('claudeElicitationProblemMaximum', "Enter {0} or less.", problem.limit);
		case 'minItems': return localize('claudeElicitationProblemMinItems', "Choose at least {0}.", problem.limit);
		case 'maxItems': return localize('claudeElicitationProblemMaxItems', "Choose at most {0}.", problem.limit);
		case 'option': return localize('claudeElicitationProblemOption', "Choose one of the options.");
	}
}

function describeElicitationFormat(format: 'email' | 'uri' | 'date' | 'date-time'): string {
	switch (format) {
		case 'email': return localize('claudeElicitationProblemEmail', "Enter an email address.");
		case 'uri': return localize('claudeElicitationProblemUri', "Enter a web address.");
		case 'date': return localize('claudeElicitationProblemDate', "Enter a date as YYYY-MM-DD.");
		case 'date-time': return localize('claudeElicitationProblemDateTime', "Enter a date and time as YYYY-MM-DDTHH:MM.");
	}
}

/** The outcome at the end of a record line. */
function describeElicitationOutcome(entry: ElicitationEntry): string {
	switch (entry.state) {
		case 'accepted':
			return entry.mode === 'url'
				? localize('claudeElicitationOutcomeOpened', "opened · {0}", entry.server)
				: localize('claudeElicitationOutcomeSubmitted', "submitted to {0}", entry.server);
		case 'declined':
			return localize('claudeElicitationOutcomeDeclined', "declined · {0}", entry.server);
		default:
			return entry.source === 'timeout'
				? localize('claudeElicitationOutcomeTimeout', "timed out · {0}", entry.server)
				: localize('claudeElicitationOutcomeCancelled', "cancelled · {0}", entry.server);
	}
}
