---
description: Rules for Klawly workbench Claude services (sessions, context, permissions, checkpoints, review, autocomplete, background agents)
globs: src/vs/workbench/services/claude/**
alwaysApply: false
---

# Workbench Claude services (`src/vs/workbench/services/claude`)

## Service set (§75, §86)
- Declare every service with `createDecorator` and register it with `registerSingleton`:
  - `IClaudeAgentService`
  - `IClaudeSessionService`
  - `IClaudeContextService`
  - `IClaudeCheckpointService`
  - `IClaudeReviewService`
  - `IClaudePermissionService`
  - `IClaudeAutocompleteService`
  - `IClaudeBackgroundAgentService`
- Each service depends on `IClaudeRuntimeService` (or other services), never on the SDK. Each one must be testable with `FakeClaudeRuntimeService`.

## Sessions and state (§9, §26, §50, §71, §76, §88)
- UI state is event-sourced. A **pure** `reduceAgentState(state, event)` rebuilds the timeline, and replaying persisted events must give the same view.
- Persist normalized events to `<userData>/agent-sessions/<id>/events.jsonl`, append-only. When reading, tolerate a truncated final line.
- Write `session.json` and indexes atomically (tmp file, then rename). Persisted data has a `schemaVersion` and ordered migrations. Never drop history on upgrade.
- The IDE session ID stays stable. `claudeSessionId` is stored separately for resume. If resume fails, offer "Continue in new session" with a summary.
- On crash recovery, mark tools that were running as interrupted, keep checkpoints, and never auto-resume side effects.

## Context and prompt compilation (§11, §12, §25, §39, §92)
- Each submission becomes an `AgentEnvelope`, which `compilePrompt()` turns into tagged blocks (`<ide_request mode=…>`, `<active_editor>`, attachments, diagnostics). Escape metadata.
- Treat file contents as context, never as user instructions.
- Resolve attachments at send time from the **current text model**, so unsaved buffers are included. Only use a frozen snapshot when the UI explicitly says so.
- Never serialize the whole project. Truncate large Git diffs to a patch plus stat. Attach only a bounded terminal tail, and only on request.

## Permissions (§14, §17, §40, §91)
- The IDE is the authority. `canUseTool` → normalize → `policy.evaluate()` → if there is no automatic decision, ask the UI asynchronously.
- Mode policies are enforced here:
  - **Ask** is read-only and returns a structured denial for writes or mutating shell commands. Never silently switch modes.
  - **Plan** is read-only until Build.
  - **Agent** prompts according to settings.
- Grants are scoped `once`, `session`, or `workspace`. Keep a per-session permission history.

## Checkpoints and review (§18–20, §38, §77, §89, §90)
- Snapshot dirty buffers and Git state at turn start, and snapshot each file before an approved write. Detect changes from the filesystem, never from Claude's narration.
- Store blobs content-addressed by SHA-256 at `checkpoint-objects/ab/cdef…`, using tmp-then-rename writes. Stream large or binary files instead of holding them in memory.
- **Accept** marks a change reviewed and does not commit. **Reject** restores pre-change content and preserves unrelated later edits.
- Reject-hunk must check drift first: if the current text no longer equals `modifiedText`, raise `ReviewConflictError` and never overwrite user edits.
- Writes to open models go through text-model edits with undo stops, not raw disk overwrites.

## Autocomplete (§31, §32, §82, §93)
- Debounce, cancel the previous request on every edit or cursor move, and cache by (file hash, position, nearby-text hash).
- Discard a result if the token was cancelled, if the model `versionId` changed, or if the cursor position changed.
- Never mutate another file from Tab. A cross-file next edit only shows an affordance.

## Background agents (§29, §94)
- One Git worktree per parallel agent, under `<userData>/worktrees/<repo-hash>/<task-id>` on branch `agent/<task-id>`. Two sessions never write the same working tree.
- Apply works as diff → review preview → three-way apply → merge editor for conflicts. Never copy the worktree over the workspace.
