/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKlawlySyncHttp, KlawlySyncHttpResponse } from '../common/klawlySyncDeviceFlow.js';

/** Sends a request. Defaults to the global `fetch`; tests pass a loopback server's fetch. */
export type KlawlySyncFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { forEach(callback: (value: string, key: string) => void): void }; text(): Promise<string> }>;

/**
 * The real transport for Klawly Sync: JSON in, JSON out, over HTTPS. Only GitHub hosts are
 * reachable, so a wrong URL can never send the token elsewhere. A body that is not JSON comes
 * back as its text.
 */
export class KlawlySyncNodeHttp implements IKlawlySyncHttp {

	constructor(
		private readonly _fetch: KlawlySyncFetch = (url, init) => fetch(url, init),
		private readonly _allowedHosts: readonly string[] = ['api.github.com', 'github.com'],
	) { }

	async request(method: 'GET' | 'POST' | 'PATCH', url: string, headers: Readonly<Record<string, string>>, body?: unknown): Promise<KlawlySyncHttpResponse> {
		const host = new URL(url).hostname;
		if (!this._allowedHosts.includes(host)) {
			throw new Error(`Klawly Sync does not talk to ${host}.`);
		}
		const sent: Record<string, string> = { 'User-Agent': 'Klawly-Sync', ...headers };
		if (body !== undefined) {
			sent['Content-Type'] = 'application/json';
		}
		const response = await this._fetch(url, { method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body) });
		const raw = await response.text();
		let parsed: unknown = raw;
		try {
			parsed = raw === '' ? undefined : JSON.parse(raw);
		} catch {
			// not JSON: keep the text
		}
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
		return { status: response.status, headers: responseHeaders, body: parsed };
	}
}
