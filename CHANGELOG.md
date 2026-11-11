# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [Unreleased]

## [1.4.2] - 2026-11-11

### Fixed

- `attach` now carries `networkPolicy: { constraints: [] }`. Extension 1.26.1102.11740 passes `e.networkPolicy` to `ar.getInstance().attach(tabId, e.networkPolicy)`, and that installer reads `options.timeoutMs` before any validation, so a request without the field threw `Cannot read properties of undefined (reading 'timeoutMs')` and the debugger never attached. Every CDP tool (`chrome_navigate`, `chrome_evaluate`, `chrome_screenshot`, `chrome_cdp_send`, `chrome_attach_tab`) failed on it. Empty constraints normalize to `defaultAction: "allow"` with no rules, and the installer returns before touching declarativeNetRequest, so the field adds no policy side effect. Verified against the live extension: plain `attach` fails, `attach` with the empty policy succeeds, `Page.navigate` and `Runtime.evaluate` run.

## [1.4.1] - 2026-07-04

### Fixed

- The self-heal now recognizes every string the extension uses for a lost debugger attachment, not just Chrome's `Debugger is not attached`. A concurrency race soak (`scripts/concurrency-check.mjs --inject-detach`, which detaches a tab mid-command) surfaced two more that were slipping through unhealed: `Debugger unattached` (the extension's own `se`-map check) and `Detached while handling command.` (detached mid-command). `isNotAttachedError` now matches all three, so `withSession` recovers them too. Under the race soak this took unrecovered "not attached" failures from a handful to zero.

## [1.4.0] - 2026-07-04

### Changed

- The debugger attach lifecycle now mirrors the official Codex `browser-client.mjs` discipline instead of trusting the extension's idempotent `attach`. A new `ensureAttached` attaches and then issues `Target.setAutoAttach` (`autoAttach`/`flatten`), which keeps child frames/OOPIFs in the session and doubles as a real liveness probe; `withSession` wraps every CDP tool (`chrome_navigate`/`chrome_evaluate`/`chrome_screenshot`/`chrome_cdp_send`) so a stale or lost attachment — whether it surfaces at the probe or mid-command — is healed once via `detach` → re-attach → retry. `chrome_attach_tab` now verifies the attachment with a probe and reports the real result instead of a hardcoded `{ok:true}`. This supersedes the narrower per-tool self-heal added in 1.3.1/1.3.3.
- `turn_id` is now stable for the lifetime of the MCP process instead of freshly minted on every request. The extension scopes attach/lease state by `session_id` + `turn_id` (`resolveSession(t).attach(requireTurnId(t))`), so a churning turn re-keyed leases and reset session state on every call. One controller uses one stable turn, matching the official client's turn model.

### Added

- `scripts/concurrency-check.mjs`: a concurrency soak harness that runs N real client sessions against the live bridge and reports unrecovered "not attached" failures (the regression signal) and how many self-heals engaged.
- [`docs/troubleshooting.md`](docs/troubleshooting.md): a debugging playbook and the reference points (official `browser-client.mjs`, the extension service worker's `se`/attach internals) for future debugger/attach investigations. `docs/architecture.md` gained a "Debugger Attach Lifecycle" section.

## [1.3.3] - 2026-07-04

### Fixed

- `chrome_cdp_send` now attaches first and self-heals a stale debugger attachment, matching `chrome_evaluate`/`chrome_navigate`/`chrome_screenshot` (added in 1.3.1). Previously it sent the raw CDP command with no preceding `attach` and no recovery, so any command routed through it (e.g. `Page.close`, `Network.enable`) dead-ended on `Debugger is not attached` whenever the attachment had gone stale — which happens more often when multiple sessions share one browser and contend for the single debugger per tab. It now wraps the command in the same attach → run → (on "not attached") detach → attach → retry-once helper. Note this only recovers one-shot commands: flows that need the debugger to stay attached over time (e.g. `Network.enable` then streaming events via `chrome_read_events`) remain fragile under contention, so prefer page-side APIs (Resource Timing / PerformanceObserver) there.

### Added

- `codex-control-chrome-mcp --version` (also `-v` and `version`) prints the package name and version. Previously the CLI had no way to report its own version, so `-v`/`--version` fell through to `Unknown command`.

## [1.3.1] - 2026-07-04

### Fixed

- `chrome_evaluate`, `chrome_navigate`, and `chrome_screenshot` now self-heal a stale debugger attachment instead of dead-ending on `Debugger is not attached`. Each tool already attaches before sending CDP commands, but the extension tracks attachments in memory: when Chrome tears an attachment down out-of-band (a competing debugger client, DevTools, or a renderer/process swap), that flag can go stale, so a fresh `attach` short-circuits and reports success without actually re-attaching and the next command fails with `Debugger is not attached`. The tab then stayed wedged — `attach` kept reporting `ok` while every command failed — and only a new tab recovered. These tools now retry once on that specific error by issuing a `detach` (which clears the stale flag; it may itself report "not attached", which is expected and ignored) followed by a real `attach`, so a previously wedged tab recovers automatically. The self-heal wrapper is covered by regression tests. This addresses recovery in the bridge only; the underlying churn comes from multiple debugger clients contending for the same tab, so reducing competing browser-control stacks still helps.

### Changed

- The native host launcher no longer runs `npx` on every connection. When installed to a stable location (e.g. `npm install -g codex-control-chrome-mcp`), `install-native-host` writes a launcher that execs Node directly against the installed CLI, so the Codex extension connects immediately instead of waiting for npx to resolve/download the package on each Native Messaging connect. A cold or evicted npx cache could take seconds and exceed the extension's connect timeout, which showed up as the bridge "not connecting". The launcher prefers the Node.js used at install time and falls back to `node` on `PATH`, so a Node upgrade (which moves the versioned Homebrew/nvm path) does not strand it.
- Recommended setup is now a global install followed by `codex-control-chrome-mcp install-native-host`, with the MCP stdio client pointed at the installed `codex-control-chrome-mcp` binary. Running `npx … install-native-host` still works: because that copy lives in npm's garbage-collectable `_npx` cache, the installer detects it and keeps the previous npx launcher as a fallback (install globally and re-run for the fast path).

### Fixed

- `package-lock.json` recorded a stale `1.1.0` project version; it now tracks the package version.

## [1.2.1] - 2026-07-03

### Fixed

- Native host failed to start on 1.2.0. The install launcher runs the host with `--browser <name>` before the extension origin that Chrome appends, so the origin was no longer `args[0]`. The CLI dispatcher only recognized native-host mode when the origin was `args[0]`, so the launcher's argv fell through to `Unknown command: --browser` and the host exited on every connect. The visible symptoms were the Codex extension connection flapping between connected/disconnected and `status` never listing a bridge socket (`sockets: []`). The dispatcher now detects the origin by shape anywhere in the args, and a regression test covers the launcher argv.

## [1.2.0] - 2026-06-29

### Added

- Microsoft Edge support as a first-class browser alongside Chrome. `install-native-host`, `uninstall-native-host`, and `status` accept `--browser <chrome|edge|all>`.
- Auto-detection: without `--browser`, `install-native-host` installs for every supported browser whose profile directory exists, `uninstall-native-host` targets every browser it previously installed for, and `status` reports both browsers.
- The MCP stdio server's self-heal now re-asserts the manifest for every browser it manages, not just Chrome.

### Changed

- Native host install state is now stored per browser (`install-state.<browser>.json` / `config.<browser>.json`). Chrome keeps the original unsuffixed filenames, so existing installs remain valid; Edge no longer clobbers Chrome's restore and self-heal metadata.
- `status` output now nests install state under each browser (`install.chrome`, `install.edge`). The `chrome_status` MCP tool additionally reports `manifestPaths` for every supported browser.

## [1.1.0] - 2026-06-27

### Added

- Self-healing native host registration: the MCP stdio server re-asserts the manifest on startup when a Codex update reverts it (opt out with `CODEX_CONTROL_CHROME_NO_AUTO_REGISTER=1`).
- Robust identification of OpenAI's genuine host via stable signals (manifest name + extension origin, bundle path, binary format, and the macOS OpenAI code signature) instead of the binary filename.
- `status` now reports `registered` and a `classification` of the live manifest/host.

### Fixed

- Proxy target resolution preferred a stale recorded path over the live manifest, so a renamed/removed official host (e.g. `extension-host` → `Codex for Chrome`) could be recorded as the proxy target. It now prefers the live official manifest and skips paths that no longer exist.

## [1.0.1] - 2026-06-26

### Added

- Open source governance files.
- CI and npm trusted publishing workflows.
- Node.js test coverage for framing, RPC, and installer behavior.

### Changed

- Runtime package name and version are now read from `package.json` instead of being hard-coded in implementation files.

## [1.0.0] - 2026-06-26

### Added

- Initial npm package.
- MCP stdio server.
- Chrome Native Messaging host bridge.
- Native host install and uninstall commands with manifest backup.
- Basic Chrome tab, navigation, screenshot, CDP, and event MCP tools.
- Skill documentation for Agent tool usage.
