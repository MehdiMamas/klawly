---
description: Product identity, CI, packaging, signing, update and release rules for Klawly
globs: product.json,product.overrides.json,build/**,resources/klawly/**,.github/workflows/**,UPSTREAM.md
alwaysApply: false
---

# Build, identity and release (§4, §53, §56–63, §68, §95)

## Identity (`product.json`)
- **Stable:** `nameShort`/`nameLong` `Klawly`, `applicationName` `klawly`, `dataFolderName` `.klawly`, `sharedDataFolderName` `.klawly-shared`, `win32MutexName` `klawly`, `win32AppUserModelId` `Klawly.Klawly`, `darwinBundleIdentifier` `com.klawly.ide`, `linuxIconName` `klawly`, `urlProtocol` `klawly`.
- **Insiders:** every identifier gets a distinct `-insiders` variant so both channels install side by side.
- Generate fresh GUIDs for all Windows AppIds. Never reuse VS Code GUIDs.
- Remove Microsoft telemetry keys, update URLs, and service endpoints. `extensionsGallery` points at Open VSX, and Install from VSIX stays enabled.
- About shows product version, Git commit, upstream base commit, `CLAUDE_PROTOCOL_VERSION`, build timestamp, and channel (§60).
- **Acceptance check:** installing Klawly must not touch VS Code settings, mutexes, protocol handlers, app data, or shortcuts.

## Upstream (§68)
- `UPSTREAM.md` records the current upstream SHA and version, the integration date, and the known conflict files.
- Sync only to upstream **release points**. Use `git merge --no-ff upstream/<tag>`, then `npm install`, compile, and run the full test matrix.

## CI matrix (§63)
- Targets:
  - `windows-latest` (win32-x64)
  - `macos-14` (darwin-arm64)
  - `macos-13` (darwin-x64)
  - `ubuntu-latest` (linux-x64)
  - ARM64 Windows and Linux on native or appropriate runners
- Separate jobs:
  1. lint
  2. unit
  3. compile
  4. agent contract
  5. workbench integration
  6. UI smoke
  7. package
  8. sign
  9. notarize (macOS)
  10. verify artifacts
  11. manifest
  12. publish
  13. post-install smoke
- Use the packaging task names (`npm run gulp klawly-<platform>-<arch>`, etc.) that exist at the pinned upstream revision. Read them from the repo and do not hard-code stale ones.

## Packaging and signing (§56–59)
- **Windows:** x64 and ARM64 installers, a portable ZIP, a per-user (non-admin) install, the `klawly://` handler, clean uninstall that keeps user data, and signed binaries.
- **macOS:** arm64 and x64 (plus universal if the size is acceptable), Developer ID signing, hardened runtime, correct entitlements, and notarization on macOS runners.
- **Linux:** x64 and ARM64 tar.gz, `.deb`, `.rpm`, and AppImage, with `.desktop` file, icons, and MIME/protocol registration.
- Certificates, profiles, and keys live **only in CI secrets**. Never commit them.

## Release entry point (§95)
- `node build/klawly/release.mjs --channel <stable|insiders> --version <semver>` runs these steps in order:
  1. validate CI, a clean tree, and the version
  2. compile and minify
  3. run tests
  4. package
  5. inject product metadata
  6. sign
  7. build the installer or archive
  8. compute SHA-256
  9. sign the manifest entry
  10. upload
- A final job collects the artifacts from all platforms and publishes one signed manifest per channel.

## Updates (§61, §62)
- Use our own update service and never Microsoft's.
- Manifest format: `{ version, channel, publishedAt, artifacts: { <platform>: { url, sha256, signature } } }`.
- Client flow:
  1. check the manifest
  2. compare versions
  3. download to temp
  4. verify SHA-256 and the signature
  5. stage
  6. prompt and restart
  7. health check
  8. roll back or report
- AppImage can self-replace after verification. For `.deb` and `.rpm`, notify the user or use the package repository.
- Test upgrading from version N-1 to N on every platform before a stable release.

## Held features stay out of releases
Code of a feature on hold (label `hold`, for example #1183) lives in a file named `*.held.ts`, a folder named `held`, or carries an `@klawly-held` comment. `build/klawly/check-held.ts` fails the Package workflow for any release tag while such code is in `src`, so a held feature cannot ship by accident (#1184). Lift the hold by renaming the code first.
