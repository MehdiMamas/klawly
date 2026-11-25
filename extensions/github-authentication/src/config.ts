/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IConfig {
	// The client ID of the GitHub OAuth app
	gitHubClientId: string;
	gitHubClientSecret?: string;
}

// For easy access to mixin client ID and secret
//
// NOTE: GitHub client secrets cannot be secured when running in a native client so in other words, the client secret is
// not really a secret... so we allow the client secret in code. It is brought in before we publish VS Code. Reference:
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#client-secrets
export const Config: IConfig = {
	gitHubClientId: '01ab8ac9400c4e429b23'
};

/**
 * Klawly (issue 446): Klawly signs in with its own GitHub OAuth App ("Klawly", device flow, no
 * client secret), whose client ID is `klawlyGitHubClientId` in product.json, so GitHub shows users
 * Klawly as the app they authorize. Without it the upstream client ID above stays.
 */
export function applyProductClientId(product: { readonly klawlyGitHubClientId?: unknown } | undefined): void {
	if (typeof product?.klawlyGitHubClientId === 'string' && /^[\w.-]+$/.test(product.klawlyGitHubClientId)) {
		Config.gitHubClientId = product.klawlyGitHubClientId;
	}
}
