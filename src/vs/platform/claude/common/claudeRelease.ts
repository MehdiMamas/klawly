/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';

/**
 * Klawly prereleases (issue 475): alphas, tagged `v<version>-alpha.<n>`, then betas, tagged
 * `v<version>-beta.<n>`. Packaging stamps `klawlyRelease: "alpha.<n>"` or `"beta.<n>"` into
 * `product.json` and keeps the semver `version`, which extensions check. The update feed (the
 * relay, `docs/relay.md`) sends `<version>-<stage>.<n>` as the product version of an update.
 * Users see both as "1.141.0 Alpha 8" or "1.141.0 Beta 1".
 */

const RELEASE_TAG = /^v(?<version>\d+\.\d+\.\d+)-(?<stage>alpha|beta)\.(?<number>\d+)$/;
const RELEASE_PRODUCT_VERSION = /^(?<version>\d+\.\d+\.\d+)-(?<release>(?:alpha|beta)\.\d+)$/;
const RELEASE = /^(?<stage>alpha|beta)\.(?<number>\d+)$/;

/** Reads a release tag such as `v1.141.0-alpha.8` into `{ version: '1.141.0', release: 'alpha.8' }`. */
export function parseReleaseTag(tag: string): { readonly version: string; readonly release: string } | undefined {
	const groups = RELEASE_TAG.exec(tag.trim())?.groups;
	return groups ? { version: groups.version, release: `${groups.stage}.${Number(groups.number)}` } : undefined;
}

/** The version users see: `1.141.0 Alpha 8` or `1.141.0 Beta 1` for a prerelease build, else the plain version. */
export function formatReleaseVersion(version: string, release: string | undefined): string {
	const groups = release ? RELEASE.exec(release)?.groups : undefined;
	if (!groups) {
		return version;
	}
	return groups.stage === 'beta'
		? localize('klawlyBetaVersion', "{0} Beta {1}", version, Number(groups.number))
		: localize('klawlyAlphaVersion', "{0} Alpha {1}", version, Number(groups.number));
}

/** An update's product version as users see it: `1.141.0-alpha.8` reads `1.141.0 Alpha 8`. */
export function formatProductVersion(productVersion: string): string {
	const groups = RELEASE_PRODUCT_VERSION.exec(productVersion)?.groups;
	return groups ? formatReleaseVersion(groups.version, groups.release) : productVersion;
}

/**
 * The platform macOS sends to the update feed, as upstream's Squirrel service does: the
 * universal build's asset id when there is one, `darwin` on Intel, `darwin-arm64` on Apple silicon.
 * With `zip` it adds `-zip`, which asks the feed for the app's zip (in-place install) instead of the dmg.
 */
export function darwinUpdatePlatform(arch: string, universalAssetId: string | undefined, zip = false): string {
	const platform = universalAssetId ?? (arch === 'x64' ? 'darwin' : 'darwin-arm64');
	return zip ? `${platform}-zip` : platform;
}

/** The independence notice shown in the About box (issue 1654). */
export function anthropicNotice(): string {
	return localize('anthropicNotice', "Klawly is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.");
}
