/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IClaudePreviewCapture, PreviewCaptureRect } from '../browser/claudePreviewCapture.js';

export class ClaudePreviewCapture implements IClaudePreviewCapture {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INativeHostService private readonly _nativeHost: INativeHostService,
	) { }

	async capture(rect: PreviewCaptureRect): Promise<Uint8Array | undefined> {
		const shot = await this._nativeHost.getScreenshot(rect);
		if (!shot || shot.byteLength === 0) {
			return undefined;
		}
		return shot.buffer;
	}
}
