/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentFailureKind } from '../common/claudeProtocol.js';

export interface ClassifiedAgentFailure {
	readonly kind: AgentFailureKind;
	readonly message: string;
}

const ASSISTANT_ERROR_KINDS: Readonly<Record<string, AgentFailureKind>> = {
	authentication_failed: 'auth',
	oauth_org_not_allowed: 'auth',
	account_on_hold: 'auth',
	verification_required: 'auth',
	cloud_credential_error: 'auth',
	billing_error: 'usage-limit',
	rate_limit: 'usage-limit',
	server_error: 'unknown',
	invalid_request: 'unknown',
	model_not_found: 'unknown',
	overloaded: 'unknown',
	unknown: 'unknown',
	max_output_tokens: 'unknown',
};

export function classifyAssistantError(error: string | undefined): AgentFailureKind | undefined {
	if (!error) {
		return undefined;
	}
	return ASSISTANT_ERROR_KINDS[error] ?? 'unknown';
}

export function classifyAgentFailure(error: unknown): ClassifiedAgentFailure {
	const message = errorMessage(error);
	const kind = kindFromMessage(message);
	return { kind, message: message || 'Claude stopped unexpectedly.' };
}

export function failureMessage(kind: AgentFailureKind, detail?: string): string {
	switch (kind) {
		case 'auth':
			return 'Claude is not signed in.';
		case 'usage-limit':
			return 'Claude reached its current usage limit.';
		case 'network':
			return 'Claude could not reach the network.';
		case 'runtime-missing':
			return 'Claude Code is not installed.';
		case 'runtime-version':
			return detail || 'This Claude Code version cannot run.';
		case 'permission-denied':
			return 'Claude was denied permission for that action.';
		case 'tool-failure':
			return 'A Claude tool failed.';
		case 'process-crash':
			return 'The Claude process stopped.';
		case 'workspace-conflict':
			return 'Claude could not use this workspace.';
		case 'session-owned':
			return 'This chat is already running in another window. Follow it there, or wait for it to finish.';
		case 'turn-limit':
			return detail || 'Claude stopped at its turn limit.';
		case 'unknown':
			return detail || 'Claude stopped unexpectedly.';
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

function kindFromMessage(message: string): AgentFailureKind {
	const text = message.toLowerCase();
	if (!text) {
		return 'unknown';
	}
	if (text.includes('enoent') && text.includes('claude')) {
		return 'runtime-missing';
	}
	if (text.includes('authentication') || text.includes('not logged') || text.includes('unauthorized') || text.includes('401') || text.includes('sign in')) {
		return 'auth';
	}
	if (text.includes('usage limit') || text.includes('rate limit') || text.includes('429') || text.includes('quota')) {
		return 'usage-limit';
	}
	if (text.includes('econnreset') || text.includes('enotfound') || text.includes('etimedout') || text.includes('network') || text.includes('fetch failed') || text.includes('socket')) {
		return 'network';
	}
	if (text.includes('incompatible') && text.includes('version')) {
		return 'runtime-version';
	}
	if (text.includes('permission') && text.includes('denied')) {
		return 'permission-denied';
	}
	if (text.includes('workspace') && (text.includes('conflict') || text.includes('unavailable'))) {
		return 'workspace-conflict';
	}
	if (text.includes('sigkill') || text.includes('sigterm') || text.includes('process exited') || text.includes('crashed')) {
		return 'process-crash';
	}
	return 'unknown';
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return '';
}
