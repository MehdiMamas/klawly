/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP elicitation (issue 428): an MCP server asks the user for input through
 * Claude Code, as a form or as a URL to open (a sign-in). These are the
 * normalized shapes the runtime sends to the workbench and the answers it
 * takes back. Nothing here imports the Agent SDK. Claude's own questions
 * (issue 477) use the same channel as `question` requests.
 */

import { ClaudeQuestion, ClaudeQuestionAnswers, ClaudeQuestionNotes } from './claudeQuestion.js';

export type ClaudeElicitationMode = 'form' | 'url' | 'question';

/** What a field value can be. MCP elicitation allows primitives and lists of enum strings. */
export type ClaudeElicitationValue = string | number | boolean | readonly string[];

export type ClaudeElicitationContent = Readonly<Record<string, ClaudeElicitationValue>>;

/** One request, as the `elicitation.requested` event carries it. */
export interface ClaudeElicitationRequest {
	/** Klawly's id for this request. Answers name it. */
	readonly id: string;
	/** The MCP server that asks. The card always shows it. */
	readonly server: string;
	readonly mode: ClaudeElicitationMode;
	readonly message: string;
	/** Header from the server's permission display metadata, when it sent one. */
	readonly title?: string;
	/** The JSON schema of a form, as the server sent it. Read it with {@link claudeElicitationForm}. */
	readonly schema?: Readonly<Record<string, unknown>>;
	/** The URL a `url` request asks the user to open. Absent when it was not an http(s) URL. */
	readonly url?: string;
	/** The host of `url`, shown in full on the card. */
	readonly urlHost?: string;
	/**
	 * The host of the server's configured URL (an http or SSE server). The card
	 * warns when `urlHost` is not it. Absent for a stdio server or when Claude Code did not say.
	 */
	readonly serverHost?: string;
	/** The server's own id for a URL request. `elicitation.completed` names it when the sign-in finishes. */
	readonly elicitationId?: string;
	/** The questions of a `question` request (issue 477). The card draws them; `schema` stays empty. */
	readonly questions?: readonly ClaudeQuestion[];
	/** When the runtime stops waiting and answers `cancel`, in ms since the epoch. */
	readonly expiresAt: number;
}

/**
 * The workbench's answer. `cancel` is also what a stopped session or a timeout
 * sends. Only a question card (issue 477) sends `notes` (a note under a
 * question, by its text) or `reply` (text sent in place of any answer).
 */
export type ClaudeElicitationAnswer =
	| { readonly action: 'accept'; readonly content?: ClaudeElicitationContent; readonly notes?: ClaudeQuestionNotes; readonly reply?: string }
	| { readonly action: 'decline' }
	| { readonly action: 'cancel' };

export type ClaudeElicitationSource = 'user' | 'timeout' | 'session-stopped';

/**
 * How a request ended, as `elicitation.resolved` carries it. It never holds a
 * form's content: a form can hold a secret, and events reach the transcript
 * and the export. Only a `question` request carries its answers, which go to
 * Claude as the tool's result anyway.
 */
export interface ClaudeElicitationOutcome {
	readonly id: string;
	readonly server: string;
	readonly mode: ClaudeElicitationMode;
	readonly action: ClaudeElicitationAnswer['action'];
	readonly source: ClaudeElicitationSource;
	/** The answers of an accepted `question` request, so the collapsed card shows the choices. */
	readonly answers?: ClaudeQuestionAnswers;
	/** The notes the user added to those answers. */
	readonly notes?: ClaudeQuestionNotes;
	/** The text the user sent in place of answers, so the collapsed card shows "Replied: …". */
	readonly reply?: string;
}

/**
 * How long a request waits for the user before the runtime answers `cancel`.
 * It stays under the runtime's ten-minute inactivity timer, so the server gets
 * the cancel before an idle session is stopped.
 */
export const CLAUDE_ELICITATION_TIMEOUT_MS = 8 * 60 * 1000;

interface FieldBase {
	readonly key: string;
	/** The schema's `title`, else the property name. */
	readonly title: string;
	readonly description?: string;
	readonly required: boolean;
}

export interface ClaudeElicitationOption {
	readonly value: string;
	readonly label: string;
}

/** One form field, already mapped to the widget that edits it. */
export type ClaudeElicitationField =
	| FieldBase & { readonly kind: 'text'; readonly format?: 'email' | 'uri' | 'date' | 'date-time'; readonly minLength?: number; readonly maxLength?: number; readonly defaultValue?: string }
	| FieldBase & { readonly kind: 'number'; readonly integer: boolean; readonly minimum?: number; readonly maximum?: number; readonly defaultValue?: number }
	| FieldBase & { readonly kind: 'boolean'; readonly defaultValue?: boolean }
	| FieldBase & { readonly kind: 'enum'; readonly options: readonly ClaudeElicitationOption[]; readonly defaultValue?: string }
	| FieldBase & { readonly kind: 'multiEnum'; readonly options: readonly ClaudeElicitationOption[]; readonly minItems?: number; readonly maxItems?: number; readonly defaultValue?: readonly string[] };

/**
 * A form the card can draw field by field, or `json` when the schema uses a
 * shape MCP elicitation does not allow. The card then shows one JSON text field.
 */
export type ClaudeElicitationForm =
	| { readonly kind: 'fields'; readonly fields: readonly ClaudeElicitationField[] }
	| { readonly kind: 'json' };

const TEXT_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

/**
 * Maps a requested schema to form fields. MCP elicitation allows a flat object
 * of primitive properties: strings (with an optional format), numbers,
 * integers, booleans, single-select enums (`enum` or `oneOf` with `const`) and
 * multi-select enums (an array of enum strings). Anything else is `json`.
 */
export function claudeElicitationForm(schema: unknown): ClaudeElicitationForm {
	if (!isRecord(schema) || (schema.type !== undefined && schema.type !== 'object') || !isRecord(schema.properties)) {
		return { kind: 'json' };
	}
	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
	const fields: ClaudeElicitationField[] = [];
	for (const [key, property] of Object.entries(schema.properties)) {
		const field = isRecord(property) ? toField(key, property, required.has(key)) : undefined;
		if (!field) {
			return { kind: 'json' };
		}
		fields.push(field);
	}
	return { kind: 'fields', fields };
}

function toField(key: string, property: Record<string, unknown>, required: boolean): ClaudeElicitationField | undefined {
	const base: FieldBase = {
		key,
		title: typeof property.title === 'string' && property.title.trim() ? property.title : key,
		description: typeof property.description === 'string' && property.description.trim() ? property.description : undefined,
		required,
	};
	switch (property.type) {
		case 'string': {
			const options = singleOptions(property);
			if (options === null) {
				return undefined;
			}
			if (options) {
				return { ...base, kind: 'enum', options, defaultValue: typeof property.default === 'string' && options.some(option => option.value === property.default) ? property.default : undefined };
			}
			if (property.format !== undefined && !(typeof property.format === 'string' && TEXT_FORMATS.has(property.format))) {
				return undefined;
			}
			return {
				...base,
				kind: 'text',
				format: property.format as 'email' | 'uri' | 'date' | 'date-time' | undefined,
				minLength: integerOf(property.minLength),
				maxLength: integerOf(property.maxLength),
				defaultValue: typeof property.default === 'string' ? property.default : undefined,
			};
		}
		case 'number':
		case 'integer':
			return {
				...base,
				kind: 'number',
				integer: property.type === 'integer',
				minimum: numberOf(property.minimum),
				maximum: numberOf(property.maximum),
				defaultValue: numberOf(property.default),
			};
		case 'boolean':
			return { ...base, kind: 'boolean', defaultValue: typeof property.default === 'boolean' ? property.default : undefined };
		case 'array': {
			const options = isRecord(property.items) ? multiOptions(property.items) : undefined;
			if (!options) {
				return undefined;
			}
			const defaults = Array.isArray(property.default) ? property.default.filter((value): value is string => typeof value === 'string' && options.some(option => option.value === value)) : undefined;
			return { ...base, kind: 'multiEnum', options, minItems: integerOf(property.minItems), maxItems: integerOf(property.maxItems), defaultValue: defaults };
		}
		default:
			return undefined;
	}
}

/** `undefined` for a plain string, `null` for an enum shape that cannot be read. */
function singleOptions(property: Record<string, unknown>): readonly ClaudeElicitationOption[] | undefined | null {
	if (Array.isArray(property.enum)) {
		const names = Array.isArray(property.enumNames) ? property.enumNames : [];
		const options = property.enum.map((value, index) => typeof value === 'string' ? { value, label: typeof names[index] === 'string' ? names[index] as string : value } : undefined);
		return options.length > 0 && options.every(option => option !== undefined) ? options as ClaudeElicitationOption[] : null;
	}
	if (Array.isArray(property.oneOf)) {
		return constOptions(property.oneOf) ?? null;
	}
	return undefined;
}

function multiOptions(items: Record<string, unknown>): readonly ClaudeElicitationOption[] | undefined {
	if (Array.isArray(items.enum)) {
		const values = items.enum.filter((value): value is string => typeof value === 'string');
		return values.length > 0 && values.length === items.enum.length ? values.map(value => ({ value, label: value })) : undefined;
	}
	if (Array.isArray(items.anyOf)) {
		return constOptions(items.anyOf);
	}
	return undefined;
}

function constOptions(entries: readonly unknown[]): readonly ClaudeElicitationOption[] | undefined {
	const options: ClaudeElicitationOption[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.const !== 'string') {
			return undefined;
		}
		options.push({ value: entry.const, label: typeof entry.title === 'string' && entry.title.trim() ? entry.title : entry.const });
	}
	return options.length > 0 ? options : undefined;
}

/**
 * Why a value is not valid for its field. The workbench words each code, so
 * this file stays free of user strings.
 */
export type ClaudeElicitationProblem =
	| { readonly code: 'required' }
	| { readonly code: 'type' }
	| { readonly code: 'integer' }
	| { readonly code: 'format'; readonly format: 'email' | 'uri' | 'date' | 'date-time' }
	| { readonly code: 'minLength' | 'maxLength' | 'minimum' | 'maximum' | 'minItems' | 'maxItems'; readonly limit: number }
	| { readonly code: 'option' };

/**
 * Checks one field's value. `undefined` (or an empty string) is a missing
 * value, which only a required field rejects.
 */
export function validateClaudeElicitationField(field: ClaudeElicitationField, value: ClaudeElicitationValue | undefined): ClaudeElicitationProblem | undefined {
	if (isMissing(value)) {
		return field.required ? { code: 'required' } : undefined;
	}
	switch (field.kind) {
		case 'text':
			if (typeof value !== 'string') {
				return { code: 'type' };
			}
			if (field.minLength !== undefined && value.length < field.minLength) {
				return { code: 'minLength', limit: field.minLength };
			}
			if (field.maxLength !== undefined && value.length > field.maxLength) {
				return { code: 'maxLength', limit: field.maxLength };
			}
			return field.format && !matchesFormat(field.format, value) ? { code: 'format', format: field.format } : undefined;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { code: 'type' };
			}
			if (field.integer && !Number.isInteger(value)) {
				return { code: 'integer' };
			}
			if (field.minimum !== undefined && value < field.minimum) {
				return { code: 'minimum', limit: field.minimum };
			}
			return field.maximum !== undefined && value > field.maximum ? { code: 'maximum', limit: field.maximum } : undefined;
		case 'boolean':
			return typeof value === 'boolean' ? undefined : { code: 'type' };
		case 'enum':
			return typeof value === 'string' && field.options.some(option => option.value === value) ? undefined : { code: 'option' };
		case 'multiEnum': {
			if (!Array.isArray(value)) {
				return { code: 'type' };
			}
			if (value.some(item => !field.options.some(option => option.value === item))) {
				return { code: 'option' };
			}
			if (field.minItems !== undefined && value.length < field.minItems) {
				return { code: 'minItems', limit: field.minItems };
			}
			return field.maxItems !== undefined && value.length > field.maxItems ? { code: 'maxItems', limit: field.maxItems } : undefined;
		}
	}
}

/**
 * Checks a whole form. Returns the content to send (missing optional values
 * left out) or the first problem of each field that has one.
 */
export function validateClaudeElicitationForm(fields: readonly ClaudeElicitationField[], values: Readonly<Record<string, ClaudeElicitationValue | undefined>>): { readonly content: ClaudeElicitationContent } | { readonly problems: Readonly<Record<string, ClaudeElicitationProblem>> } {
	const content: Record<string, ClaudeElicitationValue> = {};
	const problems: Record<string, ClaudeElicitationProblem> = {};
	for (const field of fields) {
		const value = values[field.key];
		const problem = validateClaudeElicitationField(field, value);
		if (problem) {
			problems[field.key] = problem;
		} else if (value !== undefined && !isMissing(value)) {
			content[field.key] = value;
		}
	}
	return Object.keys(problems).length > 0 ? { problems } : { content };
}

/**
 * Reads the JSON text field a form falls back to. The answer must be a JSON
 * object whose values are primitives or lists of strings.
 */
export function parseClaudeElicitationJson(text: string): { readonly content: ClaudeElicitationContent } | { readonly problem: 'syntax' | 'shape' } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { problem: 'syntax' };
	}
	if (!isRecord(parsed)) {
		return { problem: 'shape' };
	}
	const content: Record<string, ClaudeElicitationValue> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
			content[key] = value;
		} else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
			content[key] = value as string[];
		} else {
			return { problem: 'shape' };
		}
	}
	return { content };
}

/** The host of an http(s) URL, lower case. Undefined for any other URL. */
export function claudeElicitationUrlHost(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.host.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * True when a URL card should warn: the server has a configured URL and the
 * link's host is neither that host nor one of its subdomains. A server without
 * a URL (stdio) has no host to compare, so it never warns.
 */
export function claudeElicitationHostDiffers(urlHost: string | undefined, serverHost: string | undefined): boolean {
	if (!urlHost || !serverHost) {
		return false;
	}
	const strip = (host: string) => host.toLowerCase().replace(/:\d+$/, '');
	const link = strip(urlHost);
	const server = strip(serverHost);
	return link !== server && !link.endsWith(`.${server}`);
}

function matchesFormat(format: 'email' | 'uri' | 'date' | 'date-time', value: string): boolean {
	switch (format) {
		case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
		case 'uri': return /^[a-z][a-z0-9+.-]*:\S+$/i.test(value);
		case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
		case 'date-time': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
	}
}

/** No value: unset, an empty string or an empty list. */
function isMissing(value: ClaudeElicitationValue | undefined): boolean {
	return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function integerOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
