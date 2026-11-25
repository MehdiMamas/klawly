/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential shapes shared by log redaction (`redactSecrets` in the workbench
 * agent log) and the attachment secret scanner (master plan sections 41 and 51).
 * Detection is a best effort that reduces damage. It is never complete.
 */
export interface ClaudeSecretPattern {
	/** Stable name, such as `aws-access-key`. */
	readonly id: string;
	/**
	 * Global regular expression with the `d` flag. When it has a named group
	 * `secret`, only that group is the secret and the rest of the match (a key
	 * name, `Bearer `, PEM armor lines) stays readable. Otherwise the whole
	 * match is the secret.
	 */
	readonly pattern: RegExp;
	/**
	 * Log redaction only. Set on loose key/value shapes that would flag ordinary
	 * source code (`password: string`, `const API_TOKEN = read()`), so the
	 * attachment scanner skips them. Redaction still applies every pattern.
	 */
	readonly logOnly?: boolean;
	/** Scanner only: a shorter secret is not reported. Redaction ignores it. */
	readonly scanMinLength?: number;
}

/** Where one secret sits in a text. `end` is exclusive. */
export interface ClaudeSecretSpan {
	readonly id: string;
	readonly start: number;
	readonly end: number;
}

/** Replacement text for a redacted secret. */
export const CLAUDE_REDACTED = '[redacted]';

/**
 * Redaction applies these in order, each to the output of the one before. The
 * order matters: a PEM body is removed before its base64 lines can match
 * anything else, and `sk-ant-` is matched before the shorter `sk-` rule.
 */
export const CLAUDE_SECRET_PATTERNS: readonly ClaudeSecretPattern[] = [
	// A block cut off before its END line (a clipped log) is covered to the end of the text.
	{ id: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?<secret>[\s\S]+?)(?=-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gd },
	{ id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gd },
	// `scheme://user:password@host`. A `${VAR}`, `<placeholder>` or `%s` password is not a secret.
	{ id: 'connection-string-url', pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@'"`]+:(?<secret>(?![$<{%])[^\s@/'"`]+)@/gd },
	// `Server=...;User Id=...;Password=...;` (ADO.NET, ODBC and JDBC property strings).
	{ id: 'connection-string-password', pattern: /(?<=;[ \t]*)(?:password|pwd)[ \t]*=[ \t]*(?<secret>(?![$<{%])[^;'"`\r\n]*[^;'"`\s])/gid },
	{ id: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]+/gd },
	// Personal (ghp_), OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_) and refresh (ghr_) tokens.
	{ id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gd },
	{ id: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]+/gd },
	{ id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gd },
	{ id: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/gd },
	{ id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/gd },
	{ id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gd },
	// Long-term (AKIA) and temporary STS (ASIA) access key ids.
	{ id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gd },
	{ id: 'bearer-token', pattern: /Bearer\s+(?<secret>[A-Za-z0-9._~+/-]+=*)/gid, scanMinLength: 16 },
	{ id: 'env-assignment', pattern: /\b(?:(?:[A-Za-z0-9]+_)+(?:API_KEY|AUTH_TOKEN|TOKEN)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY)\s*=\s*(?<secret>\S+)/gd, logOnly: true },
	// One `.env` line, `[export ]NAME=value`, where NAME holds SECRET, TOKEN, PASSWORD
	// or PASSWD, or ends in _KEY, _PASS or _PWD. The value runs to the end of the line
	// (a closing quote or a `#` comment may follow), so code such as
	// `API_KEY = os.environ["X"]` does not match. Placeholders, empty values, public
	// keys and names of files, paths and URLs are skipped.
	{ id: 'dotenv-assignment', pattern: /^[ \t]*(?:export[ \t]+)?(?![A-Z0-9_]*PUBLIC)(?![A-Z0-9_]*_(?:FILE|PATH|DIR|URL|NAME|LENGTH|HEADER|TYPE|ENABLED|ID)[ \t]*=)(?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|_KEY|_PASS|_PWD)(?:_[A-Z0-9_]*)?[ \t]*=)[A-Z][A-Z0-9_]*[ \t]*=[ \t]*["']?(?<secret>(?![$<{%])(?!(?:None|null|undefined|true|false|nil|changeme|x+|\*+)["']?[ \t]*(?:#.*)?$)[^\r\n"'#]*[^\s"'#])["']?[ \t]*(?:#.*)?$/gmd },
	{ id: 'key-value', pattern: /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)\b\s*[:=]\s*(?<secret>\S+)/gid, logOnly: true },
	{ id: 'json-key-value', pattern: /"(?:api[_-]?key|token|access[_-]?token|password|secret)"\s*:\s*"(?<secret>[^"\\]*)"/gid },
];

/** Every place `entry` finds a secret in `text`, in order. Empty secrets are skipped. */
export function findClaudeSecretSpans(text: string, entry: ClaudeSecretPattern): ClaudeSecretSpan[] {
	const spans: ClaudeSecretSpan[] = [];
	for (const match of text.matchAll(entry.pattern)) {
		const range = match.indices?.groups?.secret ?? match.indices?.[0];
		if (range && range[1] > range[0]) {
			spans.push({ id: entry.id, start: range[0], end: range[1] });
		}
	}
	return spans;
}

/** Replaces `spans` (sorted, not overlapping) in `text` with {@link CLAUDE_REDACTED}. */
export function replaceClaudeSecretSpans(text: string, spans: readonly ClaudeSecretSpan[]): string {
	let result = '';
	let last = 0;
	for (const span of spans) {
		result += text.slice(last, span.start) + CLAUDE_REDACTED;
		last = span.end;
	}
	return result + text.slice(last);
}

/** Runs every pattern in order and replaces each secret with {@link CLAUDE_REDACTED}. */
export function redactClaudeSecrets(text: string): string {
	let result = text;
	for (const entry of CLAUDE_SECRET_PATTERNS) {
		const spans = findClaudeSecretSpans(result, entry);
		if (spans.length > 0) {
			result = replaceClaudeSecretSpans(result, spans);
		}
	}
	return result;
}
