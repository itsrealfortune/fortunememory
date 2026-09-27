import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FortuneMemoryManager, sqliteProviderFactory, FeatureHashEncoder, tokenize, cosineSimilarity } from "../dist/index.js";

const N = 500, QUERIES = 50;
const dir = mkdtempSync(join(tmpdir(), "fm-bench-"));
const provider = sqliteProviderFactory(dir);
await provider.init();
const mgr = new FortuneMemoryManager(provider, new FeatureHashEncoder());

const t0 = performance.now();
for (let i = 0; i < N; i++) {
  await mgr.remember({ content: `Memory number ${i} about database pricing deadline meeting decision preference project alpha ${i % 100}`, type: i % 3 === 0 ? "fact" : "note", scope: `bench/scope${i % 10}`, tags: [`tag${i % 50}`] });
}
const writeMs = performance.now() - t0;

async function bench(fn, iters, label) {
  // warmup
  for (let i = 0; i < 5; i++) await fn(i);
  const s = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const ms = performance.now() - s;
  console.log(`${label}: total=${ms.toFixed(1)}ms avg=${(ms / iters).toFixed(3)}ms/op (${iters} ops)`);
  return ms;
}

const q = (i) => `database pricing decision project ${i % 100}`;
await bench((i) => mgr.search(q(i), { limit: 10 }), QUERIES, "search-hybrid     ");
await bench((i) => mgr.search(q(i), { limit: 10, retrieval: "lexical" }), QUERIES, "search-lexical    ");
await bench((i) => mgr.search(q(i), { limit: 10, retrieval: "vector" }), QUERIES, "search-vector     ");
await bench((i) => mgr.list({ limit: 20 }), 100, "list              ");
await bench((i) => mgr.findConflicts({ content: q(i), type: "fact", scope: "bench/scope1" }), 20, "findConflicts     ");
await bench((i) => mgr.getContext(q(i), { limit: 12 }), 20, "getContext        ");

// micro: tokenize/encode/cosine
{
  const s = performance.now();
  for (let i = 0; i < 5000; i++) tokenize(`Hello world database pricing meeting ${i} lorem ipsum dolor`);
  const ms = performance.now() - s;
  console.log(`tokenize: total=${ms.toFixed(1)}ms avg=${(ms / 5000).toFixed(4)}ms/op (5000 ops)`);
}
{
  const enc = new FeatureHashEncoder();
  const v = await enc.encode("hello world test");
  const s = performance.now();
  const IT = 20000;
  for (let i = 0; i < IT; i++) cosineSimilarity(v, v);
  const ms = performance.now() - s;
  console.log(`cosineSimilarity(256d): total=${ms.toFixed(1)}ms avg=${(ms / IT).toFixed(5)}ms/op (${IT} ops)`);
}
console.log(`remember: total=${writeMs.toFixed(1)}ms avg=${(writeMs / N).toFixed(3)}ms/op (${N} ops)`);
await provider.close();
rmSync(dir, { recursive: true, force: true });
