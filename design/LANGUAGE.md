# Design language

What Klawly looks like and why: each design practice, the reason for it, and where it lives in the app. Rule 37 (`docs/rules/37-design-language.md`) makes it binding.

The other design files cover different things:

- `PRACTICES.md`: how to work on the `design/` prototype.
- `DECISIONS.md`: why the prototype works the way it does.
- `.github/skills/design-philosophy/SKILL.md`: the vocabulary (Calm, Focused, Consistent, Delightful → principles → moves).

This file sits between them. It records the **decisions** Klawly has made with that vocabulary, so the same decision is made the same way next time: on a Klawly surface, on a VS Code surface Klawly restyles, and on a VS Code surface that upstream adds later.

## How to read an entry

Every practice has an ID (`DL-NN`). Code that applies a practice cites the ID in the comment above it (`/* DL-21: ... */`), so a reader can find the reason and a search for the ID finds every place that applies it.

- **Practice**: what holds, in role terms (tier, ramp, role), with the numbers only as a reference.
- **Why**: the feeling it serves and the problem it fixed. Without a reason, the next person cannot tell a decision from an accident.
- **Where**: the files that apply it.
- **Applies to**: the surfaces it covers, including VS Code surfaces it must be carried to.
- **Since**: the issue or PR that made the decision.

## How a practice reaches a surface

Use the cheapest step that does the job, in this order. VS Code surfaces have to go through it again after every upstream merge, so cheap steps are what keep Klawly mergeable.

1. **A theme color** in `extensions/theme-klawly/themes/klawly-{dark,light}.json`. Upstream already reads these, so nothing can break on a merge.
2. **A Klawly token** in `claude.css` (`--claude-*`) for Klawly surfaces. Every token resolves to a `--vscode-*` theme variable.
3. **A scoped CSS rule** in `src/vs/workbench/contrib/claude/browser/media/claudeChrome.css` for a VS Code surface. Every rule is scoped `.monaco-workbench:not(.hc-black):not(.hc-light)` (DL-02), and its comment names the practice, the surface and the issue.
4. **A registration point** that upstream code exposes, or one small hook added to it that a contribution fills (for example `registerEditorGroupWatermarkContent`).
5. **A small edit to upstream TypeScript**, listed in `UPSTREAM.md` with the practice ID. Use this only for what CSS cannot reach: sizes computed in code, row heights, which actions are pushed.

---

## Foundations

### DL-01 Color comes from the theme, on one surface ladder

**Practice.** Every color is a theme variable: `--vscode-*` directly, or a `--claude-*` token that resolves to one. A literal color appears only as the fallback inside `var()`. Surfaces come from one neutral charcoal ladder, by role:

| Level | Role | Klawly Dark | Klawly Light |
|---|---|---|---|
| base | title bar, status bar, activity bar, the Agents window shell (`agents.background`) | `#131313` (L\* 6) | `#ebebeb` |
| pane | side bar, panel, tabs strip, Agents window panels (`agentsPanel.background`) (one step up from base, #585) | `#1b1b1b` (L\* 10) | `#f3f3f3` |
| surface | editor, chat, the active tab | `#242424` (L\* 14) | `#fcfcfc` |
| raised | cards, text fields, the composer | `#2c2c2c` (L\* 18) | `#f2f2f2` |
| overlay | menus, popovers, the quick input, hovers, dialogs | `#353535` (L\* 22) | `#ffffff` |

Every level is pure gray (hue tilt at most 1 point, no blue, warm or brown cast). In light, raised is a step *down* from the surface (a tonal well) and overlay is white. Ink fills (hover, pressed, selected) are `color-mix` of the text color, not fixed grays (DL-15). The values are a reference; the tokens carry them (`design/DECISIONS.md`, 2026-10: design language v2).
**Why.** Klawly ships Klawly Dark and Klawly Light and has to work in every user theme and in high contrast. A literal color is right in one theme and wrong in all the others. Calm: with only three slightly cool levels, the whole shell (title bar, side bar, panel, status bar, tabs) was one flat slab and cards had to be outlined to show at all. Five named levels let tone do the separating (DL-07), and naming them by role means a new surface asks "what is it" instead of picking a gray.
**Where.** `claude.css` (token block at the top), `extensions/theme-klawly/themes/`, `design/assets/global.css` (`--k-base` to `--k-overlay`).
**Applies to.** Everything. User themes keep their own colors.
**Since.** §42 of the master plan; rule 30; #570, #571.

### DL-02 High contrast keeps the stock look

**Practice.** Klawly's restyles of VS Code chrome apply only to the regular dark and light themes. High contrast themes keep upstream's look.
**Why.** Upstream's high contrast themes are tuned for accessibility (borders on every control, focus outlines, no meaning in color alone). A restyle that removes a box or a focus ring, as DL-21 does, would break that. Leaving high contrast stock keeps it accessible and is never wrong.
**Where.** Every rule in `claudeChrome.css` is scoped `.monaco-workbench:not(.hc-black):not(.hc-light)`. `workbenchThemeService.ts` keeps the stock high contrast defaults.
**Applies to.** Every restyle of a VS Code surface.
**Since.** The first chrome restyle (issues 163, 170).

### DL-03 Radius follows prominence

**Practice.** Corners are set by what a thing is, not picked per element:

| Tier | Use | Value |
|---|---|---|
| none | shell parts, panes, the tabs strip, tree rows | 0 |
| xs | small badges, scrollbar thumbs, inner edges of key caps | 4px |
| sm | compact controls: icon buttons, chips, key caps | 6px |
| md | buttons, menu rows, list highlights, text fields | 8px |
| lg | menus, popovers, the quick input, hovers, dialogs, the editor overlays (inline edit card, selection toolbar, hunk actions, change navigator) | 12px |
| xl | cards: plan, permission, question, subagent, changes, settings groups | 14px |
| 2xl | the chat composer only | 18px |
| pill | mode and status pills, round buttons | full |

An inner element is rounded one tier below its container (a menu row is md inside an lg menu). The shell is never rounded. No component redefines a tier token locally, and no literal radius appears outside `var()`.
**Why.** Calm and Consistent: the same radius means the same kind of thing everywhere, so depth reads at a glance. The old tiers were one step too tight (cards 6px, the composer 8px, buttons 4px), which made the app read sharp and boxy, and the editor overlays redefined `sm` and `md` as 5px and 7px, so one token meant two things. Rounding by prominence lets the most important surface, the composer, be the softest one.
**Where.** `--claude-radius-*` in `claude.css`; `--k-radius-*` in `design/assets/global.css`; the quick input rows in `claudeChrome.css`.
**Applies to.** Klawly surfaces and every VS Code overlay Klawly restyles.
**Since.** Phase 32 primitives; `design-philosophy` "Elevation tiers"; #570; editor overlays and their md buttons since #580.

### DL-04 Spacing on the 4px ramp

**Practice.** Gaps, padding and margins come from 2, 4, 6, 8, 12, 16, 24 and 32px (`--claude-space-1` to `-8`). 10px is allowed where a measured reference needs it (menu label inset, DL-20). **The chat has three rhythm values:** 16px between turns (`--claude-gap-turn`), 12px between blocks inside a turn (`--claude-gap-block`) and 8px between a tool row and the prose next to it (`--claude-gap-tool`); tool rows stack with no gap. Metadata lines ("Thought for", "Worked for", the finish time, the context ring) use the meta type role.
**Why.** Calm: one rhythm across the window. Off-ramp values (5px, 7px) are the most common reason two neighbors look "slightly off". In the chat, each block used to pick its own gap and ink, so a turn's edges were hard to see; three named values make a turn read as a unit and keep tool rows dense.
**Where.** `--claude-space-*` and `--claude-gap-*` in `claude.css` (`--k-gap-*` in `design/assets/global.css`); `--vscode-spacing-*` (`.github/instructions/design-tokens.instructions.md`).
**Applies to.** Everything; the `--claude-gap-*` values to the chat timeline.
**Since.** Phase 32; chat rhythm and meta lines since #578.

### DL-05 Type ramp and two weights

**Practice.** Sizes come from the ramp: 10, 11, 12, 13, 14 (chat), 15, 17, 22px. Weights are normal and semibold (600); 500 and bold are not used. Group labels are small and muted. A title is a heading, not a caps banner. The ramp is declared once, on `.monaco-workbench, .claude-pane, .claude-root`, so editor widgets, the title bar and the VS Code parts Klawly restyles read the same steps. Off-ramp sizes move to the nearest step (upstream's 18px heading is 17).
**Why.** Calm and Focused: hierarchy comes from size and color, not from capitals, bold and boxes together. Upstream uses uppercase labels in several places (notification center, settings groups), which shout next to Klawly's surfaces.
**Where.** `--claude-text-*` and `--claude-weight-strong` in the type block of `claude.css`; the notification center header, quick input and settings group titles in `claudeChrome.css`. `npm run test-node` fails on a literal `font-size` or a 500 weight in Klawly's CSS.
**Applies to.** Every label, heading and group title, including VS Code ones.
**Since.** Phase 32; issues 171 and ide-42.

### DL-06 Row and control heights follow the row ramp

**Practice.** Tree rows 22px. Menu rows and quick input rows 24px. Standard rows 28px (also headers such as the notification center's). Tall two-line rows 42px. Text fields, selects and buttons 26px; medium buttons 24px (a section head or a list); small buttons 20px (a toolbar or a card's action row).
**Why.** Consistent: a list of choices is the same height wherever it opens, so the command palette, a context menu and a Klawly picker feel like one widget. Upstream mixed 22px quick input rows with 24px menu rows and 26px notification buttons.
**Where.** `--claude-row-*`, `--claude-control-h` in `claude.css`; quick input rows in `quickInputList.ts` and `quickInputDelegate.ts` (`UPSTREAM.md`); notification buttons and settings fields in `claudeChrome.css`.
**Applies to.** Every list, menu, picker and form control. A multi-line field (a prompt, a list of rules) is three 18px lines tall at least and grows on drag. A settings row has no fixed height: it is its content plus ramp padding, its title on the label role and its description on the secondary role 2px below, and every control at its end is 26px, the column ending on one edge across rows (a switch sits centered in that 26px slot).
**Since.** Phase 32; issues 163, 164, 171, 426; settings rows since #581.

### DL-07 Depth from tone first, hairlines second

**Practice.** A surface inside a pane separates by a fill step on the ladder (DL-01), not by an outline. A border is kept only where it does a job: text fields (where you type), overlays (they float over content, so they also take the one soft shadow), the focus ring, and high contrast (DL-02). **One box deep:** a box never sits directly inside another bordered box; an inner block (a diff inside a tool row, notes inside a plan card) takes a fill step or a hairline divider instead. A divider is a hairline (`menu.separatorBackground`, `widget.border`). Shadows belong to overlays only.
**Why.** Calm: the window reads as one quiet surface. Klawly had 92 `1px` borders, transcript cards carried a border, a fill and a shadow at once, and boxes sat inside boxes, so the transcript looked like a form. Tone separates without drawing a line the eye has to read, and keeping borders for the places where they mean something (type here, this floats, this has focus) makes each remaining border informative.
**One overlay recipe.** Everything that floats over code (the inline edit card, the selection toolbar, the same toolbar over a terminal selection, the hunk actions and the change navigator) and every VS Code overlay (menus, the quick input, hovers and tooltips, dialogs, notification toasts and the notification center) takes the same four lines as Klawly's menus: the overlay fill (`--claude-bg-elevated`), a hairline (`--claude-border`), the popup shadow and the lg radius (DL-03), with its buttons one tier in at md. The inline edit card is an overlay, not a field: its focus cue is the periwinkle focus ring on that hairline (DL-09). A quiet editor hint (next edit) is a low-strength tint on the meta role, with no outline. Docked bars and finding threads are cards, not overlays.
**Kept edges.** A border stays only where it does one of those jobs: overlays (menus, the menu preview, the editor overlays above), fields (`.claude-field`; the composer shows a hairline only on hover and the focus ring on focus, since its raised fill already marks it), the focus ring, keycaps, the transparent high contrast hooks on buttons, chips and the segmented control, frames around foreign content (an MCP App, a tool image), the pane and column dividers, row dividers in settings lists, and the left rule of thinking and folded blocks. A tool row is never boxed, a shell command included: what a tool shows under its row (a diff, a command's wait, output and actions) is one tonal block at the tool indent, with no fill of its own inside it. A severity or status edge stays as a 3px left edge (a review finding); a pending permission or a warning or error banner takes a status tone instead (DL-09). Dividers inside a card use `--claude-border-faint`. In a light theme the raised step equals the side bar, so a card there is a well 5% of ink below the pane. Code reads from one gutter: `--k-code-gutter` is 68px (line numbers 64px plus 4px before the text), and everything that aligns to the text column in a diff or editor (an inline edit zone, a finding thread, a hunk row) uses it, so a design page and the app put the first character at the same x (#1454). The prototype's pending permission card follows the same base (the warning tint over a 4% ink well on the editor fill, 5% on the pane in a light theme), so its fill matches the app's rather than the raised token (#1463). Dashed means "drop here", nothing else. Like the composer, the plan card's notes have no resting edge: they sit under the steps' faint hairline as a line of text, show the field edge on hover and the ring on focus, so the card has no box inside it (#579). A plan card shows its mode with the orange checklist icon and the "Plan" label, not an edge or a wash.
**Where.** `--claude-border*`, `--claude-shadow-*` in `claude.css`, with the high contrast block that restores each removed edge at its end; the quick input header hairline and the menu separators in `claudeChrome.css`.
**Applies to.** Cards, tool rows, menus, popovers, the quick input, hovers, settings groups.
Each VS Code overlay keeps its own theme keys for the fill and the hairline (`menu.*`, `quickInput.background`, `editorHoverWidget.*`, `notifications.*`, `widget.border`), and Klawly's themes set them all to the overlay fill and the hairline; `--claude-shadow-popup` is declared on the workbench so they share the shadow. The shadow stays small (8px of blur at most) and its strength is the theme's `widget.shadow`, so an overlay keeps a visible edge over a dark or a light editor: the hairline draws it, the shadow lifts it.
**Since.** Phase 32; #570; tone over outline in every card since #575; one overlay recipe since #580, for VS Code overlays since #583; plan notes without a box since #579; the composer and command rows since #578; the terminal selection bar since issue 780.

### DL-08 Motion is short and optional

**Practice.** Transitions take 50 to 200ms with an ease-out curve. Under `prefers-reduced-motion: reduce` they are zero, and so is every infinite animation (shimmer, caret, spinners, skeleton rows). The in-app `workbench.reduceMotion: on` (`.monaco-workbench.monaco-reduce-motion`) does exactly the same with the OS setting off: every rule in a reduced-motion block has its twin under that class.
**Why.** Delightful only when it earns its keep: motion confirms a press or an opening, then gets out of the way. Reduced motion is an accessibility requirement (§42).
**Where.** `--claude-dur-*`, `--claude-ease-*`, the `prefers-reduced-motion` blocks in `claude.css` and `claudeVoice.css` and their `.monaco-reduce-motion` twins; the claudePaneCss test fails when a twin is missing.
**Applies to.** Every animated Klawly surface.
**Since.** Phase 32; rule 30; the twins from issue 787.

### DL-09 Claude Code's color roles, in Klawly's own values

**Practice.** Klawly follows Claude Code's color *roles* with its own values:
- **Brand and the one primary action:** a sibling orange (`#dd8f52` in dark; `#9e5522` where orange is text in light). It marks the Klawly K, the primary button, Send, progress and the agent's line attribution, and nothing else. A filled orange control carries dark ink (`#141414`, 7.1:1), never white.
- **Focus** is a soft periwinkle ring. **Selection** is a neutral ink fill (DL-15). Neither is ever orange. The active tab is tone plus a thin neutral ink line (#585).
- **Modes, as in Claude Code:** Plan is orange (DL-94), Accept Edits / auto is purple, Ask is a quiet green; permission prompts, links and suggestions are periwinkle. A mode tint shows only on the mode pill and the plan card's edge.
- **Meaning only:** success green, error red-pink, warning yellow (so orange never means warning). A modified file is blue, not amber.
- Never Anthropic's exact brand colors or marks (no sparkle, mascot or wordmark styling); Klawly uses its own sibling values. Never another product's brand color.

**Why.** Focused: when orange is rare, the one orange thing is the one thing to click. Indigo and teal were both saturated and competed with each other and with the Plan and Ask tints, four accents at once. Claude Code's roles let someone coming from the CLI read Plan, Accept Edits and a permission prompt at a glance, an identity that is neither another editor's nor stock VS Code's. A sibling orange, 17° away in hue and lighter than Anthropic's coral, keeps Klawly from reading as an official Anthropic product (rules 30, 35). Warning moves to yellow because an IDE reads orange as warning.
**Where.** `extensions/theme-klawly/themes/`, `--claude-accent*`, `--claude-mode-*` in `claude.css`; `--k-brand*`, `--k-focus`, `--k-mode-*` in `design/assets/global.css`; `design/workbench/palette.html` (the swatch page); `resources/klawly/` (the K).
**Applies to.** Everything.
**Since.** The Klawly themes; rebrand (PR #90); #570, #571.

### DL-10 Icons: codicons in Klawly, Seti for files in VS Code parts

**Practice.** Klawly parts draw codicons, the Klawly mark comes from `resources/klawly/`, and file icons in VS Code parts (explorer, tabs, quick input, search) stay the Seti theme's. A glyph is sized by the text it sits in, from five sizes: 12 compact (next to 11 to 12px text), 14 (next to 13 to 14px text and in toolbars), 16 base (a row's leading icon), 8 (a check inside a 14px control) and 28 (the one setup spinner). They are `--claude-icon-mark`, `-compact`, `-md`, `-base` and `-display`.
**Why.** Consistent with what the app already draws; a Klawly file icon theme was considered and rejected (issue 155). One icon set per role avoids two styles meeting in one row.
**Where.** `workbench.iconTheme: vs-seti`; `design/DECISIONS.md` (2026-10-08, file icons).
**Applies to.** Every icon.
**Since.** Issue 155.

### DL-11 Words: Klawly, Claude Code concepts, title case

**Practice.** User-visible text says Klawly (never VS Code or Code - OSS, unless it means Microsoft's editor), uses Claude Code's concepts only, uses title case for commands, buttons and menu items, and names the secondary side bar "Agent".
**Why.** The product is one thing, so its words are too. Each stray "VS Code" or "Secondary Side Bar" reminds the user they are in a fork.
**Where.** `UPSTREAM.md` (product-name rename, `auxiliaryBarActions.ts`).
**Applies to.** Every string, including the strings of upstream surfaces added later.
**Since.** 2026-10-08 rename; #358.

### DL-12 Hide what does not apply

**Practice.** A control that cannot do anything in Klawly's context is not shown: no Split on the singleton Klawly Settings editor, no breadcrumbs on the plan editor (it has its own header), no upstream Chat view while upstream chat is off, no notification position dropdown.
**Why.** Calm and "the interface explains itself": a control that does nothing or duplicates a Klawly control is noise, and every extra control is one more thing to read.
**Where.** `editor.contribution.ts`, `EditorInputCapabilities.HideBreadcrumbs`, `chatParticipant.contribution.ts`, `notificationsCenter.ts` (all in `UPSTREAM.md`).
**Applies to.** Every upstream control that shows up next to a Klawly surface, and every Klawly form field a choice makes moot: the automation editor shows only its trigger's fields, Saved In only when there is a choice, and says where a run works instead of asking.
**Since.** #106, issue 165, issue 426.

### DL-13 Neutral surfaces, muted accents

**Practice.** Klawly's look is neutral and low-saturation. Surfaces come from the neutral ladder in DL-01: charcoal grays in Klawly Dark and soft off-whites in Klawly Light, with no blue, warm or brown cast. Neighboring regions differ by one ladder step, and a border between two regions that already differ in tone is removed (DL-07). Text and icons are neutral grays, with secondary ones muted. Accents are rare: the primary action, focus and real status only (DL-09), never decoration, grouping or a region's background. Syntax colors are low-chroma and share one lightness band. Controls are borderless at rest, take a soft ink fill on hover and show an outline only on keyboard focus (DL-15); text fields keep their edge (DL-07).
**Why.** Calm and Focused: the user asked for a look that is minimalist, cohesive and polished, with a quiet hierarchy, and said the traditional developer-tool look (warm tones, strong accent colors, visible boundaries around every region) feels dated and cluttered. When tone separates regions and color is rare, the one colored thing on screen is the one that matters, and the window reads as one calm surface rather than a grid of boxes. The earlier ramp leaned slightly cool (blue 2–3 points above red); v2 makes it pure gray so the orange brand never sits on a tinted ground. It is also what makes Klawly look like its own product rather than a reskinned VS Code (DL-11).
**Where.** `extensions/theme-klawly/themes/klawly-{dark,light}.json` (surface ladder, borders, accents, token colors); `--claude-*` surface, border and accent tokens in `claude.css`; the restyles in `claudeChrome.css`; `design/assets/global.css`. Philosophy: principle 8 and the "Neutral palette" move in `.github/skills/design-philosophy/SKILL.md`.
**Applies to.** Every surface, Klawly and VS Code, in Klawly Dark and Klawly Light, including surfaces upstream adds later. High contrast keeps the stock look (DL-02). User themes keep their own colors (DL-01).
**Since.** Issue 552; #570.

### DL-14 A choice that cannot run says why, in place

**Practice.** When an option applies here but cannot run with this setup (an older Claude Code, the wrong sign-in), it stays in its list and its own description says why, in Claude Code's words ("needs Claude Code 2.1.296 or later; this is 2.1.200"). Picking it does nothing; no dialog, no notification after the click.
**Why.** Calm and "the interface explains itself": hiding the option (DL-12) would hide a feature the user could get by updating, and failing after a click makes them pay a step to learn what Klawly already knew.
**Where.** `claudeRunInPicker.ts` (Cloud...), `claudeCloudUnavailableReason` in `claudeCloud.ts`.
**Applies to.** Klawly pickers and menus whose rows depend on what the installed Claude Code supports. DL-12 still covers options that never apply in Klawly.
**Since.** Issue 532.

### DL-15 One recipe for interaction states

**Practice.** Every control shows its state the same way, as fills mixed from ink (`color-mix(in srgb, <ink> N%, transparent)`), plus the accent only where DL-09 allows it:

| State | Klawly Dark | Klawly Light |
|---|---|---|
| hover | ink 6% | ink 5% |
| pressed | ink 10% | ink 8% |
| selected | ink 12% (neutral, never orange) | ink 10% |
| selected and hovered | ink 15% | ink 12% |
| focus-visible | a 1px soft periwinkle ring, outside the control (inside on list rows) | same |
| disabled | 40% opacity, no hover | same |
| loading | the control keeps its size; a spinner or the progress bar replaces the glyph | same |

A filled orange button mixes in 12% of its own text ink on hover. Transitions change color and opacity only, at DL-08 durations. No glows; shadows are only for overlays (DL-07). Focus never relies on a fill alone.
**Why.** Consistent and Calm: five button variants, seven text-field rules and several chip styles each showed hover and selection their own way, so the same state looked different across the window. Mixing from ink keeps the recipe right in any theme (DL-01), and a neutral selection keeps orange rare (DL-09).
**Recipes.** One recipe per control (issue 576): `.claude-btn` is the secondary button by default (a tone fill, never an outline, DL-13), with `is-primary`, `is-ghost`, `is-icon` and `is-danger`, and `is-medium` and `is-small` sizes; `.claude-field` is every text field (`is-wrapper` for a field with an icon, `is-select`, `is-multiline`), with an edge that strengthens on hover and turns to the ring on focus; `.claude-chip.is-toggle` with `aria-pressed` is a filter that stays on; `.claude-segmented` is a fill track at md with the current segment at sm; pills are for mode and status only. A surface adds layout (width, margin, flex) to a recipe, never its own colors or states. `design/workbench/controls.html` shows every control in every state in both themes.
**Where.** `--claude-state-{hover,pressed,selected,selected-hover,disabled}`, `--claude-field-edge{,-hover}`, `--claude-fill-*` and `--claude-focus*` in `claude.css` (in the block editor widgets and the title bar also read); `--k-hover`, `--k-active`, `--k-selected`, `--k-focus` and `--k-field-edge` in `design/assets/global.css`.
**Applies to.** Every Klawly control, and the VS Code lists, buttons and inputs Klawly restyles.
**Since.** #570; the recipes since #576.

### DL-16 Type roles

**Practice.** A component asks for a role, not a size. Each role is a size from the DL-05 ramp, one of two weights (400 or 600) and an ink level:

| Role | Size / weight | Ink |
|---|---|---|
| page title | 22 / 600 | ink |
| section heading | 15 / 600 | ink |
| label (field and group labels) | 12 / 600 | ink-2 |
| body (UI default) | 13 / 400 | ink-2 |
| chat body | 14 / 400 | ink |
| secondary | 12 / 400 | muted |
| metadata (times, counts, paths in a row) | 11 / 400 | muted |
| tool output | 12 mono / 400 | ink-2 |
| code and file reference | 12 mono / 400 | ink |
| status (status bar, pills) | 11 / 400 | ink-2 |

No caps banners. Body, secondary and metadata ink pass 4.5:1 on every ladder level they sit on (the table is in `design/DECISIONS.md`).
**Why.** Calm and Focused: hierarchy comes from a small, named set, so two headings at the same level always match. Sizes picked per component drifted, which reads as slightly off even when no one can say why.
**Where.** `--claude-text-<role>` (the size) with `-leading`, `-weight` and `-ink` in the type block of `claude.css`; `--k-text-<role>` in `design/assets/global.css`. Tool output and code add `font-family: var(--claude-font-mono)`. Inline code inside prose is the code face at .92em of its line, which is 12px in 13px body text.
**Applies to.** Every Klawly text, and the VS Code labels and headings Klawly restyles.
**Since.** #570; tokens in #577.

---

## VS Code surfaces Klawly restyles

### DL-20 Menus

**Practice.** Title bar and workbench context menus are at least 320px wide and take the overlay recipe (DL-07): lg corners and the popup shadow, with md rows. Labels start 10px in and key hints end 10px from the right. The row highlight is rounded and inset 4px. A gutter for a check mark is kept only in a menu that shows a check. Separators are a tight hairline across the whole menu. Klawly's own menus are built with `claudePopoverMenu.ts` on the same row ramp (24px rows, DL-06) and highlight tier, at their own widths (`--claude-menu-w`, `--claude-menu-w-wide`). A row's own menu inside a Klawly popover (its More button or a right-click) cascades beside the row as a submenu of that popover, never as a separate menu: the popover stays open under it, and a pick closes both.
**Why.** Consistent: upstream menus and Klawly menus open side by side (title bar, agent pane), and two menu styles in one window read as two products. Reserving an empty check gutter in every menu pushed every label right for nothing.
**Where.** `claudeChrome.css` (Menus); `browser/widgets/claudePopoverMenu.ts`.
**Applies to.** Every `.monaco-menu`. The editor context menu renders in a shadow root that the stylesheet cannot reach, so it keeps the stock metrics. That is a known gap, not a choice.
**Since.** Issue 163; row menus inside a popover are from issue 746.

### DL-21 Quick input

**Practice.** Quick Open, the command palette and every picker built on the quick input:
- the filter is the widget's first line, with no box and no focus ring, and a hairline below it;
- the widget is an overlay (DL-07): lg corners and the popup shadow;
- rows are 24px (DL-06) and their highlight is rounded at md, one tier in;
- a labeled group gets its own header row: small, muted, lowercase, with a rule to the row's end, never focused or hovered;
- matched letters look like find matches (semibold on the editor's find-match box);
- a row offers only its X; Open to the Side stays on Ctrl+Enter;
- the widget is up to 800px wide and floats 7px under the title bar.
**Why.** Focused: the palette is a search box with answers, so the field should not look like a form inside a box, and the rows should look like the menus they replace. Match highlighting reuses the find-match color so "this matched" means the same thing in the editor and the palette. Per-row action icons competed with the row's label on every hover.
**Where.** `claudeChrome.css` (Quick input); `quickInputController.ts`, `quickInputList.ts`, `quickInputDelegate.ts`, `layout.ts` (`UPSTREAM.md`).
**Applies to.** Every quick pick, including ones upstream adds later.
**Since.** ide-05, ide-07, ide-24, ide-45; #161.

### DL-22 Key caps

**Practice.** A shortcut is one key cap per key, 2px apart, with no "+" between them, everywhere except the Keyboard Shortcuts editor (which keeps the "+" as an editable table).
**Why.** Consistent with Klawly's own key chips; the "+" doubled the visual noise of every shortcut hint in menus and the palette.
**Where.** `claudeChrome.css` (Keybinding labels).
**Applies to.** Every `.monaco-keybinding`.
**Since.** The quick input restyle.

### DL-23 Notifications

**Practice.** Toasts and the notification center are overlays (DL-07): lg corners and the popup shadow. The center header is on the same fill as the rows, with a hairline under it, and is a 28px row with an 11px semibold title in sentence case, not a caps label. The "Source:" line is a faint 11px footnote. Action buttons are Klawly's 20px small buttons, rounded at sm. Severity shows only in the icon's color. The header has three actions (Clear All, Do Not Disturb, Hide); the position lives in the setting.
**Why.** Calm: a toast is a sentence and a choice, not a dialog. Stock 26px buttons and a caps header made a passing message the loudest thing on screen.
**Where.** `claudeChrome.css` (Notification center, Notification toasts); `notificationsCenter.ts` (`UPSTREAM.md`).
**Applies to.** Toasts and the notification center.
**Since.** ide-42, issues 164, 165; the overlay recipe since #583.

### DL-24 Classic Settings editor

**Practice.** The table of contents is a flat list with no chevrons (a group still expands on click; entries sit 12px in). Group titles are headings (17, 15, 13px), not banners. User and Workspace are small underline tabs, muted until checked. Selects are 200px and text and number fields 300px, all 26px tall. The table of contents has an "AI / Claude" entry, and upstream's Chat entry is hidden while upstream chat is off.
**Why.** Consistent with Klawly Settings, which users reach from the same gear. Chevrons on a two-level list added a column of icons that said nothing. Fixed control widths line the values up into a column you can scan.
**Where.** `claudeChrome.css` (Classic Settings); `settingsLayout.ts`, `settingsTree.ts`, `settingsEditor2.ts` (`UPSTREAM.md`).
**Applies to.** The classic Settings editor.
**Since.** Issues 170, 171, 292.

### DL-25 Window frame

**Practice.** The custom title bar is 35px on Windows and Linux; macOS keeps its native-sized bar. The secondary side bar holds the Agent, and its view switcher row hides when the Agent is its only view. The empty editor shows Klawly's Home and watermark.
**Why.** The frame is the first thing that says what product this is. Upstream drops to 30px when the command center is off, and Klawly turns it off; 35px keeps room for the title bar controls. macOS users expect the native traffic-light metrics.
**Where.** `titlebarPart.ts`, `chatParticipant.contribution.ts`, `editorGroupWatermark.ts` (`UPSTREAM.md`); `design/workbench/editor.html`.
**Applies to.** The window frame.
**Since.** #106 and the frame work in `design/`.

### DL-26 Managed settings

**Practice.** A Klawly Settings row an organization's policy sets keeps its place and its value, shows a faint "Managed by your organization" line with a briefcase icon under its description, and locks its control at half opacity. The row is not hidden or moved.
**Why.** Consistent with the classic Settings editor, which marks policy settings with the same briefcase. Hiding a locked row would leave users looking for a setting that still decides what Claude does; showing it unlocked would let them change a value that snaps back.
**Where.** `claudeSettingsEditor.ts` (`renderManaged`, `renderCustomizeItem`); `claudeCustomizeDiscover.ts` (`renderPolicy`); `claude.css` (`.claude-settings-row-managed`); `design/settings/agents-security.html`, `design/settings/customize.html`, `design/settings/customize-discover.html`.
**Applies to.** Every Klawly Settings row whose setting has a policy, every Customize row for a file in Claude Code's managed folder (the same briefcase line; the row still opens the file to read), and every plugin or marketplace Claude Code's managed settings require (a Required or Team badge, with the briefcase on Required, and no Remove).
**Since.** Issue 432; issue 523.

### DL-27 One name, one window

**Practice.** "Agents Window" names one window at a time. The title bar pill, File > Open Agents Window, Home's Agents Window start and Klawly: Open Agents Window in the Command Palette all open it through one command. With `claude.agentsWindow.enabled` off (the default) it is the chat in its own window. With it on, it is VS Code's Agents window, run by the Agent Host on the user's own Claude Code, and VS Code's own title bar button for that window stays hidden.
**Why.** Consistent: two windows with the same name, or two buttons in the title bar for "the agents window", would make users guess which one they get. One command behind every entry point means the setting changes what the name means everywhere at once, and the pill keeps its place.
**Where.** `claudeTitleBar.ts`, `claudeMenus.ts`, `claudeHome.ts`, `claudeAgentEditorActions.ts` (`CLAUDE_OPEN_AGENTS_WINDOW_COMMAND_ID`); `claudeChatDefaults.ts` (hides VS Code's button); `constants.ts`, `agentHostEnablementService.ts`, `sessionsSetUpService.ts` (`UPSTREAM.md`); `design/chat/agents-window.html`, `design/chat/agent-sessions-window.html`.
**Applies to.** Every way into the Agents window.
**Since.** Issue 617.

### DL-28 Workbench shell

**Practice.** The frame around the editor speaks in roles, not in its own sizes. Tree rows show hover and selection as fills; the focus ring appears for keyboard focus only. Every view title, section header (the explorer's root folder included) and panel tab is the label role in sentence case, never a caps banner; header heights stay 35px and 22px, and action icons stay the one codicon size. Title bar, activity bar and panel tab icons rest in secondary ink and take the foreground ink when active or hovered, under a quiet neutral line. The status bar is the status role on a neutral fill; only errors, warnings and the debugging mode carry color. Sashes light up as the focus color at half strength.
**Why.** Calm: caps banners, an outline on every mouse-selected row and full-strength icons at rest all compete with the editor for attention. Consistent: one title role and one ink ramp mean a header in the side bar, the panel and the secondary side bar reads the same. Keyboard users still see exactly where focus is.
**Where.** `claudeChrome.css` (the DL-28 block); `claudePointerFocus.ts` (marks a list its pointer focused, so the ring waits for a key); `extensions/theme-klawly/themes/klawly-{dark,light}.json` (`activityBar(Top).inactiveForeground`, `panelTitle.inactiveForeground`, `sideBarSectionHeader.foreground`, `sash.hoverBorder`); `design/assets/global.css` (`.k-sidebar-title`, `.k-section-header`, `.k-tree-row`, `.k-statusbar`).
**Applies to.** Trees and lists, view and panel headers, the title bar, activity bar and status bar, sashes. High contrast themes keep the stock look (DL-02).
**Since.** Issue 582.

### DL-29 Hovers and dialogs

**Practice.** A hover (a tooltip from the hover service, a hover card, an editor hover) is an overlay (DL-07): lg corners and the popup shadow on its hairline, at its own small padding. A hover with a pointer keeps md, so the pointer never sits on the curve. Under a title, a Klawly hover's detail lines take the secondary ink (DL-16). A dialog is an overlay too: lg corners and the popup shadow, a title in the heading role, and buttons from the shared family (26px, md, 12px sides; DL-15), in the platform's order (the primary button last on macOS and Linux, first on Windows).
**Why.** Consistent: a hover, a menu and a dialog open next to each other over the same code. With upstream's 5px hover, 12px dialog with a 20px shadow and 4px buttons, they read as three products. The heading role makes a dialog's question the first thing read.
**Where.** `claudeChrome.css` (Hovers, Dialogs); `claude.css` (`.claude-hover-content`).
**Applies to.** `.monaco-hover.workbench-hover`, the editor's hovers, `.monaco-dialog-box`. The editor context menu's shadow root is out of reach (DL-20).
**Since.** #583.

### DL-30 Every job is in the Command Palette, under the words users say

**Practice.** A job the user can do from a button, a pill or a Settings page also has a "Klawly:" command in the Command Palette, named the way the visible entry is named. Its other names go in the command's English alias (`title.original`, "Change Permission Level (Permissions, Allow Everything, Auto Approve, Bypass, YOLO)"): the palette matches them but never shows them, so the row stays short. The same words go in the Settings row's `keywords`, so Klawly Settings' search finds the row too. A command that only opens a Settings page is fine: it brings the user to the one place the setting lives.
**Why.** Focused: the palette is where people go when they cannot see a button, and they type their own words ("yolo", "usage", "skills"), not ours (issue 723). Before this, "stop asking me", "where's my usage?" and "add an MCP server" found nothing in the palette. Consistent: one name on the button, the command and the guide; the other words find it without adding a second name anywhere you can read.
**Where.** `claudeSettingsEditorActions.ts` (Change Permission Level, Show Plan & Usage, Open Customize); `claudeActions.ts` (Pick Mode, and the aliases on New Agent and Pick Model); `claudeCommands.ts`, `claudeSetup.ts`, `claudeFeedback.ts` (aliases); `claudeChatShare.ts` (Copy Chat as Markdown, Export Transcript, Share Chat Link: the chat's More menu jobs, issue 767); `claudeWorktreeCommands.ts` (Apply Worktree and Delete Worktree answer to git worktree and branch, issue 904); `claudeSettingsSearchHint` in `common/claudeSettingsPages.ts` (a Klawly Settings search that finds nothing but names something VS Code owns, such as "theme", says so and offers a button that opens that picker, beside Search All Settings); `commandsQuickAccess.ts` (a match at a word start sorts first, so "bug" finds Send Feedback, issue 795); `claudeCommands.ts` (Start Goal, Start Loop, Edit Last Message, Create Skill, Remove Instrumentation, and "rewind" on Restore Checkpoint: jobs that lived only in slash commands, hover actions and a chat card, issue 901); `claudeAccountCommands.ts` ("accounts") and `claudeShareToPhone.ts` ("remote control"), issue 902; `keywords` in `common/claudeSettingsPages.ts`; FEATURES.md section 4b (Where to find things).
**Applies to.** Every new Klawly feature with a visible entry point; the sprint UX check confirms each one with palette shots in users' words. One job has one name everywhere: New Agent (never New Agent Session), Agent History, Klawly Settings (never Agent Settings); an older name stays only as an alias (issue 766).
**Since.** Issue 723.

## Klawly surfaces

### DL-50 A wait on the user is shown where the call is

**Practice.** When a tool call cannot finish until the user acts somewhere else (an interactive command in a terminal), its running card gains one strip under its row: a codicon, a strong line that says where Claude waits ("Waiting for you in the terminal"), Claude's reason in muted small text, then the way there as the one primary small button and Cancel as a ghost button. The strip leaves when the call ends. No toast, no modal.
**Why.** Focused: the user sees what is blocked and the one thing to do next in the place they are already reading, and Cancel always ends the wait, so Claude never hangs on a terminal the user closed or forgot. A toast would disappear and a modal would block the terminal the user has to type in.
**Where.** `claudeToolCardView.ts` (`paintTerminalWait`, `paintReproduceWait`), `.claude-terminal-wait` in `claude.css`; `design/chat/terminal-wait.html`, `design/chat/debug-reproduce.html`.
**Applies to.** Klawly tool cards that wait on the user outside the chat, including Debug mode's Reproduce card: Claude's steps show in full, and the primary button moves from Start Capturing to I Reproduced It.
**Since.** Issue 452; the Reproduce card since issue 484.

### DL-51 A question from Claude answers on the pick

**Practice.** When Claude asks the user a question (`AskUserQuestion`), the timeline shows a card in the permission family (warning hairline, head, action row) in place of the tool row. Each option is a full-width 28px row: a radio dot or a check box, the label, its description in muted small text, and its number as a key cap. Other is the last row and opens a text field. One single-choice question answers on the pick; several questions, a multi-select or Other send together with Submit, the one primary button. A chosen row takes the focus-ring color, never a second accent. An option with a preview shows it in a code pane beside the list, under it when the pane is narrow. Each question has a quiet "Add a Note" link under its options; the note goes to Claude beside the answer. Reply Instead, a ghost button beside Submit, works with nothing chosen: it swaps the action row for a focused text field with Send and Cancel, and the text goes to Claude in place of the answers, so a question Claude got wrong is corrected, not declined. While a question waits, the composer says so in its placeholder and Enter sends its text as that reply, since Claude cannot read a queued follow-up until the question is answered. Escape closes an open reply field first; Escape and Decline always answer, so Claude never waits on a card the user dismissed. Once answered, the card becomes one record line per question with the choice and its note, or one "Replied:" line.
**Why.** Focused: the common case (one question, a few choices) is one click or one number key, and nothing asks for a second confirmation; the note and the reply stay out of the way until wanted. Honest: when Claude asked the wrong question, the user says so in words and Claude goes on, instead of a decline that ends the thread. Consistent: it waits, badges the pane and notifies like a permission card, so the user reads it as "Claude needs me" without learning a new surface. A chosen row in the action accent would compete with Submit (DL-09).
**Where.** `claudeQuestionCard.ts`, `claudeQuestion.css`; `design/chat/question.html`.
**Applies to.** Questions from Claude in the chat timeline, in the main chat and in subagent chats.
**Since.** Issue 477; issue 537.

### DL-52 A toolbar gives way in a fixed order and never overlaps

**Practice.** The composer toolbar is a size container (`claude-composer`). Fixed controls (the mode pill, icon buttons, the context ring, the Try Plan Mode hint, Queue and Steer, Send, and the Run In pill) keep their size; only the model pill shrinks, and it keeps at least 80px so its name stays readable. Every pill clips at its own edge, so a word that does not fit truncates with an ellipsis instead of drawing over the next control. As room runs out, in this order: the model name and its effort truncate; badge words go (700px; Allow Everything keeps its warning icon); the Try Plan Mode words and their key chip go together (600px); the Queue and Steer key hints go (500px); the Run In pill keeps only its icon (600px while Queue and Steer show, 420px otherwise); the mode pill keeps only its icon and chevron, before the model's name ever goes (420px); the model pill may shrink below 80px (420px, only if the row still overflows); the effort qualifier goes and the mode pill drops its chevron (its hover still names the mode), so what is left of the model pill is the model's name (360px); at 300px a busy toolbar wraps to a second row. A control that loses its word keeps its icon, its hover and its aria-label, and a key chip never shows without its words. The changes bar over the composer (`claude-changes`) gives way the same way: the Kept Automatically note goes and Keep All drops its file count (440px), the totals go (360px; the file rows still show them), then the actions wrap under the file count; the count and Review are never clipped.
**Why.** Focused: the user always reads every control, at any width, and the one they use most (the input, Send) never moves. A label drawn over a neighbour ("Mediu" over the Local icon) reads as broken and hides both controls. A fixed order means a narrow pane always looks the same, instead of whichever control the flex algorithm squeezed first.
**Where.** The "A narrow pane" block in `claude.css` (`.claude-composer-toolbar`, `@container claude-composer`); `.claude-changes-bar-head` and `@container claude-changes` in `claude.css`; `design/assets/global.css` (`.k-composer-toolbar`, `.k-changes-bar`).
**Applies to.** The agent composer toolbar and the changes bar in the pane, the agent editor and the agents window. A new toolbar control picks its step here: fixed, or a word that goes at a named width.
**Since.** Issue 531; the 700px badge step, the fixed plan hint and the model pill's 80px are from issue 738; the changes bar from issue 584; the icon-only mode pill and the 360px qualifier step from issue 793.

### DL-53 A filled round button keeps its glyph

**Practice.** A filled circle with a glyph (Send) draws the glyph in a color every theme keeps opaque: the editor background on the ink circle. Disabled turns the circle into a quiet fill and the glyph into muted text; it never fades the whole button, so the glyph stays readable in light and dark themes.
**Why.** Calm and honest: the user can see what the button does before it is enabled. The input background is see-through in Klawly Dark, so a glyph in that color vanished into the circle, and a 30% opacity on the whole button left a grey dot with no arrow.
**Where.** `.claude-send` in `claude.css`; `.claude-inline-submit` already follows it (issue 125); `design/assets/global.css` (`.k-send`).
**Applies to.** Send in the composer, Submit in inline chat and the terminal prompt, and any new filled round action button.
**Since.** Issue 531.

### DL-55 A card's next step is a quiet link under it, and its result is a normal turn

**Practice.** A timeline card that is itself a button (a pull request or issue card opens it) offers its one follow-up as a quiet link-style button under the card, in the link color at the small text size with a codicon: Sign in to GitHub to see details, or Investigate Failing Check on an open pull request whose checks failed. While the follow-up runs, the link shows a spinning codicon and a short "Reading…" label and is disabled. What it asks of Claude goes into the same session as a normal user turn with a short label ("Investigate Failing Check: test on #57"), so Claude's answer and any fix are ordinary turns and ordinary reviewable changes; nothing commits, pushes or posts on GitHub without the user.
**Why.** Focused: the card stays one click target, and the follow-up appears only when it applies (DL-12). Honest and consistent: an investigation is not a new surface to learn; it reads, edits and waits for review like any other turn, and the user keeps the push and the post (they approve everything public).
**Where.** `claudeGitHubCard.ts` (`renderGitHubCard`), `claudeCheckInvestigation.ts`, `.claude-github-card-signin` and `.claude-github-card-investigate` in `claude.css`; `design/chat/pull-request.html`.
**Applies to.** Follow-ups on timeline cards: the GitHub cards, the deploy watch (issue 509) and Tend This PR (issue 1016).
**Since.** Issue 505.

### DL-56 A fact is a row with no control

**Practice.** A settings row that states a fact, such as where some data goes, is the ordinary row (title, muted description) with nothing on its right: no disabled switch, no badge that looks clickable. When the fact has one thing to change, the row ends with the one outline button that opens it ("Change", "Open Privacy Settings"). A fact that cannot apply (no OpenTelemetry endpoint set) is hidden, not shown as "none" (DL-12).
**Why.** Calm and Consistent: a disabled control reads as a setting the user is not allowed to touch, while the truth is that there is nothing to set; a plain row says so without noise, and the same row anatomy keeps the page in step with the rest of Klawly Settings.
**Where.** `claudeSettingsPages.ts` (`statement` and `privacyAccount` rows), `claudePrivacy.ts`, `claudeSettingsEditor.ts` (`renderRow`); `design/settings/privacy.html`.
**Applies to.** The Privacy page and any later Klawly Settings row that reports instead of sets.
**Since.** Issue 522.

---

### DL-54 A diagram in an answer is drawn in the code block frame

**Practice.** A ```mermaid block, and a ```chart or ```vega-lite block Klawly can read, draw in place of their code once the answer text stops streaming; until then they stay plain code. They keep the code block frame and header: a label (Mermaid, Chart), then Show Source (a toggle, pressed while the text shows), Open in Editor and Copy as icon buttons. Mermaid draws in the sandboxed webview upstream already ships, with no network, and takes its colors from the workbench theme. Charts are plain SVG: the series colors are the theme's chart colors, grid and ticks are hairline and muted, and every mark has its value as a tooltip. A block Klawly cannot draw stays an ordinary code block, and a diagram that fails to draw says so and leaves Show Source on hand. The `claude.chat.renderDiagrams` setting turns all of it off.
**Why.** Calm: a diagram is one more code block, not a new card family, so a reply reads the same with or without one. Honest: the source is one click away and Copy copies the text Claude wrote, never a picture. Consistent: colors follow the theme in light, dark and high contrast without Klawly picking any (DL-01). Drawing a block while it streams would rebuild the webview on every delta and flash half-written diagrams.
**Where.** `claudeDiagramBlocks.ts`, `claudeChart.ts`, `claude.css`; `design/chat/diagram-reply.html`.
**Applies to.** Mermaid and chart blocks in Claude's answers in the chat timeline.
**Since.** Issue 492.

### DL-58 Line attribution is a thin mark beside the change bar

**Practice.** With `claude.editor.lineAttribution` on, every line a kept Claude change wrote gets a 2px mark at the left edge of the line decorations column, 1px in, so the source control change bar keeps its own place beside it. Kept lines are solid in `claude.attribution.agent`, lines still in review are dashed in the same color, and lines a person changed afterwards are solid in the neutral `claude.attribution.human`. Untouched lines get nothing. Agent lines also mark the left lane of the overview ruler. Hovering the line number says who wrote the line and, for Claude's lines, names the turn ("Turn 2 · model · session title") with an Open Turn link that selects the session and reveals the turn in the chat. High contrast themes widen the mark to 3px. The setting is off by default.
**Why.** Calm: the mark is thinner than the change bar and carries no background, so code reads the same with it on, and nothing shows until the user asks for it. Focused: the one question the mark answers (who wrote this line) is answered in the gutter, and the turn is one click away instead of a search through the chat. Honest: a line a person rewrote stops claiming to be Claude's.
**Where.** `claudeAttributionContribution.ts` (`attributionDecorations`, `ownerHover`), `claudeAttribution.css`; `design/editor/line-attribution.html`.
**Applies to.** Editor gutter marks that say where a line came from.
**Since.** Issue 503.

### DL-57 A plugin shows its own face

**Practice.** A plugin row in Customize > Discover, and the head of its details, shows the plugin's own image in the 28px customize tile, clipped to the tile's radius: the icon its marketplace entry names, else the avatar of the GitHub account it lives under, else its homepage's favicon. The shared process fetches it (proxy settings apply), keeps only PNG, JPEG, GIF, WebP or ICO bytes up to 128 KB, never SVG, and caches it by URL for a day (a miss for ten minutes); the UI only ever sets a `data:` URL on a fixed-size `<img>`. Until then, or without one, the tile shows the first letter of the plugin's name on one of six chart tints at 24%, picked by the name, so a plugin keeps its color. Marketplaces keep the package codicon. The row title is the entry's display name when it has one.
**Why.** Consistent with how people find tools elsewhere: a list of 300 identical glyphs cannot be scanned, a logo or a colored letter can. Calm: a remote image never reaches the renderer as a URL, so a slow or hostile server cannot stall, track or script the page, and offline the letters still tell rows apart. Tints sit on the chart ramp at low strength so they never compete with the action accent (DL-09).
**Where.** `claudePluginIconUrl`, `claudeIconDataUrl` and `getPluginIcons` in `claudePluginCatalog.ts`; `paintPluginIcon` in `claudeCustomizeDiscover.ts`; `.claude-plugin-icon` in `claudeCustomizeDiscover.css`; `design/settings/customize-discover.html`.
**Applies to.** Plugin rows and plugin details in Discover. An installed MCP server's own `serverInfo` icons are not read yet.
**Since.** Issue 534.

### DL-59 A notebook edit is a cell, not a JSON diff

**Practice.** A NotebookEdit call is an edit card like Write or Edit (same verb, checkpoint, Keep and Undo), but its row meta names the cell ("Cell 3", "New Markdown cell", "Deleted cell 3") instead of a line range, and its expanded body shows the cell itself in the edit's inner card: a faint head with the cell type's codicon, its type and its id, then the new source. Markdown is rendered (links inert, remote images blocked); code sits in the editor font. A code cell has an accent left edge, a Markdown cell a neutral one. At most 12 lines show, then "N more lines". A deleted cell shows its head struck through and one faint line. Open Diff on a notebook opens the notebook diff editor, not a text diff of the `.ipynb` JSON.
**Why.** Focused: a notebook's JSON (escaped strings, outputs, metadata) hides the one cell that changed; the cell as the notebook shows it is what people check. Consistent: the same card, footer and review flow as any other file edit, so a notebook change is never a second kind of thing to learn.
**Where.** `notebookCellEdit` and `describeNotebookCellEdit` in `claudeToolCards.ts`; `paintNotebookCell` in `claudeToolCardView.ts`; `.claude-notebook-cell` in `claude.css`; `ClaudeNotebookSnapshotFileSystem`; `design/chat/notebook-edit.html`.
**Applies to.** Claude's NotebookEdit cards and their review. The Keep and Undo overlay on the notebook diff editor is DL-90. Inline edit inside a notebook cell is not covered yet.
**Since.** Issue 526.

### DL-60 Parallel work shows as quiet live rows above the composer

**Practice.** Prompts that run in parallel (a `/multitask` message, or Run Queued in Parallel) never fill the timeline while they run. They show as one hairline box above the queue: a muted header with a count ("1 of 3 parallel tasks done") and one icon button (Stop All, then Dismiss once they end), and one row per prompt on the row ramp with a status icon, the prompt, a diff stat once files changed and a faint status word. Only the status icon takes a color (success, warning, error). A row opens that task's own chat; a run past the parallel limit says "waiting for a slot" and is not clickable. When every run ended, one combined turn goes to the chat, and that turn is the only thing the timeline gains. A multitask sent in Ask or Plan runs read-only in the chat's folder: its header leads with an eye icon and says so ("1 of 2 read-only tasks done in this folder"). After a window reload the box comes back; runs the reload cut off say why, and the combined turn waits for one quiet Send Results button next to Dismiss instead of spending tokens on its own.
**Why.** Calm: several agents at once must not turn the chat into a wall of interleaved output, so the main chat keeps one thread and the parallel work stays a glanceable list. Consistent: the rows read like queued messages and the Background view's cards, the two places the user already knows for work that is not the current turn. A colored row background would compete with the composer's send accent (DL-09).
**Where.** `claudeMultitaskCards.ts`, `claudeComposer.ts` (the Run Queued in Parallel button), `.claude-multitask` and `.claude-queue-parallel` in `claude.css`; `design/chat/multitask.html`.
**Applies to.** Klawly chats that start several background agents from one message.
**Since.** Issue 487; read-only runs, reload and Send Results in issue 686. A to-do of a plan built in parallel follows the same rule (issue 898): its agent's chat opens from a quiet icon at the end of the to-do's row, shown on hover or focus, and a to-do that waits for others starts by itself when they are ticked.

### DL-61 A chat that keeps working shows it in one row above the composer

**Practice.** A chat that sends turns on its own (a `/goal` or a `/loop`) shows one hairline box above the to-dos and the queue, with one row per goal or loop on the row ramp: a state icon, a label in default text that names it ("Goal: make npm test pass", "Loop every 10m"), then a faint detail line with its progress ("working · turn 2/10 · $0.84 of $5.00", "next 14:20 · run 3"), and icon buttons at the end: Pause or Resume, then Stop, which becomes Dismiss once it ended. Only the state icon takes a color: success when met or done, warning when paused or at a limit. The label's hover shows the whole outcome and how it is checked. The turns themselves stay in the timeline as ordinary turns with a short label.
**Why.** Focused and honest: a chat that keeps going after the user stopped typing must always say so, how far it got and what it may still spend, and must be stoppable in one click where the user is already looking. A toast would disappear and a timeline card would scroll away. One row per thing keeps it calm next to the to-do strip and the queue, which use the same hairline box, and a colored row would compete with Send (DL-09).
**Where.** `claudeGoalLoopStrip.ts`, `.claude-goal-strip` in `claude.css`; `design/chat/goal-loop.html` (`.k-goal-strip` in `design/assets/global.css`).
**Applies to.** Klawly chats with a goal or a loop. A new kind of self-running chat adds a row here.
**Since.** Issue 486.

### DL-62 Another party's UI is framed, never restyled, and acts only through the user

**Practice.** An MCP App draws under its tool's card as the server wrote it: its own HTML in a sandboxed webview, with only the origins its CSP names, on a hairline frame (DL-07) at the timeline's tool indent, unless it asks for no border. It gets the editor's theme as MCP Apps style variables (`--color-*`, `--font-*`, `--border-radius-*` mapped to the workbench colors) and picks its own height, from 32px up to 560px, after which it scrolls. Klawly adds no chrome inside it. Whatever it asks for that would act (a message to Claude, a tool call) goes into the composer for the user to send; a link opens in the browser only for http and https. An app that fails to load shows one error row with Retry in the frame's place.
**Why.** Consistent: the server's UI is its own product, and restyling it would break it. The theme variables let a well-made app look at home without Klawly reaching inside. Calm and safe: another party's page never acts for the user, so a hostile or buggy app cannot run tools or send prompts on its own, and it cannot grow past a screen of the timeline.
**Where.** `ClaudeMcpAppView` in `claudeMcpAppView.ts`; `ClaudeMcpAppBridge` and `CLAUDE_MCP_APP_STYLE_VARIABLES` in `claudeMcpAppBridge.ts`; `.claude-mcp-app` in `claude.css`; `design/chat/mcp-app.html`.
**Applies to.** MCP Apps under MCP tool cards. Fullscreen and picture-in-picture display modes are not offered yet.
**Since.** Issue 513.

### DL-63 A project is a Plan mode chat with a file, not a new surface

**Practice.** New Project asks for the goal in one VS Code input box and nothing else (the folder is the workspace's). It writes the project as a small JSON file in the user's Klawly folder (`projects/`, next to `plans/`), then opens an ordinary chat named after the goal, in Plan mode, whose first turn shows only "Plan the project: <goal>". That chat is the coordinator: Plan mode keeps it read-only, and it answers with a plan card whose to-dos carry `Files:` and `Depends:` lines. The agents start from that plan with Build in Parallel, and their results come back to the same chat as one turn. Open Project lists the project files in a quick pick (name, folder, file name) and opens that chat again. No project view, board or badge is added.
**Why.** Consistent: the coordinator is the chat, the plan card and the background agents the user already knows, so a project is a way to start them, not a second product to learn. Calm: the Agent pane gains no new region, and the long coordinator prompt stays behind its label (Show Sent Prompt still has it). Focused: the plan is the one place the work is split, so what the agents do is always visible and editable before they start.
**Where.** `claudeProject.ts` (the file, the name, the coordinator prompt) and `claudeProjects.ts` (New Project..., Open Project...); `design/chat/project.html`.
**Applies to.** Klawly projects started from the command palette. Agents grouped by project, project triggers and a shared project folder are not built yet.
**Since.** Issue 496.

### DL-64 A canvas runs sealed in its own tab, and its card only points to it

**Practice.** A page Claude writes with `klawly_canvas` (one HTML file with inline CSS, JavaScript and its data) opens in a Canvas tab next to the code, with the graph icon and the title Claude gave it. The page runs in a webview with its scripts on and a Content Security Policy set before anything in the file: inline scripts and styles, images, fonts and media from data: and blob: only, no network, no frames, no forms that post, no command links and no local files. Klawly adds one quiet toolbar on a hairline (DL-07) above it: a faint status line, then Reload, Edit Source, Save to Workspace..., Export... and Copy HTML as small ghost buttons. A change to the file, by Claude or by the user, reloads the tab; a missing file shows one line in error color and hides the page. Claude's first canvas opens without taking focus, and an update to an open canvas never switches tabs. The tool card adds one row: the title in faint text, Open Canvas and Edit Source.
**Why.** Focused: a table or a chart the user will sort and read for a while belongs next to the code, at full size, not squeezed into the timeline where it scrolls away. Calm: updates reload in place instead of stealing the user's tab. Safe: Claude wrote the page, but it may hold data from anywhere, so it can show and compute but never call home, reach the workbench or read the disk. Consistent: the toolbar uses the same small ghost buttons as other Klawly editor toolbars, and the card row reads like the SVG preview row (issue 494).
**Where.** `ClaudeCanvasEditor` and `ClaudeCanvasInput` in `claudeCanvasEditor.ts`; `CLAUDE_CANVAS_CSP` in `claudeCanvasDocument.ts`; `paintCanvas` in `claudeToolCardView.ts`; `claudeCanvas.css`; `design/chat/canvas.html` (`.k-canvas` and `.k-tool-canvas` in `design/assets/global.css`).
**Applies to.** Canvas tabs and canvas tool cards. Export... and Copy HTML hand over the page with the sealed policy written into it (#885). Hosting a canvas, or a canvas built from React with a build step, is not offered yet.
**Since.** Issue 493.

### DL-65 A Claude action that changes the repository asks first, and again before anything leaves the machine

**Practice.** A one-click Claude action that commits, branches or opens pull requests (Split into Pull Requests) starts as a normal turn in the chat. Claude first shows what it will do without changing anything and asks with a question card (DL-51); only the confirmed plan runs, in new worktrees, never in the user's checkout. Pushing and opening pull requests is a second question, and the push itself still goes through the permission prompt. The action sits in the view's overflow menu, not as a toolbar icon, next to the one Claude icon the view already has (Review Changes).
**Why.** Calm: a button that rewrites branches at one click cannot be undone from the IDE, and a branch or pull request on the remote is public. Focused: the plan is read before it runs, in the same place as every other turn. Consistent: a view title keeps one Claude icon, and rarer actions go where VS Code puts its own (More Actions).
**Where.** `splitPullRequests` and the `split-pull-requests` template in `claudePrompt.ts`; `CLAUDE_SPLIT_PULL_REQUESTS_COMMAND_ID` in `claudeGitActions.ts`; the More menu in `claudeReviewEditor.ts`; `design/workbench/source-control.html`, `design/review/review-editor.html`.
**Applies to.** Any later action that writes git history or reaches the remote (stack, rebase, publish).
**Since.** Issue 504.

---

### DL-66 Detail a reply folds away stays folded until the user opens it

**Practice.** A `<details>` section in Claude's reply draws as a native disclosure: one row with a small chevron and the `<summary>` text (or "Details") in default text, and the body under it on a hairline left rule at the body indent. It starts collapsed unless Claude wrote `<details open>`, and it keeps whatever the user chose while the reply streams and repaints. The row only takes the hover background and the focus outline; no color, badge or animation. ADHD Mode (Settings > Agents > Reply Style) asks Claude to put long detail there; the setting itself is one select row with a two-line option.
**Why.** Focused: the answer and the next step stay on screen and the explanation is one click away, which is the whole point of ADHD Mode. Consistent: it reads like the thinking line and the Worked For row, the folds the timeline already has. Calm: a collapsed section must not jump open on the next streamed token.
**Where.** `splitClaudeFoldedMarkdown` in `claudeFoldedMarkdown.ts`, `renderMarkdown` in `claudeTimelineRenderer.ts`, `.claude-fold` in `claude.css`; `CLAUDE_ADHD_REPLY_INSTRUCTIONS` in `claudeReplyStyle.ts`; `design/settings/agents.html` (Reply Style).
**Applies to.** Folded sections in Klawly chat replies. A `<details>` inside a code block stays code.
**Since.** Issue 462.

---

### DL-67 A planned stop is a quiet line with its next step, not an error

**Practice.** When Claude stops on purpose before the task is done (a turn cap an automation set), the turn ends with one activity line: a pause glyph, "Claude stopped after N steps." in muted small text, and, on the newest turn, a small primary **Continue** button that resumes the same Claude session. No red banner, no alert role, no "error" wording; the toast for a window in the background says the same.
**Why.** Calm: a stop the user or a setting chose is not a failure, and an error banner made long agent runs look broken (issues 696, 707). Focused: the one useful step, Continue, sits on the line itself.
**Where.** `renderTurnLimit` in `claudeTimelineRenderer.ts`, `.claude-activity.is-turn-limit` in `claude.css`; `describeFailure` (`turn-limit`) in `claudeAgentState.ts`; `design/chat/turn-limit.html`.
**Applies to.** Any later planned stop (a budget, a step cap) that leaves the session ready to go on. A Tend This PR run that ended (clean, merged, closed, turn cap, stopped, a GitHub CLI problem) leaves the same kind of line at the end of the chat with its reason, Tend Again when tending can go on, and Dismiss (`renderTendNotice`, `.claude-activity.is-tend-ended`; issue 1194).
**Since.** Issues 696, 707.

---

### DL-68 Numbers Klawly reads from elsewhere say how old they are, next to the way to read them again

**Practice.** A page that shows numbers Claude Code reports (the plan limits on Plan & Usage) puts a faint "Updated 2 mins ago" (under a minute, "Updated just now") in the section head, before its quiet Refresh button. The page reads them again by itself while it shows: when it opens, when the window gets focus back, every minute while it has focus, and after each finished turn, so the button is for the impatient, not the only way. The status bar item and the composer meter follow the same numbers and ask again on focus. Reads within a minute are shared, so several surfaces never make several calls.
**Why.** Calm: a number that quietly goes stale is worse than no number, because the user plans around it (issue 704). Focused: one faint line answers "is this current?" without a spinner or a banner. Consistent: it sits where the Refresh button already was, in the same text tier as the meter notes.
**Where.** `claudeUsageUpdatedLabel` and `watchClaudePlanUsage` in `claudeUsageRow.ts`; `renderPlan` in `claudeSettingsEditor.ts`; `.claude-settings-head-note` in `claude.css`; `CLAUDE_USAGE_FRESH_MS` in `claudeAgentRunner.ts`; `design/settings/plan-usage.html`.
**Applies to.** Any later Klawly surface that shows a reading it does not own (account details, MCP server state, GitHub checks).
**Since.** Issue 704.

### DL-69 Identity first, service accounts below

**Practice.** Who you are and what Klawly signs in to are two levels. The GitHub account is the Klawly profile: it heads the Accounts menu (`@login (GitHub)`, then Sign Out of GitHub, or Sign In with GitHub while signed out), draws the Accounts entry's avatar, and is the full-size block at the top of the Klawly Settings nav and the first row of General's account section. Each service account Klawly uses sits under it as one smaller row: `Claude: <kind>` (Pro, Max, API Key, Signed Out, Not Installed, Off) with that service's own actions in a submenu (Switch Account..., Log Out, Log In). In Klawly Settings the service row is indented, with a 20px avatar and extra-small text. Signing out of one never touches the other, and signed out of GitHub everything still works locally. Other extensions' accounts keep the stock rows below, and the profile's GitHub account is not listed there a second time.
**Why.** Consistent: one identity across Klawly (feedback, sync and sharing later) reads as one product, not a stack of unrelated logins. Focused: the question "who am I here" has one answer at the top; Claude's plan is a detail of that identity. Calm: the two sign-ins are separate, so a Claude log out never signs you out of GitHub, and the other way round.
**Where.** `klawlyProfileMenuActions` in `klawlyProfileMenu.ts`, `IKlawlyAccountService` in `klawlyAccount.ts`, `klawlyClaudeServiceAccount` in `claudeAccountActions.ts`; `AccountsActivityActionViewItem` in `globalCompositeBar.ts` (upstream, in `UPSTREAM.md`); `renderProfile` and the `profile` row in `claudeSettingsEditor.ts`, `.claude-settings-accounts`, `.claude-settings-profile` and `.claude-settings-row.is-nested` in `claude.css`; `design/settings/*.html` (nav) and `design/settings/general.html`.
**Applies to.** Every place that shows an account: the Accounts menu, the Klawly Settings nav and General page, and later rows for more Claude accounts (issue 450). A VS Code surface that lists accounts keeps its stock look under the profile.
**Since.** Issue 446.

---

### DL-70 A button that acts on many changes says how many, and how far it reaches

**Practice.** A Keep or Undo that covers more than one file names its scope in the label: "Keep 14 Changes in 6 Files", and "Keep 14 Changes in 6 Files from 3 Chats" once it reaches other chats. A short button that has no room for that ("Keep All (6 Files)" on the changes bar) carries the full label as its tooltip and accessible name. Where the scope can change (the review editor's Keep), a chevron picks This Turn, This Chat or Everything, and the label follows the pick. Undo for more than one turn asks first and lists the files. Changes Auto-Keep kept say "Kept automatically" in place of the review count, with an Undo per file and per turn.
**Why.** Focused: "Accept All" never said whether it meant this turn, this chat or a background agent's work too, so the user had to guess before an action they cannot easily take back (issue 706). Consistent: one label shape on the changes bar, the review editor, the status bar menu and the Command Palette. Calm: the numbers are the reassurance; no extra confirmation for Keep, which loses nothing.
**Where.** `claudeScopeActionLabel`, `claudeKeepAllFilesLabel` and `claudePendingStatusText` in `common/claudeKeepAll.ts`; `claudeUndoAllPending` and `ClaudePendingStatusContribution` in `browser/review/claudeKeepAll.ts`; `renderKeep` in `claudeReviewEditor.ts`; `.claude-keep-wide`, `.claude-changes-auto-kept` and `.claude-review-keep` in `claude.css`.
**Applies to.** Any later bulk action over agent work: commit all, discard all, resolving every conflict.
**Since.** Issue 706.

---

### DL-71 Work handed to another model is a card in the turn that handed it off, and stopping it asks once

**Practice.** When Auto hands a message to another model, the parent turn shows a delegate card in place, not a tab: the task in one line, when the router was given a reason a muted "Model: reason" line under it (DL-16 secondary role, one line, the router's why in its hover; issue 987), "Model · effort · time · cost" under that, the state as an icon tone and one word (Working, Done, Failed, Stopped, Stopped by you), the first three lines of the answer, and Open Chat, Stop while it works and Rerun after the user stopped it. A chat it delegated to in turn nests inside its card, one fill up. The card stays in view after the turn ends instead of folding into "Worked for". Opened, a delegated chat has no tabs: a crumb back to the chat that delegated ("Chat / Delegated · Opus 5.5: task"), Stop while it works, and a read-only note where the composer was. Stop on a card stops everything under it, then asks once, above the composer of the top-level chat: "Switch from Auto to <model> for this chat?" with No, Keep Auto and Yes, Switch. Nothing is rerun unless the user picks Rerun.
**Why.** Focused: the user sees which model did the work, what it cost and how far it got without leaving the chat, and one Stop reaches every chat under it (issue 693). Calm: one question per stop, at the top, never a dialog per nested chat, and never a rerun the user did not ask for. Consistent: the card is a chat card (DL-03 radius, DL-07 tone, high contrast keeps the edge) and the opened chat reuses the subagent crumb and read-only note.
**Where.** `renderClaudeDelegateCard` in `chat/claudeDelegateCard.ts`; `syncDelegatedChrome` and `syncDelegateQuestion` in `chat/claudeChatWidget.ts`; `.claude-delegate` and `.claude-delegate-question` in `claude.css`; `design/chat/delegate.html` and `design/chat/delegate-chat.html`.
**Applies to.** Any later hand-off to another chat or model: multitask runs that report into a parent, background agents started by the agent itself.
**Since.** Issue 693; the reason line, issue 987.

---

### DL-75 A command card reads like a terminal: the command in words, the command line on top, the output in its colors

**Practice.** A command card's one-line summary says what the command does when Claude described it ("Run the cart tests"), in body type; without a description it shows the command in monospace. The full command is always one hover away (`title`) and always the first line of the open output: a faint `$` prompt and the command, cut with an ellipsis on one line, then the output. Output keeps the ANSI colors and bold or dim the command printed (theme terminal colors, carried across lines like a terminal, never counted toward the wrap width). A finished card whose output is taller than the preview gets one Expand Output toggle in its footer that lets the box grow to most of the view and folds it back; a running card keeps following its tail.
**Why.** Calm: a cut-off `cd /long/path && npm …` in the header and a gray wall of text were the noise the tester reported (issue 745); the words say what is happening and the colors say whether it passed before reading a line. Consistent: the colors are the integrated terminal's own theme colors (DL-07 tones stay for the card's state), so output looks the same as in the terminal panel, and high contrast keeps the stock terminal palette. Focused: the command is never lost, it just moves from the header to the top of the output.
**Where.** `ClaudeCommandOutputView` and the command footer in `chat/claudeToolCardView.ts`; `outputRows` in `common/claudeTimelineModel.ts`; `parseAnsiLine` in `platform/claude/common/claudeStatusLine.ts`; `.claude-terminal-command` and `.claude-terminal.is-expanded` in `claude.css`.
**Applies to.** Any card that shows a process's output: background shells, hooks, task runs, the status line command.
**Since.** Issue 745.

---

### DL-72 What the chat says can be selected; its chrome cannot

**Practice.** Everything the transcript says (replies, inline code, code blocks, tables, thinking, tool output and the user's prompt) takes a text selection: drag, double-click and triple-click work, and Ctrl+C or Cmd+C copies it. Chrome stays out of the selection: buttons, row headers, toolbars, icons and fields. A prompt bubble still drags into another chat, but only from its edge; a drag that starts on its text selects the text.
**Why.** Focused: copying one command or path out of a reply is a core chat action, and the whole-message Copy button was the only way (issue 732, reported through Send Feedback). Calm: a selection that skips the chevrons and labels copies only the words, so the paste needs no cleanup. Consistent: the editor and terminal both let any text be selected; the chat should not be the one surface that does not.
**Where.** `.claude-timeline` and its chrome opt-outs in `claude.css`; `renderUser` in `chat/claudeTimelineRenderer.ts`.
**Applies to.** Any new transcript surface (a new card, a new reply part): its words select, its controls do not.
**Since.** Issue 732.

---

### DL-74 An attached image shows as itself, under the name people know it by

**Practice.** An image attached to a message is drawn as the image, never as a generic file icon or a stored id. In the composer its chip leads with a 16px thumbnail at the inner radius (`xs` inside the `sm` chip) and the image's own name: the file name for a picked or dropped file, "Pasted image" for a paste, and plain "Image" for an older attachment that only has a stored id; the chip's hover shows it up to 240 by 160 pixels. A sent message shows its images under the text as thumbnails 64px tall (`md` radius inside the `lg` prompt) that open the image in an editor; a message of images alone has no empty text line. When Claude reads an image the user attached, its tool row says "Viewed attached image <name>" with the media icon and opens the image, instead of "Read <stored path>". High contrast draws an edge around each thumbnail.
**Why.** Focused: a UUID file name says nothing, and the user could not check which screenshot they were about to send (issue 743). Consistent: what the user sent stays on the message they sent, like the text, instead of only showing up as Claude's tool row with a stored path (issue 744). Calm: the Read row is folded into words about the image rather than hidden, so the turn's tool counts still add up.
**Where.** `claudeImageLabel` and `SentImageIndex` in `common/claudeImageAttachments.ts`; `ClaudeImageThumbnails` and `appendClaudeImageThumb` in `chat/claudeImageThumbnails.ts`; `renderChips`, `chipHover` and `renderQueue` in `chat/claudeComposer.ts`; `renderSentImages` and `renderReadGroup` in `chat/claudeTimelineRenderer.ts`; `paintSummary` in `chat/claudeToolCardView.ts`; `.claude-image-thumb`, `.claude-msg-images` and `.claude-msg-image` in `claude.css`; `design/chat/composer-typed.html` and `design/chat/turn-finished.html`.
**Applies to.** Every place an attached or captured image appears. Preview screenshots become composer chips. A queued message shows its images in its row at the chip's size, named by `claudeImageLabel`, and names the message by them when it has no text (issue 791). The inline edit field takes no images yet; when it does, it uses the same chip.
**Since.** Issues 743 and 744; queued images from issue 791.

---

### DL-76 Claude's commands show in one read-only terminal that never takes focus

**Practice.** The shell commands Claude runs in a window also print, as they run, in one terminal named "Claude" in the Terminal panel: the chat's name as a dim `#` line when another chat starts writing, Claude's one-line reason dim, the command bold after `$`, its output, then `[done]` in the terminal's green, `[failed]` in its red, or `[running in the background]` dim, and a dim line again when a background command ends. The terminal is created the first time Claude runs a command, without opening the panel or changing the active terminal, and it takes no input. If the user closes it, it stays closed until Klawly: Show Claude's Commands in Terminal; `claude.terminal.mirrorCommands` turns it off. Chat rows for a background shell say "Background command", never Claude Code's `local_bash`.
**Why.** Focused: a user who is not technical can see what Claude ran and what is still running (a dev server, a watcher) in the place they already look for running things (issue 742), without reading every tool card. Calm: it never steals focus or opens the panel, and a closed terminal stays closed. Consistent: the colors are the terminal's own ANSI colors, so every theme and high contrast draw them (DL-01); the chat card stays the full record and the terminal only mirrors it.
**Where.** `ClaudeCommandMirror` and `claudeSubagentKindLabel` in `common/claudeCommandMirror.ts`; `ClaudeCommandTerminalService` in `browser/claudeCommandTerminal.ts`.
**Applies to.** Anything else Claude runs on its own that keeps running: background agents' commands, `/loop` checks.
**Since.** Issue 742.

---

### DL-77 A long paste is a pill in the message, and the user types on both sides of it

**Practice.** A paste of five lines or more, or longer than the long-paste setting, goes into the message as one token, "[Pasted text #1 +12 lines]", drawn as a pill (fill-4 behind the text, small radius, outline only in high contrast) where the cursor was, not as a chip above the field. The user writes before and after it like any word. One Backspace after it or one Delete before it takes the whole pill out and its text with it; Undo brings both back. Editing inside the token breaks the pill and drops its text. Ctrl+Shift+V still pastes plain text. Pills are numbered in the message, so "#2" names the second paste.
**Why.** Focused: a pasted test log flooded the composer, and the user could not see or write the question around it (issue 737). Consistent: the label is the one Claude Code itself shows for a paste, so the message reads the same in the terminal and here. Calm: a pill is lighter than a chip row and stays where the user put it.
**Where.** `claudePastePillLabel`, `claudePastePillAt` and `claudePastePillRuns` in `common/claudePastePill.ts`; `paintPills` and the paste-pill case of `onPaste` in `chat/claudeComposer.ts`; `.claude-composer-field` and `.claude-composer-pills` in `claude.css`; `decidePaste` in `claudePrompt.ts`.
**Applies to.** Any later inline token in the composer: an image pasted in place, a mention drawn as a pill.
**Since.** Issue 737.

### DL-78 What the user wrote is kept until they send it or throw it away, and sending never holds the form

**Practice.** A form that collects writing for someone else (Send Feedback today) keeps its draft when it is closed, by Escape, Cancel or quitting, and opens with it next time as it was left. A quiet "Discard Draft" link at the start of the footer, away from the primary button, starts over; it shows only when a kept draft opened. Send hands the report over and closes the form at once; the upload shows as a progress notification and ends in one toast. A send that fails keeps the report with its reason, and its error notification opens it again with the reason on the status line.
**Why.** Calm: a slow upload or a stray Escape never costs the user what they wrote (issues 735, 739), and nothing is modal while the network works. Focused: the user goes back to work, or starts the next report, the moment they press Send. Consistent: progress and results use the workbench's notifications, like any background task, and the discard link is the quiet link style of DL-55.
**Where.** `ClaudeFeedbackForm` (`.claude-feedback-discard` in `claudeFeedback.css`), `ClaudeFeedbackDrafts` in `browser/feedback/claudeFeedbackDrafts.ts`, `sendFeedbackInBackground` in `electron-browser/claudeFeedback.ts`; `design/workbench/feedback.html`.
**Applies to.** Any later form that sends writing off the machine or to another person: an issue or pull request description written in Klawly, an invite message.
**Since.** Issues 735 and 739.

---

### DL-80 A reply types in at a steady pace, and thinking never reads empty

**Practice.** Streamed reply text shows at a steady pace, not in the bursts Claude Code sends it in: whatever has arrived shows within about a third of a second, at least two characters a frame, with the caret at its end. Text that was already there when the turn first painted (a reopened chat) shows whole, and the whole reply shows the moment it ends or a tool row follows it, so a pause never hides an answer. Agent turns ask Claude Code for summarized thinking, so the thinking line opens to what Claude thought. While Claude thinks the line stays open and the text streams in under "Thinking" (the Working line only shows in the gap before the first thinking text); when the thinking ends it folds into "Thought for 4s", and a click opens the full text again, unless the user already opened or closed it (issue 461). When the runtime still sends no text, the line carries its token estimate instead: "Thinking · 208 tokens", then "Thought for 4s · 208 tokens".
**Why.** Calm: a reply that sits blank and then lands in one jump reads as a hang followed by a wall of text; a steady stream reads as Claude writing (issue 740). Focused: a thinking line that only ever says "Thinking" tells the user nothing; its size, or its words, says how much went into the answer. Consistent: the pace and the token count follow what Claude Code's own terminal shows while it streams.
**Where.** `revealedText` and `advanceReveal` in `chat/claudeTimelineRenderer.ts`; `describeThinking` in `common/claudeTimelineModel.ts`; the `thinking_tokens` case in `claudeStreamNormalizer.ts`; `thinkingDisplay` in `claudeAgentRunner.ts` and `claudeSdkAdapter.ts`.
**Applies to.** Any later streamed text in the chat: subagent replies opened in their own view, side questions, delegated chats.
**Since.** Issue 740.

---

### DL-81 A command in a reply runs in the terminal on one click, and never without one

**Practice.** A fenced shell block (`bash`, `sh`, `zsh`, `powershell`, `console` and the like) has Run in Terminal first in its header, before Insert and Copy. A session block (`console`, or a block where only some lines have a `$ ` prompt) runs only the prompted lines without their prompt, never the output under them. Inline code that reads as a command (a known program with arguments, such as `npm test` or `kill 8284`, or commands chained with `&&`) gets a 16px terminal button after it, faint and hidden until the command is hovered or the button has keyboard focus; its label names the command ("Run npm test in Terminal"). A click opens a new integrated terminal in the session's folder, shows it and sends the command through the same checks as Re-run on a command card. Nothing runs on render, on hover or on selection.
**Why.** Focused: the tester had to copy every command Claude suggested into a terminal by hand (issue 733); one click does it where the command is read. Calm: inline buttons stay out of sight until the user points at a command, so a reply full of commands reads as prose. Safe: the user's click is the only trigger, the Re-run checks still apply, and the terminal opens visibly so the user sees what runs.
**Where.** `shellCommandFromBlock` and `inlineShellCommand` in `common/claudeShellCommands.ts`; `renderCodeBlock`, `runInTerminal` and `linkifyCodePaths` in `chat/claudeTimelineRenderer.ts`; `rerunCommand` in `chat/claudeChatWidget.ts`; `.claude-inline-command` and `.claude-inline-run` in `claude.css`; `design/chat/turn-finished.html`.
**Applies to.** Any surface that shows a command the user may want to run: plan steps, setup instructions in a notice, error remedies.
**Since.** Issue 733.

---

### DL-82 What another tool keeps is listed as theirs, read only, and a picker says who a change is for

**Practice.** Customize lists what Klawly loads from Claude Code's own `~/.claude` (its CLAUDE.md, hooks, network domains, permission rules and MCP servers) as ordinary rows whose second line ends "· from Claude Code". Those rows have no Remove or edit action; a memory row still opens its file to read. They show only while General > Customize > Also Use My Claude Code Setup is on, and go away when it is turned off. The user's own rules for every project are one row, Your Rules, listed even before its file exists ("Not created yet. Open it to write instructions for every project"); opening it creates the file in `~/.klawly/claude`. Every Saved In and Scope picker names the choice by who it is for, not by a file: For Me, in Every Project; For This Project, Shared with the Team; For This Project, Only Me, with the file as the option's muted description.
**Why.** Calm and Consistent: Klawly reads the user's Claude Code setup but never writes it (issue 455), so a row that offered Remove would be a promise it cannot keep. The "from" line is the same anatomy as a plugin's rows ("· from <plugin>"), so a read-only row looks like the rows people already know are read only. Focused: "User" and "Local" are Claude Code's words for files; people choose by who should get the change.
**Where.** `fromClaudeCode`, `memoryName`, `memoryDetail`, `removableMcpScope` and `claudeWhereLabel` in `common/claudeSettingsPages.ts`; `findMemory`, `findHooks`, `hookFileLabel` and the add forms in `browser/settings/claudeSettingsEditor.ts`; `design/settings/customize.html`.
**Applies to.** Any later list of what Klawly reads from another tool's own folder, and every picker that chooses where a setting is saved.
**Since.** Issue 455.

---

### DL-83 A choice that costs more usage says so where it was made, once, and never blocks

**Practice.** When the user picks a different model in a chat that has a finished turn, a warning notice (the `claude-banner is-warning` style) shows above the composer: a title that names the cost ("Switching models mid-chat uses more of your usage"), one sentence on why, and, when the context meter knows it, how many tokens the new model reads again. Its buttons are, in order: Keep (primary), Switch Back, New Chat with the new model (carries the draft, and leaves the old chat on its old model), and a ghost Don't Show Again that turns the setting off. The send button stays live: the notice informs, it never asks. It goes away on the next turn, on Keep, or when the user picks the old model again. An empty chat, Auto's own switches and background runs never show it. It is a polite live region, and its buttons sit in the tab order.
**Why.** Calm: a dialog on every model pick would punish an ordinary choice; a notice the user can ignore costs nothing. Honest: Claude Code caches the conversation per model, so the next message on a new model re-reads the whole chat without the cache and uses more of the plan, which the user cannot see from the picker (issue 703). Focused: each way out sits on the notice, including the one that keeps costs down (a new chat), and a number shows only when Klawly knows it.
**Where.** `claudeModelSwitchWarns` in `common/claudeModelSwitch.ts`; `ClaudeModelSwitchService` in `browser/claudeModelSwitch.ts`; `chat/claudeModelSwitchNotice.ts`; `.claude-model-switch-notice` in `claude.css`; the Warn When Switching Mid-Chat row on the Models settings page; `design/chat/model-switch.html`.
**Applies to.** Any later choice that quietly costs more usage or drops a cache: switching effort or fast mode mid-chat, turning on a larger context window, resuming a long chat on another account.
**Since.** Issue 703.

---

### DL-84 Going back to an earlier message edits it in the composer, and asks once about the files

**Practice.** A sent message's hover toolbar has Edit after Copy. Edit puts the message's text in the composer under a strip, in the goal strip's row (DL-61), that says "Editing an earlier message" and "Sending removes it and every later message", with Cancel (Escape) at its end; the draft the composer held comes back on Cancel. Send stops a running turn, then, when agents changed files after the message, asks one question: "Undo the changes made after this message?", listing each file with its folder and lines added and removed, with Undo Changes, Keep Files and Cancel. The message and every later one then leave the chat and the edit is sent; kept files are named to Claude, not shown in the chat. When the chat can't go back to a message (a compaction since, or no saved point after the reply before it), Edit stays in place, faded, and its hover says why.
**Why.** Focused: the user fixes a message where they wrote it instead of starting a new chat and pasting the context back (issue 702). Consistent: the edit happens in the composer, so mentions, attachments and slash commands work as they do in a new message, and the strip reads like the goal and loop rows above it. Safe: nothing is removed until Send, files are never undone without the one question, and the question names every file it would change. Calm: a faded Edit that says why beats a button that disappears or an error after the user has typed.
Stop pressed before Claude showed anything takes the message back the same way, with no strip: the message leaves the chat and its text and attachments return to the composer (issue 948).
**Where.** `editEarlier`, `submitEdit` and `undoLaterChanges` in `chat/claudeComposer.ts`; the Edit button in `renderUser` in `chat/claudeTimelineRenderer.ts`; `claudeRewindCheck` in `common/claudeRewind.ts`; `rewind` in `common/claudeAgentService.ts`; `.claude-msg-toolbar .claude-icon-btn[aria-disabled="true"]` in `claude.css`; `design/chat/edit-message.html`.
**Applies to.** Any later action that goes back in a chat: retrying a reply, editing a message in the Agents window, going back from a subagent's view.
**Since.** Issue 702.

---

### DL-85 The level that skips every check says "Bypass" in the error tone, wherever it shows

**Practice.** When Allow Everything runs Claude Code in its bypass permissions mode (Agent mode, trusted workspace, warning confirmed), every place that shows the level says so in words and in the error tone, not the warning tone: the mode pill gets the error tone and an unlock icon after the mode name, the permission row in the mode menu reads "Allow Everything · Bypass" with its name and icon in the error color, and the session badge reads "Allow Everything · Bypass" with an error-tone fill. In Ask or Plan the row keeps the words and says that bypass runs in Agent only. When a managed policy turns the mode off, the row drops "Bypass", keeps the warning tone and says the organization turned it off. Allow Everything Except Credentials keeps the warning tone, because Klawly still checks each call. Colors are the `--claude-error` token mixed into transparency, so every theme, including high contrast, draws it.
**Why.** Safe: the warning tone already means "fewer prompts"; this level means "no checks at all", which is a different risk and needs a different signal (issue 694). Consistent: the same word and tone on the pill, the menu and the badge, so the user does not have to remember which surface means what. Focused: the tone shows only while bypass is really in effect, so it never cries wolf in Ask, Plan, an untrusted workspace or under a policy that turned it off.
**Where.** `paintMode` in `chat/claudeComposer.ts`; `ClaudeModeMenu` in `chat/claudeModeMenu.ts`; the badge in `chat/claudeSessionSwitches.ts`; `.claude-pill.is-bypass` in `claude.css`; `.is-bypass` in `claudePermissions.css`; `design/settings/agents.html`.
**Applies to.** Any other surface that names the permission level, such as a status bar item or the Agents window.
**Since.** Issue 694.

---

### DL-86 A plan limit says which one, when it resets and what to do, with Switch Account first

**Practice.** A turn that stops on a Claude plan limit shows an amber banner (`.claude-banner.is-warning`), never the red failure one. Its title names the limit ("You reached your 5-hour session limit.", weekly, weekly Opus or Sonnet, extra usage, Console credits); its detail says when it resets, when Claude Code said ("Resets in 2 hours."). The buttons start with Switch Account... (primary) on every limit, then what the plan offers: Pro gets Turn On Extra Usage and Upgrade to Max, Max gets Turn On Extra Usage and Upgrade Plan, a spent extra-usage window gets Manage Extra Usage, an API account out of credits gets Add Credits. A Team or Enterprise plan gets no plan button, only the line "Your organization manages this plan's usage. Ask your admin for more." Retry stays, as a ghost button. Switch Account... is a quick pick of every Claude account signed in through Klawly: the email as the label, plan · organization · In Use as the description, a check on the one in use, a sign-out button per row, and Add Account... last. A switch applies to every window and never stops a running turn: it finishes on the old account, and the next message resumes the same chat under the new one.
**Why.** Calm: hitting a plan limit is the plan working as sold, not Klawly failing, so it takes the warning tone and says when it ends. Focused: the one thing that keeps work going right now is another account with its own limits, so it comes first; the plan buttons are only those the plan can use, so a Team member is never sent to a page they cannot change. Consistent: the switcher is the stock quick pick with the same row anatomy as every other account list.
**Where.** `claudeLimitBanner` in `common/claudeLimitBanner.ts`; the usage-limit branch of the failure banner in `browser/chat/claudeTimelineRenderer.ts`; `claudeAccountPicks` in `common/claudeAccountActions.ts`; `switchAccount` in `browser/claudeAccountCommands.ts`; `design/chat/usage-limit.html`, `design/settings/plan-usage.html`.
**Applies to.** Any later stop caused by a quota, a plan or a bill, and every list of Claude accounts.
**Since.** Issue 450.

### DL-92 A delegate card shows the contract, the budget used and a report that wraps in full

**Practice.** A delegate card that was given a contract shows, under its head, label and text pairs: Objective, Done when (the acceptance) and Budget ("$0.04 of $0.50 · 12 of 40 calls", amber at the 80% notice, red once the worker was stopped at its budget). The tier joins the muted line ("Sonnet · Small tier · High"). When the worker ends, its report (at most 300 words) wraps in full under the pairs instead of being cut to three lines; a worker that ended with `[[quiet]]` shows "Nothing to report." and tells its parent nothing. A worker stopped at 100% of its budget reads Failed with "Stopped at its budget." and keeps what it reported so far.
**Why.** Focused: the user sees what the worker was asked, how it is checked and how much of the budget is gone without opening the chat (issue 837). Calm: the report is short by contract, so it is shown whole, and silence is stated in one line. Honest: a stop at the budget says so in words, not as a bare Failed.
**Where.** `renderClaudeDelegateCard`, `claudeDelegateBudgetText` in `chat/claudeDelegateCard.ts`; `.claude-delegate-contract` and `.claude-delegate-result.is-report` in `claude.css`; contract in `platform/claude/common/claudeDelegateContract.ts`; `design/chat/delegate.html`.
**Applies to.** Any worker or background run with a budget and a report: Delegation 4 and later views.
**Since.** Issue 837.

### DL-96 Usage limits belong to the account in use, and "no limits" is only said when Claude Code said it

**Practice.** The limits under the chat and the Usage Limits section of Plan & Usage follow the signed-in Claude account. When the account changes (sign in, sign out, switch), the old numbers clear at once, the section says "Loading your limits..." and the new account's limits are fetched. The section has four plain states: the meters; loading; "Couldn't load your limits. Check your connection, then try again." with a Try Again button; and "This sign-in has no plan limits to show" only when Claude Code answered with none (an API key or a cloud provider). A fetch that has not happened yet says "has not reported your limits yet", never "no limits". An answer that arrives for the previous account is dropped.
**Why.** Honest and calm: another account's numbers under the chat are wrong, and "no limits" after a failed fetch tells a user with a plan something false (issue 942, reported through Send Feedback). A failure with a button is something to act on.
**Where.** `claudeUsageState` and `watchClaudePlanUsage` in `common/claudeUsageRow.ts`; the limits row of `claudeSettingsEditor.ts`; `forgetAccount` and `accountOverview` in `claudeAgentRunner.ts`; `design/settings/plan-usage.html`.
**Applies to.** Any figure that belongs to the signed-in account: it clears on a change of account and says failed, loading and none apart.
**Since.** Issue 942.

---

### DL-89 A tool that merges for the user asks every time, and one switch turns the question off

**Practice.** The no-model CI tools (`ci_wait`, `verify`, `merge_gate`) report in plain words: a prefix naming the tool and one outcome word (PASS, FAIL, WATCHING, REFUSED, MERGED), then the run link and, for a failure, the failing jobs and the last 40 log lines. `ci_wait` never asks, because it only reads. `verify` and `merge_gate` ask through the normal permission card, as any command does. The one merge that can skip the card is gated by a named setting, Merge Without Asking (Agents, Delegation), which is off by default; a dry run of `merge_gate` never asks because it changes nothing. Ask mode refuses a real merge outright.
**Why.** Safe: a merge is outward-facing and hard to undo, so the default is a question, and the opt-out is one visible switch rather than a hidden mode. Calm: a watch that only reads never interrupts. Consistent: the card, the words and the tones are the ones every other command already uses.
**Where.** `claudeModePolicy.ts`, `allowTool` in `claudeAgentRunner.ts`, the Delegation section in `claudeSettingsPages.ts`; `design/settings/agents.html`.
**Applies to.** Any later tool that publishes or merges on the user's behalf.
**Since.** Issue 844.

### DL-90 The notebook diff editor gets the text editor's Keep and Undo, one row per changed cell

**Practice.** When Claude edits a notebook, the notebook diff editor shows the same Undo and Keep chips as a text diff, in the same overlay, labels and key hints. A head row says how many cells changed ("2 changed cells") and carries Undo All and Keep All; below it each changed cell gets one row (its number and Added, Removed or Changed) with its own Undo and Keep. Keep and Undo settle every hunk of that cell, and a cell never shows the cursor-hunk key hints, because the chips act on a cell, not on the cursor. Metadata changes outside any cell are settled by Keep All and Undo All.
**Why.** Consistent: a notebook change is judged and settled the way every other file change is, with nothing new to learn. Focused: the unit people check in a notebook is the cell, not a line of JSON, so the chips sit on the cell.
**Where.** `claudeNotebookCellBar.ts`, `paintNotebookCells` in `claudeReviewPane.ts`, `groupHunksByCell` in `claudeNotebookReview.ts`, `.claude-notebook-review` in `claude.css`; `design/chat/notebook-edit.html`.
**Applies to.** Any notebook file Claude changes, in the notebook diff editor. Not covered yet: inline edit inside a cell.
**Since.** Issue 859.

### DL-91 Find in Chat is a bar over the text, not a list

**Practice.** Ctrl or Cmd+F in the chat opens the same find bar as the editor (input, count, previous, next, close, Match Case, Whole Word, Regex) at the top right of the transcript. Every match is painted in the text with the editor's find colors, the current one stronger. It searches prompts, replies, tool commands, tool output and file edits, and opens folded work to show a match. While the bar is open the transcript keeps a top inset the height of the bar, so the first line is never hidden under it when the transcript is scrolled to the top. Closing it puts focus back in the composer. The old quick pick stays as Find in Chat as List… in the Command Palette.
**Why.** Calm: the reader stays in the transcript and sees the match where it is. Consistent: it is the find bar every other surface already has, so no new control to learn. Focused: Enter and Shift+Enter walk the matches without leaving the keyboard.
**Where.** `claudeChatFindWidget.ts`, `claudeChatFind.ts`, `claudeChatWidget.ts`, the `::highlight(claude-find-*)` rules in `claude.css`; `design/chat/find-in-chat.html`.
**Applies to.** Any later transcript search surface.
**Since.** Issue 890; the top inset, issue 915.

### DL-94 Each mode has its own color: Plan orange, Agent gray, Ask green, Debug red, Multitask purple

**Practice.** A mode shows its color on its icon in the composer pill and in the mode menu, and Plan, Ask and Debug also tint the pill. Plan is orange (`claude.mode.plan`), Agent is gray (`claude.mode.agent`), Ask is green (`claude.mode.ask`), Debug is red (`claude.mode.debug`) and Multitask is purple (`claude.mode.multitask`, on the Multitask header icon). Each is a theme token with a Klawly Dark, Klawly Light and high contrast value; the CSS reads the token and falls back to the dark value. A new mode gets its own hue, never one that another mode or a status already uses.
**Why.** Focused: the colors the owner asked for are the ones a person coming from the CLI already reads (Plan, Ask, Debug, Agent), so the mode is known before the label is read. Consistent: one hue per mode on every surface that names it, from tokens, so a theme can change them. Plan teal clashed with the Ask green beside it; orange is Klawly's accent, so Plan reads as the thing Klawly is built around.
**Where.** `claudeColors.ts`, `claude.css` (`--claude-mode-*-solid`, `.claude-pill.is-*`, the mode menu), `claudeComposer.ts` `paintMode`, both Klawly themes; `design/assets/global.css`, `design/DECISIONS.md`.
**Applies to.** Any later surface that shows a mode. Supersedes the teal Plan of DL-07 and DL-09.
**Since.** Issues 941 and 944.

### DL-97 The feedback form shows who it sends as, and a ban replaces the form with the reason and the appeal

**Practice.** Send Feedback needs a GitHub sign-in. An identity row under the title reads "Sending as @login" with a Switch Account link; signed out it offers Sign In to GitHub, Send stays off and the draft is kept. A banned account sees the ban in place of the form: the reason, what it sent, the appeal email as a mailto link, and no Send.
**Why.** Honest and calm: a report is credited to a verified account, and a refusal says why and what to do next instead of failing at Send (issue 949). Safe: the token goes only to the relay, through the account service, and is never logged.
**Where.** `claudeFeedbackForm.ts` (identity row, ban panel), `claudeFeedback.css`, `electron-browser/claudeFeedback.ts`, `platform/claude/node/claudeFeedbackRelay.ts`; `design/workbench/feedback.html`.
**Applies to.** Any form that sends something under the user's name to a service that can refuse the account.
**Since.** Issue 949.

### DL-98 The composer's model menu docks to the composer; a header menu opens under the header

**Practice.** The model menu is a panel docked to the composer: it opens just above the composer at the composer's full width, its rows (Context, Effort, Thinking, Model) on the small text size, and the model list opens beside it, toward the editor. The chat header's More menu is a wide menu (the 320px menu width) that opens under the header's toolbar at the pane's inner edge. Neither is sized or placed from the small button that opens it.
**Why.** Consistent: the controls that shape the next message sit on the composer they shape, edge to edge with it, so the panel reads as part of the composer rather than a stray popup. Focused: a header menu holds whole-chat actions with long labels, so it takes the wide width instead of wrapping.
**Where.** `claudeModelMenu.ts`, `claudeComposer.ts`; `.k-menu.is-full` and `.k-menu.is-below.is-wide` in `design/assets/global.css`; `design/chat/model-menu.html`, `design/chat/more-menu.html`.
**Applies to.** Any later menu opened from the composer or from the chat header.
**Since.** Issue 892.

### DL-99 Findings about a commit stay where the code is, and fixing them starts as a draft

**Practice.** After a commit review, each finding shows three ways at once: a thread under its lines in every plain editor open on its file (the Review editor's thread, reused; diff editors are left alone so the Review editor's own threads are not doubled), a marker in the Problems panel, and one status bar item on the right next to Claude's item: a spinner and "Reviewing {commit}" while the review runs, then "{n} findings in {commit}" until the last one is dismissed, hidden otherwise. The item opens a quick pick of the findings worst first, then Fix All in New Chat, Show Problems and Dismiss All. Fix with Agent and Fix All open a new chat with the findings written in the composer as a draft; nothing runs until the user sends it. Threads follow edits made since the commit. Fixing does not dismiss a finding; Dismiss, Dismiss All or the next review does. The review remembers the commit it covered, across windows: the next one reads only the diff since, carries open findings over it, and counts those a later commit changed as addressed, so the item reads "{open} open, {addressed}/{total} addressed" and the quick pick's header "Reviewed up to {commit}". Review Everything Again, last in the actions, forgets that and reviews the last commit alone.
**Why.** Focused: the finding sits under the code it is about instead of only in a toast that goes away. Safe: a commit review has no chat and no approval card of its own, so starting the fix as a draft keeps the chat's permission mode in charge of what runs. Calm: one status item with a count, hidden when there is nothing left, instead of a toast per finding.
**Where.** `claudeCommitReviewThreads.ts`, `claudeCommitReviewStatus.ts`, `claudeCommitReviewState.ts`, `renderClaudeFindingThread` in `review/claudeReviewFindings.ts`; `design/workbench/editor.html`.
**Applies to.** Any later review whose findings are about code outside the Review editor (a pull request review, a scheduled review).
**Since.** Issue 876; remembering what was reviewed, issue 927.

---

### DL-106 Freeze Frame freezes the preview as an image, and the drawing leaves only as one picture in the chat

**Practice.** Freeze Frame in the browser preview toolbar captures the viewport and covers it with that image and a drawing layer. A small toolbar floats at the top centre with Pen, Box, Undo, Clear, Add to Chat (the one primary button) and Cancel. Strokes are the accent-neutral red `#e5484d`, 3px, so they read on any page. Escape cancels, Ctrl or Cmd+Z undoes, and every tool is a real button, so the toolbar is reachable by Tab. Add to Chat flattens the image and strokes into one PNG and attaches it to the composer like a screenshot; closing the frame throws the drawing away.

**Why.** Focused: pointing at the thing ("this gap is too big") in a picture beats describing it. Calm: the page stops moving while the person draws, nothing is sent until Add to Chat, and nothing is kept after Cancel. Honest: what the agent receives is exactly what was on screen.

**Where.** `claudePreviewFreeze.ts`, `common/claudePreviewFreeze.ts`, `claudePreviewEditor.ts` (`freezeFrame`), `claudePreview.css` (`.claude-preview-freeze`); `design/editor/browser-preview.html`.
**Applies to.** Any surface that lets the person mark up a captured image before it goes to the agent.
**Since.** Issue 886.

## Adding or changing a practice

Add a practice when you make a design decision that is not already here and that someone could make differently next time. Signs that you are making one:

- you picked a size, color, radius, weight or spacing that no token or existing practice gives you;
- you restyled, hid or reworded a VS Code surface;
- you made a Klawly surface differ from a similar one on purpose;
- a review or the user asked for a look and gave a reason ("it reads as two products", "too loud").

How:

1. Take the next free number in the section (Foundations `DL-01`–`DL-19`, VS Code surfaces `DL-20`–`DL-49`, Klawly surfaces from `DL-50`). Never reuse a retired number.
2. Fill in all five fields. **Why** must name the feeling (Calm, Focused, Consistent, Delightful) and the concrete problem it fixed. "Looks better" is not a reason.
3. Cite the ID in the code comment above every rule that applies it, and in the `UPSTREAM.md` line when it needs an upstream edit.
4. Mirror it in the prototype (`design/assets/global.css` or the pages) so `design/` stays true (rule 36).
5. When a practice changes, edit the entry in place and add the new issue to **Since**. When a practice is dropped, replace its body with `Retired (issue): why`, and remove the code that cited it.

An existing practice that already covers the case is not a new one: extend its **Applies to** instead.

## When upstream changes

After every Code - OSS merge (the weekly upstream-watch issue opens one), and whenever you work on a VS Code surface:

1. **Find new and changed UI.** Diff upstream's CSS (`src/vs/**/media/*.css`) and the widgets that `claudeChrome.css` targets between the old and the new upstream commit. List new menus, pickers, toasts, lists, editors and settings.
2. **Check the existing restyles still apply.** For each block in `claudeChrome.css`, check the selectors still match the new DOM (open the surface, or grep the new upstream source for the class names). A selector that silently stops matching loses its practice with no error anywhere.
3. **Apply the practices to what is new.** For each new or changed surface, go through Foundations and the surface practices that cover it (a new quick pick falls under DL-21, a new context menu under DL-20). Apply them with the cheapest step in "How a practice reaches a surface".
4. **Record it.** Cite the practice ID in each new rule, add new upstream edits to `UPSTREAM.md`, and add a practice here when the new surface needs a decision none of them covers.
5. **Prove it.** Screenshot the surface in Klawly Dark and Klawly Light, and check high contrast still looks stock. Run `npm run design-sync` and `npm run design-parity` (rule 36).

6. **1.142 pass (Windows, 2026-10-19).** Diffed the CSS and widgets between the 1.141.0 and 1.142.0 snapshots. New surfaces: Agents window invitation and tour, customization marketplace welcome, image generation parts, tool group summary, MCP server configuration form, sessions list notice, Mission Control. All sit in the Agents window or the Copilot harness, which Klawly does not use (decisions in FEATURES.md section 6, 1.142), so no new restyle was needed. The MCP configuration form is stock VS Code and is covered by DL-21 and the Foundations through the existing `claudeChrome.css` rules. Selector check against the new DOM was not done in this PR (no UI run); `npm run design-sync` output is in the PR. Screenshots in Klawly Dark and Light are not taken in this PR; they come with the first alpha that carries 1.142.

### DL-73 A Klawly action with words gets its own section, not a slot in a VS Code header

**Practice.** A VS Code view header holds icon actions only. When Klawly adds an action to a VS Code view container that needs its words to be understood, it gets its own section in that container, with a one-line description and one button, placed next to the view it acts on. The section is a normal view: the user collapses, hides or moves it like any other, and the command stays in the Command Palette.
**Why.** Calm: a text button in a header squeezes the header's own title to "CH…" and pushes the icons around. Consistent: a section reads like Graph or Outline, so the user already knows how to close it. Focused: the button says what it does in full, and the line under it says what happens next.
**Where.** `claudeScmReviewSection.ts` (Review with Claude, between Changes and Graph in Source Control); `design/workbench/source-control.html`.
**Applies to.** Klawly actions on VS Code views: Source Control, Explorer, Run and Debug, Testing. An icon action that reads without words may stay in the header.
**Since.** Issue 749.

### DL-79 Work that runs elsewhere and prints nothing says what Klawly can see, and how long it has run

**Practice.** When Klawly starts something that runs outside its own UI and shows no progress of its own (the Claude Code installer in a terminal), the step it belongs to turns busy: a spinning `loading` codicon in the accent color, a title that says what is happening ("Installing Claude Code"), one muted sentence on why it can take a while, and one faint live line with what Klawly can measure and the elapsed time ("Downloaded 84 MB · 1:12", tabular figures). The line is rewritten in place every second, never by re-rendering the card, so focus stays where it is. The primary button shows the work (Show Installer), a secondary one stops it. After three minutes without movement the step turns into an error that says so, with Retry as the primary button; an ended run that did not do its job says it failed, with its exit code and Retry. Klawly keeps checking for the result while the work runs, so it is picked up without a restart.
**Why.** Calm and honest: a blank terminal for several minutes reads as broken, and users give up on work that was going fine (issue 783). A size and a clock answer "is anything happening?" without a progress bar Klawly cannot fill truthfully. Focused: one way to look, one way out, and Retry only once there is a reason for it.
**Where.** `claudeSetup.ts` (`runInstaller`, `watchInstall`), `claudeSetupCard.ts`, `claudeInstallStatusLine` in `claudeRuntimeStatus.ts`, `.claude-step.is-busy` and `.claude-install-live` in `claude.css`; `design/onboarding/first-run.html`.
**Applies to.** Installers, sign-ins and other long runs Klawly starts in a terminal or another app and then waits on.
**Since.** Issues 783 and 784.

### DL-100 A merge conflict offers Resolve with Claude where it is, and staging is a choice you make

**Practice.** Every conflict in a file gets one more CodeLens after VS Code's own (Accept Current, Accept Incoming, Accept Both, Compare): "Resolve with Claude". It sends the file the way the Merge Changes button does. Keeping Claude's changes never stages anything by itself. Settings > Review has "Stage Resolved Conflicts", off by default: with it on, a file in Merge Changes is staged once every change in it is kept or undone, at least one is kept, it is saved, and no conflict marker is left on disk. A file that still has a marker is never staged.
**Why.** Focused: the conflict is where you are looking, so the next step sits there, not in the Source Control view. Calm: staging changes what a commit will contain, so it follows your choice and not Claude's edit.
**Where.** `extensions/merge-conflict/src/codelensProvider.ts`, `claudeMergeStage.ts`, `shouldStageResolvedFile` in `claudeMergeConflicts.ts`; `claudeSettingsPages.ts` (`mergeStage`).
**Applies to.** Any step that would change the index: it is opt-in and checks the result first.
**Since.** Issue 877.

### DL-101 Chat tabs reorder by dragging or by Alt+Arrow, and the order is yours

**Practice.** A chat tab can be dragged onto another tab and drops before or after it (a thin line shows which). With a tab focused, Alt+Left and Alt+Right move it one place. The order is kept per workspace and restored on restart. New chats still go last; Settings > Agent > "New Chats First" (`claude.agent.newChatsFirst`) puts them first instead.
**Why.** Calm: the strip stays where you left it. Consistent: the mouse and the keyboard do the same move.
**Where.** `claudeSessionTabs.ts` (`reorder`), `claudeAgentService.ts` (`moveSession`, `claude.tabOrder`), `claudeSettingsPages.ts` (`newChatsFirst`).
**Applies to.** Any strip of tabs the user owns.
**Since.** Issue 964.

### DL-105 A worker that struggles moves up a tier on its own, and the card and the log say so

**Practice.** After 4 failed calls in a row a delegated worker moves one tier up (Small to Medium to Large) and its card gets a "Moved up" line with the models and the count; a cheap turn that Auto picked goes back to the chat model after 3 failed calls in a row or 30 steps, and the output log names the cause. Every limit is a number under Settings > Agents > Delegation, on by default, and 0 turns it off.
**Why.** Calm: a stuck cheap model stops burning calls without the user stepping in. Honest: every move is written in plain words where the work is shown, with the reason and the count.
**Where.** `common/claudeDelegateLadder.ts`, `claudeDelegation.ts` (`escalate`), `claudeAgentService.ts` (`fallBackToChatModel`), `chat/claudeDelegateCard.ts`; `design/settings/agents.html`.
**Applies to.** Any automatic change of the model that runs a user's work: it is shown on the card or log where the work is, with its cause.
**Since.** Issue 839.

### DL-104 Agents list rows reorder by dragging or by Alt+Up and Alt+Down, within their group

**Practice.** A row of the Agents list can be dragged onto another row of the same group and drops before or after it (a thin line shows which). With a row focused, Alt+Up and Alt+Down move it one place. The order is kept per workspace and restored on restart. A row you never placed stays above the placed ones, so a new chat still shows first in its group.
**Why.** Calm: the list stays where you left it. Consistent: the mouse and the keyboard do the same move, as with chat tabs (DL-101).
**Where.** `claudeAgentsColumn.ts` (`wireReorder`, `claude.agentsOrder`), `claudeAgentsList.ts` (`moveClaudeAgentRow`, `applyClaudeAgentRowOrder`).
**Applies to.** Any list of rows the user owns.
**Since.** Issue 977.

### DL-103 In the Agents list, a project's coordinator and agents group under the project's name

**Practice.** A chat that coordinates a project, and every agent it started, sit together in one group titled with the project's name (project icon), after the day groups and before the automation groups. A project also has a shared context folder every agent can read and write, whichever worktree it works in.
**Why.** Focused: the work of one goal reads as one thing, not as a spread of unrelated rows. Calm: the agents share notes in one place instead of repeating each other.
**Where.** `claudeAgentsList.ts` (`project:<key>` groups), `claudeAgentsColumn.ts`, `ClaudeProjectIndex` in `claudeProjects.ts`, `projectContextFolderName` in `claudeProject.ts`.
**Applies to.** Any list of agents that belong to a larger goal.
**Since.** Issue 899.

### DL-102 What Klawly reads from Claude Code can be copied into Klawly's own folder, never moved

**Practice.** Every "· from Claude Code" row in Customize (memory, rules, hooks, network domains, permission rules) opens read only and has one action, Copy to Klawly. It puts a copy in `~/.klawly/claude` (the dev build: `~/.klawly-dev/claude`) and leaves the original alone; a copy that would overwrite something of the user's is skipped and said so. Rules in `~/.claude/rules` list the same way while Also Use My Claude Code Setup is on. The command Import from Claude Code… (Command Palette) lists everything in `~/.claude` (memory, rules, skills, subagents, commands) as checkboxes, preselecting what Klawly does not have yet, and copies the chosen ones. Create forms and prompts name the folder of the running build.
**Why.** Calm and Honest: Klawly never writes `~/.claude` (DL-82), so taking something over is a copy the user asks for, with a notice that Claude Code's files were not changed. Consistent: one action name on every read-only row.
**Where.** `ClaudeCodeImporter` in `browser/settings/claudeCodeImporter.ts`; `copyToKlawly` and `openCustomizeFile` in `browser/settings/claudeSettingsEditor.ts`; `copyFrom` in `common/claudeSettingsPages.ts`; the Import from Claude Code… action in `browser/settings/claudeSettingsEditorActions.ts`; `design/settings/customize.html`.
**Applies to.** Any later list of what Klawly reads from another tool's own folder.
**Since.** Issue 807.

### DL-88 Selected chat text can be copied or quoted from a right-click, and a selecting drag scrolls the chat

**Practice.** A right-click on text selected in the chat opens a two-item menu: Copy, then Quote in Reply, which adds the selection after the composer's draft as a Markdown quote and puts the focus there. A right-click with nothing selected keeps the default menu. A drag that is selecting text and reaches the top or bottom 16 pixels of the chat scrolls it, faster the further the pointer goes past the edge (up to 28 pixels a frame), and the selection follows. A press near the edge that has not selected anything yet never scrolls.
**Why.** Focused: answering one line of a long reply meant copying, pasting and typing `>` by hand, and a selection could not reach past what fit on screen (issue 468, reported through Send Feedback). Consistent: the editor and terminal both scroll while a selection is dragged past their edge, and both offer Copy on a selection's right-click. Calm: the menu shows only when there is something to act on.
**Where.** `chat/claudeTimelineSelection.ts` and `common/claudeTimelineSelection.ts` (`selectionScrollStep`, `quoteForReply`); `design/chat/turn-finished.html`.
**Applies to.** Any surface that shows the transcript in its own scrolling element: selecting drags scroll it, and a selection's right-click offers Copy and Quote in Reply.
**Since.** Issue 468.

### DL-87 The version and the update state sit in Settings, in words, with one button

**Practice.** Klawly Settings > General has a "Version and Updates" section under the account. The Version row shows the version as testers say it ("1.141.0 Alpha 10") with the commit and build date in the muted line, and a Copy button for bug reports. The Check for Updates row says the update service's state in plain words (Checking…, Up to date, Downloading…, Ready: restart to finish updating, Couldn't check: the reason, or why updates are off in this build) and offers the one button that moves it on (Check for Updates, Try Again, Download Update, Install Update, Restart to Update). A state that cannot be acted on disables the button, and a moving state is announced politely. The row only reads the update service; it adds no update logic.
**Why.** Calm and honest: a tester should not have to find the Help menu or the About dialog to learn what they run or to ask for an update, and a silent button is a broken button. Focused: one state, one next step.
**Where.** `claudeVersionUpdates.ts`, `claudeSettingsEditor.ts` (`version` and `updates` rows), `claudeSettingsPages.ts`; `design/settings/general.html`.
**Applies to.** Any row that shows a live service state with one action.
**Since.** Issue 833.

### DL-93 Suggested reviewers and the risk note sit under the pull request card, and one button asks for them

**Practice.** Under an open pull request card, Suggest Reviewers reads GitHub (changed files, CODEOWNERS, the last year of commits to those files) and swaps itself for a small panel: a risk note in the muted tone (red only for High) such as "Medium risk: 212 lines changed, no tests changed.", up to three reviewers, each with a plain reason ("owns 2 of 5 changed files, changed 3 of them, last 12 days ago"), and Request Review, which asks GitHub and turns into Review Requested only when GitHub lists the reviewers it was asked for (otherwise "GitHub Didn't Add acme/core", since an author cannot review their own pull request). With no code owner and no recent history the panel still shows the risk note and says no one could be suggested. The same input always gives the same answer, and no Claude turn is used. When GitHub can't be read the panel says so with Try Again.
**Why.** Calm and Focused: the answer is on the card, where the decision is made, in one place and in plain words, so nobody has to read a chat turn to learn who to ask. Honest: the reason sits next to each name, and an empty result says why instead of guessing.
**Where.** `chat/claudeGitHubCard.ts`, `chat/claudeReviewerSuggestions.ts`, `common/claudeReviewerSuggestions.ts`; `design/chat/pull-request.html`.
**Applies to.** Any card that offers a next step under it: the step's result replaces the button on the card instead of going to the chat.
**Since.** Issue 870.

### DL-102 An MCP App can fill the window or float in a corner, and Esc or Exit brings it back

**Practice.** An MCP App card is inline by default. When the app asks, it fills the window (fullscreen) or floats at the bottom-right (picture-in-picture). An Exit button shows in both, and Esc in fullscreen goes back inline. Only the modes the app is told about (inline, fullscreen, pip) are granted; an app can save a file only through a save dialog the user confirms, and reads resources only from its own server.
**Why.** Calm: the app grows only when it asks and the way back is always on screen. Focused: nothing is written to disk without a choice by the user.
**Where.** `claudeMcpAppView.ts` (`setDisplayMode`, `saveFile`), `claudeMcpAppBridge.ts`, `claude.css` (`.claude-mcp-app.is-fullscreen`, `.is-pip`).
**Applies to.** Any sandboxed view the model's tools draw.
**Since.** Issue 897.

### DL-105 Nothing in an answer runs past the pane edge: code wraps, code blocks and tables scroll

**Practice.** Inline code and paths in an answer wrap anywhere. A fenced code block and a table scroll sideways inside their own box, with a visible thin scrollbar; tables have header and row rules and keep code chips whole.
**Why.** Calm: the pane never widens and nothing is cut off. Honest: a scrollbar shows there is more.
**Where.** `claude.css` (`.claude-msg-assistant`, `.claude-codeblock pre`).
**Applies to.** Any rendered answer text in a narrow pane.
**Since.** Issue 469.

### DL-106 Splitting changes into pull requests starts with groups you can see and move

**Practice.** Split into Pull Requests opens a tab with one column per pull request, each with its title, its branch name and its changes. Drag a change into another column (Shift-drag moves the whole file; Alt+Left and Alt+Right move the focused change). Add Group and Remove Group change the number of pull requests. Continue with Claude stays off while a group is empty, a branch name is one git cannot use or is shared, or a change belongs to no group, and says why in words. Claude gets the confirmed groups as given and does not regroup or ask again. In a local repository the primary button is Create Branches instead: after a confirmation that lists every branch and its files, Klawly makes one branch and one worktree per group under `.worktrees/<branch>` from HEAD and commits the group there, without touching the user's checkout, its branch or its index; then a notification offers Push and Open Draft Pull Requests as a second, separate click (DL-65). Continue with Claude stays as the secondary button.
**Why.** Focused: the user sees and decides the grouping instead of reading Claude's guess in a chat. Calm: nothing is created until Continue, and branches and pull requests still ask before they push.
**Where.** `claudeSplitEditor.ts`, `claudeSplit.contribution.ts`, `media/claudeSplit.css`, `claudeSplitPlan.ts` (the model), `splitPlanPrompt`.
**Applies to.** Any step that turns one change set into several outputs: show the groups first, validate in words, then act.
**Since.** Issue 970; Create Branches since issue 971.

### DL-107 Security findings are one list with a next step on every row

**Practice.** The Security Findings view groups open findings from the user's security automations by repository. Each row shows the severity and category, the file and line, and the detail, with Fix with Agent and Dismiss beside it. Dismiss asks for a reason and the finding leaves the list; the title bar has Refresh and Dismiss All, which asks one reason for every open finding. A security run under way shows a Scanning line, since its findings only appear when it ends. An empty list says where findings come from and offers Set Up a Security Scan, which opens the New Automation form filled from the security template.
**Why.** Focused: a finding is never a wall of text with nowhere to go, every row ends in an action. Calm: nothing is fixed or hidden without the user pressing the button, and a dismissed finding keeps its reason.
**Where.** `claudeSecurityFindingsView.ts`, `claudeSecurityFindings.ts` (the model).
**Applies to.** Any list of problems Claude found on its own: show the problem, the place and the two choices (act or dismiss with a reason).
**Since.** Issue 871; setup, scanning and Dismiss All in issue 1076.

### DL-108 Workers are one live tree where every row says its state and flags what needs you

**Practice.** The Workers view lists every worker run as a tree numbered like the plan (`1`, `1-2`, `1-2-3`). Each row shows the name, the state in words, then the model, context and cost (the run's own and, for a parent, with its workers). A finished row folds into one line until opened. A finished run left open past a few minutes, a working run with no news for a while, waiting messages and a quiet finish each get a chip whose hover says what to do. Both thresholds are settings, and 0 turns a flag off. Clicking a row opens its detail: facts, flags, steps in words, the report.
**Why.** Focused: the user sees at a glance which worker needs a decision. Calm: finished work gets out of the way and nothing is stopped for them.
**Where.** `claudeWorkersViewPane.ts`, `claudeWorkersView.ts` (the model), `claudeWorkersViewSettings.ts`, `media/claude.css` (`.claude-worker-*`).
**Applies to.** Any list of long-running things: tree, plain-words state, flags with a next step.
**Since.** Issue 840.

### DL-109 Auto states are said in plain words and each has one main action
**Practice.** Every state of a run Auto drives is named in plain words (Planning, Building, Waiting on CI, Reviewing, Waiting for you, Done, Failed, "$25 used", "Context near full"), followed by one short line of what is happening or what Claude needs. Each state has exactly one main action: Stop while working, the decision buttons when waiting, Open PR when done, Retry on Opus when failed, Continue when a guard is hit. A failure says why and what was tried. Menus never list Auto as a separate choice; with Auto on they show its choice as read-only text.
**Why.** Calm: nobody has to decode a status. Focused: the one thing to do next is always the highlighted button. Consistent: every long-running thing reads the same way (see DL-108).
**Where.** `design/chat/auto-mode.html`, `design/chat/mode-menu.html`, `design/chat/model-menu.html`, `design/settings/auto.html`.
**Applies to.** Any surface that shows an automatic run: strip, plan card, run card, menus.
**Since.** Issue 1216; the context nudge at 80% of the cap, issue 846; the cost notice and the cost stop ("$25 Used", "Waiting for You: $50 Used"), issue 1218.

### DL-112 Exports and the summary say what they wait for

**Practice.** The three review exports (Markdown, SARIF, PR comment) are palette commands for an open review and are disabled in the More menu with "Nothing to export" while there are no findings. The SARIF entry says what the format is and where it can be uploaded (GitHub code scanning). While the summary is produced the summary card shows a Summarizing line; if it fails the card shows why and a Retry button. Copy Summary and Accept only appear with a summary.
**Why.** Honest: a disabled or missing control says what it waits for. Calm: a failure has a way back that is not re-running the whole review by hand.
**Where.** `claudeReviewEditor.ts` (`exportReview`, `renderSummary`), `claudeReviewSummary.ts`, `claudeReviewEditorActions.ts`; `design/review/review-editor.html`.
**Applies to.** Any card or menu entry that depends on something still running or not produced yet.
**Since.** Issue 1078.

### DL-110 Cost is a pill that is always visible while working, and on done or failed
**Practice.** The cost of a run is a small pill (`$1.87`) at the end of the state line, in tabular numbers. It shows while the run works and stays on Done and Failed. A parent's pill includes its helpers. While only a free tool waits it reads "$0 while waiting" next to the total. When a guard is hit the pill turns amber.
**Why.** Calm: spend is never a surprise. Honest: the number matches what the guard counts.
**Where.** `design/chat/auto-mode.html` (`.am-cost`).
**Applies to.** Strip, plan card (estimates with ~), run card rows.
**Since.** Issue 1216.

### DL-111 Enter again on a queued message sends it now
**Practice.** While a turn runs, Enter queues the message. Enter again with an empty composer and a message waiting interrupts the turn and sends the first queued message right away, once. The first queued row says so in a faint hint at its end: "Press Enter Again to Send Now". Only that row carries it, because only it is sent.
**Why.** Calm: the user who queued something and now wants it can say so with the same key, without hunting for Stop. Honest: the hint names what the key will do before it is pressed.
**Where.** `claudeComposer.ts` (`renderQueue`, the Enter handler), `ClaudeAgentService.sendQueuedNow`, `.claude-queue-hint` in `claude.css`; `design/chat/multitask.html` (`.k-queue-hint`).
**Applies to.** The queue above the composer in every chat.
**Since.** Issue 1242.

### DL-112 Stacking is a checkbox beside Create Branches
**Practice.** In the Split into Pull Requests tab, Stack the Branches sits just before Create Branches. Off, every branch starts at HEAD. On, each branch starts from the one before it, in group order, so each pull request is based on the previous branch and shows only its own group. The choice is not remembered; every split starts unstacked.
**Why.** Focused: the control sits next to the button it changes, and the hover text says what it does. Calm: the default stays the simple case.
**Where.** `claudeSplitEditor.ts`, `claudeGitActions.ts`, `claudeWorktreeGit.ts` (`gitCreateSplitBranches`), `splitBranchesPrompt`.
**Applies to.** Any option that changes how an action runs: put it beside the action, off by default.
**Since.** Issue 972.

### DL-113 A tab shows what the agent says about itself
**Practice.** When the agent reports with `klawly_status`, its tab gets a small dot (grey for info, amber for attention, green for done) and the text joins the tab's hover. The dot goes away when the user writes the next message.
**Why.** Calm: a background chat tells you where it stands without a toast or a switch. Honest: the words are the agent's own, capped at 120 characters.
**Where.** `claudeSessionTabs.ts` (`.claude-tab-status`), `claudeChatWidget.ts` (`statusOf`), `claude.css`.
**Applies to.** The session tabs strip.
**Since.** Issue 1302.

### DL-114 Every session on this PC is one tree where each row says its state and the next step
**Practice.** The Claude Sessions view lists every Claude Code session on this PC, across projects and windows, managers first with their workers under them. Each row shows the name, the state in plain words (Working, Idle for N min, Waiting on you, Finished, Stopped, Failed), then model, context and cost, the folder, and a "Next:" line saying what to do. Buttons follow the state: Stop while running, Resume and Delete once not running, Open to focus the folder. Kill sits in the row's menu. Delete and Kill ask first. One command cleans up finished and idle sessions: it lists what it will delete and what it keeps and why (unpushed commits, uncommitted changes, waiting on CI, waiting on a decision for less than a day, still working).
**Why.** Calm: nobody has to open a terminal to find out what is still running. Consistent: same row reading as DL-108. Honest: a session with unpushed work is never removed, and cost says "not reported" when it is unknown.
**Where.** `claudeMachineSessionsViewPane.ts`, `claudeMachineSessions.ts` (state, keep rules, plan), `claudeMachineSessionService.ts` (shared process), `claudeSessionActions.ts`, `media/claude.css` (`.claude-sessions-*`).
**Applies to.** The Claude Sessions view and the Show All Claude Sessions and Clean Up Finished and Idle Sessions commands.
**Since.** Issue 1251.

### DL-115 A file shows which agent is editing it
**Practice.** In the Explorer and on editor tabs a file an agent is editing right now carries a filled dot in that agent's colour (one of eight, kept for the agent's life); a file two or more agents are editing at once carries an amber `!`; a file an agent changed and nobody has looked at carries an outlined dot in the agent's colour. The hover names the agent. The outlined dot goes when the user opens the file.
**Why.** Calm: you see where the agents are without opening a chat. Honest: the dot is the agent's real state, not decoration, so it takes an accent (DL-09). Consistent: it uses the one decoration slot every file row already has.
**Where.** `claudeFileTouchDecorations.ts` (`claude.pet.color1`..`8`, `claude.pet.conflict`).
**Applies to.** Explorer rows and editor tabs.
**Since.** Issue 1176.

### DL-116 Following an agent never takes your focus
**Practice.** With Follow on (the default, setting `claude.editor.followAgentEdits`) a file an agent starts editing opens in a preview tab with the keyboard focus left where it was. If you are typing in a text field or editor at that moment, nothing opens; a "Claude is editing X" item appears at the left of the status bar instead, and selecting it opens the file. The item goes when the agent stops editing that file.
**Why.** Calm: the editor follows the work without interrupting yours. Consistent: one status bar item, the same place as other Claude status (DL-09).
**Where.** `claudeFollowAgentEdits.ts`, `claudeFollowAction.ts` (the rule).
**Applies to.** The editor area and the status bar.
**Since.** Issue 1176.

### DL-121 A file Claude cannot read wears a slashed circle in the Explorer
**Practice.** A file or folder that matches the block list (`~/.klawly/claude/read-rules`, gitignore syntax) or a project's `Read(...)` deny entries gets a muted, slashed-circle mark in the Explorer, with a hover that names the rule and where it came from. The block holds in every approval mode, Allow Everything included. The setting `claude.privacy.explorerDecorations` (on by default) turns the marks off. The sandbox layer under the block is best effort and applies only while the sandbox is on.
**Why.** Honest: you see what Claude cannot read before you ask it. Calm: a muted foreground, not a loud hue, since this is a standing fact (DL-09).
**Where.** `claudeReadRulesDecorations.ts`, `claudeReadRules.ts` (the matcher), `claudeToolPolicy.ts` (the enforcement).
**Applies to.** The Explorer.
**Since.** Issue 458.

### DL-119 An agent's change grows in a view beside your work
**Practice.** With Follow on and `claude.editor.followAgentEditsDiff` on (off by default), a diff of what an agent changed in a file opens beside the editor and grows with each Edit, MultiEdit or Write call. It is a preview tab, takes no focus, and opens nothing while you are typing (DL-116).
**Why.** Calm: you see the file take shape without losing your place. Focused: the agent's change sits apart from your own editing.
**Where.** `claudeLiveDiffView.ts`, `claudeLiveDiff.ts` (the hunks).
**Applies to.** The editor area, beside the active group.
**Since.** Issue 1367.

### DL-117 A hand-off to another project is a card, and the other chat says who it is from
**Practice.** When the agent hands a request to another project's chat (`klawly_department`), the sending chat shows a card instead of a tool row: "Handed to <project>", the brief in two muted lines, and the state in plain words (Handing over, Delivered, Pick a project, Failed with the reason). The receiving chat's first message starts with a muted "From <project>" line, then the request. There is no Stop: a hand-off is not a worker and nobody waits for a reply.
**Why.** Calm: you see the request leave and where it landed without opening the other chat. Honest: the state is the real result of the tool call, and a failure says why.
**Where.** `claudeDepartmentCard.ts` (data), `claudeDepartmentCardView.ts`, `claudeTimelineRenderer.ts`, `claude.css` (`.claude-department-card`, `.claude-handoff-from`).
**Applies to.** The chat timeline.
**Since.** Issue 1177.

### DL-121 Hand-offs are a timeline, unread ones show a dot, and Switch Project Window counts them
**Practice.** The Departments group (DL-118) lists chats other projects handed work to by hand-off time, newest first, waiting ones still on top. A hand-off nobody has opened has a dot and a bold title, and an outlined count next to the "waiting" count in the group header. Opening the chat clears it, in every window. "Switch Project Window..." lists the open projects, then the recent ones, each with its unread hand-offs, most unread first.
**Why.** Calm: after a hand-off you see where it landed and what is new without opening each chat. Consistent: the dot and outlined count are the unread shapes the rest of the list uses; the state is kept app-wide, so the target project's window shows it too.
**Where.** `claudeDepartmentInbox.ts`, `claudeAgentsList.ts`, `claudeAgentsColumn.ts`, `claudeProjectSwitcher.ts`, `claude.css` (`.claude-agents-unread-dot`, `.is-unread`).
**Applies to.** The agents column and the command palette.
**Since.** Issue 1459.

### DL-120 A maker sees a Maker badge, and one click previews the normal-user experience
**Practice.** When the signed-in GitHub account has admin or maintain access to the Klawly repository, a "Maker" badge sits with the session switches in the composer and Claude is told how to work on Klawly itself. One click turns the badge into a dashed "Previewing as user" badge and Klawly behaves as it does for everyone else; another click brings Maker mode back. Normal users and signed-out users see neither the badge nor the Maker prompt section.
**Why.** Honest: the mode is always visible while it is on. Calm: the maker can check what users get without signing out. The role is checked with the account's own token and again every 24 hours, and nothing secret rides on it.
**Where.** `claudeMakerService.ts`, `claudeSessionSwitches.ts` (`.is-maker`), `claudePermissions.css`, `claudeMakerPrompt.ts`.
**Applies to.** The composer toolbar.
**Since.** Issue 1184.

### DL-118 Chats other projects handed work to are one Departments group, waiting on you first
**Practice.** The agents column pins a "Departments" group above the day groups. It lists every chat whose first message is a hand-off from another project (DL-117), the ones waiting on you first, then the rest by recency. The group title carries a count badge of the chats waiting on you, and the badge's hover text says "{0} waiting on you". The group is absent when no chat was handed work. A hand-off chat is listed only here, not again under its day.
**Why.** Calm: one place to see which handed-over chats need you, without scanning every day group. Consistent: the same group, row and badge shapes as projects and automations.
**Where.** `claudeAgentsList.ts` (`groupClaudeAgentRows`), `claudeAgentsColumn.ts`, `claude.css` (`.claude-agents-section-badge`).
**Applies to.** The agents column.
**Since.** Issue 1177.
