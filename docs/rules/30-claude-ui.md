---
description: Rules for Klawly native AI UI (Agent pane, composer, cards, inline edit, review, plan, background agents)
globs: src/vs/workbench/contrib/claude/**,src/vs/workbench/contrib/claudeBackground/**
alwaysApply: false
---

# Native AI UI (`src/vs/workbench/contrib/claude*`)

## Construction (§10, §43, §44)
- Build with native workbench DOM (`dom.$`, `append`) and Code - OSS widgets: `ViewPane`, `ScrollableElement`, `ActionBar`, `InputBox`, quick pick, the Markdown renderer, and the diff editor.
- **No React, no webview** for the Agent pane, composer, or cards.
- Register everything from `claude.contribution.ts`:
  - view container `workbench.view.claude` in `ViewContainerLocation.AuxiliaryBar`
  - the `claude.agentView` and session-history views
  - commands, menus, keybindings, and context keys (`claudeContextKeys.ts`)
  - editor contributions
- Do not replace the editor with a custom Monaco instance. The existing editor area is the product editor.

## Styling (§42)
- Follow the practices in `design/LANGUAGE.md` and cite their IDs (`DL-NN`) in the code that applies them; add a practice when you make a decision none covers (rule 37).
- Put CSS in `browser/media/claude.css` and use `var(--vscode-*)` theme tokens only. No hard-coded colors except as a fallback inside `var()`.
- Must work in dark, light, and high-contrast themes, and must respect reduced motion.
- Use the Klawly mark (`resources/klawly/`) or codicons. Never use another product's assets, and never Anthropic's coral or mascot.
- Use the shared primitives from Phase 32 (menu, submenu, search row, key chip, split button, pill, toggle, badge, value row, hover card). Every Claude menu uses `browser/widgets/claudePopoverMenu.ts`, not a one-off context view.

## Timeline and streaming (§15, §16, §52)
- Render from the reducer's view state. Coalesce `assistant.delta` and repaint at `requestAnimationFrame` cadence.
- Never dump raw JSON or Claude terminal output. Show a concise activity line instead ("Reading src/x.ts").
- Tool cards map by category:
  - **read** → file card
  - **search** → query + count
  - **write** → file-change card linked to review
  - **shell** → command, cwd, streamed output, exit code, Open in Terminal
  - **skill**, **mcp**, **web** → their own cards
  - **unknown** → a generic safe summary
  - **subagent** → a live card (type, task, state, tool count) that opens the subagent as its own read-only chat tab with Stop; never inline its events into the parent timeline (§16a)
- Virtualize long output and cap retained lines. Full logs go to an output channel.
- On failure, keep partial text and cards and mark the turn failed with actionable buttons (§28).

## Composer and context (§11, §13, §27)
- Enter sends (configurable), Shift+Enter inserts a newline, `@` opens the context picker, `/` opens slash commands grouped as Claude commands, Skills, and IDE commands.
- Support drag and drop from Explorer and pasted images.
- Pasting lines copied in a Klawly editor inserts a `path:start-end` selection chip, not the code. `Cmd/Ctrl+Shift+V` always pastes plain text. Dropped files become path chips, never inlined contents (§34a).
- Buttons and menus that mean an action (Review changes, Fix problems, Generate commit message…) go through `IClaudeActionService`, never a hand-built prompt. The turn shows which command, skill, or template ran (§34a).
- The model picker shows only enabled models from the runtime, without Claude Code's `default` alias. An alias the runtime names by family alone ("Opus") is named with the version it resolves to ("Opus 5.5"); that formats runtime data and invents nothing. Never hardcode or invent model names. A new agent starts on `claude.models.default`, else the model last picked, else the model the runtime default resolves to; the picker never reads "Default" (§34b).
- Effort, Ultracode, fast mode, 1M context and thinking are offered only when the current model's runtime `ModelInfo` supports them (`supportedEffortLevels`, `supportsFastMode`, a `[1m]` variant, `supportsAdaptiveThinking`). Changes apply live through the session's `setSessionSettings`. The effort menu has no Default row: a session always sends an explicit effort (its pick, else `claude.models.effort`, else the last effort picked, else Medium, fitted to the model). Max and Ultracode are never persisted or remembered. The permission section of the mode menu lists only SDK permission modes.
- Every user turn offers **Show sent prompt** (redacted) (§34c).
- Chats are context too: `@` Chats, or drag a history row, chat tab, subagent, or turn into the composer to make a `chat` chip. Send a summary plus a redacted transcript file path, never the raw transcript by default (§26a).
- Chips can be removed and show their resolved source and range on hover. Stale selections show a warning.
- Picker providers are cancellable on every keystroke. First results should appear in under 100 ms.
- While a turn runs, the composer stays usable: Send becomes **Queue**, and **Steer now** sits in a dropdown.

## Inline edit and diffs (§21, §22)
- `ClaudeInlineController` is an `IEditorContribution`. The widget is anchored at the selection.
- Show the diff with decorations and view zones, not HTML copies. Provide an Accept/Reject toolbar and hunk navigation.
- Wrap accepted and rejected operations in undo stops.
- Multi-region or multi-file edits move to the full review pane.

## Commands and keybindings (§45)
- Use `registerAction2` with `localize2` titles. Include every command listed in §45.
- Resolve conflicts with core bindings deliberately, and provide the Klawly Keys preset (`claude.keybindings.klawlyKeys`).
- Every action must also be reachable from menus or the command palette.

## Accessibility (§49)
- Provide ARIA labels, `role="log"` with `aria-live="polite"` on the timeline, and batched announcements (sentences, not tokens).
- Full keyboard navigation and visible focus. Cards expand with the keyboard. Permission cards trap focus and are announced.
- Never encode meaning by color alone.

## Hard limits (§77)
- UI components never write files, spawn processes, or import the SDK. They call workbench services.
- Sanitize all rendered Markdown and MCP content.
