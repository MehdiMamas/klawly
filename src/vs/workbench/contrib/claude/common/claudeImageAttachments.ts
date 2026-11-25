/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import type { SentImage } from '../../../../platform/claude/common/claudePrompt.js';

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;
const GENERATED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;
const STORED_IMAGE = /[\\/](?:claude-attachments|agent-sessions[\\/][^\\/]+[\\/]attachments)[\\/][^\\/]+\.(?:png|jpe?g|gif|webp)$/i;

/** True when a file name ends in an image extension Klawly can attach and preview. */
export function isImageName(name: string): boolean {
	return IMAGE_NAME.test(name);
}

/** The MIME type for an image file name, PNG when the extension is unknown. */
export function imageMimeForName(name: string): string {
	if (/\.jpe?g$/i.test(name)) {
		return 'image/jpeg';
	}
	if (/\.gif$/i.test(name)) {
		return 'image/gif';
	}
	if (/\.webp$/i.test(name)) {
		return 'image/webp';
	}
	return 'image/png';
}

function baseName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function fsPathOf(localUri: string): string {
	return /^[a-z][a-z0-9+.-]+:/i.test(localUri) && !/^[a-z]:[\\/]/i.test(localUri) ? URI.parse(localUri).fsPath : localUri;
}

/**
 * The name a person sees for an attached image (issue 743). Klawly stores pasted and
 * dropped images under a generated id, so the stored file name is never shown: the
 * attachment's own name wins, then a real file name, then a plain "Image".
 */
export function claudeImageLabel(localUri: string, name?: string): string {
	if (name) {
		return name;
	}
	const base = baseName(fsPathOf(localUri));
	return !base || GENERATED_NAME.test(base) ? localize('claude.image.label', "Image") : base;
}

/** True for a file Klawly wrote itself when an image was pasted, dropped or captured. */
export function isStoredImagePath(path: string): boolean {
	return STORED_IMAGE.test(path);
}

function pathKey(path: string): string {
	return fsPathOf(path).replace(/\\/g, '/').toLowerCase();
}

/**
 * The images people sent in a chat, keyed by file path, so the agent's Read of an
 * attached image folds into "Viewed attached image" instead of a raw path (issue 744).
 */
export class SentImageIndex {
	private readonly _names = new Map<string, string | undefined>();

	clear(): void {
		this._names.clear();
	}

	add(images: readonly SentImage[] | undefined): void {
		for (const image of images ?? []) {
			this._names.set(pathKey(image.uri), image.name);
		}
	}

	/** The label to show when `path` is an image the person attached, else undefined. */
	labelFor(path: string): string | undefined {
		const key = pathKey(path);
		if (this._names.has(key)) {
			return claudeImageLabel(path, this._names.get(key));
		}
		return isStoredImagePath(path) ? claudeImageLabel(path) : undefined;
	}
}
