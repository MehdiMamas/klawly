---
description: Klawly core product contract, architecture boundaries, legal limits and workflow
globs:
alwaysApply: true
---

# Klawly – core rules

The long-form spec is `KLAWLY_MASTER_PLAN.md`; rules cite it as §N. Read the cited sections before changing that area. The old phase plans, progress log and phase runbook are archived in `docs/archive/phasing/` for reference; they no longer drive the work.

## Product contract (§1, §98)
- Klawly is a **fork of Code - OSS** (microsoft/vscode) that ships as its own Electron desktop IDE.
- Never turn the AI features into a VS Code extension, webview app, web wrapper, or GUI over the Claude terminal. The Claude integration is first-party code under `src/vs/platform/claude`, `src/vs/workbench/services/claude`, and `src/vs/workbench/contrib/claude*`.
- End users can still install normal extensions (languages, debuggers, themes).
- Division of work:
  - **Code - OSS** owns editor infrastructure: reuse it and do not rewrite it.
  - **Claude Agent SDK** owns agent reasoning and tool use: do not reimplement the model loop.
  - **Our code** owns the experience: context, permissions, review, checkpoints, and UI.
- The user should never need to open a separate Claude terminal.

## Dependency direction (§74)
```
workbench UI (contrib/claude) -> workbench Claude services -> platform Claude service -> Node/Agent SDK adapter
```
- Only `src/vs/platform/claude/node/**` may import `@anthropic-ai/claude-agent-sdk` or `child_process`.
- UI never touches auth/token files, never spawns processes, and never writes files directly. Writes go through Claude tools or the checkpoint/review services.
- The agent runner never touches the DOM.
- Respect the Code - OSS layering (`common` / `browser` / `node` / `electron-*`) and its import rules (`npm run valid-layers-check` or the current equivalent).

## Upstream hygiene (§3, §68)
- Put new functionality in **new files and directories**. Register it through existing contribution and service registries.
- Keep edits to upstream files as small as possible, with no reformatting or refactoring of upstream code. Record every touched upstream file in `UPSTREAM.md`.
- After an upstream merge, carry Klawly's design practices to new and changed VS Code UI (rule 37, "When upstream changes" in `design/LANGUAGE.md`), and decide each new Copilot and Agents-window feature in `FEATURES.md` section 6 (rule 38).
- Follow upstream coding conventions: tabs, single quotes, `localize`/`localize2` for UI strings, `Disposable`/`_register` for lifetimes, `createDecorator` + DI for services, and the MIT copyright header used by Klawly files.

## Identity and legal (§2, §4.3, §53)
- Product name is **Klawly**. IDs include `klawly`, `.klawly`, `com.klawly.ide`, and `klawly://`. Insiders uses separate `klawly-insiders` IDs.
- Never use Microsoft branding, the Visual Studio Marketplace, the Microsoft update service, or Microsoft telemetry endpoints. Use **Open VSX** and VSIX installs.
- Never copy another product's source, assets, logos, trademarks, or exact artwork. Reproduce the **interaction model** only.
- Use Claude only through official SDK and CLI flows. Never spoof the official app, never scrape or read Claude credential files, and never fake an authenticated state.

## Reliability
- Claude failures must **fail closed and locally**. The IDE must stay fully usable without Claude (§73).
- Never invent data the backend does not provide, such as quotas, usage, or account info (§47).
- Never auto-commit, auto-resume side-effecting tools, or loop verify/fix without a hard cap.

## Workflow
- Keep the tree compiling. Add tests alongside each feature (see `50-testing.md`).
- If the current Agent SDK or Code - OSS API differs from the master-plan snippets, adapt the adapter layer and keep the normalized protocol stable (§97).

## Identity strings: sibling spellings
- `code-oss-dev` is the Electron user-data dir. `.vscode-oss-dev` is a home folder. A leading dot, a `-dev` suffix and the other product's folder are different paths: search all of them, with no hit cap, and open every reader and writer.
- An npm `"name": "code-oss-dev"` is not a data folder; a `path.join` that contains the string is. Do not drop a page of hits because most are the first kind.
- Missed once: changing `code-oss-dev` in `src/vs/platform/environment/node/userDataPath.ts` left `~/.vscode-oss-dev/extensions/control.json` in `build/lib/builtInExtensions.ts` and `build/builtin/browser-main.js`. The scanner reads that file from `productService.dataFolderName`.
