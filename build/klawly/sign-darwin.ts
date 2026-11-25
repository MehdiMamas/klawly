/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Klawly contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Signs and notarizes the macOS app and dmg on the self-hosted Mac (package.yml, issue 479).
// Usage:
//   node build/klawly/sign-darwin.ts detect          picks the signing mode, writes it to $GITHUB_ENV
//   node build/klawly/sign-darwin.ts app <Klawly.app> signs the app, then notarizes and staples it
//   node build/klawly/sign-darwin.ts dmg <file.dmg>  signs, notarizes and staples the dmg
//   node build/klawly/sign-darwin.ts check <Klawly.app> launches the signed app and checks it runs
// The credentials never leave the runner: the "Developer ID Application" identity lives in the
// runner user's login keychain and the notary credentials in the notarytool keychain profile
// `klawly-notary` (docs/relay.md, Signing on the Mac). This script only names them; it never reads,
// prints or exports a key, a certificate or a password. Without the identity it keeps the ad-hoc
// signature and warns in the run summary.
// Env: KLAWLY_MAC_SIGNING (auto | developer-id | ad-hoc, default auto), KLAWLY_NOTARY_PROFILE
// (default klawly-notary); `detect` sets KLAWLY_MAC_SIGN_MODE and KLAWLY_MAC_SIGN_IDENTITY.

import { execFileSync, spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';

type SignMode = 'developer-id' | 'ad-hoc';

const root = dirname(dirname(import.meta.dirname));
const notaryProfile = process.env['KLAWLY_NOTARY_PROFILE'] || 'klawly-notary';

function run(command: string, args: readonly string[]): string {
	return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runInherit(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): void {
	execFileSync(command, args, { stdio: 'inherit', env });
}

function summary(markdown: string): void {
	const file = process.env['GITHUB_STEP_SUMMARY'];
	if (file) {
		appendFileSync(file, `${markdown}\n`);
	}
}

function warn(message: string): void {
	console.log(`::warning title=macOS signing::${message}`);
	summary(`> [!WARNING]\n> ${message}\n`);
}

/** The first valid "Developer ID Application" code signing identity in the keychain search list. */
function findDeveloperIdentity(): { readonly hash: string; readonly name: string } | undefined {
	const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
	const groups = /^\s*\d+\)\s+(?<hash>[0-9A-F]{40})\s+"(?<name>Developer ID Application: [^"]+)"/m.exec(identities)?.groups;
	return groups && { hash: groups.hash, name: groups.name };
}

/** Undefined when notarytool can sign in with the stored keychain profile (it lists past submissions), else why it could not. */
function notaryProfileError(): string | undefined {
	const result = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', notaryProfile, '--output-format', 'json'], { encoding: 'utf8' });
	if (result.status === 0) {
		return undefined;
	}
	const output = `${result.stderr ?? ''}${result.error?.message ?? ''}`.trim().split('\n').slice(-5).join('\n');
	return output || `notarytool exited with status ${result.status}`;
}

function detect(): void {
	const requested = process.env['KLAWLY_MAC_SIGNING'] || 'auto';
	if (requested !== 'auto' && requested !== 'developer-id' && requested !== 'ad-hoc') {
		throw new Error(`mac-signing is auto, developer-id or ad-hoc, not ${requested}`);
	}
	let mode: SignMode = 'ad-hoc';
	let identity = '';
	if (requested === 'ad-hoc') {
		warn('Ad-hoc signature (mac-signing: ad-hoc). Gatekeeper blocks this build on another Mac until it is opened with right-click > Open.');
	} else {
		const found = findDeveloperIdentity();
		if (found) {
			const notaryError = notaryProfileError();
			if (notaryError) {
				throw new Error(`The runner has "${found.name}" but no working notarytool profile "${notaryProfile}". Run xcrun notarytool store-credentials ${notaryProfile} on the Mac (docs/relay.md, Signing on the Mac). notarytool said:\n${notaryError}`);
			}
			mode = 'developer-id';
			identity = found.hash;
			console.log(`Signing with "${found.name}", notarizing with profile ${notaryProfile}`);
		} else if (requested === 'developer-id') {
			throw new Error('mac-signing is developer-id, but the runner has no "Developer ID Application" identity (security find-identity -v -p codesigning). See docs/relay.md, Signing on the Mac.');
		} else {
			warn('No "Developer ID Application" identity on the runner, so the app keeps an ad-hoc signature and is not notarized. Gatekeeper blocks it on another Mac until it is opened with right-click > Open. See docs/relay.md, Signing on the Mac.');
		}
	}
	const env = process.env['GITHUB_ENV'];
	if (env) {
		appendFileSync(env, `KLAWLY_MAC_SIGN_MODE=${mode}\nKLAWLY_MAC_SIGN_IDENTITY=${identity}\n`);
	}
	console.log(`macOS signing: ${mode}`);
}

function signMode(): SignMode {
	const mode = process.env['KLAWLY_MAC_SIGN_MODE'];
	if (mode !== 'developer-id' && mode !== 'ad-hoc') {
		throw new Error('Run `node build/klawly/sign-darwin.ts detect` first: KLAWLY_MAC_SIGN_MODE is not set');
	}
	return mode;
}

function identity(): string {
	const hash = process.env['KLAWLY_MAC_SIGN_IDENTITY'];
	if (!hash) {
		throw new Error('KLAWLY_MAC_SIGN_IDENTITY is not set');
	}
	return hash;
}

/** Logs the executables and native modules outside the frameworks, the nested code that gets signed. */
function logNestedCode(app: string): void {
	const resources = join(app, 'Contents', 'Resources');
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(file);
			} else if (entry.isFile() && (entry.name.endsWith('.node') || (statSync(file).mode & 0o111) !== 0)) {
				found.push(relative(app, file));
			}
		}
	};
	walk(resources);
	console.log(`Executables and native modules in Contents/Resources (${found.length}):\n${found.sort().map(file => `  ${file}`).join('\n')}`);
}

/** Submits a zip or dmg to the notary service, waits for the verdict and prints the log when it is not accepted. */
function notarize(file: string): void {
	console.log(`Notarizing ${basename(file)} (profile ${notaryProfile})`);
	const result = spawnSync('xcrun', ['notarytool', 'submit', file, '--keychain-profile', notaryProfile, '--wait', '--timeout', '2h', '--output-format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
	let verdict: { id?: string; status?: string; message?: string } = {};
	try {
		verdict = JSON.parse(result.stdout);
	} catch {
		// Not JSON: notarytool failed before it submitted; its error went to stderr.
	}
	console.log(`Notary submission ${verdict.id ?? '(none)'}: ${verdict.status ?? 'no status'}${verdict.message ? ` (${verdict.message})` : ''}`);
	if (verdict.status !== 'Accepted') {
		if (verdict.id) {
			spawnSync('xcrun', ['notarytool', 'log', verdict.id, '--keychain-profile', notaryProfile], { stdio: 'inherit' });
		}
		throw new Error(`Notarization of ${basename(file)} failed: ${verdict.status ?? `notarytool exited with ${result.status}`}`);
	}
}

function staple(file: string): void {
	runInherit('xcrun', ['stapler', 'staple', file]);
	runInherit('xcrun', ['stapler', 'validate', file]);
}

/** Fails unless spctl accepts the file as notarized Developer ID code; spctl writes its verdict to stderr. */
function assessNotarized(args: readonly string[]): void {
	const result = spawnSync('spctl', ['--assess', '-vvv', ...args], { encoding: 'utf8' });
	const output = `${result.stdout}${result.stderr}`.trim();
	console.log(output);
	if (result.status !== 0 || !output.includes('source=Notarized Developer ID')) {
		throw new Error(`Gatekeeper does not accept ${args[args.length - 1]} as notarized Developer ID code`);
	}
}

function signApp(app: string): void {
	logNestedCode(app);
	if (signMode() === 'ad-hoc') {
		// Seal the whole bundle with an ad-hoc signature. The build leaves only the linker's
		// signature on the main binary, which a downloaded copy reports as "damaged" on Apple silicon.
		runInherit('codesign', ['--force', '--deep', '--sign', '-', app]);
		runInherit('codesign', ['--verify', '--deep', '--strict', app]);
		return;
	}

	// Upstream's signer (@electron/osx-sign): every nested binary inside-out with hardened runtime, a
	// secure timestamp and upstream's entitlements per helper, then the app; it also writes the
	// permission prompts into Info.plist. Without AGENT_TEMPDIRECTORY it uses the login keychain.
	const env = { ...process.env };
	delete env.AGENT_TEMPDIRECTORY;
	runInherit(process.execPath, [join(root, 'build', 'darwin', 'sign.ts'), dirname(dirname(app))], { ...env, CODESIGN_IDENTITY: identity(), VSCODE_ARCH: basename(dirname(app)).replace(/^Klawly-darwin-/, '') });
	runInherit('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
	const details = spawnSync('codesign', ['--display', '--verbose=2', app], { encoding: 'utf8' });
	if (!`${details.stdout}${details.stderr}`.includes('Authority=Developer ID Application:')) {
		throw new Error(`${app} is not signed with a Developer ID Application identity`);
	}

	// notarytool takes a zip, a dmg or a pkg, not a bare bundle; ditto keeps the framework symlinks.
	const temp = mkdtempSync(join(process.env['RUNNER_TEMP'] || tmpdir(), 'klawly-notarize-'));
	try {
		const zip = join(temp, `${basename(app, '.app')}.zip`);
		runInherit('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
		notarize(zip);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	staple(app);
	assessNotarized(['--type', 'execute', app]);
	summary(`Signed with Developer ID, notarized and stapled: \`${basename(app)}\``);
}

function signDmg(dmg: string): void {
	if (signMode() === 'ad-hoc') {
		return;
	}
	runInherit('codesign', ['--force', '--sign', identity(), '--timestamp', dmg]);
	runInherit('codesign', ['--verify', '--strict', '--verbose=2', dmg]);
	notarize(dmg);
	staple(dmg);
	assessNotarized(['--type', 'open', '--context', 'context:primary-signature', dmg]);
	summary(`Signed with Developer ID, notarized and stapled: \`${basename(dmg)}\``);
}

// Runs inside the app's own main binary as Node (ELECTRON_RUN_AS_NODE), so the hardened runtime and
// library validation apply: loads the native modules from the bundle, runs a command through node-pty
// (its signed spawn-helper) and spawns the user's claude CLI. Prints one line per check.
const inAppChecks = `
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const appRoot = process.env.KLAWLY_APP_ROOT;
const modules = fs.existsSync(path.join(appRoot, 'node_modules.asar')) ? path.join(appRoot, 'node_modules.asar') : path.join(appRoot, 'node_modules');
// Same lookup as enableASARSupport in src/bootstrap-node.ts, which -e skips: dependencies inside the archive resolve there.
const Module = require('module');
const resolveLookupPaths = Module._resolveLookupPaths;
Module._resolveLookupPaths = (request, parent) => {
	const paths = resolveLookupPaths(request, parent);
	const index = Array.isArray(paths) ? paths.indexOf(path.join(appRoot, 'node_modules')) : -1;
	if (index >= 0) { paths.splice(index, 0, path.join(appRoot, 'node_modules.asar')); }
	return paths;
};
let failed = false;
const report = (name, ok, detail) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ': ' + detail : '')); failed ||= !ok; };
for (const name of ['node-pty', '@vscode/spdlog', '@vscode/sqlite3', '@parcel/watcher', 'native-keymap', '@vscode/policy-watcher']) {
	try { require(path.join(modules, name)); report('load ' + name, true); } catch (error) { report('load ' + name, false, String(error && error.message || error)); }
}
const home = os.homedir();
const pathWithClaude = [process.env.PATH, home + '/.local/bin', home + '/.claude/local', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: pathWithClaude } });
if (claude.error && claude.error.code === 'ENOENT') {
	console.log('skip claude --version: no claude CLI on the runner PATH, ~/.local/bin, /opt/homebrew/bin or /usr/local/bin');
} else {
	report('spawn claude --version', claude.status === 0, (claude.stdout || '').trim() || String(claude.error || claude.stderr).trim());
}
let output = '';
const pty = require(path.join(modules, 'node-pty')).spawn('/bin/sh', ['-c', 'echo pty-ok'], { cols: 80, rows: 24, env: process.env });
pty.onData(data => { output += data; });
const timer = setTimeout(() => { report('node-pty spawn', false, 'no exit in 15s'); process.exit(1); }, 15000);
pty.onExit(({ exitCode }) => {
	clearTimeout(timer);
	report('node-pty spawn', exitCode === 0 && output.includes('pty-ok'), 'exit ' + exitCode + ', output ' + JSON.stringify(output.trim()));
	process.exit(failed ? 1 : 0);
});
`;

/** Waits until `ready()` holds, the process exits, or the timeout passes. */
async function waitFor(ready: () => boolean, exited: () => boolean, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
	for (const end = Date.now() + timeoutMs; Date.now() < end;) {
		if (ready()) {
			return 'ready';
		}
		if (exited()) {
			return 'exited';
		}
		await new Promise(done => setTimeout(done, 1000));
	}
	return 'timeout';
}

function readIfExists(file: string): string {
	return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Proves the signed, hardened app runs (issue 479): the CLI prints its version, the main binary as Node
 * loads the bundle's native modules, runs node-pty and spawns claude, and a full launch with a throwaway
 * profile reaches the workbench and starts the extension host (the Plugin helper) before it is quit.
 */
async function checkApp(app: string): Promise<void> {
	const resources = join(app, 'Contents', 'Resources', 'app');
	const product = JSON.parse(readFileSync(join(resources, 'product.json'), 'utf8')) as { nameShort: string };
	const binary = join(app, 'Contents', 'MacOS', product.nameShort);

	console.log(`codesign flags: ${/flags=\S+/.exec(spawnSync('codesign', ['--display', '--verbose=2', app], { encoding: 'utf8' }).stderr)?.[0] ?? 'unknown'}`);
	// The macOS shortcut is always bin/code (build/gulpfile.vscode.ts); "Install Command in PATH" names its link after applicationName.
	const cli = spawnSync(join(resources, 'bin', 'code'), ['--version'], { encoding: 'utf8', timeout: 60000 });
	console.log(`bin/code --version (exit ${cli.status}):\n${`${cli.stdout ?? ''}${cli.stderr ?? ''}`.trim()}`);
	if (cli.status !== 0) {
		throw new Error(`The signed app's CLI failed: bin/code --version exited with ${cli.error?.message ?? cli.status ?? cli.signal}`);
	}

	const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KLAWLY_APP_ROOT: resources };
	delete env.NODE_OPTIONS;
	const inApp = spawnSync(binary, ['-e', inAppChecks], { encoding: 'utf8', timeout: 120000, env });
	console.log(`${`${inApp.stdout ?? ''}${inApp.stderr ?? ''}`.trim()}\nIn-app checks exited with ${inApp.error?.message ?? inApp.status ?? inApp.signal}`);
	if (inApp.status !== 0) {
		throw new Error('The signed app could not load its native modules, run node-pty or spawn claude (see above)');
	}

	const temp = mkdtempSync(join(process.env['RUNNER_TEMP'] || tmpdir(), 'klawly-launch-'));
	const logs = join(temp, 'logs');
	const rendererLog = join(logs, 'window1', 'renderer.log');
	const launchEnv = { ...process.env };
	delete launchEnv.ELECTRON_RUN_AS_NODE;
	const child = spawn(binary, [`--user-data-dir=${join(temp, 'user')}`, `--extensions-dir=${join(temp, 'extensions')}`, `--logsPath=${logs}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window'], { detached: true, stdio: 'ignore', env: launchEnv });
	let exit: string | undefined;
	child.once('exit', (code, signal) => exit = `code ${code}, signal ${signal}`);
	try {
		const outcome = await waitFor(() => readIfExists(rendererLog).includes('Started local extension host'), () => exit !== undefined, 120000);
		const tail = (file: string) => readIfExists(file).trim().split('\n').slice(-15).join('\n');
		if (outcome !== 'ready') {
			console.log(`main.log:\n${tail(join(logs, 'main.log'))}\nrenderer.log:\n${tail(rendererLog)}`);
			throw new Error(outcome === 'exited' ? `The signed app exited during startup (${exit})` : 'The signed app did not reach the workbench in 120s');
		}
		console.log(`Launch: the workbench loaded and started the extension host:\n${readIfExists(rendererLog).split('\n').filter(line => line.includes('Started local extension host')).join('\n')}`);
		summary(`Signed app ran: CLI version, native modules, node-pty, workbench and extension host (\`${basename(app)}\`)`);
	} finally {
		const pid = child.pid;
		if (exit === undefined && pid) {
			// SIGTERM to the main process alone makes Electron quit and close its windows; signalling
			// the whole group kills the renderer first and leaves a "window terminated unexpectedly"
			// dialog on the runner's screen. The group (the app runs in its own) is the fallback.
			const signal = (target: number, name: NodeJS.Signals) => {
				try {
					process.kill(target, name);
				} catch {
					// Already gone.
				}
			};
			signal(pid, 'SIGTERM');
			if (await waitFor(() => exit !== undefined, () => false, 20000) !== 'ready') {
				signal(-pid, 'SIGKILL');
			}
		}
		rmSync(temp, { recursive: true, force: true });
	}
}

async function main(command: string | undefined, target: string | undefined): Promise<void> {
	if (command === 'detect') {
		detect();
	} else if ((command === 'app' || command === 'dmg') && target) {
		(command === 'app' ? signApp : signDmg)(resolve(target));
	} else if (command === 'check' && target) {
		await checkApp(resolve(target));
	} else {
		throw new Error('Usage: node build/klawly/sign-darwin.ts detect | app <Klawly.app> | dmg <file.dmg> | check <Klawly.app>');
	}
}

if (import.meta.main) {
	await main(process.argv[2], process.argv[3]);
}
