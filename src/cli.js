import { runMcpServer } from "./mcp-server.js";
import { runNativeHost } from "./native-host.js";
import {
  detectInstalledBrowsers,
  detectManagedBrowsers,
  installNativeHost,
  nativeHostInstallStatus,
  uninstallNativeHost,
} from "./installer.js";
import { DEFAULT_BROWSER, SUPPORTED_BROWSERS } from "./constants.js";
import { listBridgeSockets } from "./bridge-client.js";
import { probeLengthPrefixedSocket } from "./probe.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-meta.js";

export async function runCli(argv) {
  const args = argv.slice(2);
  const invocation = classifyInvocation(args);

  if (invocation.mode === "mcp") {
    await runMcpServer();
    return;
  }

  if (invocation.mode === "native-host") {
    await runNativeHost({ origin: invocation.origin ?? argv[3], browser: invocation.browser });
    return;
  }

  const command = invocation.command;
  switch (command) {
    case "install-native-host": {
      const binPath = readOption(args, "--bin");
      const noProxy = args.includes("--no-proxy");
      const browsers = await resolveBrowsers(readOption(args, "--browser"), "install");
      const result = {};
      for (const browser of browsers) {
        result[browser] = await installNativeHost({ binPath, proxy: !noProxy, browser });
      }
      printJson(result);
      return;
    }
    case "uninstall-native-host": {
      const force = args.includes("--force");
      const browsers = await resolveBrowsers(readOption(args, "--browser"), "uninstall");
      const result = {};
      for (const browser of browsers) {
        result[browser] = await uninstallNativeHost({ force, browser });
      }
      printJson(result);
      return;
    }
    case "status": {
      const browsers = await resolveBrowsers(readOption(args, "--browser"), "status");
      const install = {};
      for (const browser of browsers) {
        install[browser] = await nativeHostInstallStatus({ browser });
      }
      printJson({ install, sockets: await listBridgeSockets() });
      return;
    }
    case "probe-socket": {
      const socketPath = args[1];
      if (!socketPath) {
        throw new Error("Usage: codex-control-chrome-mcp probe-socket <socket-path>");
      }
      printJson(await probeLengthPrefixedSocket(socketPath));
      return;
    }
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/**
 * Decide how an invocation should be handled, purely from the CLI args.
 *
 * Chrome/Edge launch the native host by appending the extension origin as a
 * positional arg, and the install launcher prepends `--browser <name>`. That
 * prefix shifts the origin out of `args[0]`, so both the mode check and the
 * origin lookup must scan by shape rather than position. (A 1.2.0 regression
 * only checked `args[0]` here, so the launcher's `--browser`-prefixed argv fell
 * through to `Unknown command: --browser` and the native host exited on every
 * connect.)
 */
export function classifyInvocation(args) {
  if (args.includes("--stdio") || args[0] === "stdio") {
    return { mode: "mcp" };
  }
  if (args.includes("--native-host") || args.some(looksLikeChromeOrigin)) {
    return {
      mode: "native-host",
      origin: args.find(looksLikeChromeOrigin),
      browser: normalizeBrowser(readOption(args, "--browser")),
    };
  }
  return { mode: "command", command: args[0] };
}

function looksLikeChromeOrigin(value) {
  return typeof value === "string" && value.startsWith("chrome-extension://");
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizeBrowser(value) {
  if (value == null) return DEFAULT_BROWSER;
  const browser = String(value).toLowerCase();
  if (!SUPPORTED_BROWSERS.includes(browser)) {
    throw new Error(
      `Unsupported browser: ${value}. Supported values: ${SUPPORTED_BROWSERS.join(", ")}, all.`,
    );
  }
  return browser;
}

/**
 * Map an optional `--browser` selector to the list of browsers a command acts
 * on. With no selector each command auto-detects: install targets browsers
 * present on the machine, uninstall targets browsers we previously installed,
 * and status reports every supported browser.
 */
async function resolveBrowsers(selector, mode) {
  if (selector && selector !== "all") {
    return [normalizeBrowser(selector)];
  }
  if (selector === "all" || mode === "status") {
    return [...SUPPORTED_BROWSERS];
  }
  if (mode === "install") {
    const present = await detectInstalledBrowsers();
    return present.length ? present : [DEFAULT_BROWSER];
  }
  // uninstall
  const managed = await detectManagedBrowsers();
  return managed.length ? managed : [DEFAULT_BROWSER];
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`codex-control-chrome-mcp

Usage:
  codex-control-chrome-mcp --stdio
  codex-control-chrome-mcp --native-host
  codex-control-chrome-mcp install-native-host [--bin /path/to/codex-control-chrome-mcp] [--no-proxy] [--browser <chrome|edge|all>]
  codex-control-chrome-mcp uninstall-native-host [--force] [--browser <chrome|edge|all>]
  codex-control-chrome-mcp status [--browser <chrome|edge|all>]
  codex-control-chrome-mcp probe-socket <socket-path>
  codex-control-chrome-mcp --version

Notes:
  --stdio is the MCP server mode for Agent tools.
  --native-host is normally launched by Chrome/Edge through Native Messaging.
  install-native-host without --bin writes a stable launcher that runs npx.
  --browser selects a browser. Without it, install/uninstall auto-detect the
  browsers present (or previously installed) and status reports both.
`);
}
