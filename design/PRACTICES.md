# Design practices

How to work on the Klawly design prototype so it stays useful: true to the app where it says it is, clear where it is a proposal, and easy to turn back into TypeScript. The binding version of these points is rule 36 (`docs/rules/36-design-prototype.md`). `README.md` explains how the prototype works; `DECISIONS.md` explains why it works that way.

## 1. Think in roles, not pixels

The prototype uses the same design language as the app. Before changing a size or a color, name what feels wrong (Calm, Focused, Consistent, Delightful), the principle it breaks, and the token that fixes it. Say "this menu is rounded at the control tier" or "this gap is off the spacing ramp", not "make it 6px".

- Vocabulary and worked examples: `.github/skills/design-philosophy/SKILL.md`.
- The app's size tokens: `.github/instructions/design-tokens.instructions.md`.
- The decisions already made with that vocabulary, each with its reason: [`LANGUAGE.md`](LANGUAGE.md). Follow the practice that covers your change; if none does, add one (rule 37).

## 2. Change the smallest layer that does the job

1. **A token** at the top of `assets/global.css` when the change should hold everywhere (a color, a radius, a type size). Change both themes: `:root` is dark, `[data-theme="light"]` is light.
2. **A `k-` component class** in `assets/global.css` when one kind of thing changes everywhere it appears (every menu, every settings row).
3. **Tailwind utilities** in the HTML for a change to one spot on one page.

Never hard-code a color in a page. Use a token, through a `k-` class or a Tailwind name (`bg-raised`, `text-muted`), so both themes keep working. A page that only looks right in dark is not done.

## 3. Change the frame once

The window frame (title bar, view switcher, side bar, editor area, agent pane, status bar) lives in `workbench/editor.html`. Change it there first, then carry the same change to the other pages. Each page only changes what that screen is about.

## 4. Every part says who owns it

Every big region of a page (the `<!-- ===== Name ===== -->` blocks) and every menu (`[data-popover]`) carries:

- `data-origin`: `klawly` (our code, easy to change), `mixed` (VS Code that Klawly styles; colors are easy, layout is a VS Code patch) or `vscode` (stock VS Code; only theme colors are easy).
- `data-label`: a short name for the part.
- `data-source`: the app files that draw it, separated by spaces, relative to the repo root.

When you add a region or a menu, add all three. The sync lists any page with no labels at all, and any menu without `data-origin`, under "Parts without an owner label" in `STALE.md`. `data-source` is what lets the sync tell you when the app changed under a page, so name the real files.

## 5. Every click is true or marked

A link or a menu trigger in the prototype says "the app does this". If the app does not:

- `data-app="idea"` when the control is not in the app at all. It is a proposal.
- `data-app="differs"` with `data-app-note="what the app really does"` when the control exists but does something else.

When you add or change a click, check it against the app code (start from the files in `data-source`). The sync records every click it has seen with its verdict. A new or changed click shows up under "Clicks not checked against the app" in `STALE.md` until you accept the page.

When the app catches up (it gains the control or changes its behavior), remove or update the mark in the same change. A stale `idea` mark is as wrong as a missing one.

## 6. Keep in step with the app

`npm run compile` runs `build/klawly/design-sync.ts` at the end (or run `npm run design-sync`). Then read `design/STALE.md`:

| Section | What to do |
|---|---|
| Pages to redraw | Open the page next to the app, redraw the named region, re-check its clicks, then accept. |
| Clicks not checked | Check each click against the app; mark it `idea` or `differs` if needed; accept. |
| Parts without an owner label | Add `data-origin`, `data-label` and `data-source`. |
| Tokens and assets changed in the prototype | Design changes waiting to go into the app. Leave them; they are the point. |
| Tokens and assets the sync could not read | The app file moved or changed shape. Fix the map in `design-sync.ts`. |

Accept a page with `npm run design-sync -- --accept chat/new-chat.html`, or everything with `--accept-all` once every listed page really is done. Each accept is written to its own file, `design/.accepts/<page>.json`; commit those with the pages. `STALE.md` is generated and not committed. Never edit them by hand.

The sync never overwrites a token or an asset you changed in the prototype, so hand edits are safe.

### Check what both render

The sync compares tokens and file hashes, not what is on screen. Before you merge a UI change, run `npm run design-parity` (it launches the dev build, so run `npm run compile` first; not part of the compile). It opens a demo workspace with the fake agent runtime at 1440x900 in both themes, drives the app to the states in its `STATES` list, shoots the matching pages, and compares each prototype `[data-label]` region with the app element its `REGIONS` map names: x, y, width and height (2px tolerance), background and font size.

- The deltas go to the Parity section of `design/STALE.md`; side-by-side images (prototype left, app right, regions with a delta outlined) go to `design/.parity/pairs/`, which is not committed.
- **No new deltas.** A UI change must not add lines to the Parity section. Fix the app or the page, or say in the pull request why the delta is right. Commit the updated section with the change.
- To cover more: add a region to `REGIONS` in `build/klawly/design-parity.ts` (prototype `data-label` → app CSS selector) and list it in a state, or add a state whose `drive` step brings the app to what the page draws. `--theme dark|light` and `--only <page.html,...>` run a part; the other entries are kept.

## 7. Use the app's assets

The logo in `assets/klawly-mark.svg` and `assets/klawly-mark-mono.svg` is copied from the app by the sync. To use the logo, reference those files with `<img>` instead of pasting the SVG into a page, so a brand change reaches every page. (CSS `mask` and `fetch` do not work: browsers block them on pages opened from disk.) Icons are codicons, the same set the app uses. File icons in VS Code parts (explorer, tabs, breadcrumbs, quick input, search, diff) are the Seti theme's, drawn by `.k-fileicon <type>` from `assets/vendor/seti/seti.woff`; Klawly parts draw `codicon-file`, as the app does.

## 8. Clean room

The prototype is built clean-room, as the app is:

- Measure and write the result in our own words. Never copy another product's markup, class names, CSS, icons or wording.
- Claude Code concepts only: its models, efforts, modes, slash commands, MCP servers, hooks and permissions. Nothing that belongs only to another product.
- Text is Klawly / Claude Code wording. "VS Code" appears only where it names VS Code itself (the origin labels, "Import from VS Code").

## 9. Send changes back with intent

A change that only restyles is ready to port. A change that adds or removes controls needs a note: what it is for, and a `data-app="idea"` mark so nobody mistakes it for current behavior. When the app is changed to match the prototype, the same pull request updates the prototype's marks and accepts the page, so both sides stay true.

## Checklist before you commit

- [ ] Both themes look right (`?theme=light`, `?theme=dark`).
- [ ] New regions and menus have `data-origin`, `data-label` and `data-source`.
- [ ] New clicks are checked, and the ones the app does not do are marked.
- [ ] `npm run design-sync` ends with no pages to redraw, no unchecked clicks and no unlabeled parts, or you said why in the pull request.
- [ ] The `design/.accepts/` files are committed with the pages.
- [ ] For a UI change: `npm run design-parity` adds no lines to the Parity section of `STALE.md`.
