---
title: "Klawly: Claude Code IDE"
subtitle: "Single Master Build Plan (Phases 1-26) - Forked Code - OSS Desktop Product"
author: "Implementation blueprint"
date: "2026-10-01"
---

# Klawly: the Claude Code IDE

## Single Master Build Plan (Phases 1-26)

**This is the only implementation plan.** The product is a **fork of Code - OSS** that becomes its own desktop IDE. It is not a VS Code extension, not a Claude Code extension, not a web wrapper, and not a terminal skin. The shipped application is a native Electron desktop IDE with the full class of interaction users expect from a modern AI IDE: editor, file tree, tabs, terminal, Git, debugger, search, Problems, AI chat/agent pane, inline edits, diffs, accept/reject, checkpoints, context attachments, planning, parallel agents, and autocomplete. Claude Code is the agent engine beneath that experience.

The final deliverables are installable desktop applications for:

- Windows x64 and ARM64;
- macOS Apple Silicon and Intel, with a universal build if desired;
- Linux x64 and ARM64, distributed as archive plus `.deb`, `.rpm`, and AppImage where practical.

The final product must boot and function without the user ever opening a separate Claude terminal. The IDE discovers or installs the Claude Code runtime, performs the supported Claude authentication flow, starts Claude sessions itself, translates IDE state into Claude input, translates Claude events into native IDE UI, and controls changes through IDE-owned review/checkpoint logic.

---

# 1. Non-negotiable product contract

The architecture is fixed:

```text
User
  |
  v
Forked Code - OSS desktop IDE
  |
  +-- normal IDE systems
  |     Explorer / editor / tabs / terminal / Git / debug / search / LSP
  |
  +-- Klawly AI systems written into the fork
        Chat / Agent / Ask / Plan / inline edit / Tab / review / checkpoints
  |
  v
IDE-to-Claude orchestration layer
  |
  +-- context resolver
  +-- prompt/input compiler
  +-- permission policy
  +-- session manager
  +-- event normalizer
  +-- patch/checkpoint manager
  +-- terminal bridge
  +-- worktree/background-agent manager
  |
  v
Claude Agent SDK / Claude Code process
  |
  v
Claude model + Claude Code tools
```

There is **no extension architecture for our AI feature**. The AI code is part of our fork under `src/vs/platform/...`, `src/vs/workbench/services/...`, and `src/vs/workbench/contrib/...`. Extensions remain a normal end-user capability of the IDE because a serious IDE needs language tooling, debuggers, themes, and ecosystem packages, but the Claude integration itself is first-party core product code.

The work split is also fixed:

- **Code - OSS owns editor infrastructure.** We reuse its editor, files, SCM, debug, terminal, language-server, workspace, keybinding, command, storage, lifecycle, accessibility, and extension-host systems.
- **Claude Code owns agent reasoning and coding tool use.** We do not reimplement Claude's model loop.
- **Our code owns the product experience.** We decide what context is sent, when Claude runs, how permissions appear, how file edits are captured, how diffs are reviewed, how checkpoints work, how sessions are displayed, and how every Claude event maps to the IDE.

A successful build feels like a polished IDE with Claude inside it. A failed build feels like a chat box connected to a terminal. Every design choice in this document is intended to prevent the latter.

---

# 2. Legal and platform boundaries that affect the architecture

The Code - OSS repository is MIT licensed. The Microsoft-branded Visual Studio Code distribution is not the thing we copy. The fork must use its own product name, icons, bundle identifiers, installer IDs, URLs, update service, telemetry endpoints, and branding. Microsoft also states that third-party Code - OSS forks are not permitted to use the Visual Studio Marketplace. Therefore the shipped product must use an allowed extension registry such as Open VSX, a private registry, or direct VSIX installation. This is an ecosystem constraint, not a reason to change the IDE architecture.

Do not copy any other product's source, private assets, trademarks, logos, screenshots, or exact proprietary artwork. Reproduce the **interaction model**: right-side agent panel, composer behavior, file/context chips, inline prompts, diff review, tool cards, checkpoints, and familiar keyboard flows. Use our own product name, visual tokens, icons, copy, and implementation.

Claude authentication is a separate concern from the UI. Anthropic currently documents Claude Code access through paid Claude plans in supported Claude Code/IDE usage, but Anthropic also states that developers building third-party products should use supported developer authentication and must not misrepresent their application's identity or route third-party traffic improperly against subscription limits. Therefore this product must invoke official Claude Code/Agent SDK components honestly and must never spoof the official Claude app. The backend service is isolated so the allowed authentication mode can change without changing the IDE.

**Release gate:** before public distribution, verify Anthropic's then-current Claude Code/Agent SDK commercial/authentication terms. The technical architecture does not depend on bypassing them.

---

# 3. Final repository layout

Use a fork of `microsoft/vscode` as the repository root. Do not keep our core feature in a separate extension repository.

```text
claude-ide/
+- build/                              # inherited Code - OSS build system + our release tasks
|  +- darwin/
|  +- linux/
|  +- win32/
|  +- claudeide/                       # our signing/update/manifest helpers
+- resources/
|  +- claudeide/                       # icons, installer art, product assets
+- src/vs/platform/claude/
|  +- common/
|  |  +- claude.ts                     # service contracts
|  |  +- claudeProtocol.ts             # normalized events/messages
|  |  +- claudeContext.ts              # attachment types
|  |  +- claudePermissions.ts          # policy model
|  |  +- claudeStorage.ts              # persistence DTOs
|  +- node/
|  |  +- claudeAgentRunner.ts          # Agent SDK integration
|  |  +- claudeRuntime.ts              # installation/version/auth detection
|  |  +- claudeStreamNormalizer.ts     # SDK -> normalized events
|  |  +- claudeProcessRegistry.ts      # running sessions
|  |  +- claudeToolPolicy.ts           # host-side permission enforcement
|  +- test/
+- src/vs/workbench/services/claude/
|  +- common/
|  |  +- claudeAgentService.ts
|  |  +- claudeSessionService.ts
|  |  +- claudeContextService.ts
|  |  +- claudeCheckpointService.ts
|  |  +- claudeReviewService.ts
|  |  +- claudeAutocompleteService.ts
|  |  +- claudeBackgroundAgentService.ts
|  +- browser/
|  +- electron-browser/
+- src/vs/workbench/contrib/claude/
|  +- browser/
|  |  +- claude.contribution.ts
|  |  +- claudeCommands.ts
|  |  +- claudeContextKeys.ts
|  |  +- chat/
|  |  |  +- claudeViewPane.ts
|  |  |  +- claudeTimeline.ts
|  |  |  +- claudeComposer.ts
|  |  |  +- claudeContextPicker.ts
|  |  |  +- claudeMarkdownRenderer.ts
|  |  |  +- cards/
|  |  |     +- fileToolCard.ts
|  |  |     +- commandToolCard.ts
|  |  |     +- searchToolCard.ts
|  |  |     +- permissionCard.ts
|  |  |     +- agentStatusCard.ts
|  |  +- inline/
|  |  |  +- claudeInlineController.ts
|  |  |  +- claudeInlineWidget.ts
|  |  |  +- claudeInlineDiff.ts
|  |  +- review/
|  |  |  +- claudeReviewPane.ts
|  |  |  +- claudeFileChange.ts
|  |  |  +- claudeHunkActions.ts
|  |  +- plan/
|  |  |  +- claudePlanView.ts
|  |  |  +- claudeTodoRenderer.ts
|  |  +- autocomplete/
|  |  |  +- claudeInlineCompletions.ts
|  |  |  +- claudeCompletionCache.ts
|  |  +- media/
|  |     +- claude.css
|  |     +- claudeIcons.css
|  +- test/
+- src/vs/workbench/contrib/claudeBackground/
|  +- ...                               # worktree/background session UI
+- src/vs/code/electron-main/
|  +- ...                               # minimal wiring only
+- test/claude/
|  +- unit/
|  +- integration/
|  +- e2e/
|  +- fixtures/
+- product.json                         # our product identity
+- product.overrides.json               # generated release-specific values
+- package.json
```

Keep modifications to heavily edited upstream files small. New functionality should live in new directories and register itself through existing contribution/service registries. This is what makes monthly upstream merges survivable.

---

# 4. Bootstrap the fork and prove native builds before AI work

The first code task is not Claude. The first task is proving that the fork builds, runs, and can be packaged on every target OS.

## 4.1 Fork and remotes

```bash
git clone git@github.com:<your-org>/claude-ide.git
cd claude-ide
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream
```

Keep `main` releaseable. Use a long-lived `upstream-base` tag/branch only to record the Microsoft revision currently integrated; do not develop features there.

## 4.2 Toolchain

Use the exact Node version in Code - OSS `.nvmrc`. At the time of this plan, the current contribution guide requires a modern Node 22-class toolchain, Python for `node-gyp`, and native C/C++ tooling. On Windows install Visual Studio 2022 Build Tools with Desktop Development with C++; on macOS install Xcode command-line tools; on Debian-family Linux install the documented X11, keyboard, secret-store, Kerberos and build packages.

```bash
npm install
npm run watch
```

Run development desktop:

```bash
# macOS / Linux
./scripts/code.sh

# Windows
.\scripts\code.bat
```

Do not begin AI work until all three CI operating systems can at least compile the unmodified fork.

## 4.3 Product identity

Replace Code - OSS identity immediately in `product.json`:

```json
{
  "nameShort": "YourIDE",
  "nameLong": "YourIDE",
  "applicationName": "youride",
  "dataFolderName": ".youride",
  "sharedDataFolderName": ".youride-shared",
  "win32MutexName": "youride",
  "win32DirName": "YourIDE",
  "win32NameVersion": "YourIDE",
  "win32RegValueName": "YourIDE",
  "win32AppUserModelId": "YourCompany.YourIDE",
  "darwinBundleIdentifier": "com.yourcompany.youride",
  "linuxIconName": "youride",
  "urlProtocol": "youride"
}
```

Generate new GUIDs for every Windows AppId. Replace icons under the platform resource directories. Replace issue/report URLs. Remove Microsoft-specific telemetry keys and service URLs that do not belong in the fork.

**Acceptance test:** installing YourIDE alongside VS Code must not overwrite VS Code settings, mutexes, protocol handlers, app data, or shortcuts.

---

# 5. Build the Claude runtime as a core platform service

The renderer/workbench must not spawn arbitrary agent processes directly. Treat Claude as a privileged platform service. The workbench calls a typed service; the service launches and supervises the Claude runtime in the Node-capable process boundary.

Create `src/vs/platform/claude/common/claude.ts`:

```ts
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IClaudeRuntimeService = createDecorator<IClaudeRuntimeService>('claudeRuntimeService');

export interface IClaudeRuntimeService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeRuntimeState: Event<ClaudeRuntimeState>;
  readonly onDidEmitEvent: Event<NormalizedClaudeEvent>;

  getRuntimeState(): Promise<ClaudeRuntimeState>;
  ensureRuntime(): Promise<ClaudeRuntimeState>;
  begin(request: BeginClaudeRequest): Promise<ClaudeRunHandle>;
  send(sessionId: string, input: ClaudeUserInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  disposeSession(sessionId: string): Promise<void>;
}

export interface ClaudeRuntimeState {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  authMode?: 'claude-account' | 'api-key' | 'enterprise' | 'unknown';
  error?: string;
}
```

The important design rule is that `IClaudeRuntimeService` is the only thing the workbench knows about the agent engine. UI components never import `@anthropic-ai/claude-agent-sdk` directly.

---

# 6. Runtime discovery, installation, and authentication

The IDE needs a deterministic onboarding state machine:

```text
APP START
  -> detect Claude runtime
     -> found: inspect version
     -> missing: show Install Claude button
  -> inspect authentication
     -> signed in: Ready
     -> not signed in: Sign in button
  -> start user session
```

Create `claudeRuntime.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function probeClaude(binary = 'claude'): Promise<{version: string} | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], {
      timeout: 5000,
      windowsHide: true
    });
    return { version: stdout.trim() };
  } catch {
    return undefined;
  }
}
```

Do **not** scrape credentials from Claude files. Authentication should be initiated through supported Claude flows. If the Agent SDK exposes the needed authentication/session state, use that. Otherwise launch the official `claude` login flow in a controlled integrated terminal or external browser and re-probe state afterward.

The IDE stores only its own metadata such as `runtimePath`, last-known version, and UI state. Claude credentials remain owned by Claude's supported credential store.

Onboarding UI:

```text
+------------------------------------------------+
| Claude is required to power YourIDE Agent.     |
|                                                |
| [Install Claude Code]                          |
|                                                |
| Already installed? [Detect again]              |
+------------------------------------------------+
```

After runtime detection:

```text
+------------------------------------------------+
| Claude Code found: vX.Y.Z                      |
|                                                |
| [Sign in to Claude]                            |
+------------------------------------------------+
```

Never fake an authenticated state. If Claude returns an auth error, surface it directly and offer the supported sign-in action.

---

# 7. Use the Claude Agent SDK as the primary agent transport

The main implementation uses `@anthropic-ai/claude-agent-sdk` inside the privileged runtime service. The SDK is preferable to terminal scraping because it exposes structured messages, session semantics, tools, permissions, hooks, and other Claude Code capabilities while still running the Claude Code agent system.

Create `claudeAgentRunner.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeAgentRunner {
  async run(req: AgentRunRequest, sink: (e: NormalizedClaudeEvent) => void): Promise<void> {
    for await (const message of query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        settingSources: ['user', 'project'],
        maxTurns: req.maxTurns,
        allowedTools: req.allowedTools,
        permissionMode: 'default',
        resume: req.resumeSessionId,
        additionalDirectories: req.additionalDirectories,
        canUseTool: async (toolName, input, context) => {
          return req.permissionBridge.request({ toolName, input, context });
        }
      }
    })) {
      sink(normalizeClaudeMessage(message));
    }
  }
}
```

Do not hard-code the raw SDK message shapes throughout the app. Immediately normalize them into our stable product protocol.

The SDK configuration should preserve project/user Claude settings and `CLAUDE.md` behavior rather than inventing a parallel rule format unless we need UI-specific metadata.

---

# 8. Define the IDE-owned normalized event protocol

This protocol is the heart of the translation layer. It prevents UI code from being coupled to Claude SDK revisions.

Create `claudeProtocol.ts`:

```ts
export type NormalizedClaudeEvent =
  | { type: 'session.started'; sessionId: string; model?: string }
  | { type: 'assistant.delta'; sessionId: string; text: string }
  | { type: 'assistant.completed'; sessionId: string; text: string }
  | { type: 'tool.started'; sessionId: string; call: ToolCall }
  | { type: 'tool.updated'; sessionId: string; callId: string; update: unknown }
  | { type: 'tool.completed'; sessionId: string; callId: string; result: ToolResult }
  | { type: 'permission.requested'; sessionId: string; request: PermissionRequest }
  | { type: 'file.beforeWrite'; sessionId: string; uri: string; before: string | null }
  | { type: 'file.afterWrite'; sessionId: string; uri: string; after: string | null }
  | { type: 'todo.changed'; sessionId: string; items: TodoItem[] }
  | { type: 'usage.changed'; sessionId: string; usage: UsageInfo }
  | { type: 'session.compacted'; sessionId: string; info?: unknown }
  | { type: 'session.failed'; sessionId: string; message: string }
  | { type: 'session.completed'; sessionId: string };

export interface ToolCall {
  id: string;
  name: string;
  category: 'read' | 'write' | 'search' | 'shell' | 'web' | 'skill' | 'mcp' | 'other';
  input: unknown;
  display: ToolDisplayModel;
}
```

The normalizer converts Claude-specific tool names and message variants into stable UI categories. Example:

```ts
export function classifyTool(name: string): ToolCall['category'] {
  if (name === 'Read') return 'read';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return 'write';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'Bash') return 'shell';
  if (name === 'Skill') return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}
```

Persist normalized events, not the raw stream, as the primary UI session log. Optionally retain raw events in debug logs behind an explicit developer setting.

---

# 9. Session model and lifecycle

Klawly needs durable conversations that can be stopped, resumed, renamed, and reopened after app restart.

```ts
export interface IdeAgentSession {
  id: string;                 // our ID
  claudeSessionId?: string;   // Claude/SDK resume ID
  workspaceId: string;
  title: string;
  mode: 'agent' | 'ask' | 'plan';
  createdAt: number;
  updatedAt: number;
  status: 'idle' | 'running' | 'waiting-permission' | 'failed' | 'complete';
  turns: AgentTurn[];
  checkpointIds: string[];
  worktree?: WorktreeDescriptor;
}
```

Use the IDE storage service for indexes and metadata. Store larger event transcripts in a dedicated product data directory:

```text
<userData>/agent-sessions/<session-id>/
  session.json
  events.jsonl
  checkpoints/
  attachments/
```

Write JSONL append-only during execution so a crash does not corrupt the entire history. Compact into canonical JSON on clean close.

Session controller:

```ts
export class ClaudeSessionController {
  private sessions = new Map<string, RunningSession>();

  async start(req: StartIdeSessionRequest): Promise<string> { /* ... */ }
  async send(sessionId: string, input: UserComposerInput): Promise<void> { /* ... */ }
  async interrupt(sessionId: string): Promise<void> { /* ... */ }
  async resume(sessionId: string): Promise<void> { /* ... */ }
  async fork(sessionId: string, fromTurnId: string): Promise<string> { /* ... */ }
}
```

The UI session ID remains stable even if the Claude runtime changes its own identifier after compaction/fork behavior.

---

# 10. Implement the AI pane as a native workbench contribution

Register a dedicated view container on the right side. This is core workbench code, not a webview extension.

`claude.contribution.ts` should register:

- view container;
- Agent view;
- session history view;
- commands;
- keybindings;
- menu entries;
- context keys;
- editor contributions for inline actions;
- services.

Conceptual registration:

```ts
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry)
  .registerViewContainer({
    id: 'workbench.view.claude',
    title: localize2('claude', 'Agent'),
    icon: Codicon.sparkle,
    order: 100,
    ctorDescriptor: new SyncDescriptor(ViewPaneContainer)
  }, ViewContainerLocation.AuxiliaryBar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
  {
    id: 'claude.agentView',
    name: localize2('claudeAgent', 'Agent'),
    ctorDescriptor: new SyncDescriptor(ClaudeAgentViewPane),
    canToggleVisibility: true
  }
], container);
```

Use Code - OSS layout primitives, input controls, scrollables, action bars, keybinding service, theme service, and accessibility service. Avoid embedding a React app/webview for the primary pane because that creates focus, keyboard, theme, accessibility, drag/drop, context-menu, and performance inconsistencies.

The pane owns three zones:

```text
+-------------------------------------+
| Session title   Mode   Model   ...  |
+-------------------------------------+
|                                     |
| scrollable timeline                 |
| user messages                       |
| assistant streaming                 |
| tool cards                          |
| diff summaries                      |
| permission cards                    |
| todos                               |
|                                     |
+-------------------------------------+
| context chips                       |
| [file.ts] [selection] [errors]      |
| +---------------------------------+ |
| | Ask Claude...                   | |
| |                                 | |
| +---------------------------------+ |
| [Agent v]                 [Send]    |
+-------------------------------------+
```

---

# 11. Build the composer and context-chip system

The composer is not a plain textbox. It must support multiline text, keyboard send behavior, `@` references, slash commands, drag/drop, pasted files/images where supported, and attached IDE context.

Data model:

```ts
export interface ComposerState {
  text: string;
  mode: AgentMode;
  attachments: ContextAttachment[];
  queued: ComposerSubmission[];
}

export type ContextAttachment =
  | { kind: 'file'; uri: string; range?: SerializedRange }
  | { kind: 'folder'; uri: string }
  | { kind: 'symbol'; uri: string; name: string; range: SerializedRange }
  | { kind: 'selection'; uri: string; range: SerializedRange; versionId: number }
  | { kind: 'diagnostics'; uri?: string; severity?: number[] }
  | { kind: 'git-diff'; scope: 'working-tree' | 'staged' }
  | { kind: 'terminal'; terminalId: number; lines: number }
  | { kind: 'image'; localUri: string }
  | { kind: 'chat'; sessionId: string; subagentId?: string; turnRange?: [number, number]; scope: 'summary' | 'full'; asOfTurn: number };
```

Key behavior:

- `Enter`: send when composer setting says so;
- `Shift+Enter`: newline;
- `@`: open context picker;
- `/`: offer Claude-supported slash commands/skills plus IDE-local commands;
- drag file from Explorer: create file chip;
- selected code + "Add to Agent": create selection chip;
- remove chip: remove context before submission;
- hover chip: show exact resolved source/range;
- stale selection: warn and resolve against current model if possible.
- paste of lines copied in a Klawly editor: selection chip instead of code; `Cmd/Ctrl+Shift+V` pastes plain text (§34a);
- drop from outside the workspace: ask before attaching (§34a).
- drag a chat (history row, chat tab, subagent card, or a single turn) into the composer: chat chip (§26a).

Do not blindly serialize the entire project into the prompt. Attachments tell the orchestration layer what context matters; Claude Code can still use its own filesystem tools.

---

# 12. Context resolution: translate IDE state into Claude-understandable input

Each user submission becomes an `AgentEnvelope`:

```ts
export interface AgentEnvelope {
  userText: string;
  mode: AgentMode;
  workspaceRoot: string;
  activeFile?: ActiveFileContext;
  attachments: ResolvedAttachment[];
  diagnostics: DiagnosticSummary[];
  git?: GitContext;
  terminal?: TerminalContext;
  instructionFiles: string[];
}
```

Compile a concise, deterministic textual preamble only for data that Claude cannot reliably infer from `cwd` and tools:

```ts
export function compilePrompt(e: AgentEnvelope): string {
  const blocks: string[] = [];
  blocks.push(`<ide_request mode="${e.mode}">`);
  blocks.push(e.userText);
  blocks.push(`</ide_request>`);

  if (e.activeFile) {
    blocks.push(`<active_editor path="${e.activeFile.relativePath}" ` +
      `cursor_line="${e.activeFile.cursorLine}">`);
    if (e.activeFile.selection) blocks.push(e.activeFile.selection);
    blocks.push(`</active_editor>`);
  }

  for (const a of e.attachments) blocks.push(renderAttachment(a));
  if (e.diagnostics.length) blocks.push(renderDiagnostics(e.diagnostics));
  return blocks.join('\n\n');
}
```

Use explicit markers so selected code is not confused with user instructions. Escape/sanitize attachment metadata. Never treat file contents as privileged instructions from the user; they are context.

For unsaved editors, include the in-memory buffer for the attached range/file because Claude's filesystem read would otherwise see the older disk version.

---

# 13. `@` picker implementation

Pressing `@` opens a fuzzy picker anchored to the composer.

Provider groups:

```text
Files
Folders
Symbols
Open Editors
Recent Files
Git Changes
Problems
Terminal
Chats (past sessions and their subagent threads, §26a)
Documentation / URLs if web context is enabled
```

Use existing services:

- `IFileService` for files;
- `IWorkspaceContextService` for roots;
- `IOutlineModelService` / symbol providers for symbols;
- `IEditorService` for open editors;
- SCM/Git services for diffs;
- `IMarkerService` for Problems;
- terminal services for terminal context;
- search service for workspace matching.

Picker interface:

```ts
interface ContextProvider {
  id: string;
  search(query: string, token: CancellationToken): Promise<ContextCandidate[]>;
  resolve(candidate: ContextCandidate): Promise<ContextAttachment>;
}
```

Results must be cancellable on every keystroke. Limit expensive folder expansion until selected.

---

# 14. Implement Agent, Ask, and Plan as real execution modes

The mode switch changes permissions and behavior, not just prompt wording.

## Agent

Agent can read, search, edit, write, run commands, and use approved tools.

```ts
const AGENT_POLICY: SessionPolicy = {
  allowReads: true,
  allowWorkspaceWrites: 'prompt-or-auto',
  allowShell: 'prompt',
  allowNetwork: 'prompt',
  captureFileSnapshots: true
};
```

## Ask

Ask is read-only. The runtime may read/search but the IDE permission bridge denies write/shell actions that mutate the project.

```ts
const ASK_POLICY: SessionPolicy = {
  allowReads: true,
  allowWorkspaceWrites: false,
  allowShell: 'read-only-commands',
  allowNetwork: 'prompt',
  captureFileSnapshots: false
};
```

If Claude requests a write in Ask mode, return a structured denial explaining that the current IDE mode is read-only. Do not silently switch modes.

## Plan

Plan is read-only during planning and produces a structured plan artifact in the timeline. When the user presses **Build**, create or continue an Agent turn with the accepted plan as explicit context.

```ts
export interface PlanArtifact {
  title: string;
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    detail?: string;
    files?: string[];
    status: 'pending' | 'active' | 'done' | 'blocked';
  }>;
}
```

The UI renders steps as checklist rows, not merely Markdown text.

---

# 15. Stream assistant responses into the native timeline

Do not wait for the final response. Maintain a turn view model:

```ts
interface TurnViewModel {
  id: string;
  user: UserMessageModel;
  assistantText: string;
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'failed';
  cards: ToolCardModel[];
  changedFiles: ChangedFileSummary[];
}
```

On `assistant.delta`, append and schedule a render at animation-frame cadence rather than rerendering for every token. Use Code - OSS Markdown rendering/sanitization primitives. Code blocks get Copy and Insert actions. File references such as `src/foo.ts:42` become clickable editor links when safely parseable.

During execution display a compact activity line like:

```text
Reading src/auth.ts
Searching "verifyToken"
Editing 3 files
Running npm test
```

Do not dump internal JSON or the raw Claude terminal UI.

---

# 16. Tool cards: map Claude operations to Klawly UI

Every tool call becomes a native `ToolCardModel`.

```ts
export interface ToolCardModel {
  id: string;
  icon: ThemeIcon;
  title: string;
  subtitle?: string;
  state: 'running' | 'success' | 'failed' | 'cancelled';
  collapsed: boolean;
  body?: ToolCardBody;
}
```

Mappings:

- Read -> file card with path and optional range;
- Grep/Glob -> search card with query and count;
- Edit/Write -> file-change card, linked to review state;
- Bash -> command card with command, cwd, output, exit code;
- Skill -> skill card;
- MCP -> provider/tool card;
- web fetch/browser tool -> network/tool card;
- unknown -> generic tool card preserving safe summary.

Shell card should stream stdout/stderr into a virtualized text area with maximum retained line count. Full logs can be opened in an output channel.

---

# 16a. Subagent threads

Claude Code starts subagents on its own through its agent tool (built-in agents such as general-purpose, Explore and Plan; the user's `.claude/agents/*.md`; and agents Klawly passes in the SDK `agents` option). The user never types a command for this. Klawly must make each subagent visible and controllable: a card in the parent chat that opens as its own read-only chat.

Routing: every SDK message produced inside a subagent carries `parent_tool_use_id`, the id of the agent-tool call that started it. The normalizer (§8) turns that into `parentRunId` on each `ClaudeEvent`, and the reducer (§76) keeps one `ClaudeSubagentRun` per agent-tool call:

```ts
export interface ClaudeSubagentRun {
  id: string;               // agent-tool call id
  parentRunId?: string;     // nested subagents
  agentType: string;        // e.g. 'general-purpose', 'Explore', 'reviewer'
  description: string;      // the task Claude gave it
  model?: string;
  background: boolean;
  state: 'running' | 'success' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  toolCallCount: number;
  resultText?: string;      // final answer returned to the parent
}
```

Parent chat (the subagent card, Phase 14):

- shows agent type, task description, live state, elapsed time, tool-call count and the latest tool line;
- several cards can run at once (parallel subagents), grouped when Claude starts them in one turn;
- on finish the card collapses to the result summary and the parent chat continues;
- background subagents keep running after the parent turn ends; their card stays live and the parent chat shows the result when the notification arrives.

Subagent chat (click the card):

- opens as its own chat tab with the same timeline, tool cards and diffs as a normal chat, plus a breadcrumb back to the parent turn;
- live while running, read-only: there is no composer, because Claude Code does not take user messages into a running subagent;
- **Stop** on the card and in the tab stops that subagent only, when the SDK supports it; otherwise Stop interrupts the parent turn and says so (verify in Phase 4);
- after it finishes, **Continue in new chat** opens a normal chat seeded with a chat reference to it (§26a);
- the subagent chat can be dragged into a composer as a chat reference (§26a).

Permissions: requests from inside a subagent go through the same `canUseTool` bridge (§17) and the prompt names the subagent ("reviewer wants to run `npm test`"). Its file edits land in the same review and checkpoint state as the parent session (§18–20).

Klawly's own agents: Klawly may pass a small set of definitions in the SDK `agents` option (for example a read-only `reviewer` and an `explorer` with a cheaper model). They merge with the user's agents; a user agent with the same name wins. `claude.subagents.builtInAgents` turns them off.

History: subagent events are stored in the parent session's `events.jsonl` with their `parentRunId`, so reopened sessions show the same cards and subagent chats (§26).

Not the same as background agents (§29): those are separate sessions the user starts in a git worktree. Subagents are started by Claude inside a turn.

---

# 17. Permission bridge: the IDE must be the authority

Claude should request actions; the IDE decides whether they are allowed.

Permission model:

```ts
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  scope?: 'once' | 'session' | 'workspace';
}

export interface PermissionPolicy {
  readWorkspace: 'allow';
  writeWorkspace: 'ask' | 'allow';
  writeOutsideWorkspace: 'deny' | 'ask';
  shellSafe: 'allow' | 'ask';
  shellDestructive: 'ask' | 'deny';
  network: 'ask' | 'allow' | 'deny';
}
```

Classifier examples:

```ts
const destructivePatterns = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/s\b/i,
  /\bformat\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+database\b/i
];
```

Regex is only a first pass; also classify tool type, target path, workspace trust, and user settings.

Permission UI:

```text
Claude wants to run:

npm install zod

Working directory: /repo
Reason: add requested validation dependency

[Allow once] [Allow for this session] [Deny]
```

For filesystem writes outside workspace, show the absolute target. For commands that may expose secrets or modify credentials, never auto-allow.

---

# 18. Capture file changes independently of Claude's narration

Never rely on Claude saying "I edited X." The IDE must observe actual filesystem changes and snapshot content.

At beginning of every Agent turn:

1. record Git working-tree state;
2. snapshot all currently dirty editor buffers;
3. start a filesystem-change collector scoped to workspace;
4. before approved writes, capture original content when possible;
5. after tool completion, read changed content;
6. calculate diffs;
7. associate changed files with the turn.

```ts
interface FileSnapshot {
  uri: URI;
  existed: boolean;
  content: Uint8Array | null;
  stat?: { mtime: number; size: number };
}

interface TurnCheckpoint {
  id: string;
  sessionId: string;
  turnId: string;
  createdAt: number;
  files: FileSnapshot[];
  gitHead?: string;
}
```

For large/binary files, store metadata and copy the original to a checkpoint object store rather than holding it in memory.

---

# 19. Build the review system before calling the agent experience complete

Changed files appear in a dedicated review area and as an editor gutter/state decoration.

```text
Changes  4
  src/auth.ts          +24 -8
  src/middleware.ts    +10 -2
  tests/auth.test.ts   +31
  package.json          +1

[Review Next] [Accept All] [Reject All]
```

Opening a change uses the existing diff editor with:

- left: pre-turn snapshot;
- right: current working content;
- hunk decorations;
- Accept Hunk;
- Reject Hunk;
- Accept File;
- Reject File;
- Next/Previous change.

The right side is the real current working model. Rejecting a hunk applies an inverse edit against the current file, with conflict detection if the user manually changed that region after Claude.

Represent hunks:

```ts
interface ReviewHunk {
  id: string;
  uri: URI;
  originalStart: number;
  originalLength: number;
  modifiedStart: number;
  modifiedLength: number;
  originalText: string;
  modifiedText: string;
  state: 'pending' | 'accepted' | 'rejected' | 'conflicted';
}
```

Use the editor/model diff services rather than invoking `git diff` for every render. Git is still useful as an external integrity check.

---

# 20. Accept, reject, and checkpoint semantics

**Accept** means "keep current workspace content and mark this AI change reviewed." It does not automatically commit Git.

**Reject** means "restore the pre-change content for that file/hunk while preserving unrelated edits made after the checkpoint."

**Restore checkpoint** means "return the workspace to the snapshot at the checkpoint boundary," with a confirmation screen listing user changes that would be overwritten.

Checkpoint algorithm:

```ts
async function restoreCheckpoint(cp: TurnCheckpoint) {
  const conflicts = await detectPostCheckpointUserEdits(cp);
  if (conflicts.length) {
    const approved = await showRestorePreview(conflicts);
    if (!approved) return;
  }
  for (const file of cp.files) {
    await restoreSnapshot(file);
  }
}
```

Persist checkpoint objects content-addressed by SHA-256 so unchanged files across checkpoints are de-duplicated:

```text
<userData>/checkpoint-objects/ab/cdef...blob
<userData>/agent-sessions/<id>/checkpoints/<checkpoint>.json
```

Garbage collect unreferenced objects when session history retention expires.

---

# 21. Inline edit: reproduce the `Ctrl/Cmd+K` flow natively

Inline edit is a separate interaction from the side-pane Agent. It must feel immediate and local.

User flow:

1. select code or place cursor;
2. press `Ctrl+K` / `Cmd+K` or our chosen conflict-free binding;
3. small prompt widget appears at the selection;
4. user enters "make this async";
5. Claude receives only the required local context plus nearby symbols;
6. IDE shows an inline diff directly in the editor;
7. user presses Accept or Reject;
8. accepted edit becomes normal editor content and participates in undo.

Register an editor contribution:

```ts
export class ClaudeInlineController extends Disposable implements IEditorContribution {
  static readonly ID = 'editor.contrib.claudeInline';

  constructor(
    private readonly editor: ICodeEditor,
    @IClaudeAgentService private readonly claude: IClaudeAgentService,
    @IInstantiationService private readonly instantiationService: IInstantiationService
  ) { super(); }

  async start(): Promise<void> {
    const model = this.editor.getModel();
    if (!model) return;

    const selection = this.editor.getSelection();
    const widget = this.instantiationService.createInstance(ClaudeInlineWidget, this.editor, selection);
    const instruction = await widget.prompt();
    if (!instruction) return;

    await this.claude.runInlineEdit({ modelUri: model.uri, selection, instruction });
  }
}
```

Prompt envelope:

```text
<task>Modify only the target selection unless required for correctness.</task>
<file path="src/cart.ts" language="typescript">
...nearby context...
</file>
<selection start="42:1" end="59:2">
...selected text...
</selection>
<instruction>make this async and propagate errors correctly</instruction>
```

For the output, ask Claude to make the actual edit through Claude Code's editing tools rather than returning prose. The checkpoint layer captures the mutation. The inline controller then opens a localized diff decoration around the changed range.

Use editor undo stops around accepted/rejected operations so `Ctrl/Cmd+Z` behaves predictably.

---

# 22. Inline diff rendering

For small local edits, opening a full side-by-side diff is too disruptive. Render removed lines and inserted lines in-place using decorations/view zones.

```ts
interface InlineDiffModel {
  uri: URI;
  original: string;
  modified: string;
  hunks: ReviewHunk[];
}
```

Implementation pieces:

- use line/inline decorations for changed spans;
- use view zones for deleted lines that no longer exist in the current model;
- show Accept / Reject toolbar near the final changed hunk;
- allow `Alt+[ / Alt+]` or equivalent to move through hunks;
- Esc rejects/cancels only before user acceptance when configured;
- preserve syntax highlighting for inserted content through the editor itself, not HTML copies.

If the edit touches many separated regions or multiple files, transition automatically to the full review UI instead of forcing inline rendering.

---

# 23. Terminal integration and command execution

Claude Code may use Bash/shell tools. The IDE should present commands in the agent timeline and allow opening them in the actual integrated terminal.

Normalized command model:

```ts
interface CommandExecutionModel {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  output: string[];
  truncated: boolean;
}
```

UI card:

```text
> npm test
  workspace: /repo

  PASS tests/auth.test.ts
  48 tests passed

  Exit code 0                         [Open in Terminal]
```

Do not create a fake terminal emulator inside chat. Use a small log preview; "Open in Terminal" creates/focuses a normal Code - OSS terminal with the same cwd. For commands that are useful for reproducibility, provide Copy Command and Re-run actions subject to the same permission policy.

When the user explicitly asks the Agent to inspect current terminal errors, attach a bounded tail of terminal output. Do not continuously exfiltrate every terminal session into the model.

---

# 24. Diagnostics, compiler errors, and Problems integration

The product should close the loop between edits and IDE diagnostics.

Use `IMarkerService` to collect current Problems after a tool/edit batch. Create a compact diagnostic context:

```ts
interface DiagnosticSummary {
  uri: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  source?: string;
  code?: string;
  message: string;
}
```

After Claude completes a code-changing turn:

1. wait briefly for language services/build watchers to settle;
2. collect new errors in files Claude touched;
3. show "3 new problems" in the change summary;
4. optionally offer **Fix Problems** which sends those exact diagnostics as the next turn;
5. if automatic verification is enabled, let Claude inspect/fix errors within a bounded additional turn budget.

Do not automatically loop forever. Configure a hard maximum number of verify/fix cycles.

---

# 25. Git integration

Reuse Code - OSS SCM UI. Our AI layer adds context and agent-aware actions rather than replacing Git.

Features:

- `@Git Changes` context attachment;
- Ask Claude about selected diff;
- Generate commit message from staged diff;
- Explain selected commit/diff;
- Agent-created files marked in review UI;
- checkpoint restoration aware of Git state;
- parallel agents use Git worktrees;
- optional **Commit accepted changes** action after review.

Never commit automatically after an Agent turn unless the user explicitly enabled that behavior.

Git context structure:

```ts
interface GitContext {
  branch?: string;
  head?: string;
  stagedPatch?: string;
  workingPatch?: string;
  untrackedPaths: string[];
}
```

Truncate giant diffs and include paths/stat summaries. Claude can open the files itself.

---

# 26. Session history, resume, branch, rename, and export

The left/top of the Agent pane needs a session switcher equivalent to modern AI IDE history.

Each history row contains:

- generated/user-edited title;
- workspace name;
- updated timestamp;
- mode;
- running indicator;
- worktree/background badge where applicable.

Actions:

```text
Open
Rename
Duplicate / Fork from turn
Export transcript
Delete
Reveal worktree
```

Export format should be Markdown plus a machine-readable JSON option. Do not include hidden secrets from raw environment/tool inputs. Export only user-visible messages/tool summaries unless the user explicitly selects a developer/raw export.

Resume behavior:

```ts
async function resumeSession(s: IdeAgentSession) {
  if (!s.claudeSessionId) throw new Error('No resumable Claude session');
  await runtime.begin({
    cwd: workspaceRoot,
    resumeSessionId: s.claudeSessionId,
    prompt: buildResumePrompt(s)
  });
}
```

If Claude's session cannot resume because of version/auth changes, preserve the IDE transcript and offer **Continue in new session**, providing a compact conversation summary plus explicit current workspace context.

---

# 26a. Chat references: mention a chat as context

Users can use another chat as context, as a past-chat mention.

Ways to attach (all create a `chat` chip, §11):

- `@` picker → **Chats** group, fuzzy over titles, first message and changed files;
- drag a history row, a chat tab, or a subagent card or tab into the composer;
- drag a single turn (its header) to reference only that turn;
- **Reference in new chat** in the history row and chat tab menus;
- **Continue in new chat** on a finished subagent (§16a).

What is sent: Klawly does not paste the whole transcript. It writes a redacted Markdown export (same exporter as §26, user-visible content only) to `<userData>/agent-sessions/<id>/reference-<asOfTurn>.md`, then `compilePrompt()` adds:

```text
<chat_reference title="Fix login redirect" turns="1-14" as_of_turn="14" path="/…/reference-14.md">
Summary: <title, first user request, final assistant result, changed files, open todos; capped at claude.chatReferences.summaryChars>
</chat_reference>
```

Claude reads the full file with its own Read tool when it needs more. That path is added to `additionalDirectories` and a Read of exactly that file is auto-allowed; nothing else in `<userData>` is exposed.

Chip behavior:

- the chip shows the title, the turn range and "as of turn N"; hover shows the summary;
- the chip menu toggles **Summary** (default) and **Full transcript**; Full puts the whole redacted export inline, subject to the context budget, and the chip warns when it is large;
- referencing a running chat snapshots it at the current turn; later turns are not included;
- a deleted chat leaves the chip in an error state and the prompt omits it;
- a chat from another workspace is allowed, and the chip marks it with the workspace name;
- the reference file is deleted with its session (§26 retention) and never leaves the machine except as prompt content.

Show sent prompt (§34c) shows the `<chat_reference>` block exactly as sent.

---

# 27. Queue and steer while Agent is running

Users should not have to wait for a long tool sequence to finish before adding context.

Implement two interaction types:

- **Queue**: message is held until current agent turn completes;
- **Steer**: message is delivered at the next safe agent input boundary when supported by streaming input/session mode.

```ts
interface PendingInput {
  id: string;
  text: string;
  attachments: ContextAttachment[];
  behavior: 'queue' | 'steer';
  createdAt: number;
}
```

The composer remains usable during execution. Send button label changes to **Queue** by default. A dropdown permits **Steer now** if the backend supports it.

Queued items render directly above the composer and can be edited/deleted before dispatch.

---

# 28. Stop, retry, regenerate, and failure recovery

Every running turn needs a visible Stop button. Stop must invoke SDK cancellation/interrupt and terminate child work safely if cancellation fails.

Failure classes:

```ts
type AgentFailureKind =
  | 'auth'
  | 'usage-limit'
  | 'network'
  | 'runtime-missing'
  | 'runtime-version'
  | 'permission-denied'
  | 'tool-failure'
  | 'process-crash'
  | 'workspace-conflict'
  | 'unknown';
```

Map them to useful UI:

```text
Claude reached its current usage limit.
Your files are safe. The current checkpoint is preserved.

[Retry] [Open Claude status] [Close]
```

Do not erase partial assistant text/tool cards on failure. Mark the turn failed and keep its history. If writes happened before failure, they remain reviewable/rejectable.

---

# 29. Parallel/background agents using Git worktrees

To run parallel agents without corrupting one workspace, every parallel coding agent gets an isolated Git worktree.

```ts
interface BackgroundAgentTask {
  id: string;
  sessionId: string;
  repoRoot: string;
  baseRef: string;
  worktreePath: string;
  branchName: string;
  status: 'starting' | 'running' | 'waiting' | 'complete' | 'failed';
}
```

Creation:

```bash
git worktree add -b agent/<task-id> <userData>/worktrees/<repo-hash>/<task-id> <base-ref>
```

The Claude session runs with `cwd = worktreePath`. The main IDE shows a background-agent card containing:

- task name;
- status;
- files changed;
- command/test status;
- open worktree;
- review changes;
- apply/merge changes;
- stop/delete.

To apply completed changes, compute the diff/commit from the worktree and use a controlled merge/cherry-pick/replay path. If the user's main branch changed meanwhile, surface conflicts in normal merge editors.

Do not let two independent agent sessions directly write the same working directory concurrently.

---

# 30. Plan/Todo execution visualization

Claude Code/Agent SDK can expose todo/progress semantics. Normalize these into a timeline plan:

```text
Plan
[x] Inspect authentication flow
[x] Locate token validation
* Update middleware
o Add tests
o Run test suite
```

The plan is a view over agent progress, not a second scheduler. It must update from actual tool/todo events where available and mark steps complete only when evidence exists.

If the user modifies a plan item, send that change into the active session as steering context rather than editing a UI-only plan that Claude never sees.

---

# 31. Claude-powered Tab/autocomplete

Tab is latency-sensitive. The requirement remains: the completion is generated by the Claude backend, not by a separate proprietary model.

Build it as a separate service from the Agent timeline:

```ts
export interface IClaudeAutocompleteService {
  provideCompletion(input: CompletionInput, token: CancellationToken): Promise<CompletionResult | undefined>;
}

interface CompletionInput {
  uri: URI;
  languageId: string;
  prefix: string;
  suffix: string;
  recentEdits: RecentEdit[];
  relatedSnippets: CodeSnippet[];
}
```

Use a dedicated constrained Claude SDK invocation:

- no tools;
- one model turn;
- small context window;
- low-latency model available through Claude Code/SDK;
- strict output contract: replacement text only;
- aggressive cancellation when cursor moves;
- debounce around 100-200 ms after typing pause;
- cache by `(file hash, cursor position, nearby text hash)`;
- speculative prefetch after accepted edits.

Conceptual call:

```ts
for await (const message of query({
  prompt: buildCompletionPrompt(input),
  options: {
    cwd: workspaceRoot,
    maxTurns: 1,
    allowedTools: [],
    model: settings.autocompleteModel
  }
})) {
  // capture final text only
}
```

Register with the editor's inline-completion infrastructure so results render as ghost text and multi-line suggestions, not chat bubbles.

Acceptance rules:

- Tab accepts;
- Esc dismisses;
- typing through identical suggestion text advances naturally;
- no completion appears in password/secret input surfaces;
- cancellation is immediate when the document version changes;
- stale completion results are discarded.

If Claude Code cannot meet a chosen latency target on a machine/network, keep the feature correct rather than displaying stale completions. Measure actual P50/P95 and tune context/model accordingly.

---

# 32. Next-edit prediction and multi-line completion behavior

Tab completion is more than "finish the current token." Include recent edits and cursor movement so Claude can propose the likely next change.

Context builder:

```ts
interface RecentEdit {
  uri: string;
  before: string;
  after: string;
  range: SerializedRange;
  ageMs: number;
}
```

Prompt intent:

```text
You are an IDE inline completion engine.
Return only the exact text that should be inserted/replaced.
Predict the user's likely next edit from the cursor context and recent edits.
Do not explain.
Do not wrap in Markdown.
```

For cross-file next edits, do not silently mutate another file from Tab. Show a small **Next edit available in X** affordance; accepting it navigates to the target and previews the change.

---

# 33. Search and codebase understanding

Claude Code already has file search/read tools, but the IDE should provide fast product-level search and concise context.

Reuse Code - OSS text search and symbol infrastructure. Add a small metadata/index service for:

- file paths;
- language IDs;
- symbol names/ranges;
- open/recent files;
- import relationships when cheaply available;
- latest diagnostics;
- Git modified state.

Do not build a huge embeddings/vector database before it is necessary. Claude Code can search the repo. Start with deterministic IDE metadata and only add semantic indexing if measured retrieval failures justify it.

For `@symbol`, use language-server symbol providers first, because they understand the active language better than plain text search.

---

# 34. MCP and Claude skills integration

The IDE should expose the Claude capabilities users already configure rather than hiding them.

On session initialization, inspect SDK init metadata for:

- available slash commands;
- loaded skills;
- MCP servers/tools;
- model/session info.

Slash menu groups:

```text
Claude commands
  /compact
  /context
  /usage

Skills
  /code-review
  /verify
  /my-project-skill

IDE commands
  /add-selection
  /add-problems
  /review-changes
```

IDE-local slash commands execute locally; Claude commands are sent to Claude. Clearly distinguish them in the menu.

MCP tool calls use the same permission and tool-card pipeline as built-in tools. Do not render arbitrary MCP HTML inside the workbench without sanitization/sandboxing.

---

# 34a. Actions: IDE gestures map to Claude commands

Users should not have to know command names. When a button, menu item, drag, or paste already says what the user wants, Klawly sends the right thing directly. Typing `/command` still works as before.

Every gesture goes through one service instead of each feature building its own prompt:

```ts
export type AgentActionId =
  | 'addSelection' | 'explainSelection' | 'reviewChanges' | 'reviewTurnChanges'
  | 'generateCommitMessage' | 'fixProblems' | 'fixTerminalError';

export interface AgentActionRequest {
  id: AgentActionId;
  source: 'button' | 'menu' | 'keybinding' | 'drop' | 'paste' | 'palette';
  attachments: ContextAttachment[];
  args?: Record<string, string>;
}

export type ActionResolution =
  | { kind: 'claude-command'; command: string }   // e.g. '/review', listed in session init data
  | { kind: 'skill'; skill: string }              // a loaded skill whose name/description matches
  | { kind: 'prompt'; templateId: string };       // Klawly's built-in fallback prompt

export interface IClaudeActionService {
  resolve(req: AgentActionRequest): ActionResolution;
  run(req: AgentActionRequest): Promise<void>;
}
```

Rules:

- **Command first, template as fallback.** Each action lists preferred commands/skills in order. `resolve()` picks the first one that the current session's init data (§34) reports; otherwise it uses the built-in template. The button always works.
- **Clicking sends immediately.** Actions that need more input from the user (e.g. inline edit) prefill the composer or open the inline prompt instead.
- **Visible.** The user turn shows a label such as "Review changes · via `/review`", and the compiled prompt is inspectable (§34c).
- Actions still go through `compilePrompt()` and the permission policy. An action never bypasses review or permissions.
- Setting `claude.actions.preferClaudeCommands` (default `true`) turns command lookup off, always using the built-in templates.

Action table (each action is registered by the phase that owns its UI):

| Where | Action | Prefers | Fallback | Phase |
|---|---|---|---|---|
| Editor context menu, `Cmd/Ctrl+L` | Add selection to chat | (chip only) | — | H |
| Editor context menu | Explain selection | explain skill if loaded | template | H |
| Changed-files card | Review all changes | `/review`, a review skill | template + turn diff | L |
| Problems panel, lightbulb, "N new problems" | Fix with Agent | fix skill if loaded | template + diagnostics chip | O |
| Failed command card / terminal | Fix this error | — | template + terminal chip | O |
| Source Control view title | Review changes | `/review`, a review skill | template + `@Git Changes` | P |
| Commit message box | Generate commit message | commit skill if loaded | template + staged diff | P |

## Composer gestures

| Gesture | Result |
|---|---|
| Copy lines in a Klawly editor, paste into the composer | Selection chip `path:startLine-endLine` instead of the code |
| `Cmd/Ctrl+Shift+V` in the composer | Plain-text paste, never converted |
| Paste from outside Klawly | Plain text; a very long paste (configurable threshold) becomes a "Pasted text" chip |
| Drop a file/folder from Explorer, an editor tab, or the OS (inside the workspace) | File/folder chip (a path reference, not the contents). Claude reads it with its own `Read` tool. |
| Drop a file from outside the workspace | Ask: attach a copy as context, or add its folder via `additionalDirectories` |
| Paste or drop an image | Image chip |

Note: reading a file is a Claude **tool**, not a slash command, so "use the read file command" means "attach a path reference and let Claude read it."

Paste detection: on every editor copy, record `{ uri, range, versionId, hash(text) }` in a small in-memory copy tracker (keep only the latest entry). On composer paste, hash the clipboard text; if it matches, insert a selection chip. If the document changed since the copy, the chip uses the stale-selection rules of §11. No match → plain paste. Never read the clipboard outside a paste event.

---

# 34b. Model selection

Switching models must be one click.

- **Model list.** On session start, read the models the runtime supports (Agent SDK `supportedModels()` or the equivalent: re-verify the name in Phase 4, §97). Merge with Claude Code's model aliases and any custom IDs from settings.
- **Picker.** The pane header's model control (§43) opens a list of **enabled** models with name and short description. Changing it applies to the next turn of the current session (SDK `setModel()` when available; otherwise pass `model` on the next `query()` with `resume`). A keybinding cycles enabled models.
- **Settings → Models page.** Lists every model the runtime reports, each with an on/off toggle; a refresh button; "Add custom model ID"; and the default model. Disabled models are hidden from the picker but still work if set explicitly.
- **Settings keys:** `claude.models.enabled: string[]` (empty = all), `claude.models.default: string`, `claude.models.custom: string[]`, plus the existing per-feature overrides such as `claude.autocomplete.model` (§31) and `claude.inlineEdit.model`.
- **Concrete models only.** The picker leaves out Claude Code's `default` alias. A new agent starts on `claude.models.default`, else the model the user last picked (remembered across windows), else the model the runtime default resolves to, named as that model. An alias the runtime names by family alone is shown with the version it resolves to (`opus` → `claude-opus-5-5` reads "Opus 5.5").
- **Visible.** Each assistant turn records the model that produced it (`session.modelChanged` event) and shows it on hover. Never invent model names or pricing; show only what the runtime reports.
- If the runtime rejects a model (plan, region, or version), show a clear error and fall back to the default instead of failing silently.

```ts
export interface ClaudeModelInfo {
  id: string;            // value passed to the SDK
  displayName: string;
  description?: string;
  source: 'runtime' | 'alias' | 'custom';
}
```

---

# 34c. Transparency: show users what Klawly sends

Users can always see exactly what Klawly sent to Claude and what came back.

- **Show sent prompt** on every user turn (live and from history): the compiled prompt from `compilePrompt()`, the action resolution (§34a), the model (§34b), and the SDK options used (mode, allowed tools, additional directories). Secrets are redacted.
- **Session inspector**: a panel listing every event of the session in order (sent input, assistant output, tool calls and results, permission requests and decisions, errors), with filters and copy-as-JSON. It reads normalized events by default; with `claude.debug.retainRawEvents` on, it also shows the raw SDK messages.
- Redaction follows §41 and rule `40-security.mdc` everywhere in this view.

---

# 35. Project rules and `CLAUDE.md`

Claude Code already understands project/user instruction sources. Preserve them.

Add an IDE command **Open Claude Project Instructions** that locates or creates the appropriate project instruction file through the supported Claude convention. The UI may help users edit it, but the file remains ordinary project content.

Session start should use:

```ts
settingSources: ['user', 'project']
```

so Claude's established project settings/skills load. Do not silently inject a giant hidden system prompt that overrides project behavior. Our prompt compiler should only add IDE-specific context and mode boundaries.

---

# 36. Image and visual context

Where the Claude backend supports image input, allow:

- paste screenshot into composer;
- drag local image;
- attach selected browser-preview screenshot;
- attach a rendered UI region generated by the preview system.

Store copied images under the session attachment directory with a random ID. Show a thumbnail chip. The agent backend gets an SDK-supported image/content block or a local file reference only if that is the supported route.

Never upload arbitrary workspace images merely because they exist.

---

# 37. Browser preview and UI verification

An AI coding flow benefits from running a local dev server and previewing it inside the IDE.

Use a workbench editor/webview preview with strict origin isolation. Features:

- open `http://localhost:<port>`;
- refresh;
- back/forward;
- device size presets;
- screenshot current viewport;
- copy console errors;
- optional element picker that records DOM selector/text/bounds from the preview page when same-origin/instrumented permissions allow it.

Agent context actions:

```text
Add screenshot to Agent
Add console errors to Agent
Add selected element to Agent
Fix with Agent
```

The browser preview itself is not Claude. It is an IDE surface that produces structured context Claude can use.

Do not weaken Electron/webview security globally to enable preview inspection. Keep preview pages sandboxed and bridge only the explicit data required.

---

# 38. AI-generated edits must coexist with normal editor undo/redo

Every accepted local edit should create editor undo stops. Multi-file agent edits require both:

1. normal editor undo history for open models; and
2. persistent AI checkpoints for cross-file/session restore.

Why both are required:

- `Ctrl/Cmd+Z` is immediate editing behavior;
- checkpoint restore survives app restart and spans unopened files.

When the checkpoint service writes a file that is open and dirty, use text-model edit APIs when possible instead of blindly overwriting disk. If the file changed independently, open a conflict review.

---

# 39. Unsaved file handling

The agent must understand what the user currently sees even if the file is not saved.

Rules:

- active/attached unsaved buffer content is included in the context envelope;
- before Claude writes a dirty file, permission/review logic must compare disk vs model versions;
- write application goes through the editor text model if it is the canonical newer state;
- never silently save every dirty editor just to let Claude read it;
- agent command execution still sees disk state, so warn when commands/tests may not include unsaved edits.

Provide setting:

```json
"claude.agent.saveBeforeCommands": "prompt"
```

Values: `always`, `prompt`, `never`.

---

# 40. Security and trust model

The product executes code. Security must be architecture, not a dialog added at the end.

Trust boundaries:

```text
Untrusted workspace files
Untrusted repository instructions
Untrusted terminal output
Untrusted MCP content
        |
        v
Claude model/tool requests
        |
        v
IDE permission policy (trusted enforcement point)
        |
        v
filesystem / shell / network
```

Requirements:

- respect Workspace Trust;
- no Agent writes/shell in an untrusted workspace until trust is granted or narrowly approved;
- canonicalize paths before permission checks;
- block traversal/symlink escapes according to policy;
- redact known secret values from logs;
- never show authentication tokens in debug output;
- sanitize rendered Markdown/HTML;
- bound command output retained in UI;
- sandbox preview webviews;
- verify update signatures;
- sign production builds;
- maintain dependency/license scanning;
- keep a user-visible permission history per session.

Path guard:

```ts
function isInsideWorkspace(target: URI, roots: readonly URI[]): boolean {
  const real = canonicalize(target);
  return roots.some(root => isEqualOrParent(real, canonicalize(root)));
}
```

Re-check after resolving symlinks for write operations.

---

# 41. Secret protection

Secrets can appear in files, environment variables, shell output, and Git diffs.

Do not indiscriminately inject process environment into prompts. The Claude process receives only the environment required for normal operation, with explicit pass-through rules.

Add an optional secret scanner before user-attached bulk content is serialized. The scanner should detect common credential formats and `.env`-like key names, then warn:

```text
This attachment appears to contain 2 secrets.
[Send anyway] [Remove secrets] [Cancel]
```

Do not claim perfect secret detection. The purpose is damage reduction.

---

# 42. UI design system: build Klawly, not a branded VS Code skin

The base workbench already supplies typography, tabs, menus, split panes, activity bar, status bar, editor chrome, quick pick, notifications, and theme variables. We keep those ergonomic foundations and design our AI surfaces to visually belong to the same application.

Create tokens in `claude.css` using VS Code theme colors rather than hard-coded RGB values wherever possible:

```css
.claude-agent-view {
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}

.claude-tool-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
}

.claude-composer {
  border: 1px solid var(--vscode-input-border, transparent);
  background: var(--vscode-input-background);
}
```

Primary surfaces to design and implement:

1. AI/Agent right sidebar;
2. session selector;
3. composer;
4. mode selector;
5. model/status selector;
6. attachment/context chips;
7. timeline user/assistant messages;
8. tool cards;
9. permission cards;
10. plan/todo card;
11. changed-files summary;
12. full review pane;
13. inline edit prompt;
14. inline diff actions;
15. Tab ghost text;
16. background agents view;
17. onboarding/login view;
18. usage/runtime status view;
19. settings pages;
20. error/limit states.

---

# 43. Exact screen composition

Default layout should resemble the productive geometry users already know from VS Code:

```text
+----------------------------------------------------------------------------+
| title bar / command center                                                 |
+----+------------------+---------------------------------+------------------+
|Act | Explorer /       | editor tabs                     | Agent            |
|bar | Search / SCM     +---------------------------------+                  |
|    |                  |                                 | timeline         |
|    |                  | source editor                   | tool cards       |
|    |                  |                                 | diffs            |
|    |                  |                                 |                  |
|    |                  +---------------------------------+                  |
|    |                  | terminal / problems / output    +------------------+
|    |                  |                                 | composer         |
+----+------------------+---------------------------------+------------------+
| status bar                                                                 |
+----------------------------------------------------------------------------+
```

Agent pane belongs in the auxiliary/right sidebar so the Explorer remains on the left. Users can move/hide it through normal workbench customization.

Do not replace the normal editor with a custom Monaco instance. The existing editor area **is** the product editor.

---

# 44. How the UI is actually made and "exported"

There is no separate "export Figma into the IDE" step that produces production-quality code. The production UI is TypeScript/CSS integrated into Code - OSS.

Use this design workflow:

1. create component mockups in Figma if desired;
2. define spacing, icon, radius, typography, and state tokens;
3. export only original vector/icon assets that we own;
4. implement layouts with Code - OSS DOM/workbench utilities and CSS;
5. bind colors to theme variables;
6. run the actual desktop IDE for every visual review;
7. capture reference screenshots for automated visual regression.

Example component shell:

```ts
export class ClaudeComposer extends Disposable {
  readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;

  constructor(container: HTMLElement) {
    super();
    this.element = append(container, $('.claude-composer'));
    this.input = append(this.element, $('textarea.claude-composer-input'));
    this.input.placeholder = 'Ask Claude...';
  }
}
```

The **finished UI is exported with the application itself** when Code - OSS is compiled and packaged. HTML/CSS/TypeScript become bundled workbench assets inside the Electron app. Icons/resources are copied into the platform packages by the build process.

---

# 45. Keyboard interaction parity

Define first-party commands and keybindings:

```ts
registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'claude.focusAgent',
      title: localize2('focusAgent', 'Focus Agent'),
      keybinding: {
        primary: KeyMod.CtrlCmd | KeyCode.KeyL,
        weight: KeybindingWeight.WorkbenchContrib
      }
    });
  }
  run(accessor: ServicesAccessor) { /* focus composer */ }
});
```

Do not blindly copy a shortcut that conflicts with essential Code - OSS commands. The product's default keymap should intentionally resolve conflicts while allowing the **Klawly Keys preset** (`claude.keybindings.klawlyKeys`).

Required commands:

```text
Focus Agent
New Agent
Open Agent History
Add Selection to Agent
Add File to Agent
Inline Edit
Accept AI Edit
Reject AI Edit
Review Next Change
Review Previous Change
Accept All Changes
Reject All Changes
Restore Checkpoint
Stop Agent
Queue Message
Cycle Model
Pick Model
Show Sent Prompt
Open Session Inspector
Open Subagent Chat
Stop Subagent
Reference Chat in Composer
Review Changes with Claude
Fix Problems with Claude
Open Background Agents
Toggle AI Autocomplete
```

All actions must also be reachable without keyboard shortcuts for accessibility.

---

# 46. Settings surface

Add a dedicated **AI / Claude** settings category using normal Code - OSS configuration registration.

Example settings:

```json
{
  "claude.agent.enabled": true,
  "claude.agent.runtimePath": "",
  "claude.agent.defaultMode": "agent",
  "claude.agent.defaultPermissionMode": "prompt",
  "claude.agent.autoApproveWorkspaceReads": true,
  "claude.agent.autoApproveWorkspaceWrites": false,
  "claude.agent.saveBeforeCommands": "prompt",
  "claude.agent.maxParallelSessions": 3,
  "claude.agent.retainSessionDays": 30,
  "claude.autocomplete.enabled": true,
  "claude.autocomplete.debounceMs": 140,
  "claude.review.openAfterAgentEdit": true,
  "claude.checkpoints.enabled": true,
  "claude.preview.enabled": true,
  "claude.telemetry.enabled": false,
  "claude.models.enabled": [],
  "claude.models.default": "",
  "claude.models.custom": [],
  "claude.inlineEdit.model": "",
  "claude.actions.preferClaudeCommands": true,
  "claude.composer.pasteAsReference": true,
  "claude.composer.longPasteChipChars": 2000,
  "claude.subagents.builtInAgents": true,
  "claude.subagents.openOnStart": false,
  "claude.chatReferences.summaryChars": 4000,
  "claude.debug.retainRawEvents": false
}
```

Models (§34b) get their own **Models** page in this category: every runtime-reported model with an on/off toggle, refresh, add custom ID, and default model.

Sensitive configuration never belongs in workspace settings if it could be committed. Credentials remain outside our settings entirely.

---

# 47. Status bar and account/runtime status

Status bar item shows only useful state:

```text
Claude: Ready
Claude: Working
Claude: Sign in
Claude: Limit reached
Claude: Runtime missing
```

Click opens a compact status menu:

```text
Claude Code vX.Y.Z
Authenticated account: <safe display if provided>
Current session model: ...
Usage/status: ...

Open Agent
Claude settings
Re-detect runtime
Sign in / Switch account
Open logs
```

Do not invent quota numbers the backend does not provide.

---

# 48. Notifications and attention management

Use native notifications sparingly:

- permission needed;
- background agent finished;
- background agent failed;
- runtime authentication expired;
- update available/restart required.

Ordinary read/search/tool progress stays inside the Agent pane. The IDE should not become a toast generator.

---

# 49. Accessibility

Every custom AI surface must meet the same bar as the rest of the workbench:

- semantic labels;
- keyboard navigation;
- visible focus states;
- screen-reader live regions for meaningful agent state changes without token-by-token spam;
- high-contrast theme support;
- reduced-motion compliance;
- no information encoded by color alone;
- accessible diff labels;
- tool cards expandable by keyboard;
- permission dialogs focus-trapped and announced.

Example:

```ts
composer.setAttribute('aria-label', 'Claude agent message');
timeline.setAttribute('role', 'log');
timeline.setAttribute('aria-live', 'polite');
```

Batch streaming announcements so screen readers receive coherent sentences rather than every token.

---

# 50. Data persistence and schema migrations

Define versioned persisted data from day one:

```ts
interface PersistedAgentDatabase {
  schemaVersion: number;
  sessions: SessionIndexRecord[];
  preferences: AgentPreferences;
}
```

Each release may migrate old metadata:

```ts
const migrations: Migration[] = [
  { from: 1, to: 2, run: migrateV1ToV2 },
  { from: 2, to: 3, run: migrateV2ToV3 }
];
```

Never make an application update destroy session/checkpoint history because a JSON field changed.

---

# 51. Logging and diagnostics

Create a dedicated output channel **Claude Agent**. Production logs include:

- runtime version;
- session lifecycle;
- normalized tool names;
- timings;
- cancellation/errors;
- update state.

Do not log:

- raw OAuth tokens;
- API keys;
- full secret-bearing environment;
- full file contents by default;
- hidden model reasoning.

Add **Developer: Export Claude Agent Diagnostics** that produces a redacted ZIP containing versions, configuration (secrets removed), event types, crash stack traces, and recent logs.

---

# 52. Performance budgets

Set budgets before optimization becomes vague.

Targets for the AI integration itself:

- no more than ~50 ms additional synchronous work on workbench startup;
- Agent pane opens immediately from cached UI state;
- no project-wide index on startup;
- context picker first results under ~100 ms for normal repos;
- streamed response repaint capped to animation-frame cadence;
- tool output virtualized after large line counts;
- file snapshots streamed/compressed for large files;
- autocomplete request cancelled immediately on edit/cursor invalidation;
- background agents isolated from renderer CPU work.

The exact network/model latency is external, so measure IDE overhead separately.

---

# 53. Extension ecosystem in the finished IDE

A real IDE needs installable language/tool extensions. Since a Code - OSS fork cannot simply use Microsoft's Visual Studio Marketplace under Microsoft's stated marketplace terms, configure an allowed registry such as Open VSX and retain **Install from VSIX**.

This is not our AI architecture; it is normal IDE functionality.

Product configuration should point the Extensions view at the selected allowed gallery. Verify compatibility for common developer extensions and maintain a small compatibility test suite.

If an extension is only licensed/served for Visual Studio family products, do not redistribute it without permission.

---

# 54. Built-in language, debug, terminal, Git, search, and editor systems

Do not rewrite these. Verify them after rebranding/upstream changes:

- Monaco editor functions;
- multi-root workspaces;
- language server extensions;
- integrated terminal;
- tasks;
- debugger;
- source control;
- global/workspace search;
- Problems;
- breadcrumbs/minimap;
- command palette;
- settings UI;
- keybindings;
- themes;
- extension host;
- remote/workspace support that is legally distributable in the fork.

The product is "full IDE" because these systems are inherited and maintained from Code - OSS, while our Claude layer integrates with them.

---

# 55. Cross-platform path, shell, and process abstractions

Never assume Bash paths in core code.

```ts
interface PlatformShellInfo {
  platform: 'win32' | 'darwin' | 'linux';
  defaultShell: string;
  pathSeparator: '/' | '\\';
}
```

Runtime runner should use process APIs with argument arrays where possible, not shell-concatenated strings. Claude's own Bash tool may abstract shell behavior internally; our permission display must still show exact requested command/cwd.

Normalize URIs through Code - OSS `URI` and file services, not manual string slicing.

Test paths containing spaces, Unicode, long Windows paths, symlinks, case-sensitive/case-insensitive collisions, and multi-root workspaces.

---

# 56. Windows product requirements

Windows release targets:

- x64 installer;
- ARM64 installer;
- portable ZIP for testing/recovery;
- Start Menu shortcut;
- optional desktop shortcut;
- "Open with YourIDE" shell integration if chosen;
- protocol handler `youride://`;
- proper uninstall;
- signed executables/installers;
- auto-update or install-on-restart flow.

Use unique AppUserModelId, uninstall registry keys, mutex names, and installer GUIDs.

Test:

- Windows 11 x64;
- Windows on ARM where available via CI/cloud hardware;
- PowerShell default terminal;
- Git Bash terminal;
- paths in OneDrive-like folders;
- non-admin install;
- upgrade over prior version;
- uninstall preserving user data unless user selects deletion.

---

# 57. macOS product requirements

macOS release targets:

- arm64 `.app`;
- x64 `.app`;
- universal app if release size is acceptable;
- DMG or signed ZIP distribution;
- Developer ID signing;
- hardened runtime as required;
- notarization;
- correct entitlements;
- `youride://` protocol;
- update flow.

CI must build on macOS runners rather than attempting to produce/sign the final macOS binary entirely from Windows/Linux.

Notarization pipeline uses Apple-issued credentials stored only in CI secrets. Never commit signing certificates/profiles.

---

# 58. Linux product requirements

Linux release targets:

- x64 tar.gz archive;
- ARM64 archive;
- `.deb`;
- `.rpm`;
- AppImage if we want a distro-independent single-file experience.

Provide `.desktop` file, icons, MIME/protocol registration where appropriate.

Test at least Ubuntu LTS and Fedora-class environments. Test Wayland and X11 where CI/environment permits.

Linux auto-update behavior must respect the packaging type. AppImage can self-replace after signature verification; `.deb`/`.rpm` builds can notify and download or rely on our package repository if we operate one.

---

# 59. Packaging the actual desktop app

Code - OSS already provides packaged build tasks. The current project documents tasks such as:

```bash
npm run gulp klawly-win32-x64
npm run gulp klawly-win32-arm64
npm run gulp klawly-darwin-x64
npm run gulp klawly-darwin-arm64
npm run gulp klawly-linux-x64
npm run gulp klawly-linux-arm64
```

Use the current upstream task names at the exact revision we track. Build scripts may evolve, so CI reads the repository's current build definitions rather than hard-coding an ancient wiki forever.

The packaged directory is the **compiled IDE**. Our TypeScript/CSS/resources are already inside it because they are part of the fork. Platform packaging then wraps/signs that directory into the installer/archive formats.

---

# 60. Product versioning

Use SemVer-style product versions and a build number:

```text
1.0.0
1.0.1
1.1.0
2.0.0
```

Embed:

- product version;
- Git commit;
- Code - OSS upstream base commit;
- Claude integration protocol version;
- build timestamp;
- release channel.

Expose in **Help -> About**.

---

# 61. Release channels

Ship at least:

```text
stable
insiders
```

Use distinct application/data identifiers for Insiders so a user can install both without collision.

Insiders receives frequent upstream/Claude integration changes. Stable receives only builds that have passed the full platform matrix.

---

# 62. Auto-update architecture

Own the update service. Do not point a fork at Microsoft's VS Code updater.

Server manifest:

```json
{
  "version": "1.2.3",
  "channel": "stable",
  "publishedAt": "2026-10-01T00:00:00Z",
  "artifacts": {
    "win32-x64": {
      "url": "...",
      "sha256": "...",
      "signature": "..."
    },
    "darwin-arm64": {
      "url": "...",
      "sha256": "...",
      "signature": "..."
    },
    "linux-x64-appimage": {
      "url": "...",
      "sha256": "...",
      "signature": "..."
    }
  }
}
```

Client flow:

```text
check manifest
 -> compare version/channel/platform
 -> download artifact to temp
 -> verify SHA-256
 -> verify product signature
 -> stage update
 -> prompt/restart based on platform
 -> apply
 -> health-check new version
 -> rollback/report on failure where feasible
```

Use HTTPS plus cryptographic artifact verification. A compromised update server must not be enough to execute an unsigned binary.

---

# 63. CI/CD matrix: how to build and test systems you do not physically own

You do not need a Mac and Linux machine on your desk to produce continuously tested builds. Use hosted CI runners for each OS, then do periodic real-device smoke testing before major stable releases.

GitHub Actions conceptual matrix:

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        target: win32-x64
      - os: macos-14
        target: darwin-arm64
      - os: macos-13
        target: darwin-x64
      - os: ubuntu-latest
        target: linux-x64
```

Separate jobs:

```text
lint
unit tests
compile
agent contract tests
workbench integration tests
UI smoke tests
package
sign
notarize (macOS)
artifact verification
release manifest generation
publish
post-publish install smoke tests
```

ARM64 Windows/Linux may require native/appropriate hosted runners or controlled cross-build support. Do not mark a platform "supported" until its actual binary has executed in a compatible environment.

---

# 64. Automated UI testing

Use the Code - OSS smoke/integration infrastructure where possible and add product-specific UI drivers. The tests should launch the real Electron application.

Critical E2E cases:

1. clean first launch;
2. open folder;
3. open Agent pane;
4. runtime missing state;
5. authenticated mocked runtime state;
6. send Ask message;
7. stream assistant response;
8. show file-read card;
9. request command permission;
10. deny permission;
11. approve permission;
12. edit file;
13. review diff;
14. reject hunk;
15. accept file;
16. restore checkpoint;
17. inline edit;
18. Tab completion;
19. resume session after restart;
20. background worktree agent;
21. update notification.

For deterministic CI, do not hit live Claude for every UI test. Feed recorded normalized event fixtures through a fake runtime service.

---

# 65. Live Claude contract tests

Separate from deterministic UI tests, run a small controlled suite against the actual installed Claude/Agent SDK on authorized CI or local environments.

Test contracts, not model wording:

- session starts and yields init metadata;
- assistant text streams;
- read tool event is recognized;
- edit/write event is recognized;
- permission callback fires;
- cancellation works;
- resume works;
- `/compact` behavior is handled;
- skills list is parsed;
- model/tool schema changes do not crash normalizer.

Record sanitized fixtures from successful runs and add them to compatibility tests.

---

# 66. Unit testing targets

High-value pure units:

```text
Claude message normalizer
context prompt compiler
path permission guard
command risk classifier
diff/hunk mapper
checkpoint object store
session JSONL recovery
schema migration
context picker ranking
autocomplete stale-result rejection
update manifest verification
version comparison
```

Example:

```ts
test('denies write outside workspace', async () => {
  const result = await policy.evaluate({
    tool: 'Write',
    path: '/tmp/outside.txt'
  });
  assert.strictEqual(result.behavior, 'deny');
});
```

---

# 67. Fault-injection testing

Simulate failures intentionally:

- Claude process exits mid-write;
- internet drops mid-response;
- workspace file changes while Claude is editing it;
- user rejects permission after long wait;
- Git worktree creation fails;
- disk becomes read-only/full;
- session log truncates mid-line;
- app crashes after snapshot but before write;
- update download corrupts;
- update signature invalid;
- old session schema loaded after upgrade;
- Claude SDK emits an unknown event type.

Desired behavior is graceful degradation, not perfect continuation.

---

# 68. Upstream Code - OSS maintenance

Maintain a small patch surface and sync deliberately.

Workflow:

```bash
git fetch upstream
git checkout main
git merge --no-ff upstream/main
npm install
npm run compile
# run entire test matrix
```

In practice, sync to known upstream release points rather than merging arbitrary daily main into stable.

Track an `UPSTREAM.md`:

```text
Current upstream commit: <sha>
Current upstream version: <version>
Integrated on: <date>
Known conflicts:
- workbench auxiliary bar registration
- product.json
- update service
```

Keep our features in newly added modules. Avoid large formatting/refactoring changes to upstream files, because those create needless merge conflicts.

---

# 69. Claude SDK/runtime compatibility management

Pin the Agent SDK version in lockfiles. Add a compatibility layer around it.

```ts
export const CLAUDE_PROTOCOL_VERSION = 1;

export interface ClaudeSdkAdapter {
  start(req: InternalRunRequest): AsyncIterable<NormalizedClaudeEvent>;
  cancel(id: string): Promise<void>;
  capabilities(): Promise<ClaudeCapabilities>;
}
```

At startup, detect installed Claude runtime version and compare against a tested range. Do not hard-block newer versions merely because they are unknown; warn and log. Hard-block only known incompatible versions.

Insiders channel should validate new Claude versions first.

---

# 70. Product analytics and privacy

The IDE can ship with no product telemetry by default during private development. If telemetry is later enabled, make it transparent and configurable.

Safe operational metrics can include:

```text
app version
OS/arch
feature invocation counts
latency buckets
crash/error codes
agent tool categories
```

Do not send source code, prompts, filenames, command contents, terminal contents, or Claude conversation text to our telemetry backend unless there is a separately disclosed opt-in diagnostic flow.

Claude itself handles data according to the user's Anthropic account/terms; our product should not silently create a second copy in our servers.

---

# 71. Crash handling

Use the existing Electron/workbench crash infrastructure where appropriate but point reports only to services we operate and disclose.

On restart after crash:

1. detect incomplete agent sessions;
2. recover JSONL events up to last valid line;
3. mark running tool calls interrupted;
4. preserve checkpoint data;
5. show "Agent session was interrupted" with Resume/Review Changes actions.

Never auto-resume a tool that may have side effects without user intent.

---

# 72. Onboarding experience

First launch should take the user from zero to coding without terminal knowledge.

Screens:

```text
Welcome to YourIDE
[Open Folder] [Clone Repository]

Claude powers the Agent features.
[Set up Claude]

Claude Code: detected / install required
Authentication: signed in / sign in

[Start Coding]
```

If Claude is missing, give a safe supported install route appropriate to the OS. If installation requires elevated privileges, explain before invoking it. Allow the user to skip Claude setup and use the non-AI IDE normally.

Once a project opens, show one unobtrusive hint pointing to the Agent pane and inline-edit shortcut.

---

# 73. Normal editor workflows must remain first-class

Klawly is still an IDE even when Claude is offline.

Validate that users can:

- edit/save files;
- install permitted extensions;
- run terminal commands;
- debug;
- use Git;
- search;
- run tasks;
- use language intelligence;
- configure settings/keybindings;
- use multiple windows/workspaces;
- recover files after crash;

without an active Claude session.

Claude integration must fail closed and locally, not make the whole editor unusable.

---

# 74. Final source-level dependency direction

Enforce this dependency graph:

```text
workbench UI
   |
   v
workbench Claude services/interfaces
   |
   v
platform Claude service
   |
   v
Node/Agent SDK adapter

review/checkpoint/context services
   ^          ^
   |          |
workbench/editor/file/git/terminal services
```

Forbidden:

```text
chat DOM component -> @anthropic-ai/claude-agent-sdk
inline widget -> child_process
renderer -> auth token files
agent runner -> direct DOM
```

This separation is what makes the code testable and upgradeable.

---

# 75. Core service interfaces to implement

Create these before building most UI so features have stable boundaries:

```ts
export const IClaudeAgentService = createDecorator<IClaudeAgentService>('claudeAgentService');
export const IClaudeSessionService = createDecorator<IClaudeSessionService>('claudeSessionService');
export const IClaudeContextService = createDecorator<IClaudeContextService>('claudeContextService');
export const IClaudeCheckpointService = createDecorator<IClaudeCheckpointService>('claudeCheckpointService');
export const IClaudeReviewService = createDecorator<IClaudeReviewService>('claudeReviewService');
export const IClaudePermissionService = createDecorator<IClaudePermissionService>('claudePermissionService');
export const IClaudeAutocompleteService = createDecorator<IClaudeAutocompleteService>('claudeAutocompleteService');
export const IClaudeBackgroundAgentService = createDecorator<IClaudeBackgroundAgentService>('claudeBackgroundAgentService');
```

Representative agent API:

```ts
export interface IClaudeAgentService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeSession: Event<IdeAgentSession>;
  readonly onDidReceiveEvent: Event<NormalizedClaudeEvent>;

  createSession(options?: CreateSessionOptions): Promise<IdeAgentSession>;
  submit(sessionId: string, input: UserComposerInput): Promise<void>;
  stop(sessionId: string): Promise<void>;
  queue(sessionId: string, input: UserComposerInput): Promise<void>;
  resume(sessionId: string): Promise<void>;
}
```

---

# 76. Event reducer: make UI state deterministic

Treat the timeline like an event-sourced state machine.

```ts
export function reduceAgentState(
  state: AgentViewState,
  event: NormalizedClaudeEvent
): AgentViewState {
  switch (event.type) {
    case 'assistant.delta':
      return appendAssistantDelta(state, event);
    case 'tool.started':
      return addToolCard(state, event.call);
    case 'tool.completed':
      return completeToolCard(state, event.callId, event.result);
    case 'session.failed':
      return failActiveTurn(state, event.message);
    default:
      return state;
  }
}
```

Persist the same normalized events. On restart, replay them to rebuild visible state. This minimizes UI corruption and makes regression tests straightforward.

---

# 77. Exact file-edit event pipeline

When Claude requests or performs an edit, the pipeline is:

```text
Claude write/edit tool request
 -> permission bridge receives intent
 -> path canonicalized and checked
 -> pre-write snapshot recorded
 -> permission resolved
 -> Claude tool executes
 -> filesystem event observed
 -> post-write content loaded
 -> diff calculated
 -> review item created
 -> editor decorations refreshed
 -> changed-file summary updated
 -> checkpoint metadata finalized at turn boundary
```

At no point does the chat renderer itself write files.

---

# 78. Exact shell-event pipeline

```text
Claude Bash request
 -> command classifier
 -> workspace trust check
 -> policy lookup
 -> permission card if needed
 -> allow/deny returned to Claude
 -> tool execution occurs
 -> stdout/stderr events normalized
 -> command card updated
 -> exit status shown
 -> diagnostics/build artifacts may refresh
```

The command is shown to the user before approval when approval is required.

---

# 79. Exact Ask-mode pipeline

```text
User asks question
 -> resolve selected/attached IDE context
 -> start/read-only Claude session
 -> allow Read/Grep/Glob and safe non-mutating discovery
 -> deny Edit/Write
 -> shell policy limited to safe/read-only or prompted
 -> stream answer and read/search cards
 -> no checkpoint unless workspace unexpectedly changed
```

If a change nevertheless appears because of an external process, do not attribute it to Claude automatically.

---

# 80. Exact Plan-mode pipeline

```text
User enters requirement
 -> resolve context
 -> read-only Claude plan session
 -> Claude inspects repository
 -> plan text/todos normalized
 -> PlanArtifact rendered
 -> user can edit/add notes
 -> user presses Build
 -> snapshot checkpoint
 -> Agent session continues/resumes with accepted plan + notes
 -> normal write/tool/review pipeline
```

Plan mode does not mutate code before Build.

---

# 81. Exact inline-edit pipeline

```text
selection/cursor
 -> inline prompt widget
 -> build bounded context
 -> checkpoint target file/model
 -> start constrained Claude edit request
 -> Claude edits target
 -> detect exact modified ranges
 -> show inline diff
 -> accept/reject
 -> close widget
 -> normal undo remains available
```

If Claude touches files outside the intended inline scope, stop and move those edits into the normal multi-file review flow with a visible warning.

---

# 82. Exact autocomplete pipeline

```text
editor content/cursor changed
 -> debounce
 -> build tiny prefix/suffix/recent-edit context
 -> cancel previous request
 -> issue no-tools Claude completion
 -> validate document version + cursor hash
 -> parse plain replacement text
 -> render ghost text
 -> Tab accepts / Esc dismisses
 -> record accepted edit as recent-edit signal
```

Never apply an autocomplete result if the document version that produced it is stale.

---

# 83. Build order: Phases 1 through 26, ending in the finished product

This is the execution order. It is not a set of alternative plans. Complete each gate and continue to the next.

## Phase 1 - Fork Code - OSS and establish upstream

Tasks:

- fork `microsoft/vscode`;
- add upstream remote;
- lock exact upstream commit;
- install toolchains;
- compile on Windows/macOS/Linux CI;
- launch development app.

Gate: unmodified fork builds on all supported CI OSes.

## Phase 2 - Rebrand the application completely

Tasks:

- product name;
- application IDs;
- bundle ID;
- mutex/data folder;
- icons;
- URL protocol;
- Help/About fields;
- remove Microsoft-only service keys;
- configure allowed extension gallery/VSIX behavior.

Gate: installs alongside VS Code without identity collisions.

## Phase 3 - Create Claude platform contracts

Implement `IClaudeRuntimeService`, event protocol, session DTOs, permission DTOs, capability DTOs.

Gate: TypeScript compiles and fake service can emit a scripted agent session.

## Phase 4 - Implement Node-side Claude Agent SDK runner

Install/pin Agent SDK. Implement runtime probe, start, cancel, resume, message normalization, auth error mapping.

Gate: console-level integration test can run Claude in a sample repo and capture normalized events.

## Phase 5 - Wire platform service into the workbench

Register service through Code - OSS instantiation/IPC boundary. Renderer calls service without importing SDK/child-process code.

Gate: command palette action can start a fake/live session and log events to Output.

## Phase 6 - Build first-party Agent pane shell

Register auxiliary-bar view, timeline, composer, status header.

Gate: pane opens/closes/moves with normal workbench layout and survives restart.

## Phase 7 - Stream Claude text into timeline

Implement turn model, event reducer, Markdown rendering, stop/retry states.

Gate: real Claude answer streams in native pane without terminal UI.

## Phase 8 - Build context attachments and `@` picker

Implement file/folder/symbol/selection/Problems/Git/terminal chips and resolvers.

Gate: user can attach context and inspect exactly what will be sent; pasted editor lines become a file:line chip.

## Phase 9 - Implement modes

Agent, Ask, Plan policies; mode selector; read-only enforcement; Plan artifact.

Gate: Ask cannot mutate; Plan cannot mutate before Build; Agent can request writes.

## Phase 10 - Implement permissions

Path guard, command classifier, native permission cards, per-once/session/workspace grants.

Gate: no sensitive action bypasses host-side policy, except the one the user chose on purpose: the confirmed Allow Everything level runs Claude Code in its bypass permissions mode, and only in Agent mode in a trusted workspace, never from a setting value alone, and never when a managed policy turns that mode off (issue 694). Interactive tools (questions, leaving plan mode) still reach the user, and writes are still snapshotted.

## Phase 11 - Implement snapshots and checkpoints

Pre-turn snapshots, object store, JSON metadata, restore preview, crash-safe persistence.

Gate: a multi-file Claude edit can be fully restored after app restart.

## Phase 12 - Implement changed-file detection and review

File collector, diff calculation, review pane, file/hunk actions.

Gate: edit three files -> review all -> accept/reject independently.

## Phase 13 - Implement inline edit

Editor command, overlay composer, constrained Claude request, inline diff.

Gate: select code -> instruction -> inline diff -> accept/reject -> undo works.

## Phase 14 - Implement shell/tool cards

Read/search/write/shell/skill/MCP visual cards, subagent cards and subagent chats (§16a), output virtualization, Open in Terminal.

Gate: complex Agent run, including parallel subagents, is understandable without raw Claude terminal text; each subagent opens as its own live chat and can be stopped.

## Phase 15 - Implement diagnostics and verification loop

Problems capture, new-error detection, Fix Problems action, bounded verify cycle.

Gate: compiler/test errors generated by an edit can be sent back precisely.

## Phase 16 - Implement Git-aware features

Git diff attachment, commit-message generation, accepted-change actions, branch/worktree awareness.

Gate: AI changes coexist safely with staged/unstaged user changes.

## Phase 17 - Implement durable session history

JSONL events, session index, rename/delete/export/resume/fork/recovery, subagent chats in history (§16a), chat references (§26a).

Gate: restart app and continue a prior Claude conversation with its review/checkpoint state intact.

## Phase 18 - Implement queue and steering

Pending composer inputs, cancellation, safe dispatch boundaries.

Gate: user can continue interacting while a long agent turn runs.

## Phase 19 - Implement background/parallel agents

Git worktrees, isolated sessions, status view, review/apply/merge.

Gate: two agents can work concurrently without writing the same working tree.

## Phase 20 - Implement Claude-powered Tab

No-tools low-latency request path, caching, cancellation, ghost text, next-edit hints.

Gate: suggestions never apply stale text and can be fully disabled.

## Phase 21 - Implement browser preview and visual context

Preview editor, screenshot/context capture, console-error attachment, optional element targeting.

Gate: local web app can be previewed and visual/console context can be sent to Agent.

## Phase 22 - Finish product UX

Onboarding, empty states, account/runtime status, settings, shortcuts, themes, accessibility, responsive pane sizing.

Gate: no feature requires developer console/terminal knowledge.

## Phase 23 - Harden security and privacy

Workspace Trust, path/symlink enforcement, secret guards, sanitization, redacted diagnostics, dependency audit.

Gate: threat-model checklist passes and dangerous commands require intended approval.

## Phase 24 - Complete automated testing

Unit, fake-runtime E2E, live Claude contract, fault injection, performance tests, accessibility tests, visual regression.

Gate: required suite passes on Windows/macOS/Linux CI.

## Phase 25 - Package, sign, notarize, and update

Build installers/packages, sign Windows/macOS, notarize macOS, generate hashes/signatures, deploy update manifest/service, test upgrade/rollback.

Gate: fresh install and upgrade from previous build pass on every supported platform.

## Phase 26 - Stable release acceptance

Execute the final product checklist in Section 84. Produce stable installers and release notes. The plan is complete only when every required item passes.

---

# 84. Final product acceptance checklist

The product is **finished** only when all of the following are true.

## Core IDE

- [ ] Application is a branded Code - OSS fork, not an extension host masquerading as a product.
- [ ] Windows installer works.
- [ ] macOS signed/notarized app works.
- [ ] Linux packages work.
- [ ] file explorer/editor/tabs/search/terminal/SCM/debug/Problems/settings/keybindings work.
- [ ] extension installation works through the permitted registry/VSIX route.
- [ ] multiple windows/workspaces work.

## Claude runtime

- [ ] Claude runtime is detected or setup is offered.
- [ ] supported sign-in/authentication path works.
- [ ] IDE never needs a separate visible Claude terminal for ordinary use.
- [ ] session start/stream/stop/resume work.
- [ ] unknown Claude events degrade safely.

## Agent UI

- [ ] native right-side Agent pane.
- [ ] session history.
- [ ] streaming assistant output.
- [ ] tool activity cards.
- [ ] subagent cards that open as live read-only chats and can be stopped (§16a).
- [ ] chats can be referenced as context by `@`, drag and drop, or menu (§26a).
- [ ] mode selector.
- [ ] context chips.
- [ ] `@` picker.
- [ ] queued messages.
- [ ] stop/retry.
- [ ] usage/runtime states.

## Agent behavior

- [ ] Agent can read/search/edit/run commands according to policy.
- [ ] Ask is read-only.
- [ ] Plan is read-only until Build.
- [ ] project Claude instructions/skills work.
- [ ] MCP tools render through the same UI pipeline.

## Editing and review

- [ ] selected-code inline edit.
- [ ] inline diff.
- [ ] multi-file diff review.
- [ ] accept/reject hunk.
- [ ] accept/reject file.
- [ ] accept/reject all.
- [ ] checkpoints.
- [ ] restore checkpoint after restart.
- [ ] user edits after AI edits are conflict-protected.
- [ ] normal undo/redo works.

## Context

- [ ] file.
- [ ] folder.
- [ ] selection.
- [ ] symbol.
- [ ] open editor.
- [ ] diagnostics.
- [ ] Git diff.
- [ ] terminal output.
- [ ] image/screenshot when backend supports it.

## Tool integration

- [ ] read card.
- [ ] search card.
- [ ] edit card.
- [ ] shell card with streamed output.
- [ ] permission card.
- [ ] skill card.
- [ ] MCP card.
- [ ] Open in Terminal.

## Parallel work

- [ ] isolated worktree agent.
- [ ] multiple sessions run concurrently.
- [ ] completed background changes can be reviewed/applied.
- [ ] conflicts surface through normal merge/review UI.

## Autocomplete

- [ ] Claude-powered ghost text.
- [ ] cancellation/stale result guards.
- [ ] Tab accept.
- [ ] Esc dismiss.
- [ ] multiline suggestions.
- [ ] next-edit behavior where practical.

## Browser/dev loop

- [ ] localhost preview.
- [ ] refresh/navigation.
- [ ] screenshot attachment.
- [ ] console error attachment.
- [ ] selected-element context where supported securely.

## Security

- [ ] Workspace Trust respected.
- [ ] path traversal/symlink protections.
- [ ] dangerous command classification.
- [ ] writes outside workspace require explicit policy.
- [ ] no secret tokens in logs.
- [ ] rendered content sanitized.
- [ ] update artifacts cryptographically verified.

## Product quality

- [ ] dark/light/high-contrast themes.
- [ ] keyboard-only operation.
- [ ] screen-reader labels.
- [ ] no obvious memory leak from long sessions.
- [ ] large tool output virtualized.
- [ ] crash recovery preserves files/checkpoints.
- [ ] telemetry/privacy behavior documented.

## Distribution

- [ ] stable and insiders channels have separate identities.
- [ ] Windows signing.
- [ ] macOS signing and notarization.
- [ ] Linux package metadata.
- [ ] release hashes/signatures.
- [ ] updater tested from N-1 to N.
- [ ] Help/About shows product/upstream/build versions.

Only after this checklist passes should `v1.0.0` be called finished.

---

# 85. Concrete first commit set

The first product-specific commits should be small and ordered:

```text
1. chore(product): establish fork identity and resources
2. feat(claude): add common protocol and service contracts
3. feat(claude): add Agent SDK runtime runner
4. feat(claude): wire runtime service into desktop workbench
5. feat(agent-ui): register native Agent auxiliary-bar view
6. feat(agent-ui): add timeline and composer
7. feat(agent): stream normalized Claude events
8. feat(context): add selection/file context attachments
9. feat(permissions): add tool permission bridge
10. feat(checkpoints): snapshot agent turns
11. feat(review): show multi-file change review
12. feat(inline): add editor inline edit flow
```

This order creates a vertical slice early while preserving the final architecture.

---

# 86. Representative implementation of the runtime-to-workbench bridge

The actual Code - OSS IPC wiring depends on the upstream revision, but the product-level contract should resemble:

```ts
export class ClaudeAgentService extends Disposable implements IClaudeAgentService {
  readonly _serviceBrand: undefined;

  private readonly _onDidReceiveEvent = this._register(new Emitter<NormalizedClaudeEvent>());
  readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

  constructor(
    @IClaudeRuntimeService private readonly runtime: IClaudeRuntimeService,
    @IClaudeSessionService private readonly sessions: IClaudeSessionService,
    @IClaudeContextService private readonly context: IClaudeContextService
  ) {
    super();
    this._register(runtime.onDidEmitEvent(e => this.handleRuntimeEvent(e)));
  }

  async submit(sessionId: string, input: UserComposerInput): Promise<void> {
    const session = await this.sessions.get(sessionId);
    const envelope = await this.context.resolve(input, session);
    const prompt = compilePrompt(envelope);

    await this.runtime.send(sessionId, {
      prompt,
      mode: session.mode
    });
  }

  private handleRuntimeEvent(event: NormalizedClaudeEvent): void {
    this.sessions.apply(event);
    this._onDidReceiveEvent.fire(event);
  }
}
```

The service is testable with an in-memory fake runtime.

---

# 87. Representative fake runtime for UI development

Do not block UI development on live Claude calls.

```ts
export class FakeClaudeRuntimeService implements IClaudeRuntimeService {
  readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<NormalizedClaudeEvent>();
  readonly onDidEmitEvent = this.emitter.event;

  async begin(req: BeginClaudeRequest): Promise<ClaudeRunHandle> {
    const id = crypto.randomUUID();
    queueMicrotask(async () => {
      this.emitter.fire({ type: 'session.started', sessionId: id });
      this.emitter.fire({
        type: 'tool.started',
        sessionId: id,
        call: fakeReadCall('src/app.ts')
      });
      await timeout(250);
      this.emitter.fire({ type: 'assistant.delta', sessionId: id, text: 'I found the issue. ' });
      this.emitter.fire({ type: 'assistant.delta', sessionId: id, text: 'I am updating the handler.' });
      this.emitter.fire({ type: 'session.completed', sessionId: id });
    });
    return { sessionId: id };
  }
}
```

Recorded scenarios should include permission requests, multi-file edits, command failures, long output, and crashes.

---

# 88. Representative session storage implementation

```ts
class JsonlSessionStore {
  async append(sessionId: string, event: NormalizedClaudeEvent): Promise<void> {
    const path = this.eventsPath(sessionId);
    const line = JSON.stringify({ v: 1, ts: Date.now(), event }) + '\n';
    await fs.promises.appendFile(path, line, 'utf8');
  }

  async read(sessionId: string): Promise<NormalizedClaudeEvent[]> {
    const raw = await fs.promises.readFile(this.eventsPath(sessionId), 'utf8');
    const out: NormalizedClaudeEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line).event); }
      catch { break; } // tolerate truncated final line after crash
    }
    return out;
  }
}
```

Use atomic write/rename for metadata indexes.

---

# 89. Representative checkpoint object store

```ts
async function putBlob(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = join(objectsRoot, hash.slice(0, 2), hash.slice(2));
  if (!(await exists(target))) {
    await mkdir(dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + process.pid;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
  return hash;
}
```

Snapshot metadata stores `hash` rather than duplicate file content.

---

# 90. Representative hunk rejection guard

Rejecting against a changed file must detect drift:

```ts
async function rejectHunk(h: ReviewHunk, model: ITextModel) {
  const current = model.getValueInRange(h.currentRange);
  if (current !== h.modifiedText) {
    throw new ReviewConflictError(
      'The file changed after Claude created this hunk. Open conflict review.'
    );
  }

  model.pushEditOperations(
    null,
    [{ range: h.currentRange, text: h.originalText }],
    () => null
  );
}
```

A conflict is better than deleting the user's later edit.

---

# 91. Representative permission bridge to Agent SDK

```ts
async function canUseTool(
  toolName: string,
  input: unknown,
  context: unknown
): Promise<PermissionDecision> {
  const req = normalizePermissionRequest(toolName, input, context);
  const automatic = permissionPolicy.evaluate(req);

  if (automatic) return automatic;

  return await permissionUi.request(req);
}
```

The UI request is asynchronous. If the session is stopped while waiting, resolve as deny/cancel.

---

# 92. Representative context attachment resolver

```ts
async function resolveSelection(a: SelectionAttachment): Promise<ResolvedAttachment> {
  const model = modelService.getModel(URI.parse(a.uri));
  if (!model) throw new Error('Editor model no longer available');

  return {
    kind: 'selection',
    path: workspaceRelativePath(model.uri),
    languageId: model.getLanguageId(),
    range: a.range,
    content: model.getValueInRange(Range.lift(a.range))
  };
}
```

Attach current editor content, not a stale copy made when the chip was first created, unless the UI explicitly indicates a frozen snapshot.

---

# 93. Representative autocomplete stale-result guard

```ts
const requestVersion = model.getVersionId();
const requestPosition = position;
const result = await autocomplete.provideCompletion(input, token);

if (token.isCancellationRequested) return;
if (model.getVersionId() !== requestVersion) return;
if (!Position.equals(editor.getPosition(), requestPosition)) return;

showInlineCompletion(result);
```

This rule alone prevents a large class of bad AI completions.

---

# 94. Representative background-agent merge flow

```ts
async function applyBackgroundAgent(task: BackgroundAgentTask) {
  const patch = await git.diff(task.worktreePath, task.baseRef, 'HEAD');
  const preview = await review.openExternalPatch(patch);
  if (!preview.accepted) return;

  const result = await git.applyPatch(mainWorkspaceRoot, patch, { threeWay: true });
  if (result.conflicts.length) {
    await mergeEditor.openConflicts(result.conflicts);
  }
}
```

Do not overwrite the main workspace by copying the entire worktree directory.

---

# 95. Final build/release script shape

Create one release entry point rather than a pile of manual commands:

```bash
node build/claudeide/release.mjs --channel stable --version 1.0.0
```

The script validates it is running in CI and delegates platform work:

```text
validate clean Git state
validate version
compile/minify
run tests
build packaged target
inject release product metadata
sign
package installer/archive
hash
sign manifest entry
upload artifact
```

Global release workflow then gathers platform artifacts and publishes one signed manifest.

---

# 96. What "finished" means in practice

When a user downloads the final product, they should be able to do this:

1. install the IDE;
2. open a repository;
3. authenticate Claude through the supported flow;
4. see a polished Agent pane on the right;
5. type "find why login fails and fix it";
6. watch Claude read/search files through concise tool cards;
7. approve a command when necessary;
8. see files change in the editor;
9. review every change as a native diff;
10. accept or reject by hunk/file/all;
11. restore a checkpoint if the direction is wrong;
12. select code and invoke an inline edit without leaving the editor;
13. receive Claude-powered Tab suggestions while coding;
14. attach files, symbols, errors, Git changes, terminal output, or screenshots;
15. close the application, reopen it, and continue the same session;
16. run another agent in an isolated worktree;
17. use terminal, Git, debugger, extensions, settings, search, and normal editing exactly as a full desktop IDE;
18. receive signed application updates on Windows, macOS, and Linux.

The terminal implementation of Claude Code is invisible during normal use. Claude Code is the engine; the IDE is the product.

---

# 97. Current external facts used by this plan

This plan intentionally depends on a small set of current external facts that should be re-verified during implementation:

1. **Code - OSS is available under MIT.** The upstream repository describes itself as the open-source codebase used to build VS Code.
2. **Code - OSS can be built and packaged for Windows, macOS, and Linux.** Microsoft's current contribution documentation lists desktop build/run and packaged platform tasks.
3. **A third-party Code - OSS fork should not use Microsoft's Visual Studio Marketplace as though it were Visual Studio Code.** Microsoft's FAQ states the Marketplace is restricted to the Visual Studio family; use an allowed registry/VSIX distribution instead.
4. **Claude Agent SDK exposes a programmatic agent loop.** Current Claude documentation shows TypeScript `query()` usage, session/init events, filesystem setting sources, tools, slash commands/skills, and permission-related capabilities.
5. **Claude Code can be authenticated with supported Claude accounts/plans, but third-party product authentication policy matters.** Anthropic's current help material says Claude Code is included with eligible plans while separately warning developers of third-party products not to misrepresent identity or improperly route third-party use against subscription limits. Re-check this before public launch.

References to verify at implementation time:

- Microsoft `microsoft/vscode` repository README and `product.json`.
- Microsoft VS Code "How to Contribute" / packaging documentation.
- Microsoft VS Code FAQ on Marketplace usage by forks.
- Anthropic Claude Code / Agent SDK documentation, especially Agent SDK overview, sessions, permissions, checkpointing, streaming, and SDK reference.
- Anthropic help center pages for Claude Code authentication and paid-plan usage.

---

# 98. Final instruction to the implementation agent/team

Do not reinterpret this project as a plugin or a Claude terminal GUI.

Start from the Code - OSS fork. Keep the normal IDE intact. Add the Claude system as first-party workbench/platform code. Every user action is expressed in native IDE concepts; every Claude event is translated back into native IDE concepts. The user should be able to forget that Claude Code has a terminal interface at all.

Do not stop at a prototype once chat works. Continue through review, checkpoints, inline edits, autocomplete, background agents, security, tests, packaging, signing, updates, and cross-platform release. The endpoint of this document is not "we proved it can work." The endpoint is an installable, updateable, cross-platform desktop IDE.

**End state:** `v1.0.0` installers/packages for Windows, macOS, and Linux that satisfy the full acceptance checklist in Section 84.

