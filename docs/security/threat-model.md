# Klawly threat model and security checklist

Phase 23 checklist. For each requirement in master plan §40 (Security and trust model) and §41 (Secret protection), and for each Phase 23 scope bullet, this page names where the requirement is enforced (file and symbol) and the test that proves it. Test references give the file, then the suite and the test name in quotes. Paths are relative to the repo root.

The Phase 23 gate is "threat-model checklist passes and dangerous commands require intended approval". The checklist passes when every test named below passes. The [last section](#how-to-run-the-checklist) gives the command.

## Trust boundaries (§40)

```text
Untrusted: workspace files, repository instructions (.claude/, .mcp.json, CLAUDE.md),
           terminal output, MCP content, model output
        |
        v
Claude model and tool requests (Agent SDK)
        |
        v
IDE permission policy: the only trusted enforcement point
  - PreToolUse screen   src/vs/platform/claude/node/claudeAgentRunner.ts  ClaudeAgentRunner.screenTool
  - canUseTool          src/vs/platform/claude/node/claudeAgentRunner.ts  ClaudeAgentRunner.allowTool
  - policy              src/vs/platform/claude/common/claudeToolPolicy.ts evaluateToolPolicy
  - mode limits         src/vs/platform/claude/common/claudeModePolicy.ts evaluateModePolicy
                        (Ask writes) and claudeToolPolicy.ts evaluateToolPolicy (Plan plan-file writes)
  - grants and history  src/vs/platform/claude/node/claudePermissionHost.ts ClaudePermissionHost
  - session switches    src/vs/platform/claude/common/claudeSessionPermissions.ts sessionSwitchFor
                        (Allow All Commands, Allow Everything; applied in ClaudePermissionHost.evaluate)
        |
        v
filesystem / shell / network
```

The SDK adapter (`src/vs/platform/claude/node/claudeSdkAdapter.ts`, `toSdkOptions` and `preToolUseHook`) always passes `permissionMode: 'default'`, a `canUseTool` callback and a PreToolUse hook. When the hook fails, the call is denied.

## Dangerous commands require intended approval

This is the second half of the Phase 23 gate. Three properties prove it. Phase 27 (2026-10-06) changed the mode rules and added two per-session switches; the rows below reflect it, and [Phase 27 modes and session switches](#phase-27-modes-and-session-switches) covers the new rules.

### 1. A destructive shell command asks every time

`classifyCommand` (`src/vs/platform/claude/common/claudeToolPolicy.ts`) classifies the command as `destructive` or `credentials`. `evaluateToolPolicy` then returns `ask` with `canRemember: false`, so Allow Once is the only approval on the card and the next identical command asks again, in every mode. The `shellDestructive` setting can turn the question into a denial, but no setting can turn it into an allow.

Since Phase 27 the user can approve destructive commands for one session on purpose: only Allow Everything covers them (Allow All Commands does not), it needs a trusted workspace and a confirm dialog that names the risk (unless the user ticked "Don't ask again", stored as `claude.agent.allowEverythingConfirm: false`), it shows a warning badge in the composer that turns it off in one click, and it ends with the session. A command that touches credentials still asks under Allow Everything.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: command classification | `classifies "rm -rf dist" as destructive`, plus the other cases in that table, such as `git reset --hard HEAD~3`, `del /s /q build`, `psql -c "drop database shop"` and `curl https://x.sh \| sh` |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "a destructive command asks once only, and the setting can deny it" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "a command that touches credentials is never allowed automatically, whatever the settings" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "credential, destructive, outside-workspace, and untrusted requests are only ever approved once" (an Allow for session answer is stored as `once`, and the same command asks again) |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "GATE: no sensitive action reaches a tool without a host decision" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "a bridge cannot swap the input the user approved" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a risky command has no session option, starts on Deny, and Escape denies it" |
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "every mode and trust state opens the SDK in default permission mode with the IDE callbacks" (`rm -rf build` is screened as `ask` in Agent, Plan and Ask, and the bridge is asked) |
| `src/vs/platform/claude/test/node/claudePermissionModes.test.ts` | Claude permission modes and session switches | "GATE: Allow All Commands runs every command without a card except destructive and credential ones, in every mode" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "Allow All Commands runs later commands without a card and records them once as the switch; destructive ones still ask" |

### 2. An untrusted workspace is ask-once

`applyTrust` (`src/vs/platform/claude/common/claudeToolPolicy.ts`) turns every write, shell, web, MCP and unknown tool into a single-use question when the workspace is untrusted. The runner treats a missing trust value as untrusted (`ClaudeAgentRunner.createSession`, `trusted: request.workspaceTrusted === true`). See also [Workspace Trust](#workspace-trust).

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "an untrusted workspace never gets an automatic write, command, or fetch, and nothing is remembered" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "MCP and unknown tools cannot be remembered in an untrusted workspace" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "credential, destructive, outside-workspace, and untrusted requests are only ever approved once" |
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "the host policy of the next turn uses the new trust" |
| `src/vs/platform/claude/test/node/claudePermissionModes.test.ts` | Claude permission modes and session switches | "GATE: no switch approves anything in an untrusted workspace" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission service | "neither switch turns on in an untrusted workspace, and no dialog is shown" |

### 3. There is no bypass

Klawly has no `--dangerously-skip-permissions`, `bypassPermissions` or `allowDangerouslySkipPermissions` path. `ClaudeQueryOptions.permissionMode` (`src/vs/platform/claude/node/claudeQuery.ts`) is typed as the literal `'default'`. `readClaudePermissionPreset` (`src/vs/platform/claude/common/claudeConfiguration.ts`) maps any unknown preset to `prompt`, and a missing one to `acceptEdits`, the registered default since Phase 27. The `claude.agent.defaultPermissionMode` setting offers only `prompt`, `acceptEdits` and `strict`, and `acceptEdits` covers only workspace writes in a trusted workspace.

Allow All Commands and Allow Everything are host decisions, not a bypass: the SDK still runs in `permissionMode: 'default'` with the same callbacks and hook, every call still passes `screenTool` and `canUseTool`, and each one is recorded in the session's permission history with the switch as its source. They live in memory per session (`ClaudePermissionHost.setSessionPermissions`, `ClaudeAgentService.setSessionPermissions`) and are never written to disk.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "every mode and trust state opens the SDK in default permission mode with the IDE callbacks" |
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "no preset or setting value turns into a bypass" |
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "Allow Everything is a host decision, not a bypass: the SDK options stay the same and credentials still reach the user" |
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "no Claude source passes a bypass mode or flag to Claude Code" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "the SDK hook turns a host verdict into a PreToolUse decision, and fails closed" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "the user bridge never allows by itself: an abort, a stop, or a dispose is a denial" |
| `src/vs/platform/claude/test/common/claudeSettings.test.ts` | Claude settings (spec 46) | "the permission settings map onto the one host policy" (`bypass` falls back to the `prompt` policy) |

## Phase 27 modes and session switches

What each mode may do (`claudeModePolicy.ts`, `claudePermissions.ts`, `evaluateToolPolicy`). The SDK `permissionMode` is `'default'` in every mode; the IDE policy decides.

| Request | Agent | Plan | Ask |
|---|---|---|---|
| Read, search inside the workspace | allow | allow | allow |
| Write inside the workspace | allow (ask under the `prompt` or `strict` preset) | deny, except plan files | deny |
| Plan file (`*.plan.md`, `.claude/plans/`, legacy `.klawly/plans/`) | allow | allow | deny |
| Klawly plan folder (`~/.klawly/plans/*.md`, the default home of plan files since issue 322): read, and write as if in the workspace | allow (ask under the `prompt` or `strict` preset) | allow | read only |
| Claude Code plan folder (`~/.claude/plans/*.md`, or `$CLAUDE_CONFIG_DIR/plans`) | ask (outside the workspace) | allow | deny |
| Write outside the workspace | ask once | deny | deny |
| Credential file read or write | ask once (a write in Plan or Ask is denied first) | ask / deny | ask / deny |
| Read-only command (`git status`, `ls`, `rg`) | allow | allow | allow |
| Other command | ask | ask | ask |
| Destructive command | ask once | ask once | ask once |
| Web (WebFetch, WebSearch) | ask | allow | allow |
| MCP or unknown tool | ask | ask | ask |

Session switches (`claudeSessionSwitches.ts` badges, `claudePermissionCard.ts`, `ClaudePermissionService`):

- **Allow All Commands** (card button, Alt+A): every later shell command in the session runs without a card, except destructive and credential commands.
- **Allow Everything** (card link and mode menu): every request that would ask is approved, including destructive commands, network, MCP and writes outside the workspace. Rails that hold: never in an untrusted workspace (the control is disabled with "Trust this workspace first", and the host ignores the switch), credential files and credential commands still ask, a setting that denies still denies, and Plan and Ask keep their file limits.
- Plan writes are checked on the canonical path and again after following symlinks, so a `x.plan.md` link to a source file is denied.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudePermissionModes.test.ts` | Claude permission modes and session switches | "GATE: Agent, Plan and Ask allow, ask and deny exactly what Phase 27 says" |
| `src/vs/platform/claude/test/node/claudePermissionModes.test.ts` | Claude permission modes and session switches | "GATE: Allow Everything approves every request that would ask, except credentials; modes keep their file limits" |
| `src/vs/platform/claude/test/node/claudePermissionModes.test.ts` | Claude permission modes and session switches | "a setting that refuses still refuses under Allow Everything" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: plan files and modes (Phase 27) | "Plan writes only plan files, after following symlinks" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "Allow Everything runs destructive commands and outside writes, but never credentials, and only in a trusted workspace" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission service | "Allow Everything asks first; Cancel leaves the card waiting and the switch off" |
| `src/vs/workbench/contrib/claude/test/browser/claudePermissionCard.test.ts` | Claude permission card (Phase 27) | "Enter allows once, Alt+A allows all commands, Escape denies, and each button sends its choice" |

## §40 requirements

### Workspace Trust

Requirements: respect Workspace Trust, and allow no Agent writes or shell commands in an untrusted workspace until trust is granted or a request is narrowly approved.

- **Policy:** `applyTrust` and `evaluateToolPolicy` in `src/vs/platform/claude/common/claudeToolPolicy.ts`.
- **Trust state per turn:** `ClaudeAgentService` (`src/vs/workbench/services/claude/common/claudeAgentService.ts`) passes `workspaceTrusted: this._trust.isWorkspaceTrusted()` on every begin and send. `ClaudeAgentRunner.send` restarts the query when the value changes.
- **Project configuration:** `claudeSettingSourcesFor` (`src/vs/platform/claude/node/claudeAgentRunner.ts`) loads only the `user` setting source in an untrusted workspace, and the query sets `strictMcpConfig`. An untrusted repository's `.claude/settings.json` hooks and `.mcp.json` servers therefore do not load. `claudeSdkFlagsFromOptions` (`src/vs/platform/claude/node/claudeSdkAdapter.ts`) passes both values to the SDK.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "an untrusted or unknown-trust workspace loads only user settings and no MCP configuration from disk" |
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "the SDK options carry the same sources and the strict MCP flag" |
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "granting trust takes effect on the next turn: project settings load and the policy relaxes" |
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "revoking trust between turns restarts the query without project settings" |
| `src/vs/platform/claude/test/node/claudeWorkspaceTrust.test.ts` | Claude workspace trust | "a turn with unchanged or unreported trust reuses the open query" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "an untrusted workspace never gets an automatic write, command, or fetch, and nothing is remembered" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission service | "the first message carries the workspace folders and the trust state" |

Known limit: a trust change takes effect when the running turn ends, because the SDK fixes its setting sources when the query opens. This is listed under [Deferred](#deferred-and-out-of-phase-items).

### Canonicalize paths before permission checks

- `canonicalizePath`, `isInsideWorkspace`, `resolveRealPath`, `assessPath` and `isCredentialPath` in `src/vs/platform/claude/common/claudeToolPolicy.ts`.
- `ClaudePermissionHost` (`src/vs/platform/claude/node/claudePermissionHost.ts`) passes the real `realpath` of the file system.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "canonicalizePath resolves relative paths and removes traversal" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "isInsideWorkspace is exact: a sibling that shares a prefix is outside" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "Windows paths compare without case and with either separator" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "additional directories are readable but not inside the workspace" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "credential files are recognised, templates are not" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "every path a read or search tool names is checked, not only the first field" |

### Block traversal and symlink escapes

- `assessPath` checks both the lexical path and the real path. A new file is resolved through its parent folder.
- `evaluateToolPolicy` treats a write whose real path leaves the workspace as outside it, and the permission card shows the absolute path.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "a traversal that leaves the workspace is outside" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "a symlink inside the workspace that points outside is caught by the re-check" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "a new file resolves through its parent, so a link in the parent still counts" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: paths | "a workspace folder that is itself a symlink still contains its files" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "a write through a symlink that leaves the workspace is treated as outside" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "a symlink that leaves the workspace is caught in a Glob prefix, an LS path, and a relative command argument" |
| `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts` | Claude tool policy: decisions | "a write outside the workspace asks once only, or is denied by setting" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "a symlink inside the workspace that leads outside is asked about as outside (real file system)" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a write outside the workspace shows the absolute target" |

### Redact known secret values from logs

- **Shared pattern list:** `CLAUDE_SECRET_PATTERNS` and `redactClaudeSecrets` in `src/vs/platform/claude/common/claudeSecretPatterns.ts`.
- **Log redaction:** `redactSecrets`, `formatClaudeAgentEvent` and `formatClaudeLogLine` in `src/vs/workbench/services/claude/common/claudeAgentLog.ts` delegate to that list.
- **Tool output:** command output is redacted before it is stored on a card (`appendCardOutput` and `completedOutputDelta` in `src/vs/workbench/services/claude/common/claudeToolCards.ts`).
- **Checkpoint log:** checkpoint log lines go through `formatClaudeLogLine` (`NativeClaudeCheckpointService`).

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "redacts credential-shaped text" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "redacts json keys, prefixed env names, and GitHub tokens" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "redacts PEM private key blocks and JWTs through the shared pattern list" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "a free-form log line is redacted and ends in exactly one newline" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "logs tool names and drops file contents" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "file write lines keep the local file name but never the file contents" |
| `src/vs/platform/claude/test/common/claudeSecretPatterns.test.ts` | Claude secret patterns | "PEM private key bodies are removed and the armor lines stay" |
| `src/vs/platform/claude/test/common/claudeSecretPatterns.test.ts` | Claude secret patterns | "JWTs are redacted wherever they appear" |
| `src/vs/workbench/services/claude/test/common/claudeToolCards.test.ts` | Claude tool cards | "a full-output completion past the line cap adds only the unstreamed tail, with secrets redacted" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a long command log keeps only the unstreamed tail and redacts a secret" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission state | "the log line for a decision omits the command and the path" |

### Never show authentication tokens in debug output

- **Probe:** `probeClaudeRuntime` (`src/vs/platform/claude/node/claudeRuntime.ts`) keeps only the version and auth mode from `claude auth status`, never account fields or tokens.
- **Session inspector:** the inspector shows redacted, normalized events, and raw SDK messages only when `claude.debug.retainRawEvents` is on.
- **Sent prompt:** Show sent prompt is redacted.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "probes the runtimePath override and reads auth status without keeping account fields" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "logs runtime version and a redacted error" |
| `src/vs/workbench/services/claude/test/common/claudeToolCards.test.ts` | Claude tool cards | "the session inspector lists normalized events, filters them, redacts secrets, and hides raw messages" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "Show sent prompt redacts a key in the compiled prompt" |

### Sanitize rendered Markdown and HTML

- **Assistant text:** rendered only by `ClaudeTimelineRenderer.renderMarkdown` (`src/vs/workbench/contrib/claude/browser/chat/claudeTimelineRenderer.ts`), through the workbench `IMarkdownRendererService` with `isTrusted: false` and `supportThemeIcons: false`. Raw HTML is sanitized, and `command:`, `javascript:` and `data:` links are dropped.
- **Tool, MCP and permission text:** card targets, errors, output lines and permission cards are written with `textContent` only. They are never parsed as Markdown or HTML.
- **File links:** `ClaudeTimelineRenderer.linkifyFileReferences` links only text nodes outside code and links. It uses `findFileReferences` and `isSafeRelativePath` (`src/vs/workbench/contrib/claude/common/claudeFileReferences.ts`), which accept only workspace-relative paths without `..`, `.`, drive letters, UNC or schemes. `openReference` opens a file only inside a workspace folder.
- **Phase 23 audit of `linkifyFileReferences`:** no change was needed. The link is a `span` with `textContent`, so nothing in the matched text is interpreted.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/contrib/claude/test/browser/claudeSanitization.test.ts` | Claude Markdown and MCP sanitization | "raw HTML, command: links and javascript: links in assistant, tool and MCP text stay inert" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "unsafe Markdown stays inert" |
| `src/vs/workbench/contrib/claude/test/common/claudeFileReferences.test.ts` | Claude file references | "skips absolute paths, drive letters, and parent segments" |
| `src/vs/workbench/contrib/claude/test/common/claudeFileReferences.test.ts` | Claude file references | "URI schemes, traversal inside a path, UNC and home paths never become links" |
| `src/vs/platform/claude/test/common/claudePrompt.test.ts` | Claude prompt compiler | "compiles tagged blocks and escapes attachment metadata" (attachment metadata cannot break out of its prompt block) |

### Bound command output retained in the UI

`COMMAND_OUTPUT_LINE_CAP` and `retainLines` in `src/vs/workbench/services/claude/common/claudeToolCards.ts` keep a capped tail of the output. The full log goes to the Claude Command Log output channel.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/services/claude/test/common/claudeToolCards.test.ts` | Claude tool cards | "command output keeps a capped tail" |
| `src/vs/workbench/services/claude/test/common/claudeToolCards.test.ts` | Claude tool cards | "the inspector and command logs drop the oldest entries past the cap" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a long command log keeps only the unstreamed tail and redacts a secret" |

### Sandbox preview webviews

`parsePreviewUrl` accepts loopback `http` and `https` only. `buildPreviewDocument` sets a CSP with a nonce and a sandboxed iframe. `acceptPreviewRelay` accepts only explicit bridge messages. All three are in `src/vs/workbench/contrib/claude/common/claudePreview.ts`.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/contrib/claude/test/common/claudePreview.test.ts` | Claude browser preview | "opens only loopback http(s) addresses" |
| `src/vs/workbench/contrib/claude/test/common/claudePreview.test.ts` | Claude browser preview | "the preview document sandboxes the page and does not read its DOM" |
| `src/vs/workbench/contrib/claude/test/common/claudePreview.test.ts` | Claude browser preview | "the host bridge keeps other origins and uninstrumented elements out" |

### Keep a user-visible permission history per session

`ClaudePermissionHost.record` and `ClaudePermissionHost.history` (`src/vs/platform/claude/node/claudePermissionHost.ts`) keep the history. Each answered card collapses into a permission record in the timeline. A request that is pending when the session stops resolves as deny.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "the permission history lists every decision for the session, oldest first" |
| `src/vs/platform/claude/test/node/claudePermissionGate.test.ts` | Claude permission gate | "a pending request resolves to deny when the session is stopped, and the record says so" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a permission card shows the exact command and directory, takes focus, and collapses to a record once answered" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "Stop while a card is open leaves it recorded as denied" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission state | "a stopped turn leaves an open request denied, never allowed" |

### Maintain dependency and license scanning

- **Workflow:** `.github/workflows/dependency-scan.yml` runs only on `workflow_dispatch` (manual). It runs `npm audit --omit=dev --audit-level=high` for the root and `remote/` packages, then the license allowlist.
- **Script:** `build/klawly/check-licenses.ts` checks the production packages of each `package-lock.json` against `ALLOWED`. Each entry in `EXCEPTIONS` has a stated reason. The script has no dependencies.
- **Agent SDK notices:** `@anthropic-ai/claude-agent-sdk` 0.3.281 is listed in `cgmanifest.json` and `ThirdPartyNotices.txt`.
- **Proof:** the command output, not a unit test. Run `node build/klawly/check-licenses.ts . remote`. The 2026-10-06 run is recorded in the Phase 23 PR. It flags `@vscode/copilot-api` (GitHub terms that allow Code - OSS use for development only). `npm audit` reports high and critical advisories in upstream packages. Both are under [Deferred](#deferred-and-out-of-phase-items).

### Verify update signatures; sign production builds

These are not Phase 23 work. Phase 25 (Package, sign, notarize, update) owns them, and its plan holds their tests.

## §41 requirements

### The Claude process gets only an environment allowlist

- `claudeProcessEnvironment` (`src/vs/platform/claude/node/claudeRuntime.ts`) copies only allowlisted variables. The agent query and both probes (`--version` and `auth status`) use it.
- While `claude.telemetry.enabled` is off (the default), it also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_TELEMETRY=1`.
- The prompt compiler (`compilePrompt`, `src/vs/platform/claude/common/claudePrompt.ts`) never reads the environment.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "reports a missing runtime and copies only the environment allowlist" |
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "secret-bearing variables outside the allowlist never reach the Claude process" |
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "the version and auth probes run with the allowlisted environment, not the full one" |
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "telemetry off (the default) turns off Claude Code nonessential traffic; on leaves the user choice alone" |
| `src/vs/platform/claude/test/node/claudeNoPermissionBypass.test.ts` | Claude permission bypass is unavailable | "every mode and trust state opens the SDK in default permission mode with the IDE callbacks" (no bypass variable in the query env) |

### Secret scanner before bulk attachments are sent

- **Scanner:** `scanClaudeSecrets`, `countEnvelopeSecrets` and `removeEnvelopeSecrets` in `src/vs/platform/claude/common/claudeSecretScan.ts`. They use the same `CLAUDE_SECRET_PATTERNS` list as log redaction and skip the loose `logOnly` key/value patterns that would flag ordinary source code.
- **Formats covered:** AWS `AKIA`/`ASIA` key ids; GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_` tokens; Slack `xox*`; Google `AIza`; Stripe `sk_live_`/`rk_live_`; OpenAI-style `sk-`; Anthropic `sk-ant-`; JWTs; PEM private keys; `Bearer` tokens; connection strings with passwords (URL and `;Password=` forms); `.env` assignments to `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_KEY`, `*_PASS` and `*_PWD` names; and JSON `"password"`, `"token"` and `"api_key"` values.
- **What is scanned:** file, symbol and selection bodies, Git diffs, terminal output, pasted text, and the active editor selection that goes with the prompt.
- **Dialog:** `screenClaudeAttachmentSecrets` (`src/vs/workbench/contrib/claude/common/claudeSecretGuard.ts`) shows "This attachment appears to contain {0} secrets." through `IDialogService`, with Send Anyway, Remove Secrets (redact, then send) and Cancel. Its detail text says that detection is a best effort.
- **Where it runs:** the composer send, queue and queued-edit paths (`ClaudeComposer.screenSecrets` in `src/vs/workbench/contrib/claude/browser/chat/claudeComposer.ts`) and every action that sends (`ClaudeActionService.submitAction` in `src/vs/workbench/contrib/claude/browser/claudeActionService.ts`).
- **Setting:** `claude.security.scanAttachmentsForSecrets`, default `true` (`CLAUDE_SECURITY_SCAN_ATTACHMENTS_SETTING`).

| Test file | Suite | Test |
|---|---|---|
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "finds the common credential formats with their ranges" |
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "finds .env assignments and hides only the value" |
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "false positives: ordinary code, placeholders and look-alikes are not reported" |
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "overlapping matches count once and redaction agrees with the scanner" |
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "counts and removes secrets in every bulk attachment, and leaves the request alone" |
| `src/vs/platform/claude/test/common/claudeSecretScan.test.ts` | Claude secret scanner | "an active selection already sent as a chip is counted once" |
| `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts` | Claude attachment secret guard | "Send Anyway sends the attachments unchanged" |
| `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts` | Claude attachment secret guard | "Remove Secrets redacts each match and sends the rest" |
| `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts` | Claude attachment secret guard | "Cancel stops the send" |
| `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts` | Claude attachment secret guard | "one secret uses the singular message" |
| `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts` | Claude attachment secret guard | "no dialog when nothing is found or the setting is off" |
| `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts` | Claude agent pane shell | "a chip with a secret asks first: Remove Secrets sends it redacted, Cancel keeps the draft, Send Anyway sends it as is" |

### Do not claim perfect detection

The dialog detail, the `claude.security.scanAttachmentsForSecrets` description, the diagnostics README and the scanner JSDoc all say detection is a best effort. Proved by "Send Anyway sends the attachments unchanged" in `src/vs/workbench/contrib/claude/test/common/claudeSecretGuard.test.ts`, which checks the exact detail text.

## Phase 23 scope bullets

| Scope bullet | Where it is covered |
|---|---|
| Audit Workspace Trust gating | [Workspace Trust](#workspace-trust) and [untrusted is ask-once](#2-an-untrusted-workspace-is-ask-once) |
| Path and symlink enforcement | [Canonicalize paths](#canonicalize-paths-before-permission-checks) and [traversal and symlinks](#block-traversal-and-symlink-escapes) |
| Secret scanner with Send/Remove/Cancel | [Secret scanner](#secret-scanner-before-bulk-attachments-are-sent) |
| Environment pass-through allowlist for the Claude process | [Environment allowlist](#the-claude-process-gets-only-an-environment-allowlist) |
| Markdown/MCP sanitization | [Sanitize rendered Markdown and HTML](#sanitize-rendered-markdown-and-html) |
| Redacted diagnostics ZIP command | [Diagnostics export](#redacted-diagnostics-zip-51) |
| Dependency/license scanning | [Dependency and license scanning](#maintain-dependency-and-license-scanning) |
| Telemetry stays off and never includes code, prompts, file names or commands | [Telemetry](#telemetry-70) |

### Redacted diagnostics ZIP (§51)

- **Command:** Developer: Export Claude Agent Diagnostics (`claude.exportDiagnostics`, `registerClaudeDiagnosticsExport` in `src/vs/workbench/contrib/claude/electron-browser/claudeDiagnosticsExport.ts`). It asks for the target with `IFileDialogService` and writes the archive with `INativeHostService.createZipFile`.
- **Content:** `buildClaudeDiagnosticsFiles` (`src/vs/workbench/contrib/claude/common/claudeDiagnosticsExport.ts`) builds the files:
  - `versions.json`: product, Claude runtime and protocol versions, OS and architecture.
  - `configuration.json`: the `claude.*` settings, with secret-named text dropped.
  - `events.json`: event types and their counts, without content.
  - `errors.log`: error and stack lines.
  - `claude-agent.log`: the newest 2000 Claude Agent output lines.
- **Redaction:** everything passes through `redactClaudeSecrets`, the home folder becomes `~`, and each line is cut at 500 characters.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/contrib/claude/test/common/claudeDiagnosticsExport.test.ts` | Claude diagnostics export | "lists the expected files with versions, OS and the protocol version" |
| `src/vs/workbench/contrib/claude/test/common/claudeDiagnosticsExport.test.ts` | Claude diagnostics export | "secrets, prompts and file contents never reach the archive" |
| `src/vs/workbench/contrib/claude/test/common/claudeDiagnosticsExport.test.ts` | Claude diagnostics export | "configuration keeps ordinary values and drops secret-named text" |
| `src/vs/workbench/contrib/claude/test/common/claudeDiagnosticsExport.test.ts` | Claude diagnostics export | "events keep only their types, and errors keep error and stack lines" |
| `src/vs/workbench/contrib/claude/test/common/claudeDiagnosticsExport.test.ts` | Claude diagnostics export | "the log keeps the newest lines, cuts long lines, and works without a runtime" |

### Telemetry (§70)

- **Product telemetry:** `product.json` has `enableTelemetry: false` and no telemetry keys or endpoints.
- **Claude code:** no Claude code calls `ITelemetryService.publicLog*`. Only `ClaudePreviewEditor` names `ITelemetryService`, and only because the `EditorPane` base constructor requires it.
- **Setting:** `claude.telemetry.enabled` defaults to `false`. While it is off, Claude Code runs with nonessential traffic disabled (see [Environment allowlist](#the-claude-process-gets-only-an-environment-allowlist)).
- **Local logs:** the Claude Agent output channel is a local log. It omits prompts, file bodies and tool input, and permission log lines omit commands and paths.

| Test file | Suite | Test |
|---|---|---|
| `src/vs/workbench/contrib/claude/test/node/claudeTelemetry.test.ts` | Claude telemetry stays off | "no Claude code path calls ITelemetryService.publicLog*" |
| `src/vs/workbench/contrib/claude/test/node/claudeTelemetry.test.ts` | Claude telemetry stays off | "product.json keeps product telemetry off" |
| `src/vs/workbench/contrib/claude/test/node/claudeTelemetry.test.ts` | Claude telemetry stays off | "claude.telemetry.enabled is registered with default false" |
| `src/vs/platform/claude/test/node/claudeRuntime.test.ts` | Claude runtime probe | "telemetry off (the default) turns off Claude Code nonessential traffic; on leaves the user choice alone" |
| `src/vs/workbench/services/claude/test/common/claudeAgentLog.test.ts` | Claude agent log | "logs assistant size without the text" |
| `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts` | Claude permission state | "the log line for a decision omits the command and the path" |

## Other Phase 23 hardening

| Control | Enforcement | Test |
|---|---|---|
| `claude.agent.autoApproveWorkspaceReads=false` makes workspace reads ask | `readClaudePermissionPolicy` (`src/vs/platform/claude/common/claudeConfiguration.ts`), `evaluateToolPolicy`, `ClaudeAgentRunner.screenTool` | `src/vs/platform/claude/test/common/claudeToolPolicy.test.ts`, Claude tool policy: decisions, "with automatic read approval off, workspace reads and searches ask and can be remembered" |
| `claude.agent.saveBeforeCommands` saves (always) or asks (prompt) before a shell command | `ClaudeAgentRunner.beforeCommand`; `ClaudeSaveBeforeCommandsContribution` (`src/vs/workbench/contrib/claude/browser/claudeSaveBeforeCommands.ts`) | `src/vs/platform/claude/test/node/claudeSaveBeforeCommand.test.ts`, Claude save before commands, "a command that asks is saved for only after the user approves it, and a failing hook does not block it"; `src/vs/workbench/contrib/claude/test/browser/claudeSaveBeforeCommands.test.ts`, Claude save before commands contribution, "prompt asks with the command, saves only files on disk, and answers the runtime" |
| Import from VS Code/Cursor skips settings that start a program and keybindings that type into the terminal | `src/vs/workbench/contrib/claude/common/claudeImport.ts` | `src/vs/workbench/contrib/claude/test/common/claudeImport.test.ts`, Claude import from VS Code and Cursor, "settings that start a program or shell are skipped with a reason, look-alikes are imported" and "keybindings that type into the terminal are skipped, also inside runCommands; removing one is imported" |
| Ask refuses every file write; Plan writes only plan files; commands ask in every mode (Phase 27) | `evaluateModePolicy` (`src/vs/platform/claude/common/claudeModePolicy.ts`), `evaluateToolPolicy` (`claudeToolPolicy.ts`) | `src/vs/platform/claude/test/common/claudeModePolicy.test.ts`, Claude mode policy, "Ask denies every file write with a structured denial; Plan and Agent pass writes on to the host"; `src/vs/platform/claude/test/node/claudePermissionModes.test.ts`, "GATE: Agent, Plan and Ask allow, ask and deny exactly what Phase 27 says" |
| Losing workspace trust turns Allow All Commands and Allow Everything off for every session; trusting again does not restore them; a card asked while untrusted is never approved by a switch (Phase 27) | `ClaudeAgentService` (`onDidChangeTrust`), `ClaudePermissionService.respond` and `approveCovered` | `src/vs/workbench/services/claude/test/common/claudePermissionService.test.ts`, "losing workspace trust turns both switches off in the pane and the runtime, and trusting again does not turn them back on" and "a card asked before the workspace was trusted is not approved by a switch turned on later"; `src/vs/workbench/contrib/claude/test/browser/claudePaneShell.test.ts`, "the Allow Everything link confirms, approves the card and shows its badge; losing trust clears it and trusting again does not bring it back" |
| **Accepted risk (Phase 27):** with Allow All Commands (or Allow Everything) on, Plan and Ask run shell commands without a card, and a command such as `sed -i`, `echo > file` or `git checkout -- .` can change project files. The modes' "no file edits" rule covers file tools only. The switch is off by default, per session, never persisted, needs a trusted workspace, and its chip stays visible until turned off; destructive and credential commands still ask. Limiting the switch to non-writing commands in Plan and Ask is an open product decision. | `ClaudePermissionHost.evaluate` | `src/vs/platform/claude/test/node/claudePermissionModes.test.ts`, "GATE: Agent, Plan and Ask allow, ask and deny exactly what Phase 27 says" (commands follow the switch in every mode) |
| Tab completion never sends secret files | `ClaudeAutocompleteService` | `src/vs/workbench/services/claude/test/common/claudeAutocompleteService.test.ts`, Claude autocomplete service, "secret files never call the runtime" |

## Deferred and out-of-phase items

- **Trust revoked during a running turn** applies when that turn ends, because the SDK fixes setting sources when the query opens. Owner: Phase 26.
- **Live check of the SDK assumptions:** that `['user']` plus `strictMcpConfig` skips project hooks and `.mcp.json`, and that a PreToolUse `ask` for Read reaches `canUseTool`. Owner: Phase 24 (live contract suite).
- **Update signature verification and production signing.** Owner: Phase 25.
- **`@vscode/copilot-api`** is a production dependency, inherited from upstream, whose GitHub terms allow Code - OSS use for development only. The license check flags it. Owner: Phase 25 (packaging), which must remove it from the shipped build or get it cleared.
- **`npm audit` high and critical advisories** in upstream production packages (`shell-quote`, `undici`, `axios`, `adm-zip`). Owner: Phase 25, which updates them with the next upstream sync or a targeted lockfile update.
- **Secret scanner limits:** it does not scan YAML `key: value` secrets, chat references, or problem messages. It skips loose `password: x` shapes in source code to avoid false positives. Detection is a best effort.

## How to run the checklist

```sh
npm run transpile-client
npm run test-node -- --runGlob "vs/{platform/claude/test/**/*.test,workbench/services/claude/test/**/*.test,workbench/contrib/claude/test/{common,node}/**/*.test}.js"
npm run test-browser-no-install -- --browser chromium --runGlob "vs/workbench/contrib/{claude,claudeBackground}/test/browser/*.test.js"
node build/klawly/check-licenses.ts . remote
```
