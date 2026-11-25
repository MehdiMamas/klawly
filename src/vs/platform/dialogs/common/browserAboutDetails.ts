/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { localize } from '../../../nls.js';
import { CLAUDE_PROTOCOL_VERSION } from '../../claude/common/claudeProtocol.js';
import { anthropicNotice, formatReleaseVersion } from '../../claude/common/claudeRelease.js';
import { IProductService } from '../../product/common/productService.js';

export function createBrowserAboutDialogDetails(productService: IProductService, userAgent: string): { title: string; details: string; detailsToCopy: string } {
	const detailString = (useAgo: boolean): string => {
		return localize('aboutDetail',
			"Version: {0}\nCommit: {1}\nUpstream: {2}\nDate: {3}\nBrowser: {4}\nClaude protocol: {5}\n\n{6}",
			productService.version ? formatReleaseVersion(productService.version, productService.klawlyRelease) : 'Unknown',
			productService.commit || 'Unknown',
			productService.upstreamCommit || 'Unknown',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown',
			userAgent,
			String(CLAUDE_PROTOCOL_VERSION),
			anthropicNotice()
		);
	};

	return {
		title: productService.nameLong,
		details: detailString(true),
		detailsToCopy: detailString(false),
	};
}
