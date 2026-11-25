/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The plan behind Split into Pull Requests (issues 676, 970): the uncommitted diff cut
 * into hunks, the hunks sorted into groups, and one branch name per group. The group
 * editor changes this plan; the plan turns each group back into a patch.
 */

/** One hunk of one file. A file with no `@@` hunk (a rename, a mode change, a binary file) is one hunk with an empty header. */
export interface SplitHunk {
	readonly id: string;
	readonly file: string;
	/** The `@@ -a,b +c,d @@ context` line, or '' for a file with no text hunk. */
	readonly header: string;
	/** The lines after the header, without line breaks. */
	readonly body: readonly string[];
	readonly added: number;
	readonly removed: number;
}

export interface SplitFile {
	readonly path: string;
	/** The `diff --git` line and the lines up to the first hunk. */
	readonly head: readonly string[];
	readonly hunks: readonly SplitHunk[];
}

export interface SplitGroup {
	readonly id: string;
	readonly title: string;
	readonly branch: string;
	readonly hunkIds: readonly string[];
}

export interface SplitPlan {
	readonly files: readonly SplitFile[];
	readonly groups: readonly SplitGroup[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Cuts a unified diff (as `git diff` prints it) into files and hunks. */
export function parseSplitDiff(patch: string): SplitFile[] {
	const files: { path: string; head: string[]; hunks: { header: string; body: string[] }[] }[] = [];
	let current: (typeof files)[number] | undefined;
	let hunk: { header: string; body: string[] } | undefined;
	for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
		if (line.startsWith('diff --git ')) {
			current = { path: pathFromDiffLine(line), head: [line], hunks: [] };
			files.push(current);
			hunk = undefined;
		} else if (!current) {
			continue;
		} else if (HUNK_HEADER.test(line)) {
			hunk = { header: line, body: [] };
			current.hunks.push(hunk);
		} else if (hunk) {
			hunk.body.push(line);
		} else {
			current.head.push(line);
			const target = /^\+\+\+ b\/(.+)$/.exec(line);
			if (target) {
				current.path = target[1];
			}
		}
	}
	return files.map((file, fileIndex) => {
		const hunks = file.hunks.length > 0 ? file.hunks : [{ header: '', body: [] as string[] }];
		return {
			path: file.path,
			head: file.head,
			hunks: hunks.map((entry, index): SplitHunk => {
				// Only the last hunk of the whole diff can end in the empty entry the final line break leaves.
				const body = entry.body.slice();
				if (fileIndex === files.length - 1 && index === hunks.length - 1 && body[body.length - 1] === '') {
					body.pop();
				}
				return {
					id: `${fileIndex}:${index}`,
					file: file.path,
					header: entry.header,
					body,
					added: body.filter(text => text.startsWith('+')).length,
					removed: body.filter(text => text.startsWith('-')).length,
				};
			}),
		};
	});
}

function pathFromDiffLine(line: string): string {
	const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
	return match ? match[2] : line.slice('diff --git '.length);
}

/** Every hunk of the plan, in diff order. */
export function allSplitHunks(plan: SplitPlan): SplitHunk[] {
	return plan.files.flatMap(file => file.hunks);
}

/** A first plan: one group per top-level folder, so related files start together and the user only moves the exceptions. */
export function initialSplitPlan(files: readonly SplitFile[]): SplitPlan {
	const byFolder = new Map<string, string[]>();
	for (const file of files) {
		const slash = file.path.indexOf('/');
		const folder = slash > 0 ? file.path.slice(0, slash) : '';
		const ids = byFolder.get(folder) ?? [];
		ids.push(...file.hunks.map(hunk => hunk.id));
		byFolder.set(folder, ids);
	}
	const groups: SplitGroup[] = [];
	for (const [folder, hunkIds] of byFolder) {
		const title = folder || 'Root files';
		groups.push({ id: `group-${groups.length + 1}`, title, branch: suggestBranchName(title), hunkIds });
	}
	return { files, groups };
}

/** `split/<words>` from a title: lower case, dashes between words, no characters git refuses. */
export function suggestBranchName(title: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
	return `split/${slug || 'changes'}`;
}

const FORBIDDEN_IN_REF = /[\x00-\x20\x7f~^:?*[\\]/;

/** The reason git would refuse this branch name, or undefined when it is fine. Mirrors `git check-ref-format --branch`. */
export function branchNameProblem(name: string): 'empty' | 'invalid' | undefined {
	if (name.trim().length === 0) {
		return 'empty';
	}
	if (FORBIDDEN_IN_REF.test(name)
		|| name.includes('..') || name.includes('@{') || name === '@'
		|| name.startsWith('/') || name.endsWith('/') || name.includes('//')
		|| name.startsWith('-') || name.endsWith('.')
		|| name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
		return 'invalid';
	}
	return undefined;
}

export type SplitPlanProblem =
	| { readonly kind: 'empty-group'; readonly groupId: string }
	| { readonly kind: 'bad-branch'; readonly groupId: string; readonly reason: 'empty' | 'invalid' }
	| { readonly kind: 'duplicate-branch'; readonly groupId: string }
	| { readonly kind: 'branch-exists'; readonly groupId: string }
	| { readonly kind: 'unassigned'; readonly hunkId: string }
	| { readonly kind: 'no-groups' };

/** What stops the plan from being applied. `existingBranches` are the branches the repository has already. */
export function splitPlanProblems(plan: SplitPlan, existingBranches: readonly string[] = []): SplitPlanProblem[] {
	if (plan.groups.length === 0) {
		return [{ kind: 'no-groups' }];
	}
	const problems: SplitPlanProblem[] = [];
	const seen = new Set<string>();
	const taken = new Set(existingBranches);
	for (const group of plan.groups) {
		if (group.hunkIds.length === 0) {
			problems.push({ kind: 'empty-group', groupId: group.id });
		}
		const bad = branchNameProblem(group.branch);
		if (bad) {
			problems.push({ kind: 'bad-branch', groupId: group.id, reason: bad });
		} else if (seen.has(group.branch)) {
			problems.push({ kind: 'duplicate-branch', groupId: group.id });
		} else if (taken.has(group.branch)) {
			problems.push({ kind: 'branch-exists', groupId: group.id });
		}
		seen.add(group.branch);
	}
	const assigned = new Set(plan.groups.flatMap(group => group.hunkIds));
	for (const hunk of allSplitHunks(plan)) {
		if (!assigned.has(hunk.id)) {
			problems.push({ kind: 'unassigned', hunkId: hunk.id });
		}
	}
	return problems;
}

/** Moves a hunk to a group (at `index`, else the end). The hunk leaves every other group. */
export function moveSplitHunk(plan: SplitPlan, hunkId: string, groupId: string, index?: number): SplitPlan {
	if (!plan.groups.some(group => group.id === groupId)) {
		return plan;
	}
	return {
		files: plan.files,
		groups: plan.groups.map(group => {
			const rest = group.hunkIds.filter(id => id !== hunkId);
			if (group.id !== groupId) {
				return { ...group, hunkIds: rest };
			}
			const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length));
			return { ...group, hunkIds: [...rest.slice(0, at), hunkId, ...rest.slice(at)] };
		}),
	};
}

/** Moves every hunk of a file to a group. */
export function moveSplitFile(plan: SplitPlan, path: string, groupId: string): SplitPlan {
	let next = plan;
	for (const hunk of plan.files.find(file => file.path === path)?.hunks ?? []) {
		next = moveSplitHunk(next, hunk.id, groupId);
	}
	return next;
}

export function addSplitGroup(plan: SplitPlan): SplitPlan {
	const used = new Set(plan.groups.map(group => group.id));
	let number = plan.groups.length + 1;
	while (used.has(`group-${number}`)) {
		number++;
	}
	const title = `Group ${number}`;
	const taken = new Set(plan.groups.map(group => group.branch));
	const base = suggestBranchName(title);
	let branch = base;
	for (let suffix = 2; taken.has(branch); suffix++) {
		branch = `${base}-${suffix}`;
	}
	return { files: plan.files, groups: [...plan.groups, { id: `group-${number}`, title, branch, hunkIds: [] }] };
}

/** Removes a group; its hunks go to `into` (the first other group when omitted). The last group cannot be removed. */
export function removeSplitGroup(plan: SplitPlan, groupId: string, into?: string): SplitPlan {
	const group = plan.groups.find(entry => entry.id === groupId);
	const targetId = into ?? plan.groups.find(other => other.id !== groupId)?.id;
	const target = plan.groups.find(entry => entry.id === targetId && entry.id !== groupId);
	if (!group || !target) {
		return plan;
	}
	return {
		files: plan.files,
		groups: plan.groups.filter(entry => entry.id !== groupId).map(entry => entry.id === target.id ? { ...entry, hunkIds: [...entry.hunkIds, ...group.hunkIds] } : entry),
	};
}

export function renameSplitGroup(plan: SplitPlan, groupId: string, title: string): SplitPlan {
	return { files: plan.files, groups: plan.groups.map(group => group.id === groupId ? { ...group, title } : group) };
}

export function renameSplitBranch(plan: SplitPlan, groupId: string, branch: string): SplitPlan {
	return { files: plan.files, groups: plan.groups.map(group => group.id === groupId ? { ...group, branch: branch.trim() } : group) };
}

/**
 * The patch that carries one group. A group holds only some hunks of a file, so the new-side
 * start of each hunk is recounted: the lines the other groups add or remove no longer shift it.
 */
export function buildGroupPatch(plan: SplitPlan, groupId: string): string {
	const group = plan.groups.find(entry => entry.id === groupId);
	if (!group) {
		return '';
	}
	const chosen = new Set(group.hunkIds);
	const out: string[] = [];
	for (const file of plan.files) {
		const hunks = file.hunks.filter(hunk => chosen.has(hunk.id));
		if (hunks.length === 0) {
			continue;
		}
		out.push(...file.head);
		let shift = 0;
		for (const hunk of hunks) {
			if (!hunk.header) {
				continue;
			}
			const match = HUNK_HEADER.exec(hunk.header)!;
			const oldStart = Number(match[1]);
			const oldCount = match[2] === undefined ? 1 : Number(match[2]);
			const newCount = match[4] === undefined ? 1 : Number(match[4]);
			// A hunk that adds into an empty range (`-5,0`) starts one line after the old start.
			const newStart = (oldCount === 0 ? oldStart + 1 : oldStart) + shift;
			const oldPart = match[2] === undefined ? match[1] : `${match[1]},${match[2]}`;
			const newPart = match[4] === undefined && newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
			out.push(`@@ -${oldPart} +${newPart} @@${match[5]}`, ...hunk.body);
			shift += newCount - oldCount;
		}
	}
	return out.length > 0 ? `${out.join('\n')}\n` : '';
}

/** The hunks of a group in diff order, for display. */
export function splitGroupHunks(plan: SplitPlan, group: SplitGroup): SplitHunk[] {
	const chosen = new Set(group.hunkIds);
	return allSplitHunks(plan).filter(hunk => chosen.has(hunk.id));
}

/** The confirmed groups as text. It goes into the chat when the user hands the plan to Claude. */
export function splitPlanPrompt(plan: SplitPlan): string {
	const lines = ['The groups are confirmed. Do not regroup them or ask about them again; use exactly these:'];
	for (const group of plan.groups) {
		const hunks = splitGroupHunks(plan, group);
		const files = [...new Set(hunks.map(hunk => hunk.file))];
		const added = hunks.reduce((sum, hunk) => sum + hunk.added, 0);
		const removed = hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
		const where = hunks.map(hunk => hunk.header ? `${hunk.file} ${hunk.header.replace(/ @@.*$/, ' @@')}` : hunk.file).join('; ');
		lines.push(`- "${group.title}": branch ${group.branch}, ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} in ${files.join(', ')} (+${added} -${removed}). Hunks: ${where}`);
	}
	return lines.join('\n');
}

/** One group ready to become a branch: Klawly makes the branch and its worktree, applies the patch and commits it (issue 971). */
export interface SplitBranchPart {
	readonly branch: string;
	readonly title: string;
	readonly patch: string;
}

export interface SplitBranchResult {
	readonly branch: string;
	readonly title: string;
	/** The worktree, `<repo>/.worktrees/<branch>`. */
	readonly worktreePath: string;
	/** The commit, when the branch was made. */
	readonly commit?: string;
	/** The branch this one is stacked on, so its pull request is based there; absent when it starts at HEAD (issue 972). */
	readonly stackedOn?: string;
	/** Why the branch was not made. Nothing of that part is left behind. */
	readonly error?: string;
}

/** The files a group changes, in diff order. */
export function splitGroupFiles(plan: SplitPlan, group: SplitGroup): string[] {
	return [...new Set(splitGroupHunks(plan, group).map(hunk => hunk.file))];
}

/** One part per group that has hunks, in the plan's order. */
export function splitBranchParts(plan: SplitPlan): SplitBranchPart[] {
	return plan.groups
		.map(group => ({ branch: group.branch.trim(), title: group.title.trim() || group.branch.trim(), patch: buildGroupPatch(plan, group.id) }))
		.filter(part => part.patch.length > 0);
}

/** The text the confirmation shows: each branch with the files it gets. */
export function splitBranchesSummary(plan: SplitPlan): string {
	const lines: string[] = [];
	for (const group of plan.groups) {
		const files = splitGroupFiles(plan, group);
		if (files.length === 0) {
			continue;
		}
		lines.push(`${group.branch.trim()} (${group.title.trim() || group.branch.trim()})`);
		lines.push(...files.map(file => `    ${file}`));
	}
	return lines.join('\n');
}

/** Hands the made branches to Claude after the user asked to push them. Claude pushes and opens drafts; it does not regroup or commit. */
export function splitBranchesPrompt(results: readonly SplitBranchResult[]): string {
	const made = results.filter(result => result.commit);
	const lines = [
		'Klawly already made these branches, each in its own worktree with one commit. The user approved pushing them now.',
		'For each one: push the branch, then open a draft pull request with `gh pr create --draft` from its worktree, titled with the group title. Do not regroup, edit or commit anything. Report each pull request URL.',
		'Where a branch says "stacked on", push that base branch first and pass it as `--base` so the pull request shows only its own group.',
	];
	for (const result of made) {
		lines.push(`- "${result.title}": branch ${result.branch}, worktree ${result.worktreePath}, commit ${result.commit}${result.stackedOn ? `, stacked on ${result.stackedOn}` : ''}`);
	}
	return lines.join('\n');
}
