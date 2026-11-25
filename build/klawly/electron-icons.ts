/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The dev build (`.build/electron`) bakes the app and file-type icons into the
// executable and the app bundle when `npm run electron` packages it. preLaunch
// used to refresh it only when the Electron version changed, so new icons never
// reached a dev build (issue 751). `npm run electron` now writes a stamp of the
// icons it packaged, and preLaunch refreshes the dev build when the stamp is
// missing or no longer matches.

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const root = path.dirname(path.dirname(import.meta.dirname));
const iconFolders: ReadonlyArray<[folder: string, extension: string]> = [['resources/win32', '.ico'], ['resources/darwin', '.icns']];

/** Path of the stamp `npm run electron` writes next to the packaged dev build. */
export const iconStampPath = path.join(root, '.build', 'electron', 'klawly-icons');

/** Hash over the names and bytes of every icon the dev build packages. */
export async function iconHash(): Promise<string> {
	const hash = createHash('sha256');
	for (const [folder, extension] of iconFolders) {
		const names = (await fs.readdir(path.join(root, folder))).filter(name => name.endsWith(extension)).sort();
		for (const name of names) {
			hash.update(`${folder}/${name}\0`);
			hash.update(await fs.readFile(path.join(root, folder, name)));
		}
	}
	return hash.digest('hex');
}

/** True when the dev build was packaged with the icons in the tree. */
export async function isIconStampCurrent(): Promise<boolean> {
	try {
		return (await fs.readFile(iconStampPath, 'utf8')).trim() === await iconHash();
	} catch {
		return false;
	}
}

/** Records the icons the dev build was just packaged with. */
export async function writeIconStamp(): Promise<void> {
	await fs.writeFile(iconStampPath, await iconHash());
}
