# 0001 Agent Host harness

- Status: superseded 2026-11-25 (v5 P1, issue 1). Klawly drives the user's installed `claude` CLI headless through one runtime (`IClaudeRuntimeService`) for the pane, inline edit, Tab and the Agents window; no bundled Agent SDK ships (#1654). No Claude provider is registered in the Agent Host. The `claude.agentsWindow.enabled` setting remains and is to be removed in a follow-up.
- Was: accepted 2026-10-13 (issue 423).
- Date: 2026-10-10. Code read at `origin/main` b12d8cd1 (Code - OSS 1.141.0 merged, PR 422).
- Spike branch: `spike/423-agent-host` (pushed, no PR, never merged).

## Question

Code - OSS 1.141 runs agents in an Agent Host utility process and builds the Agents window (session grid, model comparison, automations, isolation picker, customizations, review) on top of it for any harness. Can Klawly's Claude runtime be that harness, so these features arrive with each upstream merge instead of being rebuilt?

## Decision

**Adopt the harness for the Agents window only.** Run upstream's own `ClaudeAgent` in the Agent Host on its *native* transport (the user's own Claude Code and credentials, no Copilot proxy), with a short list of Klawly patches, behind a Klawly setting that is off by default until permission parity (follow-up 3) lands. The main window's Agent pane, Review editor, checkpoints and session store stay on Klawly's runtime (`src/vs/platform/claude/**`) and remain the single source of truth for them.

Not "Klawly's runtime as the harness": wrapping `claudeAgentRunner.ts` in `IAgent` means implementing about 60 members (`src/vs/platform/agentHost/common/agent.ts:1271-1504`) and emitting Agent Host Protocol actions, i.e. rewriting `ClaudeAgent`. Upstream's `ClaudeAgent` already runs Claude Code on the user's own account, on the same SDK version Klawly pins (`@anthropic-ai/claude-agent-sdk` 0.3.281 in both Klawly `package.json:106` and upstream 1.141.0 `package.json:174`).

Not "stay native": upstream adds 12,600 to 24,100 non-test, non-generated lines to `src/vs/platform/agentHost` every weekly release (Q5). Rebuilding the Agents window at that pace is not realistic; taking it as-is and patching only the Claude harness is.

## 1. Provider seam

- Providers are registered by hand in `src/vs/platform/agentHost/node/agentHostMain.ts`: `CopilotAgent` unconditionally (line 154), `ClaudeAgent` when `chat.agentHost.claudeAgent.enabled` and the SDK is reachable (lines 169-171), `CodexAgent` on its own toggle (lines 175-190). `IAgentHostProviderService.registerProvider` (`src/vs/platform/agentHost/node/agentHostProviderService.ts:32`) has no contribution point, so any provider change edits `agentHostMain.ts`.
- `AgentProvider` is a plain string (`src/vs/platform/agentHost/common/agent.ts:265`), so a `KlawlyClaudeAgent` with its own id could sit beside `ClaudeAgent` without editing it. It would lose the 21 places in `src/vs/sessions/**` and `src/vs/workbench/contrib/chat/**` that special-case the `'claude'` id (icons, list filters, external-session banner, MCP support, e.g. `sessions/contrib/providers/agentHost/browser/localAgentHostSessionsProvider.ts`, `workbench/contrib/chat/browser/widget/input/modelPicker/modelProviderIcons.ts`). Patching `ClaudeAgent` in place keeps them.
- In a built product the gate at `agentHostMain.ts:169` requires `product.agentSdks.claude` (`src/vs/platform/agentHost/node/agentSdkDownloader.ts:296`), which Klawly's `product.json` does not have, so `ClaudeAgent` is never registered in a shipped Klawly today. In dev it registers because `ClaudeAgentSdkService._loadSdk` falls back to a bare import (`src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts:274-307`). Klawly ships the SDK in `node_modules`, so the fix is to accept that path in built products.

Upstream files Klawly would edit (each becomes an `UPSTREAM.md` line):

| File | Edit |
|---|---|
| `src/vs/platform/agentHost/node/agentHostMain.ts:154-190` | Do not register `CopilotAgent` or `CodexAgent`; register `ClaudeAgent` when the SDK resolves from `node_modules` in built products |
| `src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts:296` | Built products load the bundled SDK instead of the CDN downloader |
| `src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:177, 282` | Native transport spawns the installed Claude Code (done on the spike branch) |
| `src/vs/platform/agentHost/node/claude/claudeTransportMode.ts:62-73` and `claudeAgent.ts:738-800` | Native transport always; the Copilot resource is never requested or accepted, so `ClaudeProxyService` never starts |
| `src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:154-189` | Klawly's permission host runs as the `PreToolUse` hook and `canUseTool` (follow-up 3) |
| `src/vs/workbench/contrib/chat/common/constants.ts:638-644`, `src/vs/platform/agentHost/browser/agentHostEnablementService.ts`, `src/vs/sessions/browser/sessionsSetUpService.ts:155-159` | The Agents window opens on the Klawly setting instead of `chat.disableAIFeatures` and the Copilot setup flow |
| `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts:1776-1782`, `src/vs/platform/agentHost/common/agentHostCustomizationConfig.ts:87-92` | `chat.agentHost.allowSignedOutWhenUsable` forced on in Klawly |

## 2. Auth

`ClaudeAgent` does not need a separate provider for auth. Upstream 1.141 already has two transports (`src/vs/platform/agentHost/node/claude/claudeTransportMode.ts:13`): `proxy` (Copilot CAPI through `ClaudeProxyService`) and `native` (the SDK's own credential resolution: `claude login`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`).

- Native mode omits `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` and passes the real environment (`claudeSdkOptions.ts:132-143`, `buildSubprocessEnv` at 386-410).
- The native model catalog is published only when the SDK's `accountInfo()` reports a usable account (`claudeAgent.ts:918-940`, `isClaudeAccountSetUp` in `claudeTransportMode.ts`).
- Today native is chosen only when `chat.agentHost.allowSignedOutWhenUsable` is on (default off, `agentHostCustomizationConfig.ts:87-92`) and no GitHub token is present (`resolveClaudeTransportMode`, `claudeTransportMode.ts:62-73`), or per session when the picked model is in the Anthropic group (`resolveClaudeSessionTransport`, `claudeModelSelection.ts:110-128`). A GitHub sign-in in the Agents window (also used for repository features, `claudeAgent.ts:777`) starts the proxy and makes it the default, so Klawly must pin native (table above).
- Executable: upstream uses the SDK's bundled Claude Code (`executable: process.execPath`, `claudeSdkOptions.ts:177` and 282; the bundled binary is `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64`). Klawly runs the user's installed CLI (`pathToClaudeCodeExecutable`, `src/vs/platform/claude/node/claudeSdkAdapter.ts:110`, resolved by `resolveClaudeBinary`, `src/vs/platform/claude/node/claudeRuntime.ts:134`). The spike branch switches native mode to the installed CLI with that same lookup.

## 3. Safety model

| Klawly (main window) | Agent Host Claude harness | Gap |
|---|---|---|
| Permission mode is always `default` (`claudeSdkAdapter.ts:107`, `claudeAgentRunner.ts:698`) and Klawly's modes are enforced by the host policy | SDK `permissionMode` from session config, up to `bypassPermissions`, with `allowDangerouslySkipPermissions: true` always (`claudeSdkOptions.ts:180, 189`; mode list `claudeAgent.ts:2250-2265`) | Klawly's mode policy (`src/vs/platform/claude/common/claudeModePolicy.ts`) would not apply |
| Every tool passes `ClaudePermissionHost.evaluate` (`src/vs/platform/claude/node/claudePermissionHost.ts:65-104`), first in a `PreToolUse` hook that runs before the SDK's own allow rules (`claudeAgentRunner.ts:713-745`), then in `canUseTool` (`claudeAgentRunner.ts:705`) | The SDK applies `settings.json` allow rules first and calls `canUseTool` only for what it decides to surface (`claudeCanUseTool.ts:65-83`); the workbench may auto-approve at protocol level (`agentSideEffects.ts:1534-1541`). The only `PreToolUse` hook restricts the agent-merge GitHub tool (`claudeAgentSession.ts:656`) | A project `.claude/settings.json` allow rule bypasses the IDE; must reuse `ClaudePermissionHost` as hook and `canUseTool` |
| A write is snapshotted before allow is returned; a failed snapshot denies the write (`claudeAgentRunner.ts:917-941`); works in any folder and includes unsaved buffers | Git commits per turn under `refs/agents/<sid>/checkpoints/turn/<N>`; folders that are not git work trees are skipped (`src/vs/platform/agentHost/common/agentHostCheckpointService.ts:26-58`); the SDK's own `enableFileCheckpointing` (`claudeSdkOptions.ts:186`) | No checkpoint outside git; no dirty-buffer capture |
| Change capture from the IDE's own before/after snapshot (`file.beforeWrite`/`file.afterWrite` events, `claudeProtocol.ts:199+`) | `ClaudeFileEditObserver` reads the SDK message stream after the fact (`claude/CONTEXT.md`), plus git diffs (`agentHostChangesetService.ts`, interface doc `common/agentHostChangesetService.ts:94-100`) | Acceptable for the Agents window; the stream is non-bypassable by hooks |
| Untrusted workspace: project settings, hooks and MCP are not loaded (`claudeAgentRunner.ts:681`) | `settingSources: ['user', 'project', 'local']` always (`claudeSdkOptions.ts:199`); trust folders resolved by `common/agentHostWorkspaceTrust.ts:13` | Verify the harness honors workspace trust before enabling |

## 4. Protocol

The Agent Host speaks the Agent Host Protocol: 14,391 lines of generated types under `src/vs/platform/agentHost/common/state/protocol/**` (synced from a separate `agent-host-protocol` repo, `common/state/AGENTS.md`), with about 94 distinct `session/`, `chat/`, `changeset/`, `root/` and `terminal/` action names, and state held in the Agent Host process and its per-session database. Klawly's protocol is 23 normalized event types (`src/vs/platform/claude/common/claudeProtocol.ts:199-302`) consumed by the Agent pane, Review editor and `claudeSessionStore.ts`.

A projection from Agent Host state onto `claudeProtocol.ts` is possible one way (read-only: tool calls, text, permission requests map), but the two would diverge: the Agent Host owns approval, changesets and checkpoints in its own process and database, so the Agent pane would show a second, lagging copy. Hence the split: the Agents window reads Agent Host state, the main window reads Klawly's. What both share is Claude Code's own transcript on disk: the harness lists sessions through the SDK (`claudeAgent.ts:2062`) and treats sessions without its overlay as external CLI sessions (`claude/CONTEXT.md:45`), so sessions Klawly started should appear in the Agents window. Not verified (follow-up 6).

## 5. Cost of following upstream

Measured with `git diff --shortstat` between the upstream release tags, fetched into a scratch clone (`git fetch --depth=1 --filter=blob:none https://github.com/microsoft/vscode.git tag 1.138.0 tag 1.139.0 tag 1.140.0 tag 1.141.0`). This repo has only the 1.140.0 and 1.141.0 snapshots (`78d9e680`, `827b3e02`, merged in `c13b2e1f`); its 1.140.0 to 1.141.0 numbers match the upstream tags exactly. Releases are weekly (tag dates 2026-09-15, 09-22, 09-30, 10-06).

| Release | `src/vs/platform/agentHost` (all) | same, without tests and generated protocol | `agentHost/node/claude` | `src/vs/sessions` |
|---|---|---|---|---|
| 1.138.0 to 1.139.0 | 233 files, +34,127 / -5,305 | 107 files, +10,837 / -1,755 | 2 files, +10 / -6 | 276 files, +22,341 / -2,873 |
| 1.139.0 to 1.140.0 | 700 files, +62,153 / -11,129 | 224 files, +16,620 / -4,452 | 8 files, +108 / -48 | 436 files, +47,544 / -23,922 |
| 1.140.0 to 1.141.0 | 1,494 files, +53,972 / -11,352 | 303 files, +17,644 / -6,488 | 7 files, +293 / -14 | 409 files, +44,019 / -9,767 |

The harness directory itself is quiet (16 to 307 lines a week across 48 source files); the host and window around it change by tens of thousands of lines a week. Klawly's current divergence in these trees is only the product-name rename (61 files, +132 / -132 in `agentHost`; 61 files, +177 / -203 in `sessions`). Patching only `node/claude`, `agentHostMain.ts` and a few gates keeps merge conflicts small; patching the window would not.

## Spike: one Agents-window session on the user's own Claude Code

Branch `spike/423-agent-host`, commit `4987a87c`: `claudeSdkOptions.ts` native sessions and the model/account probe spawn the installed `claude.exe` (via `resolveClaudeBinary`, `KLAWLY_CLAUDE_EXECUTABLE` overrides) instead of the SDK's bundled build.

Checked (Windows 11 Pro 10.0.26200):
- `npx eslint src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts` exit 0.
- `npm run transpile-client` then `npm run test-node -- --run src/vs/platform/agentHost/test/node/claudeSdkOptions.test.ts`: 21 passing.
- `node -e` on the transpiled module: `buildModelEnumerationOptions().pathToClaudeCodeExecutable` is `C:\Users\<you>\.local\bin\claude.exe` (Claude Code 2.1.296).

Not run (needs a full compile and an app launch, which the orchestrator schedules):
1. In the spike worktree: `npm run compile`, then `scripts\code.bat --user-data-dir %TEMP%\klawly-423 --extensions-dir %TEMP%\klawly-423-ext`.
2. In that profile's `settings.json`: `"chat.disableAIFeatures": false`, `"chat.agentHost.allowSignedOutWhenUsable": true`. Do not sign in to GitHub.
3. Run `workbench.action.openAgentsWindow` (upstream's window, not Klawly's "Agents Window" pill, which opens the Klawly chat in its own window, `claudeMenus.ts:43`).
4. Expected: the window opens without a GitHub wall (`resolveSignedOutWindowGate`, `src/vs/sessions/browser/sessionsAuthGate.ts:59-72`); the Claude model picker shows the Anthropic group; a new Claude session answers a prompt; Task Manager shows `C:\Users\<you>\.local\bin\claude.exe` under the agent host process; the agent host log shows no proxy start.

Known blockers that may stop step 3 or 4, and their fix (follow-up 5): `OPEN_AGENTS_WINDOW_PRECONDITION` needs chat setup not hidden (`constants.ts:638-644`), and Klawly hides upstream chat while `chat.disableAIFeatures` is on (`UPSTREAM.md:53`); `sessionsSetUpService._start` runs the Copilot setup flow because `product.json:97` still names `GitHub.copilot-chat`, and only proceeds without GitHub when an agent reports a usable non-GitHub requirement (`sessionsSetUpService.ts:147, 237`).

## Follow-up issues (to file if this is accepted)

1. **Agent Host: Claude harness only, SDK from node_modules.** Stop registering `CopilotAgent` and `CodexAgent`; register `ClaudeAgent` in built products from the bundled SDK (`agentHostMain.ts`, `claudeAgentSdkService.ts`).
2. **Claude harness: native transport only, installed Claude Code.** Land the spike's executable change; pin native transport; never request or accept the Copilot resource so `ClaudeProxyService` cannot start; add a node test that a GitHub token does not change the transport.
3. **Claude harness: Klawly permission parity.** Run `ClaudePermissionHost` as the harness's `PreToolUse` hook and `canUseTool`; map Klawly modes onto the session permission mode; drop `bypassPermissions` and protocol-level auto-approve; honor workspace trust. Blocks turning the setting on by default.
4. **Claude harness: checkpoints outside git.** Snapshot-before-write for non-git folders and unsaved buffers, or a stated decision that the Agents window is git-only.
   Outcome (issue 616): the file-edit tools (Write, Edit, MultiEdit, NotebookEdit) are snapshotted before the write in any folder. The harness's `PreToolUse` hook, which the SDK awaits before the tool runs, reads the before-content into the session database (`ClaudeFileEditObserver.snapshotBeforeToolUse`), so upstream's undo (`AgentHostSnapshotController`) restores edits in a folder that is not a git work tree, and the snapshot no longer races the write. Decided to stay git-only: turn diffs and changes made by terminal commands (the `refs/agents/<sid>/checkpoints` commits). Not captured: unsaved buffers, because Claude Code writes to disk from the agent host process, not through the editor. The snapshot is taken when the hook runs, before the user answers the confirmation; a failed read logs a warning and does not deny the write, unlike Klawly's runner.
5. **Open upstream's Agents window in Klawly.** A `claude.agentsWindow.enabled` setting (default off) that drives the window's precondition, enablement and setup instead of `chat.disableAIFeatures` and Copilot setup; resolve the name clash with Klawly's "Agents Window" pill; `design/` page first (rule 36).
6. **Sessions across both windows.** Verify Klawly-started sessions appear in the Agents window through Claude Code's transcripts, add "Open in Agent pane" both ways, one transcript, no second store.
   Outcome (issue 618): the shared key is Claude Code's session id, and the one transcript is Claude Code's own (`claudeAgentsWindowSessions.ts` maps `agent-host-claude:/<id>` to the id the Agent pane keeps as `claudeSessionId`). Klawly-started sessions show in the Agents window because upstream's `ClaudeAgent` lists every Claude Code transcript with the SDK's `listSessions()`. A Klawly chat Claude Code has answered gets Open in Agents Window (upstream's `workbench.action.chat.openSessionInAgentsWindow`) while `claude.agentsWindow.enabled` is on, and waits while a turn runs. The Agents window's own Open in Editor (`vscode:openChatSession`) opens the Agent pane on the chat with that id, or its saved chat, or a new chat whose next message resumes the session; no Klawly code runs in the Agents window, so that button keeps upstream's label. Not done: the Agent pane does not draw the turns another window ran (Claude remembers them), and two windows sending at once still fork the transcript.
7. **Merge guard.** A node test (and a line in the upstream-merge checklist) that fails if a Klawly build would register `CopilotAgent` or start `ClaudeProxyService`.
