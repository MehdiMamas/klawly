# Klawly

Klawly is a desktop code editor built on [Code - OSS](https://github.com/microsoft/vscode), the open source core of Visual Studio Code. This branch is a fresh remake of Klawly on that base.

## Run it from source

You need Node.js (the version in `.nvmrc`), Git, Python 3 and a C++ toolchain for native modules.

```sh
npm install
npm run compile
./scripts/code.sh
```

On Windows run `scripts\code.bat` instead.

## The `klawly` command

Open the Command Palette and run **Shell Command: Install 'klawly' command in PATH** (macOS). The Windows and Linux packages put `klawly` on your PATH when you install them.

```sh
klawly .            # open the current folder
klawly --help       # all options
```

## Checks

| Command | What it checks |
| --- | --- |
| `npm run typecheck-client` | TypeScript types for `src/` |
| `npm run transpile-client` | the client builds |
| `npm run test-node` | node unit tests |
| `npm run check-names` | Klawly's own files name no other AI editor |

CI runs these on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT. See [LICENSE.txt](LICENSE.txt). Klawly includes code from Code - OSS, copyright Microsoft Corporation, under the same licence; third-party notices are in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
