import assert from "node:assert/strict";
import test from "node:test";
import { classifyInvocation, runCli } from "../src/cli.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/package-meta.js";

const ORIGIN = "chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/";

test("launcher argv with --browser before the origin dispatches to the native host", () => {
  // Regression guard for 1.2.0: the install launcher runs
  // `... --native-host --browser chrome <origin>` (and Chrome appends the
  // origin last), so the origin is not args[0]. The dispatcher must still route
  // to the native host and recover the origin/browser, not throw
  // "Unknown command: --browser".
  const invocation = classifyInvocation(["--browser", "chrome", ORIGIN]);
  assert.equal(invocation.mode, "native-host");
  assert.equal(invocation.origin, ORIGIN);
  assert.equal(invocation.browser, "chrome");
});

test("edge launcher argv dispatches to the native host with the edge browser", () => {
  const invocation = classifyInvocation(["--browser", "edge", ORIGIN]);
  assert.equal(invocation.mode, "native-host");
  assert.equal(invocation.origin, ORIGIN);
  assert.equal(invocation.browser, "edge");
});

test("an origin passed as the first arg still dispatches to the native host", () => {
  const invocation = classifyInvocation([ORIGIN]);
  assert.equal(invocation.mode, "native-host");
  assert.equal(invocation.origin, ORIGIN);
  assert.equal(invocation.browser, "chrome");
});

test("--native-host without an origin dispatches to the native host", () => {
  const invocation = classifyInvocation(["--native-host"]);
  assert.equal(invocation.mode, "native-host");
  assert.equal(invocation.origin, undefined);
});

test("--stdio dispatches to the MCP server", () => {
  assert.equal(classifyInvocation(["--stdio"]).mode, "mcp");
  assert.equal(classifyInvocation(["stdio"]).mode, "mcp");
});

test("subcommands are classified as commands, not the native host", () => {
  for (const command of ["install-native-host", "uninstall-native-host", "status", "help"]) {
    const invocation = classifyInvocation([command]);
    assert.equal(invocation.mode, "command");
    assert.equal(invocation.command, command);
  }
});

test("version flags are classified as commands", () => {
  for (const flag of ["-v", "--version", "version"]) {
    const invocation = classifyInvocation([flag]);
    assert.equal(invocation.mode, "command");
    assert.equal(invocation.command, flag);
  }
});

test("--version / -v / version print the package name and version", async () => {
  for (const flag of ["--version", "-v", "version"]) {
    const original = process.stdout.write;
    let out = "";
    process.stdout.write = (chunk) => {
      out += chunk;
      return true;
    };
    try {
      await runCli(["node", "cli.js", flag]);
    } finally {
      process.stdout.write = original;
    }
    assert.equal(out, `${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
  }
});
