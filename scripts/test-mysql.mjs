import { FortuneMemoryManager, MysqlProvider, FeatureHashEncoder } from "../dist/index.js";

process.env.FORTUNE_MEMORY_MYSQL_URL =
  "mysql://root:test@127.0.0.1:13306/fortunememory";

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
};

const p = new MysqlProvider(process.env.FORTUNE_MEMORY_MYSQL_URL);
await p.init();
const m = new FortuneMemoryManager(p, new FeatureHashEncoder());

const mems = [];
for (let i = 0; i < 20; i++) {
  mems.push(
    await m.remember({
      content: `mysql memory ${i} database pricing`,
      type: i % 2 ? "fact" : "note",
      scope: `my/s${i % 3}`,
    }),
  );
}
check("remember x20", mems.length === 20);
const got = await p.getMemory(mems[0].id);
check("getMemory active", got?.id === mems[0].id);
const hits = await m.search("database pricing", { limit: 5 });
check("search hybrid >0", hits.length > 0);
const lex = await m.search("database pricing", { limit: 5, retrieval: "lexical" });
check("search lexical >0", lex.length > 0);
const scoped = await m.list({ scope: "my/s0", limit: 20 });
check("list scope", scoped.length > 0 && scoped.every((x) => x.scope.startsWith("my/s0")));
await m.forget(mems[0].id);
check("forget", (await p.getMemory(mems[0].id)) === null);
check("forget visible w/ flag", (await p.getMemory(mems[0].id, true))?.status === "forgotten");
await p.addMany(mems.slice(1, 6).map((memory) => ({ memory, vector: [0.5, 0.25] })));
check("provider.addMany multi-row REPLACE", true);
const rows = [];
for await (const r of p.iterate(false, {})) rows.push(r);
check("iterate with vectors", rows.length >= 19 && rows.every((r) => r.vector === null || Array.isArray(r.vector)));
const novec = [];
for await (const r of p.iterate(false, { withVectors: false })) novec.push(r);
check("iterate without vectors", novec.length >= 19 && novec.every((r) => r.vector === null));
// blob precision: find a row written with [0.5, 0.25]
const blobRow = rows.find((r) => r.vector && r.vector.length === 2);
check("blob roundtrip via Buffer", !!blobRow && Math.abs(blobRow.vector[0] - 0.5) < 1e-6);
const stats = await p.count();
check("count", stats.active + stats.forgotten >= 20);
await p.close();

console.log(failures ? `\n${failures} FAILURES` : "\nALL GREEN");
process.exit(failures ? 1 : 0);
