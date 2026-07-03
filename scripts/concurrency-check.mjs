// Concurrency soak check for the debugger-attach lifecycle.
//
// Spins up N independent client sessions (each is a real ChromeUseRuntime that
// connects to the live bridge socket as its own client, so `chrome_bridge_status`
// reports `clients: N`), and hammers them concurrently through the flow that used
// to dead-end under contention: create -> navigate -> raw chrome_cdp_send ->
// evaluate -> finalize. It tallies how many operations hit an UNRECOVERED
// "not attached" (a regression) and how many times the self-heal engaged.
//
// The stale-attach eviction is triggered by external contention (competing
// debugger clients, DevTools, renderer swaps) and cannot be forced on demand, so
// this is a soak/stress test, not a deterministic repro. The deterministic proof
// of the self-heal MECHANISM lives in test/mcp-server.test.js. Run this with your
// normal Chrome (and ideally the Codex app / other sessions) active to maximize
// contention:
//
//   node scripts/concurrency-check.mjs [sessions=4] [rounds=5]
//
// Exit code is non-zero if any operation ended in an unrecovered "not attached".
import { ChromeUseRuntime, registerTools, sessionStats } from "../src/mcp-server.js";

const SESSIONS = Number(process.argv[2] ?? 4);
const ROUNDS = Number(process.argv[3] ?? 5);
const QUERIES = ["上海天气", "北京天气", "广州天气", "深圳天气", "杭州天气", "成都天气"];

function makeClient(id) {
  const handlers = new Map();
  registerTools({ registerTool: (n, _s, h) => handlers.set(n, h) }, new ChromeUseRuntime());
  const call = async (name, args = {}) => {
    const res = await handlers.get(name)(args);
    const text = res?.content?.[0]?.text ?? "";
    return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
  };
  return { id, call };
}

async function runSession(client) {
  const tally = { ok: 0, unrecovered: 0, other: 0 };
  for (let round = 0; round < ROUNDS; round++) {
    let tab;
    try {
      tab = await client.call("chrome_create_tab");
      const query = QUERIES[(client.id + round) % QUERIES.length];
      await client.call("chrome_navigate", {
        tabId: tab.id,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      });
      // The raw CDP path that used to dead-end (no attach, no heal) pre-1.4.0.
      const info = await client.call("chrome_cdp_send", {
        tabId: tab.id,
        method: "Target.getTargetInfo",
        params: {},
      });
      const evaluated = await client.call("chrome_evaluate", {
        tabId: tab.id,
        expression: "document.title",
        awaitPromise: true,
      });
      const title = evaluated.result?.value ?? "";
      if (!info.targetInfo?.attached) throw new Error("targetInfo.attached=false after ensureAttached");
      tally.ok += 1;
      console.log(`  [s${client.id} r${round}] ok — "${title}"`);
    } catch (error) {
      if (/not attached/i.test(error.message)) tally.unrecovered += 1;
      else tally.other += 1;
      console.log(`  [s${client.id} r${round}] FAIL: ${error.message.slice(0, 90)}`);
    } finally {
      try { await client.call("chrome_finalize_tabs", { keep: [] }); } catch {}
    }
  }
  return tally;
}

console.log(`Concurrency soak: ${SESSIONS} sessions x ${ROUNDS} rounds (raw cdp_send + evaluate under contention)`);
const clients = Array.from({ length: SESSIONS }, (_, i) => makeClient(i));
const results = await Promise.all(clients.map(runSession));
const sum = results.reduce(
  (a, r) => ({ ok: a.ok + r.ok, unrecovered: a.unrecovered + r.unrecovered, other: a.other + r.other }),
  { ok: 0, unrecovered: 0, other: 0 },
);

console.log("──────── results ────────");
console.log(`operations ok         : ${sum.ok}/${SESSIONS * ROUNDS}`);
console.log(`unrecovered not-attach: ${sum.unrecovered}   (must be 0 — this is the regression signal)`);
console.log(`other errors          : ${sum.other}`);
console.log(`self-heals engaged    : ${sessionStats.heals}   (evictions that were recovered)`);
console.log(`heals that gave up    : ${sessionStats.unrecovered}`);
process.exit(sum.unrecovered > 0 ? 1 : 0);
