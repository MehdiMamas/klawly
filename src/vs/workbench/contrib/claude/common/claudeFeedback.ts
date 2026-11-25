/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { ClaudeFeedbackBan, ClaudeFeedbackSendResult } from '../../../../platform/claude/common/claudeFeedbackRelay.js';

/** Klawly: Send Feedback (issue 444). */
export const CLAUDE_SEND_FEEDBACK_COMMAND_ID = 'klawly.sendFeedback';
export const KLAWLY_FEEDBACK_ENABLED_SETTING = 'klawly.feedback.enabled';
export const KLAWLY_FEEDBACK_ENDPOINT_SETTING = 'klawly.feedback.endpoint';

/**
 * The feedback relay, a separate Vercel project (`klawly-hooks-relay`, see
 * `docs/relay.md`). It files the report as an
 * issue on the project tracker, so testers need no GitHub account or access.
 */
export const KLAWLY_FEEDBACK_DEFAULT_ENDPOINT = 'https://klawly-feedback.vercel.app/api/feedback';

export const KLAWLY_FEEDBACK_MAX_IMAGES = 4;
/** Decoded image bytes over all images; the relay accepts 3.2 MB of attachments in total. */
export const KLAWLY_FEEDBACK_IMAGE_BUDGET = 2_400_000;
/** Characters of log text over all log files. */
export const KLAWLY_FEEDBACK_LOG_BUDGET = 600_000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 30_000;
const MAX_ERROR_LINES = 40;

export type ClaudeFeedbackKind = 'bug' | 'idea' | 'other';

export interface ClaudeFeedbackImage {
	readonly name: string;
	readonly type: 'image/png' | 'image/jpeg';
	readonly bytes: VSBuffer;
}

export interface ClaudeFeedbackText {
	readonly name: string;
	/** Already redacted. */
	readonly contents: string;
}

export interface ClaudeFeedbackReport {
	readonly kind: ClaudeFeedbackKind;
	readonly title: string;
	readonly description: string;
	/** Label and value rows; undefined when the tester left system info out. */
	readonly system?: readonly (readonly [string, string])[];
	/** Recent error lines, shown in the issue; the full logs go in `texts`. */
	readonly errors?: readonly string[];
	readonly images: readonly ClaudeFeedbackImage[];
	readonly texts: readonly ClaudeFeedbackText[];
}

export interface ClaudeFeedbackPayload {
	readonly v: 1;
	readonly kind: ClaudeFeedbackKind;
	readonly title: string;
	readonly body: string;
	readonly attachments: readonly { readonly name: string; readonly type: string; readonly data: string }[];
}

/** The request body the relay takes. */
export function buildClaudeFeedbackPayload(report: ClaudeFeedbackReport): ClaudeFeedbackPayload {
	return {
		v: 1,
		kind: report.kind,
		title: report.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
		body: formatClaudeFeedbackBody(report),
		attachments: [
			...report.images.map(image => ({ name: image.name, type: image.type, data: encodeBase64(image.bytes) })),
			...report.texts.filter(text => text.contents.length > 0).map(text => ({ name: text.name, type: 'text/plain', data: encodeBase64(VSBuffer.fromString(text.contents)) })),
		],
	};
}

/** The issue body before the relay adds the attachment links. Plain GitHub Markdown. */
export function formatClaudeFeedbackBody(report: ClaudeFeedbackReport): string {
	const kind = report.kind === 'bug' ? 'Bug' : report.kind === 'idea' ? 'Idea' : 'Other';
	const parts = [
		`**Kind:** ${kind}`,
		report.description.trim().slice(0, MAX_DESCRIPTION) || '_No description._',
	];
	if (report.system && report.system.length > 0) {
		parts.push(['### System', '', '| | |', '| --- | --- |', ...report.system.map(([label, value]) => `| ${escapeCell(label)} | ${escapeCell(value)} |`)].join('\n'));
	}
	const errors = report.errors?.slice(-MAX_ERROR_LINES) ?? [];
	if (errors.length > 0) {
		const fence = codeFence(errors.join('\n'));
		parts.push([`<details><summary>Recent errors (${errors.length})</summary>`, '', `${fence}text`, ...errors, fence, '', '</details>'].join('\n'));
	}
	return parts.join('\n\n');
}

/**
 * The type an image's bytes really are (issue 698): the window screenshot is a JPEG, and a
 * dropped file's type comes from its extension, so neither label can be trusted. Undefined
 * when the bytes are neither PNG nor JPEG.
 */
export function claudeFeedbackImageType(bytes: Uint8Array): ClaudeFeedbackImage['type'] | undefined {
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
		return 'image/jpeg';
	}
	return undefined;
}

/** The attachment name for an image: the extension follows the type. */
export function claudeFeedbackImageName(base: string, type: ClaudeFeedbackImage['type']): string {
	return `${base}.${type === 'image/png' ? 'png' : 'jpg'}`;
}

/** Saved image types the picker offers; all but PNG and JPEG are re-encoded to JPEG (issue 699). */
export const CLAUDE_FEEDBACK_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

/** A failed send whose message is a whole sentence for the form's status line. */
export class ClaudeFeedbackSendError extends Error {
	constructor(
		message: string,
		/** The attachment the relay refused, when it named one (issue 698). */
		readonly attachment?: string,
	) {
		super(message);
	}
}

/** The send was refused because the GitHub account is banned (issue 949); the form shows the ban panel. */
export class ClaudeFeedbackBannedError extends ClaudeFeedbackSendError {
	constructor(readonly ban: ClaudeFeedbackBan) {
		super(localize('klawlyFeedbackBanned', "Your GitHub account @{0} can't send feedback.", ban.login));
	}
}

/** The report needs a GitHub sign-in: retrying cannot help until the tester signs in. */
export class ClaudeFeedbackSignInError extends ClaudeFeedbackSendError { }

/**
 * The issue number of a sent report, or a {@link ClaudeFeedbackSendError} that says why it
 * was not sent. A network failure gets advice instead of the raw "Failed to fetch" (issue 538).
 */
export function claudeFeedbackIssueNumber(result: ClaudeFeedbackSendResult): number {
	switch (result.kind) {
		case 'sent':
			return result.number;
		case 'network':
			throw new ClaudeFeedbackSendError(localize('klawlyFeedbackNetworkError', "Couldn't reach the feedback service. Check your connection and try again."));
		case 'login_required':
			throw new ClaudeFeedbackSendError(result.message ?? localize('klawlyFeedbackLoginRequired', "Sign in to GitHub to send feedback. If you already did, update Klawly and try again."));
		case 'banned':
			throw new ClaudeFeedbackBannedError(result.ban);
		case 'rejected':
			throw new ClaudeFeedbackSendError(result.error
				? localize('klawlyFeedbackRejected', "Could not send: {0}", result.error)
				: result.status === 429
					// The relay's rate limit, when only the header says how long it lasts (issue 739).
					? localize('klawlyFeedbackRateLimited', "Could not send: too many reports. Try again in {0} minutes.", Math.max(1, Math.ceil((result.retryAfter ?? 600) / 60)))
					: localize('klawlyFeedbackHttpError', "Could not send: the feedback service answered {0}.", result.status),
				result.error?.match(/^Attachment (?<name>.+?) (?:has an unsupported type|is not base64|does not match its type)\.$/)?.groups?.name);
	}
}

/**
 * What the form holds. It is kept across closes and restarts (issue 739) and sent in the
 * background (issue 735), so it carries everything a report is built from.
 */
export interface ClaudeFeedbackDraft {
	readonly kind: ClaudeFeedbackKind;
	readonly title: string;
	readonly description: string;
	readonly images: readonly ClaudeFeedbackImage[];
	readonly includeDiagnostics: boolean;
}

/** The text `klawly_feedback` fills in (issue 1174). */
export interface ClaudeFeedbackPrefill {
	readonly kind: ClaudeFeedbackKind;
	readonly title: string;
	readonly description: string;
}

/**
 * The draft the form opens with when Claude prefills it. A draft the user already kept is not
 * lost: its text stays first and Claude's follows it. The window screenshot is attached like a fresh report.
 */
export function claudeFeedbackPrefillDraft(prefill: ClaudeFeedbackPrefill, kept: ClaudeFeedbackDraft | undefined, screenshot: ClaudeFeedbackImage | undefined): ClaudeFeedbackDraft {
	if (!kept || isEmptyClaudeFeedbackDraft(kept)) {
		return { ...prefill, images: screenshot ? [screenshot] : [], includeDiagnostics: true };
	}
	return {
		kind: kept.kind,
		title: kept.title.trim() || prefill.title,
		description: [kept.description.trim(), prefill.description].filter(text => text).join('\n\n'),
		images: kept.images,
		includeDiagnostics: kept.includeDiagnostics,
	};
}

/** A report that did not send, kept with the reason so it can be opened and sent again (issue 735). */
export interface ClaudeFeedbackUnsent {
	readonly id: string;
	readonly draft: ClaudeFeedbackDraft;
	/** A whole sentence, as {@link ClaudeFeedbackSendError} words it. */
	readonly error: string;
	/** The attachment the relay refused, if it named one. */
	readonly attachment?: string;
}

/** Nothing written yet: the window screenshot alone is not a draft worth keeping. */
export function isEmptyClaudeFeedbackDraft(draft: ClaudeFeedbackDraft): boolean {
	return !draft.title.trim() && !draft.description.trim();
}

/** A draft as plain JSON for storage, images as base64. */
export function serializeClaudeFeedbackDraft(draft: ClaudeFeedbackDraft): object {
	return { kind: draft.kind, title: draft.title, description: draft.description, includeDiagnostics: draft.includeDiagnostics, images: draft.images.map(image => ({ name: image.name, type: image.type, data: encodeBase64(image.bytes) })) };
}

/** Reads back {@link serializeClaudeFeedbackDraft}; undefined for anything else. */
export function parseClaudeFeedbackDraft(value: unknown): ClaudeFeedbackDraft | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const draft = value as Record<string, unknown>;
	if ((draft.kind !== 'bug' && draft.kind !== 'idea' && draft.kind !== 'other') || typeof draft.title !== 'string' || typeof draft.description !== 'string' || !Array.isArray(draft.images)) {
		return undefined;
	}
	const images: ClaudeFeedbackImage[] = [];
	for (const image of draft.images as unknown[]) {
		const { name, type, data } = (image ?? {}) as Record<string, unknown>;
		if (typeof name !== 'string' || (type !== 'image/png' && type !== 'image/jpeg') || typeof data !== 'string') {
			continue;
		}
		try {
			images.push({ name, type, bytes: decodeBase64(data) });
		} catch {
			// A damaged image is left out; the words are what matter.
		}
	}
	return { kind: draft.kind, title: draft.title, description: draft.description, images, includeDiagnostics: draft.includeDiagnostics !== false };
}

/** Error and stack lines from a log, newest last. */
export function claudeFeedbackErrorLines(log: string): string[] {
	return log.split(/\r?\n/).filter(line => /\b(?:error|failed|failure|exception|fatal|uncaught)\b|^\s+at\s/i.test(line)).slice(-MAX_ERROR_LINES);
}

/** The last lines of `text` that fit in `maxChars`, with a note when lines were dropped. */
export function tailClaudeFeedbackLog(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const cut = text.slice(text.length - maxChars);
	const start = cut.indexOf('\n');
	return `[earlier lines left out]\n${start === -1 ? cut : cut.slice(start + 1)}`;
}

function escapeCell(text: string): string {
	return escapeInline(text).replace(/\|/g, '\\|');
}

function escapeInline(text: string): string {
	return text.replace(/\r?\n/g, ' ').replace(/</g, '&lt;');
}

/** A backtick fence longer than any run inside `text`. */
function codeFence(text: string): string {
	const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
	return '`'.repeat(longest + 1);
}
