/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { z as Zod } from 'zod';
import { CLAUDE_KLAWLY_MCP_INSTRUCTIONS, CLAUDE_TERMINAL_TOOL, CLAUDE_TERMINAL_TOOL_DESCRIPTION, claudeTerminalToolResult } from '../common/claudeTerminalRun.js';
import { CLAUDE_DEBUG_ENDPOINT_TOOL, CLAUDE_DEBUG_ENDPOINT_TOOL_DESCRIPTION, claudeDebugEndpointText, CLAUDE_REPRODUCE_TOOL, CLAUDE_REPRODUCE_TOOL_DESCRIPTION, claudeReproductionToolResult } from '../common/claudeDebugMode.js';
import { ClaudeDebugToolHost } from './claudeDebugLogSink.js';
import { CLAUDE_MODE_TOOL, CLAUDE_MODE_TOOL_DESCRIPTION, ClaudeModeState } from '../common/claudeModeTool.js';
import { CLAUDE_FEEDBACK_TOOL, CLAUDE_FEEDBACK_TOOL_DESCRIPTION, CLAUDE_FEEDBACK_TOOL_KINDS, CLAUDE_FEEDBACK_TOOL_RESULT, ClaudeFeedbackToolKind, claudeFeedbackToolText } from '../common/claudeFeedbackTool.js';
import { CLAUDE_STATUS_KINDS, CLAUDE_STATUS_TOOL, CLAUDE_STATUS_TOOL_DESCRIPTION, ClaudeStatusKind, claudeStatusText } from '../common/claudeStatusTool.js';
import { hasKey } from '../../../base/common/types.js';
import { CLAUDE_REVIEW_APPLY_DESCRIPTION, CLAUDE_REVIEW_APPLY_TOOL, CLAUDE_REVIEW_FINDINGS_DESCRIPTION, CLAUDE_REVIEW_FINDINGS_TOOL, CLAUDE_REVIEW_MARK_DESCRIPTION, CLAUDE_REVIEW_MARK_TOOL, CLAUDE_REVIEW_RUN_DESCRIPTION, CLAUDE_REVIEW_RUN_TOOL, ClaudeReviewToolHost } from '../common/claudeReviewTools.js';
import { runClaudeReviewApplyTool, runClaudeReviewFindingsTool, runClaudeReviewMarkTool } from '../common/claudeReviewToolRun.js';
import { ClaudeLocalMcpServer, ClaudeLocalTool, ClaudeLocalToolResult } from './claudeLocalBridge.js';
import { ClaudeCanvasToolHost, ClaudeDelegateToolHost, ClaudeDepartmentToolHost, ClaudeNoModelToolHost, ClaudeStartAgentToolHost, ClaudeSettingsToolHost, ClaudeTerminalToolHost, ClaudeBrowserToolHost } from './claudeQuery.js';
import { CLAUDE_BROWSER_ACTIONS, CLAUDE_BROWSER_DESCRIPTION, CLAUDE_BROWSER_TOOL, ClaudeBrowserToolArgs, ClaudeBrowserToolResult, claudeBrowserToolText } from '../common/claudeBrowserTool.js';
import { CLAUDE_DELEGATE_TOOL, CLAUDE_DELEGATE_TOOL_DESCRIPTION, CLAUDE_MESSAGE_HELPER_TOOL, CLAUDE_MESSAGE_HELPER_TOOL_DESCRIPTION, claudeDelegateArgsProblem, ClaudeDelegateToolArgs, ClaudeDelegateToolResult, claudeDelegateToolText } from '../common/claudeDelegate.js';
import { CLAUDE_DEPARTMENT_TOOL, CLAUDE_DEPARTMENT_TOOL_DESCRIPTION, claudeDepartmentArgsProblem, ClaudeDepartmentToolArgs, ClaudeDepartmentToolResult, claudeDepartmentToolText } from '../common/claudeDepartment.js';
import { CLAUDE_START_AGENT_TOOL, CLAUDE_START_AGENT_TOOL_DESCRIPTION, claudeStartAgentArgsProblem, ClaudeStartAgentToolArgs, ClaudeStartAgentToolResult, claudeStartAgentToolText } from '../common/claudeStartAgent.js';
import { CLAUDE_DELEGATE_TEMPLATES, expandClaudeDelegateTemplate } from '../common/claudeDelegateTemplates.js';
import { CLAUDE_CI_WAIT_TOOL, CLAUDE_MERGE_GATE_TOOL, CLAUDE_VERIFY_TOOL, claudeNoModelRepoProblem } from '../common/claudeNoModelTools.js';
import { CLAUDE_CANVAS_TOOL, CLAUDE_CANVAS_TOOL_DESCRIPTION, ClaudeCanvasToolArgs, ClaudeCanvasToolResult, claudeCanvasToolText } from '../common/claudeCanvas.js';
import { CLAUDE_SETTINGS_FIND_DESCRIPTION, CLAUDE_SETTINGS_FIND_TOOL, CLAUDE_SETTINGS_SET_DESCRIPTION, CLAUDE_SETTINGS_SET_TOOL, ClaudeSettingsToolArgs, ClaudeSettingsToolResult, claudeSettingsToolText } from '../common/claudeSettingsTool.js';

/**
 * How long one terminal run may take before Claude Code gives up on it. A
 * sign-in in the browser can take a while; the user can cancel sooner.
 */
export const CLAUDE_TERMINAL_TOOL_TIMEOUT_MS = 60 * 60 * 1000;

/** The MCP result shape Claude Code reads back. */
interface ClaudeTerminalToolCallResult {
	readonly content: { readonly type: 'text'; readonly text: string }[];
	readonly isError?: boolean;
	readonly [key: string]: unknown;
}

/** The browser tool's result: text, and a screenshot as an image item. */
interface ClaudeBrowserToolCallResult {
	readonly content: ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string })[];
	readonly isError?: boolean;
	readonly [key: string]: unknown;
}

/** What a tool handler gets besides its arguments: the call's abort signal. */
interface ClaudeToolExtra {
	readonly signal: AbortSignal;
}

type ClaudeZod = typeof import('zod');

/**
 * One tool of Klawly's MCP server: the zod shape checks the arguments and
 * gives the JSON Schema Claude Code lists. Arguments that fail the check come
 * back as a tool error, so Claude can correct the call.
 */
function defineTool<Shape extends Zod.ZodRawShape>(zod: ClaudeZod, name: string, description: string, shape: Shape, handler: (args: Zod.infer<Zod.ZodObject<Shape>>, extra: ClaudeToolExtra) => Promise<ClaudeLocalToolResult>, options?: { readonly alwaysLoad?: boolean }): ClaudeLocalTool {
	const schema = zod.z.object(shape);
	const { $schema: _ignored, ...inputSchema } = zod.z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
	return {
		name,
		description,
		inputSchema,
		alwaysLoad: options?.alwaysLoad,
		async call(args, signal) {
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
			}
			return handler(parsed.data, { signal });
		},
	};
}

/**
 * Runs one `run_in_terminal` call through the host. A host that throws becomes
 * a failure result, so Claude always gets an answer and does not loop.
 */
export async function runClaudeTerminalTool(host: ClaudeTerminalToolHost, args: { readonly command: string; readonly reason?: string }, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	const command = args.command.trim();
	if (!command) {
		return { content: [{ type: 'text', text: 'Give the command to run.' }], isError: true };
	}
	const signal = signalOf(extra);
	let result;
	try {
		result = await host.run(command, args.reason?.trim() || undefined, signal);
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) } as const;
	}
	const { text, isError } = claudeTerminalToolResult(command, result);
	return { content: [{ type: 'text', text }], isError };
}

/** Debug mode's endpoint tool: the log URL and helpers, or why it refuses (issue 484). */
export async function runClaudeDebugEndpointTool(host: ClaudeDebugToolHost): Promise<ClaudeTerminalToolCallResult> {
	try {
		const endpoint = await host.endpoint();
		return hasKey(endpoint, { url: true })
			? { content: [{ type: 'text', text: claudeDebugEndpointText(endpoint.url) }] }
			: { content: [{ type: 'text', text: endpoint.refusal }], isError: true };
	} catch (error) {
		return { content: [{ type: 'text', text: `Klawly could not start the log collector: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
	}
}

/** Debug mode's reproduction tool: waits for the user and returns the captured lines (issue 484). */
export async function runClaudeReproduceTool(host: ClaudeDebugToolHost, args: { readonly steps?: string }, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	let result;
	try {
		result = await host.reproduce(args.steps?.trim() || undefined, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) } as const;
	}
	const { text, isError } = claudeReproductionToolResult(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Runs a settings tool call in the window that owns the session (issue 525). Never throws. */
export async function runClaudeSettingsTool(host: ClaudeSettingsToolHost, args: ClaudeSettingsToolArgs, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	let result: ClaudeSettingsToolResult;
	try {
		result = await host.call(args, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeSettingsToolText(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Runs a browser tool call in the window that owns the session (issue 466). Never throws. */
export async function runClaudeBrowserTool(host: ClaudeBrowserToolHost, args: ClaudeBrowserToolArgs, extra: unknown): Promise<ClaudeBrowserToolCallResult> {
	let result: ClaudeBrowserToolResult;
	try {
		result = await host.call(args, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeBrowserToolText(result);
	const content: ClaudeBrowserToolCallResult['content'] = [{ type: 'text', text }];
	if (result.kind === 'done' && result.image) {
		content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
	}
	return { content, isError };
}

/** Saves a Canvas page (issue 493). Never throws. */
export async function runClaudeCanvasTool(host: ClaudeCanvasToolHost, args: ClaudeCanvasToolArgs): Promise<ClaudeTerminalToolCallResult> {
	let result: ClaudeCanvasToolResult;
	try {
		result = await host.save(args);
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeCanvasToolText(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Runs one delegated chat (issue 693) and returns its answer. Never throws. */
export async function runClaudeDelegateTool(host: ClaudeDelegateToolHost, args: ClaudeDelegateToolArgs, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	const problem = claudeDelegateArgsProblem(args);
	if (problem) {
		return { content: [{ type: 'text', text: problem }], isError: true };
	}
	const call = expandClaudeDelegateTemplate(args);
	let result: ClaudeDelegateToolResult;
	try {
		result = await host.delegate({ ...call, task: call.task.trim() }, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeDelegateToolText(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Sends a message to a helper of this chat (issue 1380). Never throws. */
export async function runClaudeMessageHelperTool(host: ClaudeDelegateToolHost, args: { readonly helper: string; readonly text: string }, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	const helper = args.helper.trim();
	const text = args.text.trim();
	if (!helper || !text) {
		return { content: [{ type: 'text', text: 'Give the helper and the message.' }], isError: true };
	}
	let result: ClaudeDelegateToolResult;
	try {
		result = await host.delegate({ task: '', messageHelper: { helper, text } }, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const out = claudeDelegateToolText(result);
	return { content: [{ type: 'text', text: out.text }], isError: out.isError };
}

/** Hands one request to another project's chat (issue 1177). Never throws. */
export async function runClaudeDepartmentTool(host: ClaudeDepartmentToolHost, args: ClaudeDepartmentToolArgs, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	const problem = claudeDepartmentArgsProblem(args);
	if (problem) {
		return { content: [{ type: 'text', text: problem }], isError: true };
	}
	let result: ClaudeDepartmentToolResult;
	try {
		result = await host.handOff(args, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeDepartmentToolText(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Starts one new local chat (issue 991). Never throws. */
export async function runClaudeStartAgentTool(host: ClaudeStartAgentToolHost, args: ClaudeStartAgentToolArgs, extra: unknown): Promise<ClaudeTerminalToolCallResult> {
	const problem = claudeStartAgentArgsProblem(args);
	if (problem) {
		return { content: [{ type: 'text', text: problem }], isError: true };
	}
	let result: ClaudeStartAgentToolResult;
	try {
		result = await host.start(args, signalOf(extra));
	} catch (error) {
		result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
	}
	const { text, isError } = claudeStartAgentToolText(result);
	return { content: [{ type: 'text', text }], isError };
}

/** Runs one no-model tool call. A host that throws becomes a failure result, so Claude always gets an answer. */
async function runClaudeNoModelTool(call: () => Promise<{ readonly text: string; readonly isError?: boolean }> | { readonly text: string; readonly isError?: boolean }): Promise<ClaudeTerminalToolCallResult> {
	try {
		const { text, isError } = await call();
		return { content: [{ type: 'text', text }], isError };
	} catch (error) {
		return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

/** The CI tool descriptions Claude reads (issue 844). */
export const CLAUDE_CI_WAIT_DESCRIPTION = 'Watch the checks of a pull request or a workflow run without using the model. Returns at once with "watching"; when CI ends, one message with the result, the run URL and, for a failure, the failing jobs and the last 40 log lines arrives in this chat. Use it instead of sleeping or polling. If no checks start within grace_minutes the message says it never started and why.';
export const CLAUDE_VERIFY_DESCRIPTION = 'Run the right test tier for the current change without using the model. Picks the tier from git diff against the base (the tier script of the repo, else docs-only means nothing to run, else the typecheck, lint and test npm scripts), writes the full log to a file and returns PASS with counts or the failing tests with file:line and the last error lines.';
export const CLAUDE_MERGE_GATE_DESCRIPTION = 'Squash-merge a pull request after fixed checks, without using the model: refuses when the base branch has no protection, a required check is missing, pending or failed, or the PR is a draft or conflicted; when the branch is behind a strict base it updates the branch and says to wait again. dry_run only reports. Klawly asks the user first unless the user turned on Merge Without Asking.';

/** Klawly's own MCP server, served by the local bridge: the terminal tool, the settings tools (issue 525), Debug mode's tools (issue 484), Canvas (issue 493) and delegation (issue 693). */
export async function claudeKlawlyMcpServer(host: ClaudeTerminalToolHost | undefined, settings?: ClaudeSettingsToolHost, debug?: ClaudeDebugToolHost, canvas?: ClaudeCanvasToolHost, delegate?: ClaudeDelegateToolHost, noModel?: ClaudeNoModelToolHost, mode?: () => ClaudeModeState, status?: (report: { readonly text: string; readonly kind: ClaudeStatusKind }) => void, department?: ClaudeDepartmentToolHost, feedback?: (request: { readonly title: string; readonly description: string; readonly kind: ClaudeFeedbackToolKind }) => void, startAgent?: ClaudeStartAgentToolHost, review?: ClaudeReviewToolHost, browser?: ClaudeBrowserToolHost): Promise<ClaudeLocalMcpServer | undefined> {
	const zod = await import('zod');
	const z = zod.z;
	const tools: ClaudeLocalTool[] = [];
	if (host) {
		tools.push(defineTool(zod,
			CLAUDE_TERMINAL_TOOL,
			CLAUDE_TERMINAL_TOOL_DESCRIPTION,
			{
				command: z.string().describe('The command to run, as you would pass it to Bash.'),
				reason: z.string().optional().describe('One sentence for the user: what to do in the terminal.'),
			},
			(args, extra) => runClaudeTerminalTool(host, args, extra),
			{ alwaysLoad: true },
		));
	}
	if (browser) {
		tools.push(defineTool(zod,
			CLAUDE_BROWSER_TOOL,
			CLAUDE_BROWSER_DESCRIPTION,
			{
				action: z.enum(CLAUDE_BROWSER_ACTIONS).describe('What to do.'),
				url: z.string().optional().describe('For open and navigate: the address.'),
				selector: z.string().optional().describe('For click, type and scroll: a CSS selector.'),
				text: z.string().optional().describe('For click: the visible text of the element when there is no selector. For type: the text to enter.'),
				submit: z.boolean().optional().describe('For type: press Enter afterwards.'),
				x: z.number().optional().describe('For scroll: pixels to the right.'),
				y: z.number().optional().describe('For scroll: pixels down.'),
				width: z.number().optional().describe('For resize: viewport width in pixels.'),
				height: z.number().optional().describe('For resize: viewport height in pixels.'),
				expression: z.string().optional().describe('For evaluate: a JavaScript expression; its JSON value comes back.'),
				format: z.enum(['tree', 'html']).optional().describe('For snapshot: tree (default) or html.'),
				keep: z.boolean().optional().describe('For console and network: keep the entries after reading.'),
			},
			(args, extra) => runClaudeBrowserTool(browser, args, extra),
			{ alwaysLoad: true },
		));
	}
	if (debug) {
		tools.push(defineTool(zod, CLAUDE_DEBUG_ENDPOINT_TOOL, CLAUDE_DEBUG_ENDPOINT_TOOL_DESCRIPTION, {}, () => runClaudeDebugEndpointTool(debug)));
		tools.push(defineTool(zod,
			CLAUDE_REPRODUCE_TOOL,
			CLAUDE_REPRODUCE_TOOL_DESCRIPTION,
			{ steps: z.string().optional().describe('Short numbered steps the user follows to reproduce the bug.') },
			(args, extra) => runClaudeReproduceTool(debug, args, extra),
		));
	}
	if (settings) {
		tools.push(defineTool(zod,
			CLAUDE_SETTINGS_FIND_TOOL,
			CLAUDE_SETTINGS_FIND_DESCRIPTION,
			{ query: z.string().describe('Words to look for in setting names and descriptions, such as "font size" or "tab autocomplete".') },
			(args, extra) => runClaudeSettingsTool(settings, { action: 'find', query: args.query }, extra),
			{ alwaysLoad: true },
		));
		tools.push(defineTool(zod,
			CLAUDE_SETTINGS_SET_TOOL,
			CLAUDE_SETTINGS_SET_DESCRIPTION,
			{
				key: z.string().describe('The exact setting key, from klawly_settings_find.'),
				value: z.unknown().describe('The new value, of the type the setting takes.'),
				scope: z.enum(['user', 'workspace']).optional().describe('user (all windows, the default) or workspace (this folder).'),
			},
			(args, extra) => runClaudeSettingsTool(settings, { action: 'set', key: args.key, value: args.value, scope: args.scope ?? 'user' }, extra),
			{ alwaysLoad: true },
		));
	}
	if (canvas) {
		tools.push(defineTool(zod,
			CLAUDE_CANVAS_TOOL,
			CLAUDE_CANVAS_TOOL_DESCRIPTION,
			{
				name: z.string().describe('A short file name such as "slow-tests". The same name updates the same canvas.'),
				title: z.string().optional().describe('The tab title, such as "Slowest tests".'),
				html: z.string().describe('The whole page: one HTML file with inline CSS and JavaScript and the data in it.'),
			},
			args => runClaudeCanvasTool(canvas, args),
			{ alwaysLoad: true },
		));
	}
	if (delegate) {
		tools.push(defineTool(zod,
			CLAUDE_DELEGATE_TOOL,
			CLAUDE_DELEGATE_TOOL_DESCRIPTION,
			{
				task: z.string().default('').describe('The whole task, written for a chat that does not see this conversation. Leave it out when you give a template.'),
				template: z.enum(CLAUDE_DELEGATE_TEMPLATES as unknown as [string, ...string[]]).optional().describe('A fixed job on the small tier that reports failures only: watch-ci, run-tests, merge-pr or find.'),
				args: z.string().optional().describe('What the template works on: a pull request number or run id, the test command, or the question.'),
				model: z.string().optional().describe('haiku, sonnet, opus or a full model id. Leave it out to keep your own model.'),
				effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('How hard the delegated chat thinks.'),
				title: z.string().optional().describe('A short title for the card the user sees, such as "Rename the helpers".'),
				objective: z.string().optional().describe('The goal in one sentence.'),
				files: z.array(z.string()).optional().describe('The paths this worker owns; it changes nothing else.'),
				approach: z.string().optional().describe('How to do it, when you have decided.'),
				acceptance: z.string().optional().describe('How to check the work is done: commands and expected results.'),
				budget: z.object({ calls: z.number().int().positive().optional(), usd: z.number().positive().optional() }).optional().describe('Most tool calls and dollars. A notice at 80%, a stop at 100%.'),
				retries: z.number().int().min(0).optional().describe('How many times it may retry a failing step before reporting.'),
				tier: z.enum(['small', 'medium', 'large']).optional().describe('How capable a model the task needs.'),
				reason: z.string().optional().describe('One line: why this tier.'),
				name: z.string().optional().describe('A short name for the worker.'),
				profile: z.enum(['lean', 'full']).optional().describe('lean (default): file and shell tools plus delegation tools, no MCP servers, plugins or slash commands, a much smaller start. full: like this chat, for a task that needs a browser or an MCP server.'),
				orchestrates: z.boolean().optional().describe('True when the worker itself splits its job across workers. Only then does a large tier keep the full model under an Opus chat.'),
			},
			(args, extra) => runClaudeDelegateTool(delegate, args, extra),
			{ alwaysLoad: true },
		));
		tools.push(defineTool(zod,
			CLAUDE_MESSAGE_HELPER_TOOL,
			CLAUDE_MESSAGE_HELPER_TOOL_DESCRIPTION,
			{
				helper: z.string().describe('The helper card id or its title.'),
				text: z.string().describe('The whole message for the helper.'),
			},
			(args, extra) => runClaudeMessageHelperTool(delegate, args, extra),
			{ alwaysLoad: true },
		));
	}
	if (department) {
		tools.push(defineTool(zod,
			CLAUDE_DEPARTMENT_TOOL,
			CLAUDE_DEPARTMENT_TOOL_DESCRIPTION,
			{
				project: z.string().describe('The folder name, repository name or a distinctive part of either.'),
				brief: z.string().describe('The whole request, written for a chat that does not see this conversation.'),
				facts: z.string().optional().describe('What you already know that saves the other chat work.'),
				userWords: z.string().describe('What the user said, word for word.'),
			},
			(args, extra) => runClaudeDepartmentTool(department, args, extra),
			{ alwaysLoad: true },
		));
	}
	if (startAgent) {
		tools.push(defineTool(zod,
			CLAUDE_START_AGENT_TOOL,
			CLAUDE_START_AGENT_TOOL_DESCRIPTION,
			{
				prompt: z.string().describe('The whole first message, written for a chat that does not see this conversation.'),
				project: z.string().optional().describe('The folder name, repository name or a distinctive part of either. Leave out to start in the current project.'),
				title: z.string().optional().describe('A short name for the new chat.'),
			},
			(args, extra) => runClaudeStartAgentTool(startAgent, args, extra),
			{ alwaysLoad: true },
		));
	}
	if (review) {
		tools.push(defineTool(zod, CLAUDE_REVIEW_FINDINGS_TOOL, CLAUDE_REVIEW_FINDINGS_DESCRIPTION, {}, () => runClaudeNoModelTool(() => runClaudeReviewFindingsTool(review))));
		tools.push(defineTool(zod,
			CLAUDE_REVIEW_MARK_TOOL,
			CLAUDE_REVIEW_MARK_DESCRIPTION,
			{ ids: z.array(z.string()).describe('Finding ids from get_review_findings.') },
			args => runClaudeNoModelTool(() => runClaudeReviewMarkTool(review, args.ids)),
		));
		tools.push(defineTool(zod,
			CLAUDE_REVIEW_APPLY_TOOL,
			CLAUDE_REVIEW_APPLY_DESCRIPTION,
			{ id: z.string().describe('A finding id from get_review_findings.') },
			args => runClaudeNoModelTool(() => runClaudeReviewApplyTool(review, args.id)),
		));
		tools.push(defineTool(zod,
			CLAUDE_REVIEW_RUN_TOOL,
			CLAUDE_REVIEW_RUN_DESCRIPTION,
			{
				base: z.string().optional().describe('The branch to compare against. Defaults to main.'),
				depth: z.enum(['quick', 'deep']).optional().describe('Quick (default) or deep.'),
			},
			args => runClaudeNoModelTool(() => review.run({ base: args.base?.trim() || 'main', depth: args.depth ?? 'quick' })),
		));
	}
	if (noModel) {
		const repo = z.string().describe('The repository as owner/name, for example MehdiMamas/klawly-ide.');
		tools.push(defineTool(zod,
			CLAUDE_CI_WAIT_TOOL,
			CLAUDE_CI_WAIT_DESCRIPTION,
			{
				repo,
				pr: z.number().optional().describe('The pull request number to watch the checks of. Give pr or run.'),
				run: z.number().optional().describe('The workflow run id to watch. Give pr or run.'),
				grace_minutes: z.number().optional().describe('How long to wait for checks to appear before reporting that CI never started. Default 10.'),
			},
			args => runClaudeNoModelTool(() => claudeNoModelRepoProblem(args.repo) ? { text: claudeNoModelRepoProblem(args.repo)!, isError: true } : noModel.ciWait(args)),
			{ alwaysLoad: true },
		));
		tools.push(defineTool(zod,
			CLAUDE_VERIFY_TOOL,
			CLAUDE_VERIFY_DESCRIPTION,
			{
				cwd: z.string().describe('The repo or worktree folder to verify.'),
				base: z.string().optional().describe('The ref to diff against. Default origin/main.'),
			},
			args => runClaudeNoModelTool(() => noModel.verify(args)),
			{ alwaysLoad: true },
		));
		tools.push(defineTool(zod,
			CLAUDE_MERGE_GATE_TOOL,
			CLAUDE_MERGE_GATE_DESCRIPTION,
			{
				repo,
				pr: z.number().describe('The pull request number.'),
				dry_run: z.boolean().optional().describe('Only report: never update or merge.'),
			},
			args => runClaudeNoModelTool(() => claudeNoModelRepoProblem(args.repo) ? { text: claudeNoModelRepoProblem(args.repo)!, isError: true } : noModel.mergeGate(args)),
			{ alwaysLoad: true },
		));
	}
	if (mode) {
		tools.push(defineTool(zod, CLAUDE_MODE_TOOL, CLAUDE_MODE_TOOL_DESCRIPTION, {}, () => runClaudeNoModelTool(() => ({ text: JSON.stringify(mode(), undefined, 2) })), { alwaysLoad: true }));
	}
	if (feedback) {
		tools.push(defineTool(zod,
			CLAUDE_FEEDBACK_TOOL,
			CLAUDE_FEEDBACK_TOOL_DESCRIPTION,
			{
				title: z.string().describe('A short summary of the report.'),
				description: z.string().describe('The report in plain words: what happened or what is wanted, and why.'),
				kind: z.enum(CLAUDE_FEEDBACK_TOOL_KINDS as unknown as [ClaudeFeedbackToolKind, ...ClaudeFeedbackToolKind[]]).default('bug').describe('bug, idea or other.'),
			},
			args => runClaudeNoModelTool(() => {
				const text = claudeFeedbackToolText(args.title, args.description);
				if (!text) {
					return { text: 'The title or the description was empty, so the form was not opened.', isError: true };
				}
				feedback({ ...text, kind: args.kind });
				return { text: CLAUDE_FEEDBACK_TOOL_RESULT };
			}),
			{ alwaysLoad: true },
		));
	}
	if (status) {
		tools.push(defineTool(zod,
			CLAUDE_STATUS_TOOL,
			CLAUDE_STATUS_TOOL_DESCRIPTION,
			{
				text: z.string().describe('One short line for the user, such as "Waiting on CI for the fix".'),
				kind: z.enum(CLAUDE_STATUS_KINDS as unknown as [ClaudeStatusKind, ...ClaudeStatusKind[]]).default('info').describe('info (progress), attention (the user is needed soon) or done (finished).'),
			},
			args => runClaudeNoModelTool(() => {
				const text = claudeStatusText(args.text);
				if (!text) {
					return { text: 'The status line was empty, so nothing was shown.', isError: true };
				}
				status({ text, kind: args.kind });
				return { text: 'Shown on the chat tab.' };
			}),
			{ alwaysLoad: true },
		));
	}
	return tools.length === 0 ? undefined : { instructions: CLAUDE_KLAWLY_MCP_INSTRUCTIONS, tools };
}

/** The MCP request's abort signal, when Claude Code cancels the call. */
function signalOf(extra: unknown): AbortSignal | undefined {
	const signal = typeof extra === 'object' && extra !== null ? (extra as { signal?: unknown }).signal : undefined;
	return signal instanceof AbortSignal ? signal : undefined;
}
