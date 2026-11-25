/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as electron from 'electron';
import { createUpdateURL, getUpdateRequestHeaders, IUpdateURLOptions } from '../../update/electron-main/abstractUpdateService.js';
import { DarwinUpdateService } from '../../update/electron-main/updateService.darwin.js';
import { darwinUpdatePlatform } from '../common/claudeRelease.js';

/**
 * macOS updates for Klawly (issue 1212). Upstream's Squirrel.Mac service downloads the new app in
 * the background and installs it on Restart to Update; the Mac build is Developer ID signed and
 * notarized (issue 479), which Squirrel needs. The only difference is the feed platform: it asks the
 * relay for the app's zip (`darwin-arm64-zip`, `darwin-zip`), since Squirrel installs from a zip
 * and the relay keeps serving the dmg to older apps (docs/relay.md).
 */
export class DarwinSquirrelUpdateService extends DarwinUpdateService {

	protected override buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		const platform = darwinUpdatePlatform(process.arch, this.productService.darwinUniversalAssetId, true);
		const url = createUpdateURL(this.productService.updateUrl!, platform, quality, commit, options);
		try {
			electron.autoUpdater.setFeedURL({ url, headers: getUpdateRequestHeaders(this.productService.version) });
		} catch (e) {
			this.logService.error('Failed to set update feed URL', e);
			return undefined;
		}
		return url;
	}
}
