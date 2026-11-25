/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The client ID of the GitHub App "Klawly Sync". A client ID is public. The app has no client
 * secret and no private key, and none may be added: sign-in is the device flow and the app's
 * tokens do not expire. The app can read and write Contents, and read Metadata, only in the
 * repos the user installs it on, which is why Klawly does not ask for the OAuth `repo` scope.
 */
export const KLAWLY_SYNC_GITHUB_APP_CLIENT_ID = 'Iv23lijm3L8bSxBkj6V4';

/** One HTTP answer, as far as Klawly Sync reads it. */
export interface KlawlySyncHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
}

/** Sends one request. Injected, so tests never reach the network and the platform picks the transport. */
export interface IKlawlySyncHttp {
	request(method: 'GET' | 'POST' | 'PATCH', url: string, headers: Readonly<Record<string, string>>, body?: unknown): Promise<KlawlySyncHttpResponse>;
}

export interface KlawlyDeviceCode {
	readonly deviceCode: string;
	/** The code the user types at `verificationUri`. */
	readonly userCode: string;
	readonly verificationUri: string;
	/** Seconds between polls. */
	readonly interval: number;
	/** Seconds until the code stops working. */
	readonly expiresIn: number;
}

function field(body: unknown, key: string): unknown {
	return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

function text(body: unknown, key: string): string | undefined {
	const value = field(body, key);
	return typeof value === 'string' ? value : undefined;
}

/** Step 1 of the device flow: asks GitHub for a code the user enters in the browser. */
export async function requestKlawlyDeviceCode(http: IKlawlySyncHttp, clientId = KLAWLY_SYNC_GITHUB_APP_CLIENT_ID): Promise<KlawlyDeviceCode> {
	const response = await http.request('POST', 'https://github.com/login/device/code', { Accept: 'application/json' }, { client_id: clientId });
	const deviceCode = text(response.body, 'device_code');
	const userCode = text(response.body, 'user_code');
	const verificationUri = text(response.body, 'verification_uri');
	if (response.status !== 200 || !deviceCode || !userCode || !verificationUri) {
		throw new Error(text(response.body, 'error_description') ?? `GitHub did not start the sign-in (HTTP ${response.status}).`);
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		interval: Number(field(response.body, 'interval')) || 5,
		expiresIn: Number(field(response.body, 'expires_in')) || 900,
	};
}

export type KlawlyDeviceFlowResult =
	| { readonly kind: 'token'; readonly accessToken: string }
	| { readonly kind: 'denied' }
	| { readonly kind: 'expired' };

/**
 * Step 2: polls until the user approves, denies, or the code runs out. `slow_down` adds 5 s to
 * the interval, as GitHub asks. `sleep` is injected so tests do not wait.
 */
export async function pollKlawlyDeviceToken(http: IKlawlySyncHttp, code: KlawlyDeviceCode, sleep: (ms: number) => Promise<void>, clientId = KLAWLY_SYNC_GITHUB_APP_CLIENT_ID): Promise<KlawlyDeviceFlowResult> {
	let interval = code.interval;
	let waited = 0;
	while (waited <= code.expiresIn) {
		await sleep(interval * 1000);
		waited += interval;
		const response = await http.request('POST', 'https://github.com/login/oauth/access_token', { Accept: 'application/json' }, {
			client_id: clientId,
			device_code: code.deviceCode,
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		});
		const accessToken = text(response.body, 'access_token');
		if (accessToken) {
			return { kind: 'token', accessToken };
		}
		switch (text(response.body, 'error')) {
			case 'authorization_pending':
				break;
			case 'slow_down':
				interval = Number(field(response.body, 'interval')) || interval + 5;
				break;
			case 'access_denied':
				return { kind: 'denied' };
			case 'expired_token':
				return { kind: 'expired' };
			default:
				throw new Error(text(response.body, 'error_description') ?? `GitHub refused the sign-in (HTTP ${response.status}).`);
		}
	}
	return { kind: 'expired' };
}
