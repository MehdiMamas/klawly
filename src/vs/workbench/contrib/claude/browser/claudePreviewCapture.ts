/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface PreviewCaptureRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export const IClaudePreviewCapture = createDecorator<IClaudePreviewCapture>('claudePreviewCapture');

export interface IClaudePreviewCapture {
	readonly _serviceBrand: undefined;
	capture(rect: PreviewCaptureRect): Promise<Uint8Array | undefined>;
}
