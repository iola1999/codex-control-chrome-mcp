// Concurrency soak / race check for the debugger-attach lifecycle.
//
// Spins up N independent client sessions (each a real ChromeUseRuntime that
// connects to the live bridge as its own client, so chrome_bridge_status reports
// `clients: N`). Within EACH session it runs W concurrent workers. Each worker
// owns one tab and loops navigate -> cdp_send -> evaluate on it until a deadline.
//
// It deliberately keeps concurrency small (a few workers) and PAUSES ~0.5-1s
// between steps. Widening each step's "occupancy window" is what makes a handful
// of workers genuinely overlap on the shared per-tab debugger — you do not need
// dozens of fast workers (which just lags the machine) to reproduce contention.
// `maxInFlight` reports how many tool calls were actually in flight at once.
//
// (Workers reuse one tab and the session finalizes once at the end: finalizeTabs
// is session-scoped, so a per-iteration finalize would rip out sibling workers'
// tabs — that is a harness concern, not the debugger bug under test.)
//
// The stale-attach eviction this project guards against needs an out-of-band
// debugger teardown, which real contention only causes probabilistically. Pass
// --inject-detach to also run one disruptor per session that detaches a random
// live tab mid-flight, forcing the "torn down while a command runs" race so the
// self-heal is exercised and observable (watch `self-heals engaged`). This is the
// real reproduction lever — a few workers + injection reproduces it.
//
//   node scripts/concurrency-check.mjs [sessions=2] [workers=2] [ms=12000] [--inject-detach]
//
// Exit code is non-zero if any operation ended in an unrecovered "not attached".
import { ChromeUseRuntime, registerTools, sessionStats } from "../src/mcp-server.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SESSIONS = Number(args[0] ?? 2);
const WORKERS = Number(args[1] ?? 2);
const DURATION_MS = Number(args[2] ?? 12_000);
const INJECT = process.argv.includes("--inject-detach");
const QUERIES = ["上海天气", "北京天气", "广州天气", "深圳天气", "杭州天气", "成都天气"];

const started = Date.now();
const deadline = () => Date.now() - started >= DURATION_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deliberate ~0.5-1s spacing between steps so the few workers overlap in time.
const pause = () => sleep(500 + Math.floor(Math.random() * 500));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const stats = { ok: 0, unrecovered: 0, other: 0, ops: 0, inFlight: 0, maxInFlight: 0, injected: 0 };

function makeClient(id) {
  const handlers = new Map();
  registerTools({ registerTool: (n, _s, h) => handlers.set(n, h) }, new ChromeUseRuntime());
  const call = async (name, a = {}) => {
    stats.ops += 1;
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      const res = await handlers.get(name)(a);
      const text = res?.content?.[0]?.text ?? "";
      return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
    } finally {
      stats.inFlight -= 1;
    }
  };
  return { id, call, liveTabs: new Set() };
}

async function worker(client, workerId) {
  const tab = await client.call("chrome_create_tab");
  client.liveTabs.add(tab.id);
  while (!deadline()) {
    try {
      await client.call("chrome_navigate", {
        tabId: tab.id,
        url: `https://www.google.com/search?q=${encodeURIComponent(pick(QUERIES))}`,
      });
      await pause();
      await client.call("chrome_cdp_send", { tabId: tab.id, method: "Target.getTargetInfo", params: {} });
      await pause();
      await client.call("chrome_evaluate", { tabId: tab.id, expression: "document.title", awaitPromise: true });
      await pause();
      stats.ok += 1;
    } catch (error) {
      if (/not attached|unattached|detached while/i.test(error.message)) {
        stats.unrecovered += 1;
        console.log(`  [s${client.id} w${workerId}] UNRECOVERED: ${error.message.slice(0, 70)}`);
      } else {
        stats.other += 1;
        console.log(`  [s${client.id} w${workerId}] other: ${error.message.slice(0, 70)}`);
      }
    }
  }
}

// Rip the debugger out from under a random live tab mid-flight, forcing the
// "torn down while a command runs" race that the self-heal must recover from.
async function disruptor(client) {
  while (!deadline()) {
    await sleep(600 + Math.floor(Math.random() * 900));
    const tabs = [...client.liveTabs];
    if (!tabs.length) continue;
    try {
      await client.call("chrome_detach_tab", { tabId: pick(tabs) });
      stats.injected += 1;
    } catch {
      // detach throws if already gone / mid-transition — that is the point.
    }
  }
}

console.log(
  `Race soak: ${SESSIONS} sessions x ${WORKERS} workers for ${DURATION_MS}ms` +
    (INJECT ? " + mid-flight detach injection" : ""),
);
const clients = Array.from({ length: SESSIONS }, (_, i) => makeClient(i));
const tasks = [];
for (const client of clients) {
  for (let w = 0; w < WORKERS; w++) tasks.push(worker(client, w));
  if (INJECT) tasks.push(disruptor(client));
}
await Promise.all(tasks);
for (const client of clients) {
  try { await client.call("chrome_finalize_tabs", { keep: [] }); } catch {}
}

console.log("──────── results ────────");
console.log(`total tool calls        : ${stats.ops}`);
console.log(`max concurrent in-flight: ${stats.maxInFlight}   (how much actually interleaved)`);
console.log(`work loops ok           : ${stats.ok}`);
console.log(`unrecovered not-attach  : ${stats.unrecovered}   (must be 0 — the regression signal)`);
console.log(`other errors            : ${stats.other}`);
if (INJECT) console.log(`detaches injected       : ${stats.injected}`);
console.log(`self-heals engaged      : ${sessionStats.heals}   (evictions recovered)`);
console.log(`heals that gave up      : ${sessionStats.unrecovered}`);
process.exit(stats.unrecovered > 0 ? 1 : 0);
