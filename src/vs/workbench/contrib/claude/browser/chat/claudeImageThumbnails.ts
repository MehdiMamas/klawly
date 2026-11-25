/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { imageMimeForName, isImageName } from '../../common/claudeImageAttachments.js';

/** Larger files keep the icon; a thumbnail never reads a huge file into memory. */
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const MAX_CACHED = 48;

function toUri(localUri: string): URI {
	return /^[a-z][a-z0-9+.-]+:/i.test(localUri) && !/^[a-z]:[\\/]/i.test(localUri) ? URI.parse(localUri) : URI.file(localUri);
}

/**
 * Loads attached images into blob URLs for chips and message thumbnails (DL-74). Klawly
 * stores pasted images under the user data folder, which the renderer cannot load by
 * path, so the bytes go through the file service once and the URL is cached.
 */
export class ClaudeImageThumbnails extends Disposable {
	private readonly _urls = new Map<string, string>();
	private readonly _pending = new Map<string, Promise<string | undefined>>();

	constructor(@IFileService private readonly _files: IFileService) {
		super();
		this._register(toDisposable(() => {
			for (const url of this._urls.values()) {
				URL.revokeObjectURL(url);
			}
			this._urls.clear();
		}));
	}

	/** The cached URL, so a chip row that redraws often shows the image at once. */
	peek(localUri: string): string | undefined {
		return this._urls.get(localUri);
	}

	load(localUri: string): Promise<string | undefined> {
		const cached = this._urls.get(localUri);
		if (cached) {
			return Promise.resolve(cached);
		}
		let pending = this._pending.get(localUri);
		if (!pending) {
			pending = this.read(localUri).finally(() => this._pending.delete(localUri));
			this._pending.set(localUri, pending);
		}
		return pending;
	}

	private async read(localUri: string): Promise<string | undefined> {
		const uri = toUri(localUri);
		if (!isImageName(uri.path)) {
			return undefined;
		}
		try {
			const stat = await this._files.stat(uri);
			if (stat.size > MAX_THUMBNAIL_BYTES) {
				return undefined;
			}
			const content = await this._files.readFile(uri);
			if (this._store.isDisposed) {
				return undefined;
			}
			const url = URL.createObjectURL(new Blob([content.value.buffer.slice()], { type: imageMimeForName(uri.path) }));
			this._urls.set(localUri, url);
			for (const [key, old] of this._urls) {
				if (this._urls.size <= MAX_CACHED) {
					break;
				}
				URL.revokeObjectURL(old);
				this._urls.delete(key);
			}
			return url;
		} catch {
			return undefined;
		}
	}
}

/**
 * Appends a thumbnail for an attached image: the media icon until the image loads (or
 * when it can't), then the image itself, decorative because its label sits beside it.
 */
export function appendClaudeImageThumb(parent: HTMLElement, thumbnails: ClaudeImageThumbnails, localUri: string): HTMLElement {
	const holder = append(parent, $('span.claude-image-thumb'));
	const show = (url: string) => {
		holder.replaceChildren();
		const image = append(holder, $<HTMLImageElement>('img'));
		image.alt = '';
		image.draggable = false;
		image.src = url;
		holder.classList.add('is-loaded');
	};
	const cached = thumbnails.peek(localUri);
	if (cached) {
		show(cached);
	} else {
		append(holder, $(ThemeIcon.asCSSSelector(Codicon.fileMedia)));
		void thumbnails.load(localUri).then(url => {
			if (url) {
				show(url);
			}
		});
	}
	return holder;
}
