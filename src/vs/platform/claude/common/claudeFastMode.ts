/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Why fast mode is unavailable, in words the UI can show. `other` keeps the runtime's own text. */
export type ClaudeFastModeReason = 'rate-limit' | 'overloaded' | 'not-enabled' | 'billing' | 'model' | 'other';

/**
 * The real state of fast mode, as Claude Code reports it (issue 456):
 * `on` runs at fast speed, `cooldown` fell back to standard speed for a while,
 * `unavailable` cannot be used at all, and `off` is the setting being switched off.
 */
export type ClaudeFastModeStatus =
	| { readonly state: 'off' }
	| { readonly state: 'on' }
	| { readonly state: 'cooldown'; /** When fast mode returns, in ms since the epoch, if Claude Code said. */ readonly resumesAt?: number }
	| { readonly state: 'unavailable'; readonly reason: ClaudeFastModeReason; /** The runtime's own words, when it gave some. */ readonly detail?: string };

/** The fields of an SDK message that describe fast mode. */
export interface ClaudeFastModeFields {
	readonly fast_mode_state?: unknown;
	readonly fast_mode_disabled_reason?: unknown;
	readonly fast_mode_cooldown_until?: unknown;
	readonly fast_mode_resets_at?: unknown;
	readonly fast_mode_cooldown_expires_at?: unknown;
}

/** Reads a time given as epoch seconds, epoch milliseconds or an ISO string, as ms since the epoch. */
function readTime(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		// Seconds since the epoch stay below 1e11 until the year 5138.
		return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function readReason(value: unknown): { reason: ClaudeFastModeReason; detail?: string } {
	const text = typeof value === 'string' ? value.trim() : '';
	const key = text.toLowerCase().replace(/[\s-]+/g, '_');
	if (/rate_?limit|cooldown|too_many/.test(key)) {
		return { reason: 'rate-limit' };
	}
	if (/overload/.test(key)) {
		return { reason: 'overloaded' };
	}
	if (/not_?enabled|disabled_by|org|admin|policy|extra_usage|not_?allowed/.test(key)) {
		return { reason: 'not-enabled' };
	}
	if (/billing|credit|payment|quota|balance/.test(key)) {
		return { reason: 'billing' };
	}
	if (/model|unsupported|not_?supported/.test(key)) {
		return { reason: 'model' };
	}
	return text ? { reason: 'other', detail: text } : { reason: 'other' };
}

/**
 * Turns the SDK's `fast_mode_state` and `fast_mode_disabled_reason` into one status,
 * or `undefined` when the message says nothing about fast mode. Raw SDK values never leave
 * the protocol: an unknown state with a reason reads as unavailable, one without as off.
 */
export function normalizeClaudeFastMode(fields: ClaudeFastModeFields): ClaudeFastModeStatus | undefined {
	const rawState = typeof fields.fast_mode_state === 'string' ? fields.fast_mode_state.trim().toLowerCase() : '';
	const hasReason = typeof fields.fast_mode_disabled_reason === 'string' && fields.fast_mode_disabled_reason.trim() !== '';
	if (!rawState && !hasReason) {
		return undefined;
	}
	switch (rawState) {
		case 'on':
		case 'active':
		case 'enabled':
			return { state: 'on' };
		case 'cooldown':
		case 'cooling_down': {
			const resumesAt = readTime(fields.fast_mode_cooldown_until) ?? readTime(fields.fast_mode_resets_at) ?? readTime(fields.fast_mode_cooldown_expires_at);
			return resumesAt === undefined ? { state: 'cooldown' } : { state: 'cooldown', resumesAt };
		}
		case 'unavailable':
		case 'disabled': {
			const { reason, detail } = readReason(fields.fast_mode_disabled_reason);
			return detail === undefined ? { state: 'unavailable', reason } : { state: 'unavailable', reason, detail };
		}
		case 'off':
			return hasReason ? { state: 'unavailable', ...readReason(fields.fast_mode_disabled_reason) } : { state: 'off' };
		default: {
			if (hasReason) {
				return { state: 'unavailable', ...readReason(fields.fast_mode_disabled_reason) };
			}
			return rawState ? { state: 'off' } : undefined;
		}
	}
}

/** True when two statuses read the same, so the same state is not announced twice. */
export function sameClaudeFastModeStatus(a: ClaudeFastModeStatus | undefined, b: ClaudeFastModeStatus | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	if (a.state !== b.state) {
		return false;
	}
	if (a.state === 'unavailable' && b.state === 'unavailable') {
		return a.reason === b.reason && a.detail === b.detail;
	}
	return true;
}
