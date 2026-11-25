# Design decisions

What was decided about the design prototype, when, and why. Newest last. Add an entry when you change how the prototype works (not for ordinary redesigns of a screen).

## 2026-10-08: A static prototype of every screen (PR #100)

**What.** `design/` holds every Klawly screen as its own HTML page (47 pages in 9 areas), with one `assets/global.css`, Tailwind 3.4.17 from a local copy of the Play CDN build, codicons, and a small `assets/app.js` for themes, menus and the Pages drawer.

**Why.**
- The UI was being reworked by hand in TypeScript, where every experiment costs a compile and a restart. A page in a browser can be changed in seconds by anyone, including people who do not build the app.
- **No build step, nothing minified.** Double-click a file and it works; what you edit is what you see. Tailwind runs in the browser so any class you type works after a reload.
- **One global stylesheet with tokens first.** The app is driven by theme tokens, so the prototype is too. A change to `--k-indigo` reaching every page is the same move as changing a theme color in the app, which makes porting a design back straightforward.
- **One canonical frame** (`workbench/editor.html`) so the window chrome does not drift between 47 copies.
- **Clean room.** The pages were built from measurements, never from another product's markup or CSS, with Claude Code concepts only.

## 2026-10-08: Label what is VS Code and what is Klawly (PR #100)

**What.** Every region and menu carries `data-origin` (`klawly`, `mixed`, `vscode`), `data-label` and `data-source`. The Origins overlay (`O`) outlines them in three colors.

**Why.** Klawly is a fork of Code - OSS. A change to Klawly's own code is cheap; a change to a VS Code part is a patch to upstream code that has to be carried through every upstream update (`UPSTREAM.md`). The labels show, while designing, what is easy to change and what is not, so effort goes where it is cheap and expensive changes are made on purpose. `data-source` names the real app files, so a designer knows where a change lands and the sync knows which pages an app change affects.

## 2026-10-08: Mark every click the app does not do (PR #100)

**What.** Every click in the prototype (about 1,400 links and menu triggers across the pages) was checked against the app code. Controls the app does not have are marked `data-app="idea"` (8). Controls that exist but do something else are marked `data-app="differs"` with `data-app-note` saying what the app does (312). The "Not in the app" overlay (`I`) is on by default.

**Why.** A prototype that clicks somewhere the app does not go teaches the wrong product. The gap was found when the title bar gear opened Settings in the prototype but the stock Manage menu in the app. Pointing that out as a side remark was not enough: the user asked for it to be acted on, everywhere. So the whole prototype was audited, and the fix went both ways:

- Where the prototype was wrong about the app (permission dropdown options, active tabs, the Home Settings link), the prototype was fixed.
- Where the prototype was the better design (the gear), the app was changed: the title bar gear now runs `claude.openSettings`, and the Manage menu entries stay in File > Preferences and the Command Palette (`claudeTitleBar.ts`, with tests).
- Everything else that is still only a proposal is marked, so nobody mistakes it for current behavior.

**Lesson.** A side remark from the user ("btw") is a requirement. Act on it in the same piece of work.

## 2026-10-08: Keep the prototype in step on every compile (PR #100)

**What.** `npm run compile` ends with `build/klawly/design-sync.ts` (also `npm run design-sync`). It copies theme colors and `claude.css` sizes into `global.css`, hashes each page's `data-source` files, and writes `design/STALE.md` with what needs redrawing. `design/sync.json` keeps the baseline.

**Why.**
- The user asked for a fresh set to work from after every compile. A sync plus a stale list was chosen over regenerating the pages from the app: the pages are hand-designed, and regenerating would erase the design work. A sync plus a to-do list keeps both.
- **Three-way merge against the baseline.** For each token the sync compares the prototype, the app, and what it last copied. If only the app moved, it copies. If only the prototype moved, it keeps the prototype and lists it as a design change. If both moved, it reports a conflict and touches nothing. A designer's edit is never overwritten.
- **Never fails the compile.** The prototype must not block building the app. Problems go to `STALE.md`, not to the exit code.
- **Accepting is explicit** (`--accept <page>`, `--accept-all`), so a page is only marked current after someone has looked at it.

## 2026-10-08: Rules, practices, and the sync checks clicks, labels and assets

**What.**
- The sync now also:
  - **copies assets** (the logo and its mono version) with the same three-way merge as tokens;
  - **records every click** with its verdict and lists new or changed clicks as unchecked until the page is accepted;
  - **lists parts without an owner label** (a page with no labels, a menu without `data-origin`).
- It writes files only when their content changed and keeps each file's line endings, so a compile on Windows does not dirty the tree.
- The rebrand logo (a K whose arms are claws, PR #90) reached the prototype through the asset sync. The empty-editor watermark shows the mono logo as an `<img>`, so it follows the app's file; a CSS mask would have followed the ink color exactly, but browsers block masks on pages opened from disk, which is how the prototype is used.
- `design/PRACTICES.md` (how to work), this file (why), and rule 36 (`docs/rules/36-design-prototype.md`, binding for anyone changing the prototype or the Klawly UI). `AGENTS.md` points to them.

**Why.** The labels and click marks only stay true if something notices when they go stale. Pages were already checked; clicks and labels were trusted to memory, which is exactly how the gear gap happened. Making the sync check them, and making a rule of the practice, means the next app change or design change shows up in `STALE.md` instead of being found by the user.

## 2026-10-08: Check what both render, not just tokens (issue #104)

**What.**
- `npm run design-parity` (`build/klawly/design-parity.ts`) launches the dev build on a demo workspace that mirrors the prototype's `klawly-demo`, with the fake agent runtime, at 1440x900 in both themes. It drives the app to the states the prototype draws (editor, new chat, finished turn, Klawly Settings to start), shoots the matching pages, and compares the prototype's `[data-label]` regions with app elements through a map in the script: x, y, width, height (2px tolerance), background and font size.
- The deltas go to a Parity section at the end of `design/STALE.md` (design-sync keeps that section as it is); side-by-side images go to `design/.parity/` (gitignored).
- Rule 36 and `PRACTICES.md`: run it before merging a UI change; no new deltas.
- The fake runtime reads its chat scripts from the folder in `KLAWLY_FAKE_FIXTURE_DIR`, only in a dev build, so the tool needs no edit to product code at run time and a shipped app never replays files from disk.

**Why.** `design-sync` compares tokens and source-file hashes. It never renders the app, so the prototype and the app drifted apart (frame sizes, pane widths, the composer's place) while every check stayed green, and "close" was said without looking. Measuring rendered regions turns that drift into lines a pull request can be held to. It is not part of the compile because it launches Electron and a browser, and it starts with a few states and regions; the map grows as pages are brought in line.

## 2026-10-08: File icons stay Seti; the prototype draws Seti (issue 155)

**What.**
- The app keeps upstream's Seti file icon theme (`workbench.iconTheme: vs-seti`). The prototype's small monospace stand-ins ("TS", "M↓", "{}") are gone.
- `.k-fileicon <type>` in `assets/global.css` draws the Seti glyph from the Seti font (`assets/vendor/seti/seti.woff`, a copy of `extensions/theme-seti/icons/seti.woff`) with the code points and dark/light colors of `extensions/theme-seti/icons/vs-seti-icon-theme.json`: `ts`, `ts-test` (orange, for `*.test.ts`), `tsx`, `tsconfig`, `json`, `md`, `readme` (the info glyph), `js`, `css`, `html`, `py`. The span is empty and `aria-hidden`.
- Klawly parts (chat cards, composer chips, the context picker) draw `codicon-file`, because the app draws codicons there, not theme icons. Code block headers draw no icon, as in the app.

**Why.** Keeping Seti was chosen over shipping a Klawly file icon theme ("Reject" on the issue, pending the user's confirmation there). The prototype must draw what the app draws, so it uses the same font instead of an imitation.

## 2026-10-10: A design language with a reason for every practice (rule 37)

**What.**
- `design/LANGUAGE.md` lists every design practice Klawly follows as `DL-NN`: Foundations (color, high contrast, radius tiers, spacing and type ramps, row heights, depth, motion, accents, icons, words, hiding what does not apply) and the VS Code surfaces Klawly restyles (menus, quick input, key caps, notifications, classic Settings, the window frame). Each entry has the practice, why, where it lives, what it applies to, and the issue that decided it.
- It says how a practice reaches a surface (theme color, Klawly token, scoped rule in `claudeChrome.css`, a hook, then an upstream edit), how to add or retire a practice, and what to do after an upstream merge.
- Rule 37 (`docs/rules/37-design-language.md`) makes it binding: cite the ID in the code that applies a practice, add a practice when none covers a decision, and carry the practices to new VS Code UI after every merge. `claudeChrome.css` and the design lines of `UPSTREAM.md` now cite their IDs, and the weekly upstream-watch issue points to the audit.

**Why.** The reasons behind design edits lived in CSS comments, issue threads and `UPSTREAM.md` one-liners, and nowhere said which decisions were deliberate. When upstream adds a new menu or picker, nothing told anyone that Klawly's menu and quick input practices should reach it, and a `claudeChrome.css` selector that stops matching after a merge fails silently. One list with reasons, cited from the code, makes those decisions repeatable and checkable.

## 2026-10-11: One permission level for every chat (issue 453)

**What.**
- The permission level is one setting, Permission Level in Settings > Agents > Permissions, with six levels: Strict (the default on a new install), Ask Before Edits, Accept Edits, Auto (issue 510), Allow Everything Except Credentials and Allow Everything. It applies to every chat; there is no per-chat Allow Everything switch any more.
- The mode menu shows the level as one row with "Change in Settings" (DL-20, DL-11); the row opens Settings. Permission cards end with "Tired of approving?" and a link to the same place. The Allow Everything badge opens Settings and has no close icon, because the chat cannot turn the level off on its own.
- Picking either Allow Everything level the first time shows a warning dialog; Cancel puts the previous level back. It never shows again.
- Untrusted workspaces hold both Allow Everything levels back to Ask Before Edits, and the mode menu row says so.
- Auto (issue 510) edits like Accept Edits and asks Claude Haiku, inside canUseTool, about each other request that would show a card; it never refuses on its own, and a slow or failed check shows the card. Credentials, destructive commands and paths outside the workspace always keep their card, and an untrusted workspace holds Auto back to Ask Before Edits. It needs no warning dialog, because it never approves what Allow Everything Except Credentials would keep asking about. A record it approved says "allowed by Auto".

**Why.** The user wants Allow Everything to mean no prompts at all, and to set it once instead of in every chat. One place to change it, linked from every surface that asks, keeps the interface calm and explains itself; a toggle in each chat made it easy to forget which chats were open.

## 2026-10-11: A neutral, low-saturation look (issue 552)

**What.**
- `design/LANGUAGE.md` gains DL-13, "Neutral surfaces, muted accents": a cool neutral surface ramp, regions separated by one tone step instead of a border, cool gray text, desaturated and rare accents, a cool low-chroma syntax palette, and controls that are borderless at rest. DL-09 now says both accents are muted.
- The design philosophy (`.github/skills/design-philosophy/SKILL.md`) gains principle 8 under Calm, "Tone before line, neutral before color", the "Neutral palette" move and three phrasebook rows.
- The theme pass that applies it to Klawly Dark and Klawly Light (surfaces, borders, accents, syntax colors, `claude.css`, `claudeChrome.css`, the prototype) is tracked in issue 552.

**Why.** The user wants Klawly to look modern, calm and polished: neutral charcoal surfaces, subtle contrast between surfaces, cooler grays, muted accents and understated controls. They find the traditional developer-tool look (warm tones, strong accents, visible boundaries) dated and cluttered. Writing it down as a practice and a principle means every later change, including VS Code surfaces after an upstream merge, is held to the same look.

## 2026-10: Design language v2 (issues 570, 571)

**What.**
- `design/LANGUAGE.md`: DL-01 gains the surface ladder, DL-03 has new radius tiers by prominence, DL-07 becomes "Depth from tone first, hairlines second" (one box deep), DL-09 becomes "Claude Code's color roles, in Klawly's own values", DL-13 drops the cool tilt, and two practices are new: DL-15 (one recipe for interaction states) and DL-16 (type roles). The issue proposed DL-13 and DL-14 for the new ones; those IDs were taken (issues 552 and 532), so they are DL-15 and DL-16. The second DL-55 (line attribution) is now DL-58.
- `design/workbench/palette.html` shows every role on real components in both themes, with the contrast table, and Anthropic's coral beside the sibling orange as a marked comparison. The coral is on that page only and never in a token.
- `design/assets/global.css` carried the v2 values behind a switch (`data-palette="v2"`, the Palette button, `?palette=v2`) until issue 572 shipped them in the themes; the switch is gone and v2 is the default.

**Values.**

| Role | Klawly Dark | Klawly Light |
|---|---|---|
| base: title bar, status bar, activity bar | `#131313` | `#ebebeb` |
| pane: side bar, panel, tabs strip | `#1b1b1b` | `#f3f3f3` |
| surface: editor, chat, active tab | `#242424` | `#fcfcfc` |
| raised: cards, fields, composer | `#2c2c2c` | `#f2f2f2` |
| overlay: menus, popovers, dialogs | `#353535` | `#ffffff` |
| ink / ink-2 / muted / faint | `#e8e8e8` / `#bdbdbd` / `#a0a0a0` / `#6e6e6e` | `#1d1d1d` / `#4d4d4d` / `#666666` / `#a3a3a3` |
| brand fill (K, primary, Send, progress) | `#dd8f52`, text on it `#141414` | `#dd8f52`, text on it `#141414` |
| brand as text | `#dd8f52` | `#9e5522` |
| focus ring, links, permission, suggestions (periwinkle) | `#93a0f0` | `#4d5bc9` |
| Plan (orange, DL-94) | `#dd8f52` | `#9e5522` |
| Agent (gray) / Debug (red) / Multitask (purple) | `#a3a3a3` / `#ec7a8b` / `#a891e6` | `#5c5c5c` / `#b4283d` / `#6b52c0` |
| Accept Edits / auto (purple) | `#a891e6` | `#6b52c0` |
| Ask (quiet green) | `#7cba92` | `#2a754c` |
| success / error / warning | `#6cc08f` / `#f27b8f` / `#e6c35c` | `#2a754c` / `#bb344b` / `#806300` |
| modified file (blue, off amber) | `#7aaae6` | `#2d65ad` |
| text field and checkbox edge | `#808080` | `#8a8a8a` |
| radius none / xs / sm / md / lg / xl / 2xl / pill | 0 / 4 / 6 / 8 / 12 / 14 / 18px / full | same |

Every surface is pure gray (R = G = B). The teal-to-indigo brand gradient is gone; the K is one flat orange.

**The sibling orange.** `#dd8f52` is CIELAB L\* 66.2, C 50.1, hue 61.6°. Anthropic's coral `#d77757` is L\* 60.2, C 48.4, hue 44.5°. The sibling is 17.1° away in hue and 6.0 L\* lighter, past the 8° the guardrail asks for, and it reads as copper-amber next to the coral's salmon. White on it is only 2.6:1, so every filled orange control carries dark ink (`#141414`, 7.1:1), in both themes. Light uses `#9e5522` wherever orange is text (5.4:1 on the surface).

**Contrast** (WCAG 2 ratio; computed with the sRGB formula on Windows 11, worst level each color sits on):

| Pair | Dark | Light |
|---|---|---|
| ink on base / overlay | 15.2 / 10.0 | 14.1 (base) / 16.9 (overlay) |
| ink-2 on overlay / base | 6.5 | 7.1 (on base) |
| muted on overlay / base | 4.7 | 4.8 (on base) |
| periwinkle (links, focus) on overlay / base | 5.0 | 4.8 |
| Plan teal, worst level | 5.5 | 4.8 |
| Accept Edits purple, worst level | 4.6 | 4.9 |
| Ask green, worst level | 5.4 | 4.7 |
| error, worst level | 4.7 | 4.8 |
| warning, worst level | 7.2 | 4.8 |
| modified blue, worst level | 5.1 | 4.9 |
| brand as text, worst level | 4.8 | 4.7 |
| `#141414` on the orange fill | 7.1 | 7.1 |
| text field edge on raised / surface (≥ 3) | 3.3 / 3.6 | 3.1 / 3.4 |

Faint (placeholder, disabled) is exempt from 4.5:1 and is not used for anything a user must read.

**Why.** The audit in the Sprint 10 tracker (#585) found the app sharp, boxy and slightly muddy: radii a tier too tight, separation by outline, two saturated accents plus mode tints competing, and three cool surface levels with the shell as one flat slab. Claude Code's color roles were picked (2026-10-11) so someone coming from the CLI reads Plan, Accept Edits and a permission prompt at a glance, and Klawly gets an identity that is neither another editor's nor stock VS Code's. A sibling orange rather than Anthropic's own keeps Klawly from reading as an official Anthropic product. Orange stays rare (brand and the one primary action), focus and selection stay neutral or periwinkle, and warning moves to yellow because an IDE reads orange as warning. On 2026-10-12 the active tab became tone plus a thin neutral ink line, and the side bar and panel one step up from the title and status bars (#585).

**Brand check.** Before a release ships these colors, check Anthropic's published brand and trademark guidelines again and note the date here. Klawly uses no Anthropic hex value, no sparkle or asterisk, no mascot and no Claude wordmark styling; the logo stays the Klawly K. This is not a legal review; anything unclear goes to the maintainers.

**Applied by.** Issues 572 (themes and the ladder), 573 (color roles, the K recolor in `resources/klawly/` and its synced copies, `claude.attribution.agent` off coral), 574 (radius), 575 (tone, not outline), 576 (shared controls and states), 577 (type roles), and 578 to 583 per surface. Each one updates the code that cites DL-03, DL-07 or DL-09 in the files it touches.

## 2026-10-13: Klawly Dark and Light ship palette v2 (issue 572)

**What.** `extensions/theme-klawly/themes/klawly-{dark,light}.json` take the v2 values: the five-step surface ladder (title, status and activity bars on the base; side bar, panel and tab strip on the pane; editor, chat and the active tab on the surface; fields one step raised; menus, quick input, hovers, suggest, notifications and dialogs on the overlay), pure-gray ink levels, the sibling orange on buttons and progress with `#141414` ink, periwinkle on focus, links, the cursor, match highlights and badges, yellow warnings, blue for modified (git, gutter, ruler, the settings indicator), and the Claude Code mode hues (Plan teal, Ask green). `claude.css` fallbacks match Klawly Dark. The prototype's palette switch is gone.

**Borders.** The title bar, status bar, activity bar, tabs and tab strip lose their borders: tone already separates them (DL-07). The side bar, panel and editor-group edges keep a hairline because there pane meets pane and the tone step is small. Fields keep their edge (DL-07), now the v2 field edge.

**Selection.** The issue said list selection is accent-tinted; DL-15 and DL-09 say selection is neutral, so list and menu selection is ink at 12% (dark) or 10% (light). Only the editor's text selection is periwinkle.

**Cards.** `--claude-bg-card` was the editor-widget color, which v2 makes the overlay. It is now mixed one step up from the surface, so a card sits between the chat and a menu in every theme; high contrast keeps the stock widget color (DL-02).

**Not changed.** Token colors (syntax), terminal ANSI, charts, test, symbol and diff colors, and high contrast (DL-02). Radius, the K and the component moves come with issues 573 to 577; the swatch page previews them (`.pal` rules in `global.css`).

## 2026-10-13: Color roles across the app (issue 573)

**What.** Orange (DL-09) now means the brand and the one primary action only: the K, button fills, Send (in every mode), Build on the plan card, progress and the agent's line attribution (`claude.attribution.agent` moves from the old coral to the brand: `#dd8f52` dark, `#9e5522` light). Everything that wore the accent without being the primary action takes the neutral mark (`--claude-mark`, strong ink): an on switch, the chosen feedback chip, the selected Customize tab, the notebook code cell edge, the Ultracode effort icon. The preview pane's pressed toggle takes the input-option state.

**Badges.** The activity bar badge is neutral ink-2 with dark ink (it was periwinkle in 572); the status bar remote item was already a neutral fill.

**Modes.** `claude.mode.plan` and `claude.mode.ask` defaults move to teal and green in every non-contrast theme, and `claude.mode.acceptEdits` (purple) is new. Purple marks the Accept Edits and auto permission levels on their icon in the mode menu. A mode tint shows only on the mode pill and the plan card's edge: the plan hint's hover is the neutral hover, and Plan mode no longer recolors Send and Build.

**The K.** `resources/klawly/klawly-mark.svg` and `app-icon.svg` drop the teal-to-indigo gradient for one flat brand orange; the app tile is neutral dark instead of navy. `node build/klawly/generate-icons.ts` rebuilt every product icon from them.

**High contrast.** Unchanged (DL-02): the contrast values of the registered colors stay, and `--claude-mark`, the knob and Send keep their earlier colors in the high contrast block of `claude.css`.

## 2026-10-13: Radius scale v2 (issue 574)

**What.** One radius ramp (DL-03): xs 4, sm 6, md 8, lg 12, xl 14, 2xl 18 (the composer only), pill. It is declared once, on `.monaco-workbench, .claude-pane, .claude-root`, so editor widgets, the title bar and hovers read the same tiers as the pane. The scoped redefinitions (the editor widget block, the next-edit hint, the selection bar, the timeline) are gone.

**Source.** xs to lg come from the workbench sizes whose value is the tier's (`cornerRadius.small` 4, `medium` 6, `large` 8, `xLarge` 12). Themes can't override those sizes and upstream uses them in hundreds of rules, list rows and tabs among them, so Klawly did not retune them: that would round the shell. xl and 2xl have no workbench size and are literals in the ramp.

**Re-tiered.** Cards are xl (plan, permission, subagent, changes, review findings and feedback, side question, todo and goal strips, GitHub card, background agent, home start). Buttons, rows and text fields are md (`.claude-btn`, todo and tool rows, session and usage rows, plan inputs, question options and inputs, the customize search). Overlays are lg (the inline widget, the selection bar, hovers). Inner parts are one tier below their container. Every round thing is pill instead of `50%`, and no literal radius is left in Klawly's CSS.

**High contrast.** Colors and edges are unchanged (DL-02). Corners follow the same tiers in every theme: shape is not a contrast setting.

**Prototype.** `--k-radius-*` sync from the app, the composer is 2xl and the same components moved tier. The `.pal` composer and permission radius previews are gone. VS Code surfaces drawn in the prototype (find widget, matches, rulers) keep upstream's corners.

## 2026-10-13: Type roles (issue 577)

**What.** The DL-05 ramp, the four text inks, the DL-10 icon sizes and the DL-16 roles are declared once, on `.monaco-workbench, .claude-pane, .claude-root`, so editor widgets, the title bar and the VS Code parts Klawly restyles read the same values. The scoped copies (the next-edit hint, the editor widget block) are gone. Each role is four tokens: `--claude-text-<role>` and its `-leading`, `-weight` and `-ink`.

**Literal sizes.** None is left in Klawly's CSS. Glyphs moved to icon sizes (12, 14, 16, plus 8 for the check inside a question's 14px radio and 28 for the setup spinner). Text moved to a role or a ramp step. The 16px icons were already the codicon base size, and the 28px spinner is an icon, not text, so neither joins the type ramp. The empty chat title used upstream's 18px heading and is now 17 (xl). Two glyphs grew by 1px to land on the icon ramp: the todo state icon (13 to 14) and the session switch close (11 to 12).

**Weights.** Every 500 is now 400 or 600. Card heads and titles, step titles and menu group titles are 600 (heading or label). The tag badge, the settings buttons and the Agents Window pill are 400: a tag is the status role, and a button or a title-bar action reads as body text, like `.claude-btn` and the pill's neighbors.

**Inline code.** Inline code in prose keeps an em size (.92) so it sits on the line it is in. Two rules used .9em; all four are .92em now.

**Prototype.** `--k-icon-*` sync from the app; the `--k-text-<role>` tokens mirror the roles. Literal sizes in `global.css` that are ramp or icon values became tokens, value for value; the weights follow the app. VS Code surfaces drawn in the prototype keep upstream's off-ramp sizes (the 9px activity badge, the 24px dialog icon, the 34px extension icon, the 11px graph ref icon), and so does the sample content inside the canvas demo.

**High contrast.** Unchanged (DL-02): the `claudeChrome.css` rules still skip the high contrast themes, and sizes and weights are not contrast settings.

## 2026-10-13: Shared controls (issue 576)

**One recipe per control.** `.claude-btn`, `.claude-field`, `.claude-chip.is-toggle`, `.claude-segmented` and `.claude-pill` now carry all of a control's colors and states (DL-15). The surface rules that repainted them (the settings search, select, input and multiline field, the agents search, the customize search and filter chips, the plan step and new-step inputs, the side question field, the settings head buttons, the Home hint) now set only layout. The DOM gained the recipe classes; the old surface classes stay as layout hooks and test hooks.

**Secondary is the default button.** A plain `.claude-btn` is the secondary button: a tone fill (`button.secondaryBackground`), no outline (DL-13). `is-outline` is retired: the plan card's Edit Plan and the settings head buttons that were outlined (Create CLAUDE.md, the add actions, New Automation) are secondary now. `is-secondary` stays as an explicit name. The ghost and icon buttons draw nothing at rest and take the state steps on hover and press.

**Sizes.** Default 26px at md, medium 24px at md (section heads, lists), small 20px at sm (toolbars, card action rows), per DL-06 and the radius tiers (DL-03).

**States.** Hover, pressed, selected and selected-and-hovered are the `--claude-state-*` ink steps: 6/10/12/15% in a dark theme, 5/8/10/12% in a light one. Disabled is 40% opacity everywhere (the split button was 50%). The focus ring shows for the keyboard only. The tokens live in the block that editor widgets and the title bar also read, so the inline banner's buttons and the review feedback keep the accent.

**Fields.** Every field is 26px with the `input.border` edge (3:1), a stronger edge on hover and the focus color on focus. In high contrast every field takes the stock `contrastBorder` (DL-02).

**Chips and pills.** The customize filters are toggle chips at 24px with the neutral selected fill, not orange (DL-09). Pills are for mode and status only, so Queue and Steer beside Send are md buttons and the Home hint is a secondary button. The Plan hint and the pull request pill take the pill look with no outline; high contrast outlines them.

**Segmented.** The review scope switch is a fill track at md (24px) with the current segment at sm on the raised fill; hover is the state step.

**Prototype.** `global.css` mirrors the recipes (`.k-btn` primary, secondary, ghost, icon, danger, `is-md`; the field edge on `.k-input`, `.k-select` and `.k-field`; `.k-chip.is-toggle`; the segmented track). Every `is-outline` and `is-outlined` button in the pages is `is-secondary`. `workbench/controls.html` is the controls sheet.

## 2026-10-13: Tone, not outline (issue 575)

**Removed.** Cards that already differ from the pane by fill lose their outline (DL-07): the user bubble and its toolbar, code blocks, banners, the permission card, the plan card, boxed tool rows, a diff body under a tool row, subagent and background agent cards, the changes card and its bar, new problems, the todo and goal strips, review findings and their threads, the Home start card, the GitHub card, the side question, and the question preview and elicitation warning boxes. A boxed tool row and the side question also lose their shadow: they sit in the transcript or the composer stack, they do not float. Dividers inside cards (code block header, tool footer, inspector, changes head and foot, plan section heads, goal rows, the open tool row, inline answers, terminal reply and wait) are the faint hairline.

**Status by tone.** A pending permission takes an amber tone (6%) and a risky one a red tone (7%) instead of a colored edge; error and warning banners do the same, and the elicitation warning is an amber tint (DL-09). A review finding keeps only its 3px severity edge.

**Kept.** Overlays, fields (the composer, the inline edit card, `.claude-field`, plan notes, now on the field edge instead of a dashed box), the focus ring, keycaps, the transparent high contrast hooks, frames around foreign content (MCP Apps, tool images), pane, column and settings row dividers, and the left rules of thinking and folded blocks. The read-only hint lost its dashed box for a quiet fill: dashed means "drop here".

**Light themes.** The raised fill equals the side bar in a light theme, so an unoutlined card would vanish. A card there is a well 5% of ink below the pane (`--claude-bg-card` on the pane and Home roots), which also replaces the old light edge fix for code blocks and boxed tool rows.

**High contrast.** Unchanged (DL-02): one block at the end of `claude.css` (and in the question and elicitation sheets) restores every removed edge, the banner edge colors, the finding thread box, the dashed read-only hint and plan notes, and drops the status tints back to the card fill.

**Counts.** `1px` solid, dashed and dotted borders (comments excluded): `claude.css` 106 to 90, all Klawly CSS 134 to 118, of which 15 now sit in high contrast rules. The prototype's `global.css` 134 to 117; its edit card took the card fill, and its dashed details line is a solid hairline.

## 2026-10-13: One overlay recipe in the editor (issue 580)

**What.** Everything Klawly floats over code takes one recipe, the same four lines as the menus next to it: the overlay fill (`--claude-bg-elevated`), a hairline (`--claude-border`), the popup shadow and the lg radius (DL-03, DL-07). That is the inline edit card, the selection toolbar, the inline diff's hunk actions and its Undo / Keep chip, and the change navigator. One grouped rule in `claude.css` (after the editor token block) and in `global.css` holds it; the surfaces keep only layout. Their buttons sit one tier in, at md.

**Decisions.**
- The inline edit card is an overlay, not a field. It was a field edge (border-strong) on the card fill with its own 4px shadow; it now matches the menus and the selection toolbar beside it. Its focus cue is the periwinkle focus ring on the hairline (DL-09); it was described as teal in issue 121.
- The change navigator (`.claude-review-bar`) floats at the bottom of an editor, so it is an overlay. The docked changes bar above the composer stays a card (issue 575).
- The next-edit hint is a quiet chip: the suggestion periwinkle at 12% with no outline and no left mark, on the meta role (DL-16).
- Finding threads are cards at the card radius (xl), keeping their 3px severity edge. The Comments for Claude tray loses its outline like every card.
- The terminal prompt shares `.claude-inline`, so it takes the hairline; it keeps its own card fill and soft shadow.

**High contrast.** Unchanged (DL-02): the inline edit card keeps its strong edge, the inline diff's hunk actions keep no edge, the next-edit hint keeps its outline and left mark, and the tray's edge is in the restore block. The popup shadow is already none in high contrast.

## 2026-10-13: Settings rows and Home (issue 581)

**What.** Inside the Settings cards, a row is its content plus ramp padding (12px), with no fixed 61px or 45px height. Text and control sit 16px apart (DL-04). Titles use the label role and descriptions the secondary role, 2px below (DL-05). Row, meter, list and form dividers are the faint hairline inside a card (DL-07). Section labels use the heading role, 24px apart, with no rule. Every control at a row's end is 26px (DL-06): the models page's 24px effort select is gone. The control column ends on one edge and is 26px tall even for a switch. In Customize, the search is the shared field, Refresh is an icon button with its name in a hover, the kind chips are the toggle chip and Add Marketplace and Back are secondary buttons. On Home the install hint is the secondary button at the pill tier; the start tiles are cards (issue 575), and they now drop the native button edge the browser drew around them in dark and light themes.

**Decisions.**
- Settings switches stay 32 by 20, a size up from the composer's, centered in the 26px control slot. The shared switch recipe is the same control; only its size modifier differs.
- The settings card keeps its tonal fill (`fill-5`) and the Home tiles theirs; both are the card recipe already.
- The classic Settings and Keyboard Shortcuts editors (DL-24) were checked against the ladder and need no change in this issue.
- The Home start tiles had lost their `border` rule when the outline became a tone, so the browser drew its default button edge; `border: none` restores the tone-only card. High contrast still sets its edge (DL-02).
- #533 (pages do not scroll) is not part of this.

**High contrast.** Unchanged (DL-02): the dividers go back to the contrast border in one block at the end of `claude.css`.

## 2026-10-13: The agent pane (issue 578)

**Composer.** The 2xl composer keeps its raised fill (the input fill: one step up from the pane in Klawly Dark, white on the light side bar) and loses its edge at rest. A hairline (`--claude-border`) shows on hover and the focus color on `:focus-within`. The light theme's edge-and-shadow fix is gone: shadows are for overlays (DL-07). In a light editor tab the white field would vanish on the white editor, so there the composer takes the card well. The toolbar keeps its shared pills and buttons and its DL-52 and DL-53 behavior.

**Tool rows.** A shell command is a 24px row like every other tool (no card, no 30px header), with its chevron on hover. Its wait strip, output and footer sit under it as one tonal block at the 22px tool indent, md corners, with the terminal's own fill removed. The diff under an edit row drops its inner code fill for the same reason. The timeline treats commands as rows, so they stack with the other tool rows.

**Rhythm.** `--claude-gap-turn` 16px between turns, `--claude-gap-block` 12px inside a turn, `--claude-gap-tool` 8px between a tool row and prose (DL-04). Turns grow 4px apart; a row next to prose moves 4px closer, and an open command no longer adds a card's padding, so a long turn shows at least as many tool rows as before.

**Metadata.** "Thought for", "Worked for" and the finish time use the meta role (11px, muted); their chevrons go to the compact icon. The context ring takes the meta ink. Folded block summaries stay in the chat size: they are content.

**Already done.** The user bubble (lg, tonal, opaque when sticky), subagent cards, the todo strip, the changes bar, and permission and question cards took the xl card recipe in #575.

**High contrast.** Unchanged (DL-02): the composer keeps `border-strong` and its old focus mix, the command keeps its boxed card, 30px row, divider, chevron and code fills, and the diff keeps its code fill, in the restore block at the end of `claude.css`.

## 2026-10-13: Plan card and plan editor (issue 579)

**What.** The plan card in chat has no box inside it: the notes lost their field box and sit under the steps' own faint hairline, showing the field edge on hover and the ring on focus (DL-07). Spacing is on the ramp: 12px above the head, 6px around each step, 24px between the editor's sections (DL-04). Text takes the type roles: the summary and the eyebrow the body role (the eyebrow in the secondary ink), the editor's title the title role and its section heads the heading role (DL-05). Edit Plan, Open Plan and Build share one 20px height in the card and Build is 20px in the editor header, the small button of a card's action row (DL-06); Build keeps the orange fill as the one primary action (DL-09). The editor's progress bar fills in orange on a fill-step track (DL-13).

**Decisions.**
- The mode shows as a label, not an edge: the teal checklist icon and "Plan · N steps" above the title. A teal edge would be a status edge, and DL-07 keeps those for review findings only.
- One height is 20px, not 24px: DL-06 puts a card's action row on the small button, like the permission card's. Build's split follows inside the plan selectors (`.claude-split.is-plan`); the shared split stays 24px everywhere else.
- The notes keep their size (two lines, 40px at least) and stay resizable; their text now aligns with the step badges.
- The plan editor's to-do rows lose 2px each (22px, the compact row), since the 18px line already fills them; a row with a detail line is 38px.
- The plan editor's More button stays the 22px icon button of every toolbar.

**High contrast.** Unchanged (DL-02): the notes keep their dashed field box at the old size, without the hairline above it, in the restore block at the end of `claude.css`.

## 2026-10-14: Review with Claude gets its own Source Control section (issue 749)

**What.** Review Changes with Claude leaves the Changes header, where its words squeezed the repository title to "CH…". It is now the button of a Review with Claude section, under Changes and above Graph, with one line saying what the review does (DL-73).

**Decisions.**
- A section, not an icon: the reporter asked for a closable panel like Graph, and the action reads poorly as a bare mark. The section has no header actions; its body is the view's welcome content, so it is drawn by upstream code with upstream styles.
- Order 1.5 places it between Changes (1) and Graph (2) without touching upstream's registrations. It shows only while a source control provider is registered and the agent is on.
- The command stays in the Command Palette. Split into Pull Requests keeps its icon in the Changes header.

**High contrast.** Unchanged: welcome content and section headers are upstream's (DL-02).

## 2026-10-16: Fix Problems with Agent, and "Fix with Agent" everywhere (#1118)

**What.** The Preview button and command read "Fix with Agent" (tooltip: "Send the selected element to the agent to fix"). The Problems action reads "Fix Problems with Agent" in the lightbulb and the new-problems row. The Security Findings, Review editor and master-plan names follow.

**Why.**
- PR #1106 renamed the buttons to "Fix with Agent" but missed the Preview, the Problems action, `design/` and the feature lists, so one action had three names.
- Fix Problems sends every problem in the file, a wider scope than one finding or element, so it keeps "Problems" but follows the "... with Agent" pattern.
## 2026-10-16: The Preview palette command names the selected element (#1160)

**What.** The Preview button stays "Fix with Agent". The palette command `claude.preview.fixElement` reads "Fix Selected Preview Element with Agent" (PR #1149), so the palette title names the target.

**Why.**
- The palette has no selection context: a bare "Fix with Agent" in the palette does not say what it fixes, and the button already shows the target by sitting on the selected element.
- The button keeps the short label because it sits on the element; the palette title carries the target in words.
