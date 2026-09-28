// Bench fortunememory (dist) vs openself npm (ContextStore, better-sqlite3).
// Prérequis : npm i --no-save openself better-sqlite3 zod (lourds : discord.js…),
// ou OPENSELF_REF=<dir dépaqueté> (défaut /tmp/opencode/openself-ref).
// Reproduce : npm run bench:vs-openself
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FortuneMemoryManager, sqliteProviderFactory, FeatureHashEncoder } from "../dist/index.js";

const refDir = process.env.OPENSELF_REF ?? "/tmp/opencode/openself-ref";
let ContextStore;
try {
  ({ ContextStore } = await import("openself"));
} catch {
  ({ ContextStore } = await import(pathToFileURL(join(refDir, "src/context/store.js")).href));
}

const N = 500, QUERIES = 50;
const mk = (i) => ({
  content: `Memory number ${i} about database pricing deadline meeting decision preference project alpha ${i % 100}`,
  type: i % 3 === 0 ? "fact" : "note",
  scope: `bench/scope${i % 10}`,
  tags: [`tag${i % 50}`],
});
const q = (i) => `database pricing decision project ${i % 100}`;

// ── Fortune ──
const dirF = mkdtempSync(join(tmpdir(), "fm-bench-"));
const provider = sqliteProviderFactory(dirF);
await provider.init();
const mgr = new FortuneMemoryManager(provider, new FeatureHashEncoder());

let t0 = performance.now();
for (let i = 0; i < N; i++) await mgr.remember(mk(i));
const fortuneWrite = performance.now() - t0;

// ── OpenSelf ──
const dirO = mkdtempSync(join(tmpdir(), "os-bench-"));
const store = new ContextStore({ dataDir: dirO });

t0 = performance.now();
for (let i = 0; i < N; i++) store.remember(mk(i));
const openselfWrite = performance.now() - t0;

async function benchAsync(fn, iters, label) {
  for (let i = 0; i < 5; i++) await fn(i);
  const s = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const ms = performance.now() - s;
  return { label, total: ms, avg: ms / iters };
}
function benchSync(fn, iters, label) {
  for (let i = 0; i < 5; i++) fn(i);
  const s = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const ms = performance.now() - s;
  return { label, total: ms, avg: ms / iters };
}

const rows = [];
async function compare(label, fortuneFn, openselfFn, iters) {
  const f = await benchAsync(fortuneFn, iters, label);
  const o = benchSync(openselfFn, iters, label);
  const speedup = o.avg / f.avg;
  rows.push({ label, fortune: f.avg, openself: o.avg, speedup });
}

// sanity: both have N active memories
console.log(`fortune active=${(await mgr.stats()).active} openself active=${store.stats().active}`);

await compare("search-hybrid", (i) => mgr.search(q(i), { limit: 10 }), (i) => store.search(q(i), { limit: 10 }), QUERIES);
await compare("search-lexical", (i) => mgr.search(q(i), { limit: 10, retrieval: "lexical" }), (i) => store.search(q(i), { limit: 10, retrieval: "lexical" }), QUERIES);
await compare("search-vector", (i) => mgr.search(q(i), { limit: 10, retrieval: "vector" }), (i) => store.search(q(i), { limit: 10, retrieval: "vector" }), QUERIES);
await compare("list", (i) => mgr.list({ limit: 20 }), (i) => store.list({ limit: 20 }), 100);
await compare("conflicts", (i) => mgr.findConflicts({ content: q(i), type: "fact", scope: "bench/scope1" }), (i) => store.findPotentialConflicts({ content: q(i), type: "fact", scope: "bench/scope1" }), 20);
await compare("context", (i) => mgr.getContext(q(i), { limit: 12 }), (i) => store.buildContext(q(i), { limit: 12 }), 20);

console.log(`\nremember: fortune avg=${(fortuneWrite / N).toFixed(3)}ms/op openself avg=${(openselfWrite / N).toFixed(3)}ms/op speedup=${(openselfWrite / fortuneWrite).toFixed(2)}x`);
console.log("\n| Op | fortunememory avg | openself avg | speedup (openself/fortune) |");
console.log("|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.label} | ${r.fortune.toFixed(3)} ms | ${r.openself.toFixed(3)} ms | ${r.speedup.toFixed(2)}x |`);
}

// pertinence sanity: top-1 id overlap sur une requête
const fq = await mgr.search(q(7), { limit: 5 });
const oq = store.search(q(7), { limit: 5 });
console.log(`\nfortune top5 ids: ${fq.map((m) => m.id.slice(0, 8)).join(",")}`);
console.log(`openself top5 ids: ${oq.map((m) => m.id.slice(0, 8)).join(",")}`);

await provider.close();
store.close();
rmSync(dirF, { recursive: true, force: true });
rmSync(dirO, { recursive: true, force: true });
