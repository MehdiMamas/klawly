/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';

/** One project in the switcher. */
export interface ClaudeSwitcherProject {
	readonly uri: URI;
	readonly name: string;
	readonly folder: string;
	/** Hand-offs sent to this project that nobody has opened yet. */
	readonly unread: number;
	/** The project this window shows. */
	readonly current: boolean;
}

/**
 * The projects the window switcher lists (DL-121): the open ones first, then the recent ones, each
 * once. Projects with unread hand-offs come before the rest of their group, the most unread first.
 */
export function claudeSwitcherProjects(
	open: readonly URI[],
	recent: readonly URI[],
	unread: ReadonlyMap<string, number>,
): ClaudeSwitcherProject[] {
	const seen = new Set<string>();
	const build = (uris: readonly URI[]): ClaudeSwitcherProject[] => {
		const projects: ClaudeSwitcherProject[] = [];
		for (const uri of uris) {
			if (seen.has(uri.fsPath)) {
				continue;
			}
			seen.add(uri.fsPath);
			projects.push({ uri, name: basename(uri), folder: uri.fsPath, unread: unread.get(uri.fsPath) ?? 0, current: open[0]?.fsPath === uri.fsPath });
		}
		return projects.sort((a, b) => b.unread - a.unread);
	};
	return [...build(open), ...build(recent)];
}

/** The total unread hand-offs across projects other than the current one. */
export function claudeUnreadElsewhere(projects: readonly ClaudeSwitcherProject[]): number {
	return projects.reduce((sum, project) => sum + (project.current ? 0 : project.unread), 0);
}
