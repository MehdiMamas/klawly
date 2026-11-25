# Klawly design prototype

A static, clickable copy of every Klawly screen in plain HTML, CSS and JavaScript. It is here so the design can be reworked page by page and then used as the reference when the real UI (TypeScript in `src/vs/workbench/contrib/claude/browser/**`) is changed.

Nothing is built, bundled or minified. Open a file in a browser and it works.

Before you change anything, read [PRACTICES.md](PRACTICES.md) (how to work on it). [DECISIONS.md](DECISIONS.md) says why it works the way it does. [LANGUAGE.md](LANGUAGE.md) lists Klawly's design practices and the reason for each (rule 37). Rule 36 (`docs/rules/36-design-prototype.md`) makes the practices binding.

## Open it

Double-click `design/index.html` (or drag it into Chrome / Edge). It lists every screen. Every page also has a small **Pages** tab on the right edge:

- **Pages** opens a list of all screens, with **Previous**, **Next** and **Theme**.
- `[` and `]` step to the previous / next screen.
- `?theme=light` or `?theme=dark` at the end of a URL forces a theme. Otherwise the last choice is remembered.

Most buttons link to the screen they open: the mode pill goes to the mode menu, the gear goes to Settings, and so on.

## Folder layout

```
design/
  index.html                  all screens, grouped
  README.md                   this file
  PRACTICES.md                how to work on the prototype
  DECISIONS.md                what was decided about the prototype and why
  LANGUAGE.md                 Klawly's design practices (DL-NN), the reason for each, and how to carry them to VS Code UI
  STALE.md                    pages and tokens that no longer match the app (written by the sync, gitignored)
  .accepts/<page>.json        what the sync saw last time for each page; do not edit
  sync.json                   token and asset baseline only; do not edit
  assets/
    global.css                all the CSS: tokens (colors, sizes, radii) + every component class
    tailwind.config.js        Tailwind names mapped to the global.css tokens
    app.js                    theme switch, menus, tabs, toggles, Pages drawer
    klawly-mark.svg           the logo (copied from the app by the sync)
    klawly-mark-mono.svg      the one-color logo, used as a mask (copied from the app)
    vendor/                   third-party, do not edit: Tailwind 3.4.17 Play CDN, codicons, the Seti file icon font
  onboarding/  home/          start screens
  workbench/                  the window: editor, side views, palettes, menus, panel
  chat/                       the agent chat pane and its menus
  review/  plan/              review editor, pending changes, plan card and editor
  editor/                     inline edit, selection toolbar, Tab completion, terminal Ctrl+K
  settings/                   Klawly Settings pages, classic settings, keyboard shortcuts
```

Each page is a full HTML document with its own `<title>`, `<meta name="description">` and semantic tags (`header`, `nav`, `main`, `aside`, `section`, `footer`). Big regions are marked with `<!-- ===== Name ===== -->` comments so you can jump to them.

## How styling works

There are three layers. Use whichever is easiest for the change.

1. **Tokens** at the top of `assets/global.css`. `:root` is the dark theme and `[data-theme="light"]` is the light theme. Change `--k-indigo` there and every primary button, link and badge changes on every page.
2. **Component classes** in `assets/global.css`, all prefixed `k-`: `.k-btn`, `.k-menu`, `.k-composer`, `.k-settings-row`, ... Change a class once and every page that uses it follows. Sections 1–9 are shared by every page; sections 10–14 hold the pieces of one area (start screens, side views, chat, review and editor AI, settings). The contents list at the top of the file gives the numbers.
3. **Tailwind utilities** right in the HTML: `flex gap-2 px-3 text-sm text-muted rounded-lg bg-raised`. The Tailwind colors, font sizes and radii are the same tokens (see `assets/tailwind.config.js`), so `bg-raised` is always `--k-raised` in both themes.

Tailwind runs in the browser from `assets/vendor/tailwindcss-3.4.17.js`, so any class you type just works after a reload. No `npm`, no build.

Icons are [codicons](https://microsoft.github.io/vscode-codicons/dist/codicon.html), the same set the app uses: `<span class="codicon codicon-gear"></span>`.

## The window frame

`workbench/editor.html` is the canonical frame: title bar, view switcher and side bar, editor area, agent pane and status bar. Other pages copy it and change only what that screen is about. If you redesign the frame, do it in `workbench/editor.html` first; it is then copied to the other pages.

Menus and popovers that a page is about are shown open. Other menus open on click (`data-popover-target`) and close on Escape or a click outside.

## What is VS Code and what is Klawly

Klawly is VS Code with Claude built in, so some parts of a screen are Klawly's own code and some are stock VS Code. That decides how hard a change is. Turn on **Origins** in the Pages drawer (or press `O`, or add `?origins=1` to the URL) to outline every part, colored by owner:

| Color | Owner | What you can change easily |
|---|---|---|
| teal | **Klawly** | Anything: layout, content, style. It is Klawly's own code. |
| amber | **VS Code, Klawly-styled** | Colors and spacing (Klawly already styles it). Layout or behavior changes mean patching VS Code. |
| pink | **VS Code** | Only theme colors. Anything else means patching VS Code, which is hard to keep through upstream updates. |

Hover a label to see the app files that draw that part. In the HTML the same facts are attributes on the region:

```html
<section class="k-composer" data-origin="klawly" data-label="Composer"
         data-source="src/vs/workbench/contrib/claude/browser/chat/claudeComposer.ts">
```

## What a click does in the app

Most links jump to the screen a click leads to. Each click was checked against the app's code, and the ones the app does not do are marked:

- `data-app="idea"`: the control is not in the app. It is a proposal.
- `data-app="differs"`: the control is in the app but does something else there. `data-app-note` says what.

**Not in the app** in the Pages drawer (or `I`) outlines them, dashed. It is on by default. Hover a marker to read what the app really does. A click without a marker does in the app what the prototype shows.

## Kept in step with the app

`npm run compile` ends with `node build/klawly/design-sync.ts` (also `npm run design-sync`). It takes about a second and never fails the compile.

- **Tokens.** The colors in `global.css` that the app also has (`--k-surface`, `--k-indigo`, the diff colors, ...) are copied from the Klawly themes (`extensions/theme-klawly/themes/`), and the sizes (`--k-text-*`, `--k-radius-*`, row heights) from `claude.css`. A token you changed by hand is never overwritten. It is listed in `STALE.md` as a design change instead.
- **Assets.** The logo files in `assets/` are copied from the app (`src/vs/workbench/contrib/claude/browser/media/klawly-mark.svg`, `resources/klawly/klawly-mark-mono.svg`). Like tokens, a logo you changed by hand is kept and listed as a design change.
- **Pages.** When an app file named in a page's `data-source` changes, the page and the region are listed in `STALE.md` to be redrawn.
- **Clicks.** Every link and menu trigger is recorded with its mark (none, `idea` or `differs`). A new or changed click is listed in `STALE.md` until it has been checked against the app.
- **Labels.** A page with no `data-origin` labels, or a menu without one, is listed in `STALE.md`.

After redrawing a page and checking its clicks, `npm run design-sync -- --accept chat/new-chat.html` (or `--accept-all`) marks it current.

`design/.accepts/<page>.json` holds what the last run saw for that page (one file per page, so parallel branches never conflict). `design/sync.json` keeps the token and asset baseline. Commit both with the pages; `STALE.md` is not committed.

## Sending changes back

Change any file you like: HTML, `global.css`, the Tailwind config. Then send back the changed files (or the whole `design/` folder). Useful notes to add:

- which screens changed and what the intent is (for example "denser chat, bigger composer"),
- anything that is a new idea rather than a restyle (new buttons, removed controls), so it can be checked against what the app can actually do.

Text should stay Klawly / Claude Code wording. The prototype is a design reference only; the real UI is rebuilt from it in TypeScript.

## Third-party files

`assets/vendor/` holds unmodified copies of:

- Tailwind CSS 3.4.17 Play CDN build (MIT), from `https://cdn.tailwindcss.com/3.4.17`
- `@vscode/codicons` 0.0.46-40 font and stylesheet (CC BY 4.0), from the repo's `node_modules`
- `seti/seti.woff`, the Seti UI file icon font (MIT, https://github.com/jesseweed/seti-ui), from the repo's `extensions/theme-seti/icons/`
