# Troubleshooting & Debugging Playbook

Where to look when something breaks and the fix isn't obvious — especially
around the Chrome debugger attach lifecycle, which is the trickiest part of this
project because we drive `chrome.debugger` **through** the Codex extension rather
than owning it.

## Reference points (read these first)

When a debugger/CDP behavior is confusing, the ground truth lives in three
places, none of which are this repo's tool layer:

1. **The official Codex browser client** —
   `~/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs`
   (minified). This is how Codex App itself drives the browser. It is the
   reference implementation we align to. Grep it for the lifecycle discipline:
   `ensureAttached`, `Target.setAutoAttach`, `runAttachedFrameSessionInitialization`,
   `preserveDebuggerOnTimeout`, `Target.closeTarget`. Its only export is
   `setupBrowserRuntime`; it expects a `globalThis.nodeRepl` runtime
   (`nativePipe.createConnection`, `requestMeta["x-codex-turn-metadata"]`, `env`,
   `cwd`, `config`, `emitImage`, `setResponseMeta`).
2. **The extension service worker** —
   `~/Library/Application Support/Google/Chrome/Default/Extensions/hehggadaopoacecdllhhajmbjkdcmajg/<version>/background.js`
   (minified). This is what actually calls `chrome.debugger.*`. Key internals:
   - `function cn(t){ ... if(!se.has(t)){ chrome.debugger.attach({tabId:t},"1.3") } }`
     — `attach` is **idempotent on the in-memory `se` map**. If `se` still has a
     tab whose real debugger was torn down out-of-band, `attach` reports success
     without re-attaching. That stale flag is the root of "Debugger is not
     attached".
   - `chrome.debugger.onDetach.addListener(t=>{ se.delete(t.tabId) })` — clears
     `se` on detach, but can miss races / certain eviction types, leaving `se`
     stale.
   - `resolveSession(t).attach(requireTurnId(t), t)` — attach/lease state is
     scoped by `session_id` + `turn_id`; leases are `{sessionId, turnId, instanceId}`.
     This is why a churning `turn_id` destabilizes session state (see below).
3. **This repo's design** — [`docs/architecture.md`](./architecture.md), especially
   "Coexistence With Codex App" (the same-name proxy) and "Reusing Codex Logic".

## The "Debugger is not attached" failure (root cause)

Three layers stack up:

1. **Trigger (environment):** a tab's `chrome.debugger` is torn down by a
   competing debugger client (another session, DevTools, a renderer/process
   swap). Only one debugger client is allowed per tab. Running multiple
   browser-control stacks (Codex App + several MCP sessions + Claude's extension)
   makes this common.
2. **Extension bug:** after that teardown, `se` can stay stale, so `attach`
   lies (`if(!se.has(t))` short-circuit) and the next `sendCommand` throws
   `Debugger is not attached`. A `detach` clears the flag (it may itself throw
   "not attached" — expected), after which `attach` re-attaches for real.
3. **Our client:** the pre-1.4.0 client fired `attach` and trusted the `{ok}`,
   with no verification and no recovery, so a recoverable state became a dead
   end.

The 1.4.0 client mirrors the official lifecycle discipline: `ensureAttached`
(attach + `Target.setAutoAttach`, which doubles as a real liveness probe),
`withSession` (ensure → run → on "not attached" `detach` → re-`ensureAttached` →
retry once), verified `chrome_attach_tab` (no more hardcoded `{ok:true}`), and a
**stable per-process `turn_id`** instead of a fresh one per request. See
`src/mcp-server.js` (`ensureAttached` / `withSession`) and `test/mcp-server.test.js`.

## Debugging playbook

Techniques that isolated the bug, roughly in order:

- **Is it concurrency?** `chrome_bridge_status` → `clients` is the number of MCP
  sessions sharing the native host. `proxy: true` means Codex App is proxied
  through us too.
- **Which stacks are running?** `ps aux | grep -iE "codex|native-host"` — look
  for multiple `codex-control-chrome-mcp` instances (global vs `_npx` cache),
  the official `Codex for Chrome` host, and Claude's extension host.
- **Tab-specific or global?** Open a **fresh** tab and try it. If the new tab
  works but the old one doesn't, the old tab's attach state is corrupted (stale
  `se`), not the whole extension.
- **Manual recovery / confirm the mechanism:** on a wedged tab, `chrome_detach_tab`
  (it will error with "not attached" — that's expected and clears the stale flag),
  then `chrome_attach_tab`, then retry. If that revives it, it's the stale-attach bug.
- **What did the page/debugger do?** `chrome_read_events` dumps buffered CDP
  notifications (Page/Runtime lifecycle). Note: events are **broadcast to all MCP
  clients**, so under concurrency you will see other sessions' tabs too. Large
  dumps are written to a file — analyze with `jq '.events[].params.method'`.
- **Extension-side detach reasons** are NOT on disk: `chrome.debugger.onDetach`
  is a callback, not a CDP event, so `Inspector.detached` won't appear in
  `chrome_read_events`. To see it you'd need the extension service worker console.
- **Codex App logs:** `~/Library/Logs/com.openai.codex/<date>/codex-desktop-*.log`.
- **Concurrency soak:** `node scripts/concurrency-check.mjs [sessions] [rounds]`
  runs N real sessions concurrently through the create → navigate → raw
  `cdp_send` → evaluate → finalize flow and reports unrecovered "not attached"
  (must be 0) plus how many self-heals engaged.

## Known limitations

- **Session isolation holds, the debugger is shared.** Concurrent sessions can't
  see or close each other's tabs (leases are per `session_id`), but they contend
  for the one debugger-per-tab, so contention raises the eviction rate. The
  self-heal recovers one-shot commands; it does not remove the contention.
- **Streaming CDP is fragile under contention.** Flows that need the debugger to
  stay attached over time (e.g. `Network.enable` then reading events) can lose
  the attachment mid-stream. Prefer page-side APIs (Resource Timing /
  `PerformanceObserver` via `chrome_evaluate`) for network/DOM observation.
- **Live tools run the installed package, not this repo.** Editing `src/` does
  nothing until `npm i -g codex-control-chrome-mcp@<version>` **and** the MCP
  client restarts (and the extension reconnects). Beware stale `_npx` copies.

## Runtime/release gotchas

See [`docs/release.md`](./release.md). Publishing is `git push` of a `v*` tag →
`.github/workflows/publish.yml` publishes to npm via OIDC (no local `npm login`).
