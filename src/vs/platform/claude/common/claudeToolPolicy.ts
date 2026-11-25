/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix, win32 } from '../../../base/common/path.js';
import { AgentMode } from './claudeContext.js';
import { isReadOnlyShellCommand, NON_MUTATING_TOOLS } from './claudeModePolicy.js';
import { PermissionPolicy } from './claudePermissions.js';
import { ClaudeReadRule, isReadBlocked } from './claudeReadRules.js';
import { KLAWLY_PLANS_FOLDER, LEGACY_KLAWLY_PLANS_FOLDER, PLAN_FILE_SUFFIX } from './claudePlanFiles.js';
import { classifyTool, CommandRisk, PermissionRequest, ToolCategory } from './claudeProtocol.js';
import { CLAUDE_BROWSER_TOOL_ID, isClaudeBrowserLocalUrl } from './claudeBrowserTool.js';
import { CLAUDE_SETTINGS_SET_TOOL_ID, claudeSettingsChangeSubject, isClaudeBlockedSetting } from './claudeSettingsTool.js';

/**
 * The host policy for tool requests (master plan sections 17, 40 and 91).
 *
 * This file decides; it does not ask the user and it does not touch the file
 * system. Whatever needs the disk (`realpath`) is passed in, so the same rules
 * run in the shared process and in tests. The model only supplies `toolName`
 * and `input`. Everything else here comes from the host.
 */

/** Resolves symlinks. Returns undefined when `path` does not exist. */
export type PathRealpath = (path: string) => Promise<string | undefined>;

export interface ToolPolicyContext {
	/** Absolute directory the session runs in. */
	readonly cwd: string;
	/** Absolute workspace folders. Writes are only free inside these. */
	readonly workspaceFolders: readonly string[];
	/** Absolute directories the session may also read. Never writable without asking. */
	readonly additionalDirectories: readonly string[];
	/** Workspace Trust. An untrusted workspace never gets an automatic write or command. */
	readonly trusted: boolean;
	readonly policy: PermissionPolicy;
	readonly realpath?: PathRealpath;
	/**
	 * Mode of the turn. Unset behaves as Agent. Plan writes only plan files and
	 * Ask writes nothing; both fetch from the web without a card (Phase 27).
	 */
	readonly mode?: AgentMode;
	/** Absolute folders Claude Code writes plan files to. See `claudePlanFiles.ts`. */
	readonly planDirectories?: readonly string[];
	/**
	 * Klawly's own plan folder for this user (`~/.klawly/plans`). Its `.md` files
	 * are plans Klawly wrote: Claude may read them, and write them in Plan and
	 * Agent mode as if they were in the workspace, so Build can tick their to-dos.
	 */
	readonly klawlyPlanDirectory?: string;
	/**
	 * Files Claude may not touch (issue 458). A request that names a blocked path
	 * is refused before anything else, so the block holds in every mode and when
	 * the user allowed everything. See `claudeReadRules.ts`.
	 */
	readonly readRules?: readonly ClaudeReadRule[];
	/** Absolute home folder, for a `~` in a request. */
	readonly homeDirectory?: string;
}

export interface ToolPolicyResult {
	readonly behavior: 'allow' | 'ask' | 'deny';
	/** What the permission card shows. `id`, `input`, and `reason` are added by the caller. */
	readonly details: Omit<PermissionRequest, 'id' | 'toolName' | 'input' | 'reason'>;
	/** The command or absolute path the decision covers. */
	readonly subject: string;
	/** Key a session or workspace grant is stored under. */
	readonly grantKey: string;
	/** False when only a single use may be approved. */
	readonly canRemember: boolean;
	/** Sentence for the user: why the host is asking or refusing. */
	readonly why: string;
	/** Message returned to the model on `deny`. */
	readonly message?: string;
	/** Set on a `deny` that comes from the mode (Plan or Ask), not from a setting. */
	readonly modeDenial?: boolean;
	/**
	 * Set on a write to a plan file in Klawly's or Claude Code's plan folder. Such
	 * a plan is not a code change, so it is not snapshotted for review or undo.
	 */
	readonly planFile?: 'klawly' | 'claude';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function styleFor(path: string, cwd: string) {
	return isWindowsPath(path) || (!path.startsWith('/') && isWindowsPath(cwd)) ? win32 : posix;
}

/**
 * Resolves `path` against `cwd` and removes `.`, `..`, doubled separators, and
 * a trailing separator. This is lexical: it does not follow symlinks.
 */
export function canonicalizePath(path: string, cwd: string): string {
	const style = styleFor(path, cwd);
	const resolved = style.isAbsolute(path) ? style.normalize(path) : style.normalize(style.join(cwd, path));
	return trimTrailingSeparator(resolved, style.sep);
}

function trimTrailingSeparator(path: string, sep: string): string {
	let end = path.length;
	// Keep a root such as `/` or `C:\`.
	const minimum = path.startsWith('\\\\') ? 2 : (/^[a-zA-Z]:/.test(path) ? 3 : 1);
	while (end > minimum && path[end - 1] === sep) {
		end--;
	}
	return path.slice(0, end);
}

/** Comparison key. Windows paths compare case-insensitively with one separator. */
function pathKey(path: string): string {
	return isWindowsPath(path) ? path.replace(/\//g, '\\').toLowerCase() : path;
}

/** True when `target` equals a root or lies under it. Both must already be canonical. */
export function isInsideWorkspace(target: string, roots: readonly string[]): boolean {
	const key = pathKey(target);
	const sep = isWindowsPath(target) ? '\\' : '/';
	return roots.some(root => {
		const rootKey = pathKey(root);
		if (key === rootKey) {
			return true;
		}
		return key.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep);
	});
}

/**
 * Follows symlinks for the longest existing prefix of `path` and appends the
 * rest. A file that does not exist yet therefore resolves through its parent,
 * which is what a write would do.
 */
export async function resolveRealPath(path: string, realpath: PathRealpath): Promise<string> {
	const style = isWindowsPath(path) ? win32 : posix;
	let current = path;
	const tail: string[] = [];
	for (let depth = 0; depth < 128; depth++) {
		let real: string | undefined;
		try {
			real = await realpath(current);
		} catch {
			real = undefined;
		}
		if (real !== undefined) {
			return tail.length > 0 ? trimTrailingSeparator(style.join(real, ...tail.reverse()), style.sep) : trimTrailingSeparator(real, style.sep);
		}
		const parent = style.dirname(current);
		if (parent === current) {
			return path;
		}
		tail.push(style.basename(current));
		current = parent;
	}
	return path;
}

export interface PathAssessment {
	/** Lexically canonical absolute path. This is what the card shows. */
	readonly absolute: string;
	/** Path after following symlinks. Equals `absolute` when no `realpath` was given. */
	readonly real: string;
	/** Inside a workspace folder, both as written and after symlinks. */
	readonly inside: boolean;
	/** Readable: inside a workspace folder or an additional directory. */
	readonly readable: boolean;
	/** Written as inside the workspace, but a symlink leads out. */
	readonly escapesViaSymlink: boolean;
}

async function realRoots(roots: readonly string[], cwd: string, realpath: PathRealpath | undefined): Promise<string[]> {
	const canonical = roots.map(root => canonicalizePath(root, cwd));
	if (!realpath) {
		return canonical;
	}
	const real = await Promise.all(canonical.map(root => resolveRealPath(root, realpath)));
	return [...canonical, ...real];
}

/** Canonicalizes `path`, then re-checks it after symlinks (master plan section 40). */
export async function assessPath(path: string, context: Pick<ToolPolicyContext, 'cwd' | 'workspaceFolders' | 'additionalDirectories' | 'realpath'>): Promise<PathAssessment> {
	const absolute = canonicalizePath(path, context.cwd);
	const real = context.realpath ? await resolveRealPath(absolute, context.realpath) : absolute;
	const workspace = await realRoots(context.workspaceFolders, context.cwd, context.realpath);
	const extra = await realRoots(context.additionalDirectories, context.cwd, context.realpath);
	const inside = isInsideWorkspace(absolute, workspace) && isInsideWorkspace(real, workspace);
	const insideExtra = isInsideWorkspace(absolute, extra) && isInsideWorkspace(real, extra);
	const lexicallyInside = isInsideWorkspace(absolute, workspace);
	return {
		absolute,
		real,
		inside,
		readable: inside || insideExtra,
		escapesViaSymlink: lexicallyInside && !inside,
	};
}

/** Like `assessPath`, but `~` paths are outside: the host does not expand them, so it cannot vouch for them. */
async function assessTarget(path: string, context: Pick<ToolPolicyContext, 'cwd' | 'workspaceFolders' | 'additionalDirectories' | 'realpath'>): Promise<PathAssessment> {
	if (path.startsWith('~')) {
		return { absolute: path, real: path, inside: false, readable: false, escapesViaSymlink: false };
	}
	return assessPath(path, context);
}

// ---------------------------------------------------------------------------
// Plan files
// ---------------------------------------------------------------------------

/** Where a plan file lives: inside a workspace folder, in Klawly's plan folder for this user, or in Claude Code's plan folder. */
export type PlanFileLocation = 'workspace' | 'klawly' | 'claude';

/**
 * Classifies one canonical absolute path against canonical roots. Returns
 * undefined for a file that is not a plan file (see `claudePlanFiles.ts`).
 */
export function planFileLocation(path: string, workspaceFolders: readonly string[], planDirectories: readonly string[], klawlyPlanDirectories: readonly string[] = []): PlanFileLocation | undefined {
	const style = isWindowsPath(path) ? win32 : posix;
	const name = style.basename(path).toLowerCase();
	const strictlyInside = (roots: readonly string[]) => roots.some(root => isInsideWorkspace(path, [root]) && pathKey(path) !== pathKey(root));
	// The plan folders come first: a workspace can contain them (the home folder opened as one).
	if (name.endsWith('.md') && strictlyInside(klawlyPlanDirectories)) {
		return 'klawly';
	}
	if (name.endsWith('.md') && strictlyInside(planDirectories)) {
		return 'claude';
	}
	if (strictlyInside(workspaceFolders)) {
		if (name.endsWith(PLAN_FILE_SUFFIX)) {
			return 'workspace';
		}
		if (strictlyInside(workspaceFolders.flatMap(folder => [KLAWLY_PLANS_FOLDER, LEGACY_KLAWLY_PLANS_FOLDER].map(plans => canonicalizePath(plans, folder))))) {
			return 'workspace';
		}
	}
	return undefined;
}

/**
 * Plan-file check for a write. The path must be a plan file both as written
 * and after symlinks, so a `x.plan.md` link to `src/index.ts` is not one.
 */
async function assessPlanFile(assessed: PathAssessment, context: ToolPolicyContext): Promise<PlanFileLocation | undefined> {
	const workspace = await realRoots(context.workspaceFolders, context.cwd, context.realpath);
	const planDirectories = await realRoots(context.planDirectories ?? [], context.cwd, context.realpath);
	const klawlyPlanDirectories = await realRoots(context.klawlyPlanDirectory ? [context.klawlyPlanDirectory] : [], context.cwd, context.realpath);
	const written = planFileLocation(assessed.absolute, workspace, planDirectories, klawlyPlanDirectories);
	const real = planFileLocation(assessed.real, workspace, planDirectories, klawlyPlanDirectories);
	return written !== undefined && written === real ? written : undefined;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const CREDENTIAL_BASENAMES: readonly RegExp[] = [
	/^\.env(\..+)?$/,
	/^\.(npmrc|netrc|pypirc|git-credentials|pgpass|my\.cnf)$/,
	/^id_(rsa|dsa|ecdsa|ed25519)$/,
	/^credentials(\.json)?$/,
	/^secrets?\.(json|ya?ml|toml)$/,
	/\.(pem|key|p12|pfx|keystore|jks)$/,
	/^\.claude\.json$/,
	/^\.credentials\.json$/,
];

const CREDENTIAL_TEMPLATES: RegExp = /^\.env\.(example|sample|template|dist)$/;

const CREDENTIAL_SEGMENTS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.password-store']);

/** True for files that hold secrets, such as `.env`, `~/.ssh/*`, and `.npmrc`. */
export function isCredentialPath(path: string): boolean {
	const segments = path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
	const name = segments[segments.length - 1] ?? '';
	if (CREDENTIAL_TEMPLATES.test(name)) {
		return false;
	}
	if (segments.some(segment => CREDENTIAL_SEGMENTS.has(segment))) {
		return true;
	}
	const parent = segments[segments.length - 2];
	if ((parent === '.docker' && name === 'config.json') || (parent === 'gcloud' && segments[segments.length - 3] === '.config')) {
		return true;
	}
	if (parent === '.claude' && name.startsWith('.credentials')) {
		return true;
	}
	return CREDENTIAL_BASENAMES.some(pattern => pattern.test(name));
}

/** Files whose contents run code or change repository history when written. */
function isSensitiveWritePath(path: string): boolean {
	return path.replace(/\\/g, '/').toLowerCase().split('/').includes('.git');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CREDENTIAL_COMMAND_PATTERNS: readonly RegExp[] = [
	/\.env\b(?!\.(example|sample|template|dist))/i,
	/\.(ssh|aws|gnupg|kube|azure)\b/i,
	/\.docker[\\/]config/i,
	/\.(npmrc|netrc|pypirc|git-credentials|pgpass)\b/i,
	/\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
	/\.(pem|p12|pfx|jks)\b/i,
	/credentials?\.json\b/i,
	/\.claude\.json\b|\.claude[\\/]\.credentials/i,
	/\bprintenv\b/i,
	/\b(gci|get-childitem|dir|ls)\s+env:/i,
	/(^|[;&|]\s*)(env|set|export|declare\s+-x)\s*($|[|;&>])/i,
	/\$\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*\}?/i,
	/\$env:\w*(token|secret|password|key|credential)/i,
	/\bsecurity\s+(find|add|delete|dump)-(generic|internet|keychain)/i,
	/\b(cmdkey|vaultcmd|secret-tool|keychain)\b/i,
	/\bgh\s+auth\s+(token|status\s+(-t|--show-token))/i,
	/\bgit\s+credential\b/i,
	/\baws\s+configure\s+(get|list)\b/i,
	/\bnpm\s+token\b/i,
	/\bgcloud\s+auth\s+(print|application-default)/i,
	// Sign-ins store a token, so they touch credentials too (issue 452).
	/\b(gh|glab)\s+auth\s+(login|refresh|logout)\b/i,
	/\b(npm|yarn|pnpm)\s+(login|adduser|logout)\b/i,
	/\b(az|docker|podman|firebase|vercel|netlify|heroku|wrangler|fly|flyctl)\s+login\b/i,
	/\bgcloud\s+auth\s+login\b/i,
	/\baws\s+(sso\s+login|configure)\b/i,
];

const DESTRUCTIVE_COMMAND_PATTERNS: readonly RegExp[] = [
	/\brm\s/i,
	/\brmdir\b/i,
	/\b(del|erase)\s/i,
	/\brd\s+\/s/i,
	/\bRemove-Item\b/i,
	/\bformat\b/i,
	/\bmkfs/i,
	/\bdd\s+if=/i,
	/\b(shred|truncate)\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bgit\s+(checkout|restore|switch)\s+(--\s+)?\./i,
	/\bgit\s+restore\b/i,
	/\bgit\s+push\b.*(--force|--force-with-lease|\s-f\b|\s\+)/i,
	/\bgit\s+branch\s+-D\b/i,
	/\bgit\s+stash\s+(drop|clear)\b/i,
	/\bgit\s+(rebase|filter-branch|filter-repo|update-ref\s+-d)\b/i,
	/\bgit\s+reflog\s+expire\b|\bgit\s+gc\b.*--prune/i,
	/\bdrop\s+(database|table|schema)\b/i,
	/\b(chmod|chown)\s+-R\b/i,
	/\bsudo\b|\bsu\s|\bdoas\b/i,
	/\b(shutdown|reboot|halt)\b/i,
	/\breg\s+(delete|add|import)\b/i,
	/\b(kill|killall|pkill|taskkill)\b/i,
	/\|\s*(sh|bash|zsh|fish|pwsh|powershell|cmd)\b/i,
	/\b(iex|Invoke-Expression|eval)\b/i,
	/\bbase64\s+(-d|--decode)\b/i,
	/>\s*\/dev\/(sd|nvme|disk)/i,
];

const NETWORK_COMMAND_PATTERNS: readonly RegExp[] = [
	/\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
	/\bgit\s+(clone|fetch|pull|push|remote\s+update|submodule)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|publish|dlx|create|exec)\b/i,
	/\bnpx\b/i,
	/\bpip3?\s+install\b|\bpipx\b|\buv\s+(add|pip|sync|tool)\b|\bcargo\s+(install|add|update|publish)\b|\bgo\s+(get|install)\b|\bgem\s+install\b|\bbrew\s+(install|upgrade)\b|\bapt(-get)?\s+(install|update|upgrade)\b|\bdocker\s+(pull|push|run)\b|\bgh\s+\w/i,
];

/** Commands that put work where others see it: a push, a pull request, a release, a publish or a deploy (issue 1167). */
const PUBLISH_COMMAND_PATTERNS: readonly RegExp[] = [
	/\bgit\s+(-[cC]\s+\S+\s+|-\S+\s+)*push\b/i,
	/\bgh\s+(pr\s+(create|merge|ready|comment|review)|release\s+(create|upload|edit)|issue\s+(create|comment)|repo\s+create|workflow\s+run)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/i,
	/\b(vercel|netlify|firebase|fly|flyctl|wrangler|heroku)\s+(\S+\s+)*(deploy|publish|release)\b|\bvercel\b.*--prod\b|\bterraform\s+apply\b|\bkubectl\s+apply\b/i,
];

/** True when a shell command pushes, publishes or deploys. The session switches never approve it (issue 1167). */
export function isPublishCommand(command: string): boolean {
	return PUBLISH_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

export interface CommandAssessment {
	readonly risk: CommandRisk;
	/** Absolute-looking arguments: `/etc/x`, `~/x`, `C:\x`, or anything with `..`. */
	readonly pathArguments: readonly string[];
}

/**
 * First-pass classification of a shell command. Regex is only a first pass
 * (master plan section 17): the caller also weighs the tool, the target
 * paths, workspace trust, and settings. Order matters: credentials win over
 * destructive, which wins over network, which wins over read-only.
 */
export function classifyCommand(command: string): CommandAssessment {
	const pathArguments = pathArgumentsOf(command);
	if (CREDENTIAL_COMMAND_PATTERNS.some(pattern => pattern.test(command))) {
		return { risk: 'credentials', pathArguments };
	}
	if (DESTRUCTIVE_COMMAND_PATTERNS.some(pattern => pattern.test(command))) {
		return { risk: 'destructive', pathArguments };
	}
	if (NETWORK_COMMAND_PATTERNS.some(pattern => pattern.test(command))) {
		return { risk: 'network', pathArguments };
	}
	return { risk: isReadOnlyShellCommand(command) ? 'safe' : 'mutating', pathArguments };
}

function pathArgumentsOf(command: string, every = false): string[] {
	const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) ?? [];
	const paths: string[] = [];
	for (const raw of tokens) {
		let token = raw.replace(/^["']|["']$/g, '');
		const equals = token.indexOf('=');
		if (token.startsWith('-') && equals > 0) {
			token = token.slice(equals + 1);
		} else if (token.startsWith('-')) {
			continue;
		}
		if (every ? token.length > 0 : (token.startsWith('/') || token.startsWith('~') || token.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(token) || /(^|[\\/])\.\.([\\/]|$)/.test(token))) {
			paths.push(token);
		}
	}
	return paths;
}

/**
 * Every non-flag argument, relative ones too. A relative name can be a symlink
 * that leaves the workspace, so each one gets the same re-check as an absolute path.
 */
function operandsOf(command: string): string[] {
	return pathArgumentsOf(command, true);
}

// ---------------------------------------------------------------------------
// Tool requests
// ---------------------------------------------------------------------------

const TARGET_FIELDS: Readonly<Record<string, string>> = {
	Read: 'file_path',
	Write: 'file_path',
	Edit: 'file_path',
	MultiEdit: 'file_path',
	NotebookEdit: 'notebook_path',
	NotebookRead: 'notebook_path',
	Grep: 'path',
	Glob: 'path',
};

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Read tools the protocol files under `other`. They are judged by path like `Read`. */
const READ_LIKE_TOOLS: ReadonlySet<string> = new Set(['LS', 'NotebookRead']);

/** Every field a read or search tool may use to name a place on disk. */
const READ_PATH_FIELDS: readonly string[] = ['file_path', 'path', 'notebook_path', 'directory'];

/**
 * All paths a read or search request reaches: every path field, plus the fixed
 * prefix of a `Glob` pattern (`/etc/*` reaches `/etc/`).
 */
function readTargetsOf(toolName: string, input: unknown): string[] {
	const targets = new Set<string>();
	for (const field of READ_PATH_FIELDS) {
		const value = stringField(input, field);
		if (value !== undefined) {
			targets.add(value);
		}
	}
	const pattern = toolName === 'Glob' ? stringField(input, 'pattern') : undefined;
	if (pattern !== undefined) {
		if (/(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
			targets.add(pattern);
		} else {
			const wildcard = pattern.search(/[*?[{!(]/);
			const fixed = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
			const separator = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'));
			const prefix = wildcard < 0 ? fixed : fixed.slice(0, separator + 1);
			if (prefix.length > 0) {
				targets.add(prefix);
			}
		}
	}
	return [...targets];
}

function stringField(input: unknown, field: string): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

type Draft = Omit<ToolPolicyResult, 'details'> & { details: ToolPolicyResult['details'] };

const READ_ASKS_WHY = 'Automatic approval of workspace reads is turned off.';

/**
 * Decides one tool request. `allow` means the host needs no question. `ask`
 * means a person must answer. `deny` is final. The function fails closed: a
 * tool it does not know, or a request missing the field it needs, is not allowed.
 */
export async function evaluateToolPolicy(toolName: string, input: unknown, context: ToolPolicyContext): Promise<ToolPolicyResult> {
	const category = classifyTool(toolName);
	const blocked = await blockedByReadRules(toolName, category, input, context);
	if (blocked) {
		return blocked;
	}
	const draft = await evaluateCategory(toolName, category, input, context);
	return applyTrust(draft, category, toolName, context);
}

/**
 * Refuses a request that names a path on the block list (issue 458). Every path
 * field of any tool counts, MCP tools included, and every operand of a shell
 * command; each is judged as written and after symlinks. A Grep or Glob without
 * a path searches the working folder, so that folder is judged too.
 */
async function blockedByReadRules(toolName: string, category: ToolCategory, input: unknown, context: ToolPolicyContext): Promise<ToolPolicyResult | undefined> {
	const rules = context.readRules;
	if (!rules || rules.length === 0) {
		return undefined;
	}
	let targets: string[];
	if (category === 'shell') {
		const command = stringField(input, 'command');
		targets = command === undefined ? [] : operandsOf(command);
	} else {
		targets = readTargetsOf(toolName, input);
		if ((toolName === 'Grep' || toolName === 'Glob') && stringField(input, 'path') === undefined) {
			targets.push(context.cwd);
		}
	}
	for (const target of targets) {
		const expanded = context.homeDirectory && (target === '~' || target.startsWith('~/') || target.startsWith('~\\'))
			? context.homeDirectory + target.slice(1)
			: target;
		const absolute = canonicalizePath(expanded, context.cwd);
		const real = context.realpath ? await resolveRealPath(absolute, context.realpath) : undefined;
		const verdict = isReadBlocked(rules, { absolute, real });
		if (verdict.blocked) {
			const why = 'This file is on the list of files Claude cannot read.';
			return deny({ category }, absolute, toolName, why, `Denied by the IDE: ${absolute} is on the user's list of files Claude cannot read or change. Do not try again or work around it (${toolName}).`);
		}
	}
	return undefined;
}

async function evaluateCategory(toolName: string, category: ToolCategory, input: unknown, context: ToolPolicyContext): Promise<Draft> {
	const { policy } = context;
	const base = { category };
	if (category === 'shell') {
		const command = stringField(input, 'command');
		if (command === undefined) {
			return refuse(toolName, base, 'The command is missing, so the IDE cannot judge it.', toolName);
		}
		return evaluateShell(toolName, command, context);
	}

	const targetField = TARGET_FIELDS[toolName];
	const rawTarget = targetField ? stringField(input, targetField) : undefined;

	if (WRITE_TOOLS.has(toolName) || category === 'write') {
		if (rawTarget === undefined) {
			return refuse(toolName, base, 'The file path is missing, so the IDE cannot judge it.', toolName);
		}
		const assessed = await assessPath(rawTarget, context);
		const grantKey = `${toolName}\n${assessed.absolute}`;
		if (context.mode === 'ask') {
			const askDetails = { ...base, targetPath: assessed.absolute, outsideWorkspace: !assessed.inside };
			return modeDeny(askDetails, assessed.absolute, grantKey, 'Ask mode never changes files.', `Denied by the IDE: Ask mode never changes files (${toolName} ${assessed.absolute}). Nothing was changed and the mode was not switched. Answer without editing; the user can switch to Agent to allow changes.`);
		}
		// Computed in every mode, also inside the workspace: a workspace can contain the plan folders.
		const location = await assessPlanFile(assessed, context);
		if (context.mode === 'plan' && location === undefined) {
			const planDetails = { ...base, targetPath: assessed.absolute, outsideWorkspace: !assessed.inside };
			return modeDeny(planDetails, assessed.absolute, grantKey, 'Plan mode only writes plan files.', `Denied by the IDE: Plan mode only writes plan files (*${PLAN_FILE_SUFFIX}, ${KLAWLY_PLANS_FOLDER}/, Klawly's plan folder, or Claude's plan folder), not ${assessed.absolute}. Nothing was changed and the mode was not switched. Put the plan in your reply or in a plan file. Press Build to run the plan in Agent mode, or switch the mode yourself.`);
		}
		// Klawly's and Claude Code's plan folders are outside the workspace, but
		// Plan mode writes its plan there, and Build ticks the to-dos of a plan in
		// Klawly's folder, so they count as the workspace.
		const planFolder = location === 'klawly' || location === 'claude' ? location : undefined;
		const inside = assessed.inside || (planFolder !== undefined && (context.mode === 'plan' || planFolder === 'klawly'));
		const details = { ...base, targetPath: assessed.absolute, outsideWorkspace: !inside };
		const result = (draft: Draft): Draft => planFolder ? { ...draft, planFile: planFolder } : draft;
		if (isCredentialPath(assessed.absolute) || isCredentialPath(assessed.real)) {
			return ask(details, assessed.absolute, grantKey, false, 'This file holds credentials. The IDE never approves it automatically.', 'credentials');
		}
		if (!inside) {
			const why = assessed.escapesViaSymlink
				? `A symbolic link leads outside the workspace to ${assessed.real}.`
				: 'This file is outside the workspace.';
			if (policy.writeOutsideWorkspace === 'deny') {
				return deny(details, assessed.absolute, grantKey, why, `Denied by the IDE: writing outside the workspace is turned off (${assessed.absolute}). Nothing was changed.`);
			}
			return result(ask(details, assessed.absolute, grantKey, false, why));
		}
		if (isSensitiveWritePath(assessed.absolute) || isSensitiveWritePath(assessed.real)) {
			return ask(details, assessed.absolute, grantKey, false, 'This path is inside .git, where a write can run code or rewrite history.');
		}
		// In Plan mode the plan file is the turn's output, and Plan mode writes nothing else.
		if (policy.writeWorkspace === 'allow' || (context.mode === 'plan' && planFolder)) {
			return result(allow(details, assessed.absolute, grantKey));
		}
		return result(ask(details, assessed.absolute, grantKey, true, planFolder ? 'Claude wants to update the plan file.' : 'Claude wants to change a file in the workspace.'));
	}

	if (category === 'read' || category === 'search' || READ_LIKE_TOOLS.has(toolName)) {
		let first: PathAssessment | undefined;
		let unreadable: PathAssessment | undefined;
		for (const target of readTargetsOf(toolName, input)) {
			const found = await assessTarget(target, context);
			first ??= found;
			if (isCredentialPath(found.absolute) || isCredentialPath(found.real)) {
				const credentialDetails = { ...base, targetPath: found.absolute, outsideWorkspace: !found.inside };
				return ask(credentialDetails, found.absolute, `${toolName}\n${found.absolute}`, false, 'This file holds credentials. The IDE never approves it automatically.', 'credentials');
			}
			if (!found.readable && await assessPlanFile(found, context) !== 'klawly') {
				unreadable ??= found;
			}
		}
		if (!first) {
			// Grep, Glob, and LS without a path search the session directory.
			const cwdKey = `${toolName}\n${context.cwd}`;
			return policy.readWorkspace === 'ask'
				? ask({ ...base, targetPath: context.cwd, outsideWorkspace: false }, context.cwd, cwdKey, true, READ_ASKS_WHY)
				: allow({ ...base }, context.cwd, cwdKey);
		}
		const assessed = unreadable ?? first;
		const details = { ...base, targetPath: assessed.absolute, outsideWorkspace: !assessed.inside };
		const grantKey = `${toolName}\n${assessed.absolute}`;
		if (!unreadable) {
			return policy.readWorkspace === 'ask'
				? ask(details, assessed.absolute, grantKey, true, READ_ASKS_WHY)
				: allow(details, assessed.absolute, grantKey);
		}
		return ask(details, assessed.absolute, grantKey, true, assessed.escapesViaSymlink
			? `A symbolic link leads outside the workspace to ${assessed.real}.`
			: 'This path is outside the workspace.');
	}

	if (category === 'web') {
		const subject = stringField(input, 'url') ?? stringField(input, 'query') ?? toolName;
		const grantKey = `${toolName}\n${subject}`;
		const details = { ...base, command: subject };
		// Plan and Ask research without a card (Phase 27). A setting that denies the network still wins.
		const network = (context.mode === 'plan' || context.mode === 'ask') && policy.network === 'ask' ? 'allow' : policy.network;
		switch (network) {
			case 'allow': return allow(details, subject, grantKey);
			case 'deny': return deny(details, subject, grantKey, 'Network access is turned off.', `Denied by the IDE: network access is turned off (${toolName}). Nothing was fetched.`);
			default: return ask(details, subject, grantKey, true, 'Claude wants to use the network.');
		}
	}

	if (category === 'skill' || NON_MUTATING_TOOLS.has(toolName)) {
		return allow({ ...base }, toolName, toolName);
	}

	// Klawly's own settings change (issue 525): every change asks, naming the setting and the value, and a blocked setting never changes here.
	if (toolName === CLAUDE_SETTINGS_SET_TOOL_ID) {
		const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
		const subject = claudeSettingsChangeSubject(record);
		if (!subject) {
			return refuse(toolName, base, 'The setting key is missing.', toolName);
		}
		const key = String(record.key).trim();
		if (isClaudeBlockedSetting(key)) {
			return deny({ ...base, command: subject }, subject, `${toolName}\n${subject}`, 'This setting can only be changed in Settings.', `Denied by the IDE: ${key} controls permissions, trust or what leaves the machine, so Claude cannot change it. Ask the user to change it in Settings.`);
		}
		return ask({ ...base, command: subject }, subject, `${toolName}\n${subject}`, false, 'Claude wants to change a Klawly setting.');
	}

	// The Agent Browser (issue 466): localhost opens freely; any other address follows the network setting. Actions on a page that is already open run without a card.
	if (toolName === CLAUDE_BROWSER_TOOL_ID) {
		const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
		const action = stringField(record, 'action') ?? 'screenshot';
		const url = stringField(record, 'url');
		const details = { ...base, command: url ? `${action} ${url}` : action, ...(url && !isClaudeBrowserLocalUrl(url) ? { agentBrowser: true } : {}) };
		if (!url || isClaudeBrowserLocalUrl(url)) {
			return allow(details, details.command, `${toolName}\n${action}`);
		}
		const grantKey = `${toolName}\n${url}`;
		switch (policy.network) {
			case 'allow': return allow(details, url, grantKey);
			case 'deny': return deny(details, url, grantKey, 'Network access is turned off.', `Denied by the IDE: network access is turned off. The browser did not open ${url}.`);
			default: return ask(details, url, grantKey, true, 'Claude wants to open a page outside this machine in the Agent Browser.');
		}
	}

	// MCP tools and every tool this version does not know.
	return ask({ ...base }, toolName, toolName, true, category === 'mcp'
		? 'This tool comes from an MCP server. The IDE cannot tell what it changes.'
		: 'The IDE does not recognise this tool, so it cannot tell what it changes.');
}

async function evaluateShell(toolName: string, command: string, context: ToolPolicyContext): Promise<Draft> {
	const { policy } = context;
	const assessment = classifyCommand(command);
	const grantKey = `${toolName}\n${command}`;
	const publishes = isPublishCommand(command);
	const base = { category: 'shell' as const, command, cwd: context.cwd, risk: assessment.risk, ...publishes ? { publishes } : {} };

	let outside: string | undefined;
	for (const argument of new Set([...assessment.pathArguments, ...operandsOf(command)])) {
		const assessed = await assessTarget(argument, context);
		if (!assessed.readable) {
			outside = assessed.absolute;
			break;
		}
	}
	const details = outside === undefined ? base : { ...base, targetPath: outside, outsideWorkspace: true };

	switch (assessment.risk) {
		case 'credentials':
			return ask(details, command, grantKey, false, 'This command can read or change credentials. The IDE never approves it automatically.', 'credentials');
		case 'destructive':
			if (policy.shellDestructive === 'deny') {
				return deny(details, command, grantKey, 'This command can delete data or rewrite history.', 'Denied by the IDE: destructive commands are turned off. Nothing was run.');
			}
			return ask(details, command, grantKey, false, 'This command can delete data or rewrite history.');
		case 'network':
			if (policy.network === 'deny') {
				return deny(details, command, grantKey, 'Network access is turned off.', 'Denied by the IDE: network access is turned off. Nothing was run.');
			}
			if (publishes) {
				return ask(details, command, grantKey, true, 'This command pushes, publishes or deploys.');
			}
			if (policy.network === 'allow' && outside === undefined) {
				return allow(details, command, grantKey);
			}
			return ask(details, command, grantKey, true, 'This command uses the network.');
		case 'safe':
			if (outside !== undefined) {
				return ask(details, command, grantKey, true, 'This command reads outside the workspace.');
			}
			return policy.shellSafe === 'allow'
				? allow(details, command, grantKey)
				: ask(details, command, grantKey, true, 'Claude wants to run a command.');
		default:
			return ask(details, command, grantKey, true, outside === undefined ? 'Claude wants to run a command.' : 'This command touches a path outside the workspace.');
	}
}

/** A setting that loosens the policy never applies in an untrusted workspace. */
function applyTrust(draft: Draft, category: ToolCategory, toolName: string, context: ToolPolicyContext): ToolPolicyResult {
	if (context.trusted || draft.behavior === 'deny') {
		return draft;
	}
	const needsTrust = category === 'write' || category === 'shell' || category === 'web' || category === 'mcp'
		|| WRITE_TOOLS.has(toolName)
		|| (category === 'other' && !NON_MUTATING_TOOLS.has(toolName) && !READ_LIKE_TOOLS.has(toolName));
	if (!needsTrust) {
		return draft;
	}
	if (draft.behavior === 'ask') {
		return draft.canRemember ? { ...draft, canRemember: false } : draft;
	}
	return { ...draft, behavior: 'ask', canRemember: false, why: 'This workspace is not trusted. Approve this one action, or trust the workspace first.' };
}

function allow(details: Draft['details'], subject: string, grantKey: string): Draft {
	return { behavior: 'allow', details, subject, grantKey, canRemember: true, why: '' };
}

function ask(details: Draft['details'], subject: string, grantKey: string, canRemember: boolean, why: string, risk?: CommandRisk): Draft {
	return { behavior: 'ask', details: risk ? { ...details, risk } : details, subject, grantKey, canRemember, why };
}

function deny(details: Draft['details'], subject: string, grantKey: string, why: string, message: string): Draft {
	return { behavior: 'deny', details, subject, grantKey, canRemember: false, why, message };
}

function modeDeny(details: Draft['details'], subject: string, grantKey: string, why: string, message: string): Draft {
	return { ...deny(details, subject, grantKey, why, message), modeDenial: true };
}

function refuse(toolName: string, base: Draft['details'], why: string, subject: string): Draft {
	return deny(base, subject, toolName, why, `Denied by the IDE: ${why} (${toolName}).`);
}
