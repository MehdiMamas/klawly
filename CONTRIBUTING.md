# Contributing to Klawly

Thanks for helping. Open an [issue](https://github.com/MehdiMamas/klawly-ide/issues) first for anything bigger than a small fix, so we agree on the plan before code is written.

## Set up

```sh
git clone https://github.com/MehdiMamas/klawly-ide.git
cd klawly-ide
npm install
npm run compile
./scripts/code.sh
```

## Branches and pull requests

- Work on a branch and open a pull request into the branch the issue names (`v5-remake` while the remake is under way).
- Keep a pull request to one change. Describe what changed and how you checked it.
- CI must pass: typecheck, transpile, names check and node unit tests. Run `npm run check-names` and the tests that cover your change before you push.

## Code style

- Tabs, not spaces.
- Every user-visible string goes through `nls.localize`. Use title-style capitalization for commands, buttons and menu items.
- New source files carry the Microsoft copyright and MIT licence header used across the codebase.
- Klawly's own files must not name another AI editor; `npm run check-names` enforces this.
- Keep edits to upstream Code - OSS files small, so merging a newer upstream stays easy.

## Names and branding

The product is called Klawly and its command is `klawly`. Do not add "Visual Studio Code" or "VS Code" to anything a user can see. Upstream licence notices stay as they are.

## Licence

By contributing you agree that your work is released under the MIT licence in [LICENSE.txt](LICENSE.txt).
