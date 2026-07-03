import assert from "node:assert/strict";
import test from "node:test";
import { isNotAttachedError, registerTools, withReattach } from "../src/mcp-server.js";

// Mimics the extension: `detach` on a dead debugger throws "not attached"
// (its only useful side effect is clearing the stale attach flag), everything
// else resolves ok.
function makeRuntime() {
  const calls = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      if (method === "detach") {
        return Promise.reject(new Error("Debugger is not attached to the tab with id: 7"));
      }
      return Promise.resolve({ ok: true });
    },
  };
}

test("isNotAttachedError matches the extension's stale-attach error only", () => {
  assert.equal(
    isNotAttachedError(new Error("Debugger is not attached to the tab with id: 7")),
    true,
  );
  assert.equal(isNotAttachedError(new Error("Timed out waiting for executeCdp")), false);
  assert.equal(isNotAttachedError(null), false);
});

test("withReattach passes through when the first run succeeds (no heal)", async () => {
  const runtime = makeRuntime();
  let runs = 0;
  const result = await withReattach(runtime, 7, async () => {
    runs += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(runs, 1);
  assert.deepEqual(runtime.calls.map((c) => c.method), ["attach"]);
});

test("withReattach self-heals a stale attach: detach -> attach -> retry", async () => {
  const runtime = makeRuntime();
  let runs = 0;
  const result = await withReattach(runtime, 7, async () => {
    runs += 1;
    if (runs === 1) throw new Error("Debugger is not attached to the tab with id: 7");
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(runs, 2);
  assert.deepEqual(runtime.calls.map((c) => c.method), ["attach", "detach", "attach"]);
});

test("withReattach rethrows non-attach errors without retrying", async () => {
  const runtime = makeRuntime();
  let runs = 0;
  await assert.rejects(
    withReattach(runtime, 7, async () => {
      runs += 1;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(runs, 1);
  assert.deepEqual(runtime.calls.map((c) => c.method), ["attach"]);
});

test("withReattach gives up after one retry if still detached", async () => {
  const runtime = makeRuntime();
  let runs = 0;
  await assert.rejects(
    withReattach(runtime, 7, async () => {
      runs += 1;
      throw new Error("Debugger is not attached to the tab with id: 7");
    }),
    /not attached/,
  );
  assert.equal(runs, 2);
  assert.deepEqual(runtime.calls.map((c) => c.method), ["attach", "detach", "attach"]);
});

// --- Tool wiring: the self-heal wrapper must actually be applied to the CDP tools ---

function makeToolServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _schema, handler) {
      handlers.set(name, handler);
    },
  };
}

// Simulates the extension: `detach` throws (already gone), and the first
// `executeCdp` optionally fails with the stale-attach error.
function makeToolRuntime({ failFirstCdp = false } = {}) {
  const calls = [];
  let cdpCalls = 0;
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      if (method === "detach") {
        return Promise.reject(new Error("Debugger is not attached to the tab with id: 7"));
      }
      if (method === "executeCdp") {
        cdpCalls += 1;
        if (failFirstCdp && cdpCalls === 1) {
          return Promise.reject(new Error("Debugger is not attached to the tab with id: 7"));
        }
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true }); // attach and anything else
    },
  };
}

function getHandler(name, runtime) {
  const server = makeToolServer();
  registerTools(server, runtime);
  return server.handlers.get(name);
}

test("chrome_cdp_send attaches first and self-heals a stale attach", async () => {
  const runtime = makeToolRuntime({ failFirstCdp: true });
  const handler = getHandler("chrome_cdp_send", runtime);
  const result = await handler({ tabId: 7, method: "Page.close", params: {} });
  assert.deepEqual(
    runtime.calls.map((c) => c.method),
    ["attach", "executeCdp", "detach", "attach", "executeCdp"],
  );
  assert.match(result.content[0].text, /"ok": true/);
});

test("chrome_cdp_send with a live attachment issues no detach/re-attach", async () => {
  const runtime = makeToolRuntime();
  const handler = getHandler("chrome_cdp_send", runtime);
  await handler({ tabId: 7, method: "Page.close", params: {} });
  assert.deepEqual(runtime.calls.map((c) => c.method), ["attach", "executeCdp"]);
});

test("chrome_evaluate self-heals a stale attach through withReattach", async () => {
  const runtime = makeToolRuntime({ failFirstCdp: true });
  const handler = getHandler("chrome_evaluate", runtime);
  await handler({ tabId: 7, expression: "1+1", awaitPromise: true });
  // Runtime.enable fails -> heal -> Runtime.enable + Runtime.evaluate both re-run
  assert.deepEqual(
    runtime.calls.map((c) => c.method),
    ["attach", "executeCdp", "detach", "attach", "executeCdp", "executeCdp"],
  );
});
