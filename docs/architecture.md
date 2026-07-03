# Codex Control Chrome MCP Architecture

## Goal

Expose the existing Codex Chrome extension flow to other Agent tools through an MCP stdio server.

The important design constraint is that target machines may not have Codex App installed. Therefore this project must not depend on Codex App's private runtime, `node_repl`, or official `extension-host` being present.

## Key Conclusion

The Codex Chrome extension does not use Chrome remote debugging port. It uses:

```text
Chrome extension
  -> chrome.runtime.connectNative("com.openai.codexextension")
  -> native messaging host
  -> JSON-RPC
  -> chrome.debugger.attach / chrome.debugger.sendCommand
```

This is why it can reuse the normal Chrome profile, cookies, logged-in sessions, and installed extensions. The extension is already inside the normal profile and has the `debugger` permission.

## Native Messaging Manifest

Chrome native messaging is the registry layer that maps a string host name to a local executable.

The installed Codex extension hard-codes the production host name:

```text
com.openai.codexextension
```

The extension is distributed as the [Codex Chrome Extension](https://chromewebstore.google.com/detail/hehggadaopoacecdllhhajmbjkdcmajg) and uses extension ID `hehggadaopoacecdllhhajmbjkdcmajg`.

Chrome resolves that name through a manifest such as:

```json
{
  "name": "com.openai.codexextension",
  "path": "/absolute/path/to/codex-control-chrome-mcp",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/"
  ]
}
```

On macOS the manifest path is:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json
```

The manifest does not contain a socket path. It only tells Chrome which executable to spawn when the extension calls `chrome.runtime.connectNative(hostName)`.

## Host Name Binding

The host name must match the extension's `connectNative()` argument. The current Web Store extension will not connect to a different name such as `com.example.chromeuse`.

Therefore, without modifying/repacking the extension, this project must register as:

```text
com.openai.codexextension
```

## Install and Uninstall Strategy

Installing this project replaces the manifest path, not the original binary.

The installer must:

1. Read the current `com.openai.codexextension.json`.
2. Copy it to the same directory with a timestamped backup suffix.
3. Write a new manifest that points to `codex-control-chrome-mcp`.
4. Store install state in `~/.codex-control-chrome-mcp/install-state.json`.
5. Store the original official host path in `~/.codex-control-chrome-mcp/config.json` for proxy mode.

Uninstalling restores the backed-up manifest.

This means the official Codex binary is not modified or deleted.

## Coexistence With Codex App

Only one native host manifest can own `com.openai.codexextension` at a time. True side-by-side registration under two names is not possible with the unmodified official extension.

Coexistence is possible through a same-name proxy:

```text
Chrome extension
  -> com.openai.codexextension
  -> codex-control-chrome-mcp native host
       -> local MCP bridge socket
       -> optional official extension-host child process
```

Proxy behavior:

1. Requests from MCP use an internal ID prefix such as `codex-control-chrome-mcp:*`.
2. Responses with that prefix are routed back to MCP.
3. Official Codex requests/responses are forwarded to the original `extension-host`.
4. Extension notifications such as `onCDPEvent` are broadcast to MCP clients and forwarded to the official host.

If the MCP stdio server is stopped but the native host proxy is still running, Codex can continue working. If the native host proxy is removed, run uninstall to restore the original manifest.

## Process Layers

```text
Other Agent
  -> MCP stdio
  -> codex-control-chrome-mcp --stdio
  -> /tmp/codex-browser-use/codex-control-chrome-mcp-*.sock
  -> codex-control-chrome-mcp --native-host
  -> Chrome native messaging stdio
  -> Codex Chrome extension
  -> chrome.debugger
```

The `--stdio` process is short-lived and Agent-facing.

The `--native-host` process is Chrome-facing and owns the extension connection.

MCP stdio is implemented with the official TypeScript SDK:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

The project does not hand-roll MCP message parsing. The custom 4-byte length-prefixed framing is only for Chrome Native Messaging and the local bridge socket.

## CDP Flow

MCP tools call the local bridge with JSON-RPC:

```json
{
  "jsonrpc": "2.0",
  "id": "mcp:1",
  "method": "executeCdp",
  "params": {
    "session_id": "codex-control-chrome-mcp-session",
    "turn_id": "turn-1",
    "target": { "tabId": 123 },
    "method": "Runtime.evaluate",
    "commandParams": {
      "expression": "document.title",
      "returnByValue": true
    }
  }
}
```

The native host forwards this to the extension, which calls:

```js
chrome.debugger.sendCommand({ tabId }, method, commandParams)
```

CDP events come back as notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "onCDPEvent",
  "params": {
    "source": { "tabId": 123 },
    "method": "Network.requestWillBeSent",
    "params": {}
  }
}
```

## Debugger Attach Lifecycle

The extension's `attach` is idempotent on an in-memory set (`background.js`:
`if(!se.has(t)) chrome.debugger.attach(...)`). If a tab's real debugger is torn
down out-of-band (a competing debugger client, DevTools, a renderer/process
swap) and that flag goes stale, `attach` reports success without re-attaching and
the next CDP command fails with `Debugger is not attached`.

Since 1.4.0 the client mirrors the official `browser-client.mjs` discipline
instead of trusting that `attach`:

- `ensureAttached(tabId)` — `attach`, then `Target.setAutoAttach`
  (`autoAttach`/`flatten`), which keeps child frames/OOPIFs in the session and
  doubles as a real liveness probe that surfaces a stale attach.
- `withSession(tabId, run)` — `ensureAttached` → run the CDP sequence → on
  "not attached" (from the probe or mid-command) `detach` (clears the stale
  flag) → re-`ensureAttached` → retry once. Every CDP tool
  (`chrome_navigate`/`evaluate`/`screenshot`/`cdp_send`) goes through it, and
  `chrome_attach_tab` verifies with a probe instead of returning a hardcoded ok.
- A **stable per-process `turn_id`**. The extension scopes attach/lease state by
  `session_id` + `turn_id` (`resolveSession(t).attach(requireTurnId(t))`);
  minting a fresh turn per request churned that state.

When a debugger/attach issue recurs, start from
[`docs/troubleshooting.md`](./troubleshooting.md) — it has the reference points
(official client, extension service worker) and the debugging playbook.

## Reusing Codex Logic

The preferred long-term reuse point is Codex's `browser-client.mjs`, not the official `extension-host` socket.

Codex App normally provides private runtime objects:

```text
globalThis.nodeRepl.nativePipe
globalThis.nodeRepl.requestMeta["x-codex-turn-metadata"]
globalThis.nodeRepl.env
globalThis.nodeRepl.cwd
globalThis.nodeRepl.emitImage()
globalThis.nodeRepl.setResponseMeta()
```

This project can shim those APIs and point `nativePipe.createConnection()` at its own bridge socket. That lets the vendored `browser-client.mjs` reuse its existing high-level browser logic while avoiding Codex App as a dependency.

The initial implementation exposes direct MCP tools first.

As of 1.4.0 we chose to **align the lifecycle discipline in our own small client**
(see "Debugger Attach Lifecycle" above) rather than vendor `browser-client.mjs`.
Vendoring the 983 KB minified bundle into this MIT-licensed, published package
would redistribute OpenAI's proprietary code (a licensing question), couple us to
a specific Codex build, and add an opaque, unreviewable dependency. Re-implementing
the key mechanisms (`ensureAttached`, `Target.setAutoAttach`, stable turn,
verified attach, self-heal) gets the same behavior while staying MIT-clean and
reviewable. Full vendoring remains an option only if the redistribution question
is resolved.

## Runtime And Launch Model

The package is distributed on npm and run as its installed CLI. A global install (`npm install -g codex-control-chrome-mcp`) gives both entrypoints — the `--stdio` MCP server and the `--native-host` bridge — a stable path.

Agent-side MCP config should use the installed binary:

```json
{
  "type": "stdio",
  "command": "codex-control-chrome-mcp",
  "args": ["--stdio"]
}
```

Chrome Native Messaging manifests cannot store command arguments. Therefore `install-native-host` writes a stable launcher script at:

```text
~/.codex-control-chrome-mcp/native-host-launcher
```

The launcher execs Node directly against the installed CLI (no `npx` in the hot path, so the extension connects without waiting on a package resolve/download) and injects the mode and browser. The `--browser` flag tells the host which browser's proxy config to read:

```sh
#!/usr/bin/env sh
node_bin='/path/to/node'
[ -x "$node_bin" ] || node_bin=node
exec "$node_bin" '/path/to/codex-control-chrome-mcp/bin/codex-control-chrome-mcp.js' --native-host --browser chrome "$@"
```

It prefers the Node.js used at install time and falls back to `node` on `PATH` so a Node upgrade does not strand it. The native host manifest points to the launcher, not to the CLI directly (a manifest cannot pass `--browser`).

When the CLI is instead run through `npx` — its copy lives in npm's garbage-collectable `_npx` cache — `install-native-host` detects that and falls back to a launcher that runs `npx -y codex-control-chrome-mcp@latest --native-host …`. That is stable but pays npx's startup cost on every connect; a global install avoids it.
