/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Questions from Claude (issue 477): Claude Code's `AskUserQuestion` tool asks
 * the user one to four questions with two to four options each. They travel on
 * the elicitation channel as a `question` request so they wait, time out and
 * badge the pane like an MCP form. Nothing here imports the Agent SDK.
 */

/** The tool Claude Code calls to ask. */
export const CLAUDE_QUESTION_TOOL = 'AskUserQuestion';

/** The `server` a question request names: the card says who asks. */
export const CLAUDE_QUESTION_ASKER = 'Claude';

/** What Claude is told when the user declines, so the turn goes on without an answer. */
export const CLAUDE_QUESTION_DECLINED = 'The user declined to answer the questions.';

export interface ClaudeQuestionOption {
	readonly label: string;
	readonly description: string;
	/** Code or a mockup to compare options side by side. Only single-select questions carry one. */
	readonly preview?: string;
}

export interface ClaudeQuestion {
	/** The full question. Answers are keyed by it. */
	readonly question: string;
	/** A short chip label (at most 12 characters in the SDK). */
	readonly header: string;
	readonly options: readonly ClaudeQuestionOption[];
	readonly multiSelect: boolean;
}

/** The answer of each question by its text: the chosen labels joined by ", ", or the text typed in Other. */
export type ClaudeQuestionAnswers = Readonly<Record<string, string>>;

/** The note the user added under a question, by its text. */
export type ClaudeQuestionNotes = Readonly<Record<string, string>>;

/**
 * What the SDK reads back from the tool's `updatedInput`. Claude Code puts a
 * note in the tool result after the answer, and a `response` in place of the
 * answers ("The user responded: …"), so Claude reads either and goes on.
 */
export interface ClaudeQuestionResult {
	readonly answers: Record<string, string>;
	readonly response?: string;
	readonly annotations?: Record<string, { readonly preview?: string; readonly notes?: string }>;
}

/**
 * Reads the tool's input. Returns `undefined` when it is not a list of
 * questions each with a text and at least one labeled option, so the runner
 * leaves such a call to the normal permission path.
 */
export function readClaudeQuestions(input: unknown): readonly ClaudeQuestion[] | undefined {
	if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
		return undefined;
	}
	const questions: ClaudeQuestion[] = [];
	for (const raw of input.questions) {
		if (!isRecord(raw) || typeof raw.question !== 'string' || !raw.question.trim() || !Array.isArray(raw.options)) {
			return undefined;
		}
		const options: ClaudeQuestionOption[] = [];
		for (const option of raw.options) {
			if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) {
				return undefined;
			}
			const preview = typeof option.preview === 'string' && option.preview.trim() ? option.preview : undefined;
			options.push({ label: option.label, description: typeof option.description === 'string' ? option.description : '', ...(preview ? { preview } : {}) });
		}
		if (options.length === 0 || questions.some(question => question.question === raw.question)) {
			return undefined;
		}
		questions.push({
			question: raw.question,
			header: typeof raw.header === 'string' ? raw.header.trim() : '',
			options,
			multiSelect: raw.multiSelect === true,
		});
	}
	return questions;
}

/**
 * Maps the card's content (each question's text to the chosen labels or the
 * Other text) to the SDK's `answers`. A multi-select answer is the labels joined
 * by ", " as the SDK documents. A single choice whose option has a preview
 * also sends that preview as an annotation, and a note goes beside it.
 * Returns `undefined` when a question has no answer.
 */
export function claudeQuestionResult(questions: readonly ClaudeQuestion[], content: Readonly<Record<string, unknown>>, notes?: Readonly<Record<string, unknown>>): ClaudeQuestionResult | undefined {
	const answers: Record<string, string> = {};
	const annotations: Record<string, { preview?: string; notes?: string }> = {};
	for (const question of questions) {
		const value = content[question.question];
		const parts = (Array.isArray(value) ? value : [value]).filter((part): part is string => typeof part === 'string').map(part => part.trim()).filter(part => part.length > 0);
		if (parts.length === 0) {
			return undefined;
		}
		answers[question.question] = parts.join(', ');
		const preview = parts.length === 1 ? question.options.find(option => option.label === parts[0])?.preview : undefined;
		const note = notes?.[question.question];
		const trimmed = typeof note === 'string' ? note.trim() : '';
		if (preview || trimmed) {
			annotations[question.question] = { ...(preview ? { preview } : {}), ...(trimmed ? { notes: trimmed } : {}) };
		}
	}
	return Object.keys(annotations).length ? { answers, annotations } : { answers };
}

/**
 * The result of a reply sent in place of any answer: no answers, the text as
 * the SDK's `response`. It is not a decline, so Claude reads the text and goes
 * on with it. Returns `undefined` for blank text.
 */
export function claudeQuestionReply(reply: unknown): ClaudeQuestionResult | undefined {
	const response = typeof reply === 'string' ? reply.trim() : '';
	return response ? { answers: {}, response } : undefined;
}

/** The notes of a result, by question text, or `undefined` when it has none. */
export function claudeQuestionNotes(result: ClaudeQuestionResult): ClaudeQuestionNotes | undefined {
	const notes: Record<string, string> = {};
	for (const [question, annotation] of Object.entries(result.annotations ?? {})) {
		if (annotation.notes) {
			notes[question] = annotation.notes;
		}
	}
	return Object.keys(notes).length ? notes : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
