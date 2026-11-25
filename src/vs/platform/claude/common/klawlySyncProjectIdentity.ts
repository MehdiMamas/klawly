/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Names a project the same on every machine (issue 448). The identity is the git remote with the
 * scheme, credentials, port, `.git` suffix and case removed: `git@github.com:Owner/Repo.git` and
 * `https://user:token@github.com/owner/repo` are both `github.com/owner/repo`. A project with
 * no remote has none; the user may give it an alias instead.
 */
export function klawlyProjectIdentityFromRemote(remote: string): string | undefined {
	const trimmed = remote.trim();
	if (!trimmed) {
		return undefined;
	}
	const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(?<host>[^/:]+)(?::\d+)?\/(?<path>.+)$/i.exec(trimmed);
	const scp = /^(?:[^/@]+@)?(?<host>[^/:]+):(?<path>(?!\/\/).+)$/.exec(trimmed);
	const match = url ?? scp;
	if (!match?.groups) {
		return undefined;
	}
	const { host, path } = match.groups;
	const text = path.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
	const segments = text.split('/').filter(s => s.length > 0);
	if (segments.length < 2 || segments.some(s => s === '.' || s === '..')) {
		return undefined;
	}
	return `${host}/${segments.join('/')}`.toLowerCase();
}

/** The identity for a user-chosen alias, for a project without a remote. Empty or blank gives none. */
export function klawlyProjectIdentityFromAlias(alias: string): string | undefined {
	const slug = alias.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
	return slug ? `alias/${slug}` : undefined;
}

/**
 * The folder name an identity is stored under: one safe path segment on every OS, reversible
 * enough to read (`/` becomes `__`), with no leading dot and no characters Windows rejects.
 */
export function klawlyProjectIdentitySlug(identity: string): string {
	return identity.replace(/\//g, '__').replace(/[^a-z0-9._-]/gi, '_').replace(/^\.+/, '_');
}
