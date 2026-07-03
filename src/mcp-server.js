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

class ChromeUseRuntime {
  constructor() {
    this.sessionId = `codex-control-chrome-mcp-${crypto.randomUUID()}`;
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
      turn_id: `turn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
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
      await runtime.request("attach", { tabId });
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
      toolResult(await withReattach(runtime, tabId, () =>
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
      toolResult(await withReattach(runtime, tabId, async () => {
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
      toolResult(await withReattach(runtime, tabId, async () => {
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
      toolResult(await withReattach(runtime, tabId, async () => {
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
 * Attach the debugger, run a CDP sequence, and self-heal a stale-attach state.
 *
 * The Codex Chrome extension tracks debugger attachments in memory. When Chrome
 * tears an attachment down out-of-band (a competing debugger client, DevTools, a
 * renderer/process swap), that flag can go stale: a fresh `attach` short-circuits
 * and reports success without actually re-attaching, so the next CDP command
 * fails with "Debugger is not attached". A `detach` clears the stale flag (it may
 * itself throw "not attached" — expected, and ignored), after which `attach`
 * re-attaches for real. We retry the sequence once on that specific error.
 */
export async function withReattach(runtime, tabId, run) {
  await runtime.request("attach", { tabId });
  try {
    return await run();
  } catch (error) {
    if (!isNotAttachedError(error)) throw error;
    try {
      await runtime.request("detach", { tabId });
    } catch {
      // Detach throws when the debugger is already gone; we only need its side
      // effect of clearing the extension's stale attach flag.
    }
    await runtime.request("attach", { tabId });
    return await run();
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
