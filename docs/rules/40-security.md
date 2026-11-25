---
description: Apply when touching permissions, shell/file tools, path handling, secrets, logging, Markdown/MCP rendering, webviews/preview, workspace trust, or the update system
globs:
alwaysApply: false
---

# Security and trust model (§17, §37, §40, §41, §62)

## Trust boundaries
Workspace files, repo instructions, terminal output, and MCP content are **untrusted**. Claude tool requests pass through the **IDE permission policy**, which is the only trusted enforcement point. Nothing reaches the filesystem, shell, or network without passing that policy. The one exception is the confirmed Allow Everything level in Agent mode in a trusted workspace, which runs Claude Code in its bypass permissions mode (issue 694); only `claudeSdkAdapter.ts` and `claudeUnaskedPolicy.ts` may name that mode, and `claudeNoPermissionBypass.test.ts` holds it there.

## Required controls
- **Workspace Trust:** in an untrusted workspace, no Agent writes or shell commands run until trust is granted or narrowly approved.
- **Paths:**
  - Canonicalize before every check, using `isInsideWorkspace(target, roots)` built on `isEqualOrParent`.
  - Re-check after resolving symlinks for writes.
  - Block traversal and symlink escapes.
  - Writes outside the workspace are denied or explicitly prompted, and the prompt shows the absolute path.
- **Commands:**
  - Classify with the destructive-pattern regexes (`rm -rf`, `del /s`, `format`, `git reset --hard`, `git clean -f`, `drop database`, …), plus tool type, target, trust, and settings.
  - Regex is only a first pass.
  - Never auto-allow commands that touch credentials, keychains, SSH keys, or auth configuration.
  - Show the exact command and cwd **before** approval.
- **Permission requests:** if the session stops while a request is waiting, resolve it as deny. Keep a per-session permission history visible to the user.
- **Secrets:**
  - Pass the Claude process an environment allowlist.
  - Run the optional secret scanner on bulk attachments, offering [Send anyway] [Remove secrets] [Cancel]. Never claim detection is perfect.
  - Redact known secret values from logs and exports. Never print auth tokens.
- **Rendering:** use the Code - OSS Markdown sanitizer. Never inject unsanitized MCP or HTML into the workbench.
- **Browser preview:** use a sandboxed webview with strict origin isolation. Bridge only explicit data (screenshot, console errors, selected element). Never weaken Electron or webview security globally.
- **Telemetry:** off by default. Never send code, prompts, filenames, commands, terminal output, or conversation text (§70).
- **Updates:**
  - HTTPS plus SHA-256 plus a product signature, verified before staging.
  - A compromised update server alone must not be able to run an unsigned binary.
  - Signing material lives only in CI secrets.
- **Diagnostics export:** produces a redacted ZIP only (§51).

## Tests to accompany any change here
Add unit tests for the path guard (spaces, Unicode, long Windows paths, symlinks, case collisions, multi-root), the command classifier, and the permission policy. One example: a test that a write outside the workspace is denied.
