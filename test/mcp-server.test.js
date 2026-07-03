import assert from "node:assert/strict";
import test from "node:test";
import { isNotAttachedError, registerTools, withSession } from "../src/mcp-server.js";

const notAttached = () => new Error("Debugger is not attached to the tab with id: 7");

// Simulates the Codex extension's behavior. `detach` always throws (the debugger
// is already gone) but its real-world side effect is clearing the stale attach
// flag. With `staleUntilReattach`, the first attach is a lie: every CDP command
// fails "not attached" until a detach + real re-attach (the second attach). With
// `alwaysStale`, attach never recovers. `calls` records the RPC method sequence.
function makeRuntime({ staleUntilReattach = false, alwaysStale = false } = {}) {
  const calls = [];
  let attaches = 0;
  return {
    calls,
    request(method) {
      calls.push(method);
      if (method === "attach") {
        attaches += 1;
        return Promise.resolve({ ok: true });
      }
      if (method === "detach") return Promise.reject(notAttached());
      if (method === "executeCdp") {
        if (alwaysStale || (staleUntilReattach && attaches < 2)) {
          return Promise.reject(notAttached());
        }
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true });
    },
  };
}

test("isNotAttachedError matches the extension's stale-attach error only", () => {
  assert.equal(isNotAttachedError(notAttached()), true);
  assert.equal(isNotAttachedError(new Error("Timed out waiting for executeCdp")), false);
  assert.equal(isNotAttachedError(null), false);
});

test("withSession attaches with auto-attach, then runs, when healthy", async () => {
  const runtime = makeRuntime();
  let ran = 0;
  const result = await withSession(runtime, 7, async () => {
    ran += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(ran, 1);
  // attach + Target.setAutoAttach probe, then the caller's run — no heal.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp"]);
});

test("withSession self-heals a stale attach surfaced by the probe", async () => {
  const runtime = makeRuntime({ staleUntilReattach: true });
  let ran = 0;
  const result = await withSession(runtime, 7, async () => {
    ran += 1;
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(ran, 1);
  // setAutoAttach probe fails "not attached" -> detach -> re-attach -> probe ok -> run.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp", "detach", "attach", "executeCdp"]);
});

test("withSession heals when the command hits a stale attach mid-flight", async () => {
  const runtime = makeRuntime();
  let ran = 0;
  const result = await withSession(runtime, 7, async () => {
    ran += 1;
    if (ran === 1) throw notAttached();
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(ran, 2);
  // attach, probe ok, run throws -> detach -> re-attach -> probe ok -> run ok.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp", "detach", "attach", "executeCdp"]);
});

test("withSession rethrows non-attach errors without healing", async () => {
  const runtime = makeRuntime();
  await assert.rejects(
    withSession(runtime, 7, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(runtime.calls, ["attach", "executeCdp"]);
});

test("withSession surfaces an unrecoverable stale attach after one heal", async () => {
  const runtime = makeRuntime({ alwaysStale: true });
  await assert.rejects(
    withSession(runtime, 7, async () => "never runs"),
    /not attached/,
  );
  // probe fails -> detach -> re-attach -> probe fails again -> give up.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp", "detach", "attach", "executeCdp"]);
});

// --- Tool wiring: the session discipline must actually be applied to the tools ---

function makeToolServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _schema, handler) {
      handlers.set(name, handler);
    },
  };
}

function getHandler(name, runtime) {
  const server = makeToolServer();
  registerTools(server, runtime);
  return server.handlers.get(name);
}

test("chrome_cdp_send ensures attachment (auto-attach) then sends, self-healing a stale attach", async () => {
  const runtime = makeRuntime({ staleUntilReattach: true });
  const handler = getHandler("chrome_cdp_send", runtime);
  const result = await handler({ tabId: 7, method: "Page.close", params: {} });
  // probe fails stale -> heal -> re-attach -> probe ok -> Page.close.
  assert.deepEqual(
    runtime.calls,
    ["attach", "executeCdp", "detach", "attach", "executeCdp", "executeCdp"],
  );
  assert.match(result.content[0].text, /"ok": true/);
});

test("chrome_attach_tab verifies with a real probe and reports success", async () => {
  const runtime = makeRuntime();
  const handler = getHandler("chrome_attach_tab", runtime);
  const result = await handler({ tabId: 7 });
  // attach + setAutoAttach probe + Runtime.evaluate verification probe.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp", "executeCdp"]);
  assert.match(result.content[0].text, /"ok": true/);
});

test("chrome_attach_tab surfaces an unrecoverable stale attach instead of lying", async () => {
  const runtime = makeRuntime({ alwaysStale: true });
  const handler = getHandler("chrome_attach_tab", runtime);
  await assert.rejects(handler({ tabId: 7 }), /not attached/);
});

test("chrome_evaluate ensures attachment then enables + evaluates", async () => {
  const runtime = makeRuntime();
  const handler = getHandler("chrome_evaluate", runtime);
  await handler({ tabId: 7, expression: "1+1", awaitPromise: true });
  // attach + setAutoAttach probe, then Runtime.enable + Runtime.evaluate.
  assert.deepEqual(runtime.calls, ["attach", "executeCdp", "executeCdp", "executeCdp"]);
});
