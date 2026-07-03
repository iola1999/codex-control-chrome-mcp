import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectBridge, listBridgeSockets } from "./bridge-client.js";
import { SUPPORTED_BROWSERS, nativeHostManifestPath } from "./constants.js";
import { detectManagedBrowsers, ensureNativeHostRegistered } from "./installer.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-meta.js";

export async function runMcpServer() {
  await autoRegisterNativeHost();
  const runtime = new ChromeUseRuntime();
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  registerTools(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * On stdio startup, re-assert our native-host manifest if a Codex update (or
 * anything else) reverted it. Best-effort and silent: it only logs to stderr
 * (stdout is the MCP JSON-RPC channel) and never blocks server startup.
 * Opt out with CODEX_CONTROL_CHROME_NO_AUTO_REGISTER=1.
 *
 * Note: re-asserting the manifest only takes effect on the Chrome extension's
 * next Native Messaging connection (reload the extension or restart Chrome).
 */
async function autoRegisterNativeHost() {
  if (process.env.CODEX_CONTROL_CHROME_NO_AUTO_REGISTER === "1") return;
  let browsers = [];
  try {
    browsers = await detectManagedBrowsers();
  } catch {
    browsers = [];
  }
  for (const browser of browsers) {
    try {
      const result = await ensureNativeHostRegistered({ browser });
      if (result.action === "re-registered") {
        process.stderr.write(
          `[codex-control-chrome-mcp] native host manifest for ${browser} was ${result.reason}; ` +
            `re-registered it. Reload the Codex extension (or restart ${browserLabel(browser)}) ` +
            "to reconnect the bridge.\n",
        );
      }
    } catch (error) {
      process.stderr.write(
        `[codex-control-chrome-mcp] auto-register (${browser}) skipped: ${error?.message ?? error}\n`,
      );
    }
  }
}

function browserLabel(browser) {
  return browser === "edge" ? "Edge" : "Chrome";
}

export class ChromeUseRuntime {
  constructor() {
    this.sessionId = `codex-control-chrome-mcp-${crypto.randomUUID()}`;
    // Stable per-process turn id. The Codex extension scopes attach/lease state
    // by (session_id, turn_id); minting a fresh turn per request (as we used to)
    // churned that state and re-keyed tab leases on every call. We are a single
    // controller, so one stable turn mirrors the official client's turn model.
    this.turnId = `turn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    this.bridge = null;
  }

  async rpc() {
    if (!this.bridge) {
      this.bridge = await connectBridge();
    }
    return this.bridge.rpc;
  }

  sessionParams() {
    return {
      session_id: this.sessionId,
      turn_id: this.turnId,
      session_context: "codex-control-chrome-mcp",
    };
  }

  async request(method, params = {}, options = {}) {
    const rpc = await this.rpc();
    return await rpc.request(method, { ...params, ...this.sessionParams() }, options);
  }

  async rawRequest(method, params = {}, options = {}) {
    const rpc = await this.rpc();
    return await rpc.request(method, params, options);
  }
}

export function registerTools(server, runtime) {
  server.registerTool(
    "chrome_status",
    {
      description: "Show native host manifest paths and discovered bridge sockets.",
      inputSchema: {},
    },
    async () => toolResult({
      manifestPath: nativeHostManifestPath(),
      manifestPaths: Object.fromEntries(
        SUPPORTED_BROWSERS.map((browser) => [browser, nativeHostManifestPath(browser)]),
      ),
      sockets: await listBridgeSockets(),
    }),
  );

  server.registerTool(
    "chrome_bridge_status",
    {
      description: "Ask the active Codex Control Chrome MCP bridge for status.",
      inputSchema: {},
    },
    async () => toolResult(await runtime.rawRequest("bridge.getStatus", {})),
  );

  server.registerTool(
    "chrome_get_info",
    {
      description: "Get connected Codex Chrome extension backend info.",
      inputSchema: {},
    },
    async () => toolResult(await runtime.request("getInfo")),
  );

  server.registerTool(
    "chrome_name_session",
    {
      description: "Set the Chrome tab group/session name.",
      inputSchema: {
        name: z.string().default("Codex Control Chrome MCP"),
      },
    },
    async ({ name }) => {
      await runtime.request("nameSession", { name });
      return toolResult({ ok: true });
    },
  );

  server.registerTool(
    "chrome_user_tabs",
    {
      description: "List user Chrome tabs visible to the extension.",
      inputSchema: {},
    },
    async () => toolResult({ tabs: await runtime.request("getUserTabs") }),
  );

  server.registerTool(
    "chrome_session_tabs",
    {
      description: "List tabs currently claimed by this MCP browser session.",
      inputSchema: {},
    },
    async () => toolResult({ tabs: await runtime.request("getTabs") }),
  );

  server.registerTool(
    "chrome_create_tab",
    {
      description: "Create a new background tab and claim it for this MCP session.",
      inputSchema: {},
    },
    async () => toolResult(await runtime.request("createTab")),
  );

  server.registerTool(
    "chrome_claim_tab",
    {
      description: "Claim an existing Chrome tab by numeric tab id.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
      },
    },
    async ({ tabId }) => toolResult(await runtime.request("claimUserTab", { tabId })),
  );

  server.registerTool(
    "chrome_attach_tab",
    {
      description: "Attach Chrome debugger to a claimed tab.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
      },
    },
    async ({ tabId }) => {
      // Verify the attachment for real instead of trusting the extension's
      // idempotent `attach` (which can report success on a stale flag). The
      // probe runs a trivial evaluate; withSession heals a stale attach first.
      await withSession(runtime, tabId, () =>
        executeCdp(runtime, {
          tabId,
          method: "Runtime.evaluate",
          params: { expression: "1", returnByValue: true },
        }),
      );
      return toolResult({ ok: true });
    },
  );

  server.registerTool(
    "chrome_detach_tab",
    {
      description: "Detach Chrome debugger from a claimed tab.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
      },
    },
    async ({ tabId }) => {
      await runtime.request("detach", { tabId });
      return toolResult({ ok: true });
    },
  );

  server.registerTool(
    "chrome_cdp_send",
    {
      description: "Send a raw CDP command to a claimed and attached tab.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
        method: z.string().min(1),
        params: z.record(z.string(), z.unknown()).default({}),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ tabId, method, params, timeoutMs }) =>
      toolResult(await withSession(runtime, tabId, () =>
        executeCdp(runtime, { tabId, method, params, timeoutMs }),
      )),
  );

  server.registerTool(
    "chrome_navigate",
    {
      description: "Navigate a claimed tab to a URL using CDP Page.navigate.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
        url: z.string().url(),
      },
    },
    async ({ tabId, url }) =>
      toolResult(await withSession(runtime, tabId, async () => {
        await executeCdp(runtime, { tabId, method: "Page.enable", params: {} });
        return await executeCdp(runtime, {
          tabId,
          method: "Page.navigate",
          params: { url },
        });
      })),
  );

  server.registerTool(
    "chrome_evaluate",
    {
      description: "Evaluate JavaScript in a claimed tab using Runtime.evaluate.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
        expression: z.string().min(1),
        awaitPromise: z.boolean().default(true),
      },
    },
    async ({ tabId, expression, awaitPromise }) =>
      toolResult(await withSession(runtime, tabId, async () => {
        await executeCdp(runtime, { tabId, method: "Runtime.enable", params: {} });
        return await executeCdp(runtime, {
          tabId,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise,
            returnByValue: true,
          },
        });
      })),
  );

  server.registerTool(
    "chrome_screenshot",
    {
      description: "Capture a screenshot from a claimed tab. Returns base64 PNG.",
      inputSchema: {
        tabId: z.number().int().nonnegative(),
        format: z.enum(["png", "jpeg", "webp"]).default("png"),
      },
    },
    async ({ tabId, format }) =>
      toolResult(await withSession(runtime, tabId, async () => {
        await executeCdp(runtime, { tabId, method: "Page.enable", params: {} });
        return await executeCdp(runtime, {
          tabId,
          method: "Page.captureScreenshot",
          params: { format, captureBeyondViewport: true },
          timeoutMs: 30_000,
        });
      })),
  );

  server.registerTool(
    "chrome_read_events",
    {
      description: "Read and clear CDP/download notifications buffered by this MCP process.",
      inputSchema: {
        method: z.string().optional(),
        limit: z.number().int().positive().default(100),
      },
    },
    async ({ method, limit }) => {
      const rpc = await runtime.rpc();
      return toolResult({ events: rpc.readNotifications({ method, limit }) });
    },
  );

  server.registerTool(
    "chrome_finalize_tabs",
    {
      description: "Finalize claimed tabs. Use status handoff or deliverable.",
      inputSchema: {
        keep: z.array(z.object({
          tabId: z.number().int().nonnegative(),
          status: z.enum(["handoff", "deliverable"]),
        })).default([]),
      },
    },
    async ({ keep }) => {
      await runtime.request("finalizeTabs", { keep });
      return toolResult({ ok: true });
    },
  );
}

/**
 * Bring `tabId` to a known-attached state, mirroring the official Codex
 * browser-client's discipline instead of trusting the extension's idempotent
 * `attach`. The extension only calls `chrome.debugger.attach` when the tab is
 * absent from its in-memory set (background.js: `if(!se.has(t)) attach()`), so
 * after an out-of-band detach that flag can go stale and `attach` reports
 * success with no live debugger. `Target.setAutoAttach` is a real CDP command:
 * it keeps child frames/OOPIFs in the session (as the official client does) and
 * doubles as a liveness probe that surfaces a stale attach as "not attached".
 */
async function ensureAttached(runtime, tabId) {
  await runtime.request("attach", { tabId });
  try {
    await executeCdp(runtime, {
      tabId,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
    });
  } catch (error) {
    // A stale attach surfaces here as "not attached"; re-throw so withSession
    // heals it. Any other setAutoAttach failure is best-effort (some targets
    // reject it) and must not block the real command.
    if (isNotAttachedError(error)) throw error;
  }
}

/**
 * Ensure the tab is attached, run a CDP sequence, and self-heal once if the
 * debugger is torn down out-of-band (a competing debugger client, DevTools, or a
 * renderer/process swap) — whether that surfaces during the attach probe or
 * mid-command. Recovery is a `detach`, which clears the extension's stale attach
 * flag (it may itself throw "not attached" — expected, and ignored), then a real
 * re-attach via ensureAttached, then one retry.
 */
/**
 * Diagnostics for the self-heal path: `heals` counts how often a stale/lost
 * attachment was recovered, `unrecovered` how often recovery still failed.
 * Used by scripts/concurrency-check.mjs to observe behavior under contention.
 */
export const sessionStats = { heals: 0, unrecovered: 0 };

export async function withSession(runtime, tabId, run) {
  try {
    await ensureAttached(runtime, tabId);
    return await run();
  } catch (error) {
    if (!isNotAttachedError(error)) throw error;
    sessionStats.heals += 1;
    try {
      await runtime.request("detach", { tabId });
    } catch {
      // Detach throws when the debugger is already gone; we only need its side
      // effect of clearing the extension's stale attach flag.
    }
    try {
      await ensureAttached(runtime, tabId);
      return await run();
    } catch (retryError) {
      if (isNotAttachedError(retryError)) sessionStats.unrecovered += 1;
      throw retryError;
    }
  }
}

export function isNotAttachedError(error) {
  return /not attached/i.test(error?.message ?? String(error ?? ""));
}

async function executeCdp(runtime, { tabId, method, params = {}, timeoutMs }) {
  return await runtime.request(
    "executeCdp",
    {
      target: { tabId },
      method,
      commandParams: params,
      ...(timeoutMs == null ? {} : { timeoutMs }),
    },
    { timeoutMs: Math.max(timeoutMs ?? 30_000, 30_000) },
  );
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}
