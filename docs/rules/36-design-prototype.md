---
description: Design prototype rule — keep design/ true to the app (labels, click marks, sync) whenever the prototype or the Klawly UI changes
globs: design/**,src/vs/workbench/contrib/claude/**,src/vs/workbench/contrib/claudeBackground/**,extensions/theme-klawly/**,resources/klawly/**,build/klawly/design-sync.ts,build/klawly/design-parity.ts
alwaysApply: false
---

# Design prototype (`design/`)

`design/` is a static HTML/CSS copy of every Klawly screen and the reference for UI work. How it works: `design/README.md`. How to work on it: `design/PRACTICES.md`. Why: `design/DECISIONS.md`. What the app should look like, and why: `design/LANGUAGE.md` (rule 37).

## When you change the Klawly UI
- Run `npm run design-sync` (it also runs after `npm run compile`) and read `design/STALE.md`.
- Redraw every page it lists, in the same pull request or with a note in the pull request saying which pages are left and why.
- If the app now does what a `data-app="idea"` or `data-app="differs"` control shows, remove or update the mark. If the app stops doing what a page shows, add the mark.
- Accept a page only after it is redrawn and its clicks are checked: `npm run design-sync -- --accept <area>/<page>.html`. Use `--accept-all` only when every listed page is done.
- Before you merge, run `npm run design-parity` (after `npm run compile`; it launches the dev build). It compares what the app and the prototype render, region by region, and writes the Parity section of `design/STALE.md`. No new deltas: the change must not add lines there, or the pull request says why the delta is right. Commit the section with the change.

## When you change the prototype
- Every region and every menu (`[data-popover]`) has `data-origin` (`klawly` | `mixed` | `vscode`), `data-label` and `data-source` (real app files, repo-relative).
- Every link and menu trigger does what the app does, or carries `data-app="idea"`, or `data-app="differs"` with `data-app-note`. Check against the app code, not memory.
- Change the smallest layer: token, then `k-` class in `assets/global.css`, then Tailwind in the page. No hard-coded colors in pages; both themes must work.
- Frame changes go into `workbench/editor.html` first.
- Use the synced logo files in `design/assets/`; never paste the logo SVG into a page.
- Keep `npm run design-sync` clean: no unchecked clicks and no unlabeled parts.

## Parallel branches and heavy runs
- `design/sync.json` (now only the token and asset baseline) is merged by the git merge driver `klawly-design-sync` (`.gitattributes`, `build/klawly/merge-design-sync.ts`): it keeps our side and regenerates the file with `design-sync --accept-all`, so two UI branches never conflict on it. `npm install` runs `merge-design-sync.ts --install`, which sets `merge.klawly-design-sync.driver` (idempotent, a no-op outside a git checkout). `npm run compile` regenerates the baseline again. Try it: `node build/klawly/test/merge-design-sync-demo.ts`.
- A merge from main must not cost a new heavy run: `node build/klawly/test-tier.ts --since <last passing heavy-run head>` says "No new heavy run needed" when HEAD is only that one merge of the base and the files the branch side also changed are `design/sync.json` alone. Anything else keeps its tier (rule 55).

## Never
- Never edit `design/.accepts/`, `design/sync.json` or `design/STALE.md` by hand. They are written by `build/klawly/design-sync.ts` (and the Parity section by `build/klawly/design-parity.ts`); commit `.accepts/` and `sync.json` with the pages. `STALE.md` is generated and gitignored. Page accepts live one file per page, and the sync does nothing while a rebase or merge is in progress.
- Never edit `design/assets/vendor/`.
- Never let `design-sync` fail the compile. Problems go to `STALE.md`.
- Never overwrite a design change from the app side. A token or asset changed in the prototype is a design proposal; port it to the app or leave it.
- Never copy reference captures or another product's markup, CSS, icons or wording into the prototype. Claude Code concepts only.
