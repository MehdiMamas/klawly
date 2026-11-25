---
description: Rules for the privileged Claude platform service and Agent SDK adapter
globs: src/vs/platform/claude/**
alwaysApply: false
---

# Claude platform layer (`src/vs/platform/claude`)

## Boundaries (§5, §74)
- `common/` holds contracts and DTOs: `claude.ts`, `claudeProtocol.ts`, `claudeContext.ts`, `claudePermissions.ts`, `claudeStorage.ts`, `claudeActions.ts`. `fakeClaudeRuntimeService.ts` is the one runtime allowed there: Phase 24 end-to-end tests replay it from the product build, and it imports no Node modules. No other `common/` file may import Node.
- `node/` is the only place in the codebase that imports `@anthropic-ai/claude-agent-sdk`, `child_process`, or `fs` for agent work.
- The workbench interacts with the engine only through `IClaudeRuntimeService`, exposed across the Code - OSS IPC/process boundary. Never expose SDK types through that interface.

## Agent SDK usage (§7, §35, §69)
- Pin the SDK version exactly. Wrap it in a `ClaudeSdkAdapter` (`start`, `cancel`, `capabilities`) so upgrades touch one file.
- Call `query()` with `cwd`, `settingSources: ['user', 'project']` in a trusted workspace (only `['user']` plus `strictMcpConfig: true` when the workspace is untrusted or trust is unknown, so project hooks and `.mcp.json` never load before trust), `resume`, `allowedTools`, `additionalDirectories`, `maxTurns`, and `canUseTool` delegated to the host permission bridge. The permission mode is `default` (or `plan` for a side question), and `bypassPermissions` only for the confirmed Allow Everything level in Agent mode in a trusted workspace (`claudeRunsUnasked`, issue 694), switched live with `setPermissionMode`. Preserve the user's `CLAUDE.md`, skills, and MCP config. Do not inject a large hidden system prompt.
- Subagent messages carry `parent_tool_use_id`; normalize it to `parentRunId` on every event and never drop or flatten subagent events (§16a). Klawly's own agent definitions go in the SDK `agents` option and never override a user agent with the same name.
- Models come from the SDK's supported-models data; switching uses the SDK's live model switch when available, otherwise `model` on the next resumed `query()` (§34b).
- Autocomplete uses a separate constrained invocation: no tools, one turn, small context, strict plain-text output (§31).
- Use the SDK's interrupt or cancel mechanism on stop. If that fails, terminate child work safely. Pending permission requests resolve to deny.

## Normalization (§8, §76)
- Convert every SDK message **immediately** into `NormalizedClaudeEvent`. Raw SDK shapes must not leave `claudeStreamNormalizer.ts`.
- Unknown or new message types are logged at debug level and dropped (or mapped to a safe generic event). They must never throw or crash a session.
- Classify tools with `classifyTool()` into `read`, `write`, `search`, `shell`, `web`, `skill`, `mcp`, or `other`.
- Keep `CLAUDE_PROTOCOL_VERSION` and bump it on any breaking protocol change.

## Runtime and auth (§6, §69)
- Probe with `execFile(binary, ['--version'], { timeout, windowsHide: true })`. Honor the `claude.agent.runtimePath` setting.
- Detect auth state only through supported SDK or CLI signals. Sign-in launches the official `claude` login flow (integrated terminal or browser), after which the runtime is re-probed.
- Store only our own metadata (runtime path, last version). Credentials stay in Claude's own store.
- Compare the runtime version against a tested range. For unknown newer versions, warn and log. Hard-block only known-bad versions.
- Map errors to `AgentFailureKind`: `auth`, `usage-limit`, `network`, `runtime-missing`, `runtime-version`, `permission-denied`, `tool-failure`, `process-crash`, `workspace-conflict`, or `unknown` (§28).

## Processes and paths (§55)
- Pass argument arrays and never build shell strings. Normalize paths through `URI` and the file services, never by string slicing.
- Pass the Claude process an explicit environment allowlist. Never forward the full environment blindly (§41).

## Logging (§51)
- The "Claude Agent" output channel may log versions, lifecycle events, tool names, timings, and errors.
- Never log tokens, API keys, secret-bearing environment variables, full file contents, or hidden reasoning.
- Raw SDK events may be logged only behind an explicit developer setting.
