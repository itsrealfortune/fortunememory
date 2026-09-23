/**
 * Tests fortunememory : `npm test` (build puis node dist/test.js).
 * Sans réseau — providers temp (json, csv, sqlite), feature-hash offline.
 * Les suites aux dépendances optionnelles (roxify) sont skippées si absentes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FortuneMemoryManager } from "./manager.ts";
import { FeatureHashEncoder, cosineSimilarity } from "./vectors.ts";
import { memoryContentHash } from "./schema.ts";
import type { FortuneProvider } from "./providers/interface.ts";
import { jsonProviderFactory } from "./providers/json.ts";
import { csvProviderFactory } from "./providers/csv.ts";
import { sqliteProviderFactory } from "./providers/sqlite.ts";
import { roxifyProviderFactory } from "./providers/roxify.ts";
import { roxifiedCsvProviderFactory } from "./providers/roxcsv.ts";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

/** Provider wrapper : init auto à la première opération. */
function autoInit(provider: FortuneProvider): FortuneProvider {
  let ready = provider.init();

  const queue = <T>(fn: () => Promise<T>): Promise<T> =>
    (async () => {
      await ready;
      return fn();
    })();

  return {
    name: provider.name,
    init: () => queue(() => provider.init()),
    close: () => queue(() => provider.close()),
    addMemory: (memory, vector) => queue(() => provider.addMemory(memory, vector)),
    updateStatus: (id, status, at) => queue(() => provider.updateStatus(id, status, at)),
    getMemory: (id, includeForgotten) => queue(() => provider.getMemory(id, includeForgotten)),
    iterate: async function* (includeForgotten?: boolean) {
      await ready;
      yield* provider.iterate(includeForgotten);
    },
    count: () => queue(() => provider.count()),
  };
}

async function runSuite(label: string, factory: (dataDir: string) => FortuneProvider): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const dir = mkdtempSync(join(tmpdir(), "fortune-test-"));
  try {
    const manager = new FortuneMemoryManager(autoInit(factory(dir)));

    const fox = await manager.remember({
      type: "fact",
      content: "Fox c'est ma soeur de coeur, café ensemble le 08/09",
      summary: "Fox soeur de coeur",
      scope: "discord/dm/42",
      sensitivity: "private",
      confidence: 0.9,
      sourceKind: "discord",
      tags: ["name:fox"],
    });
    check("remember renvoie un record complet", Boolean(fox.id && fox.contentHash));

    await manager.remember({
      type: "fact",
      content: "Fortune code en Python sur le clone",
      summary: "Fortune dev",
      scope: "discord/99",
      sensitivity: "personal",
    });

    const lexical = await manager.search("Fox café", {
      retrieval: "lexical",
      scope: "discord/dm/42",
    });
    check("search lexical trouve Fox", lexical.some((m) => m.content.includes("Fox")));

    const hybrid = await manager.search("soeur de coeur café", { scope: "discord/dm/42" });
    check("search hybrid trouve Fox", hybrid.some((m) => m.id === fox.id));
    check(
      "hybrid expose relevance+match",
      hybrid[0]?.relevance !== undefined && hybrid[0]?.match !== undefined,
    );

    const vectorOnly = await manager.search("soeur de coeur", {
      retrieval: "vector",
      minVectorScore: 0.05,
    });
    check("search vector trouve un souvenir", vectorOnly.length > 0);

    const secret = await manager.remember({
      type: "note",
      content: "mot de passe wifi test secret",
      scope: "discord/dm/42",
      sensitivity: "private",
    });
    const publicOnly = await manager.search("wifi", { maxSensitivity: "public" });
    check("maxSensitivity public masque le private", !publicOnly.some((m) => m.id === secret.id));

    const subtree = await manager.list({ scope: "discord", limit: 100 });
    check("list scope préfixe ramasse discord/*", subtree.length === 3);

    const conflicts = await manager.findConflicts({
      content: "Fox c'est ma soeur de coeur, café ensemble le 08/09 (bis)",
      type: "fact",
      scope: "discord/dm/42",
    });
    check("findConflicts détecte le quasi-doublon", conflicts.some((c) => c.memory.id === fox.id));

    check("findConflicts ignore les types non listés",
      (await manager.findConflicts({ content: "n'importe quoi", type: "note", scope: "x" })).length === 0);

    check("forget soft-delete", await manager.forget(secret.id));
    check("get sur oublié = null", (await manager.get(secret.id)) === null);
    check(
      "get includeForgotten ressort",
      (await manager.get(secret.id, true))?.status === "forgotten",
    );

    const stats = await manager.stats();
    check("stats comptent 2 actifs / 1 oublié", stats.active === 2 && stats.forgotten === 1);

    // Dédup : même contenu au même scope → même record retourné
    const dupe = await manager.remember({
      type: "fact",
      content: "Fox c'est ma soeur de coeur, café ensemble le 08/09",
      scope: "discord/dm/42",
    });
    check("remember déduplique le contenu identique", dupe.id === fox.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Suites aux dépendances optionnelles : skip propre si absentes. */
async function runSuiteOptional(
  label: string,
  factory: (dataDir: string) => FortuneProvider,
): Promise<void> {
  try {
    await runSuite(label, factory);
  } catch (error) {
    if (error instanceof Error && /dépendance optionnelle/.test(error.message)) {
      console.log(`\n=== ${label} ===\n  ⊘ skip (${error.message})`);
      return;
    }
    throw error;
  }
}

export async function runTests(): Promise<void> {
  // vecteurs
  const encoder = new FeatureHashEncoder();
  const close = await encoder.encode("Fox café soeur de coeur");
  const similar = await encoder.encode("café avec Fox soeur");
  const unrelated = await encoder.encode("réplication base de données postgres");
  check("cosine(similaire) > cosine(étranger)",
    cosineSimilarity(close, similar) > cosineSimilarity(close, unrelated));
  check("norme unitaire",
    Math.abs(Math.sqrt(close.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-6);
  check("contentHash stable", memoryContentHash("abc") === memoryContentHash("abc"));

  await runSuite("JSON provider", (dir) => jsonProviderFactory(dir));
  await runSuite("CSV provider", (dir) => csvProviderFactory(dir));
  await runSuite("SQLite provider", (dir) => sqliteProviderFactory(dir));
  await runSuiteOptional("Roxify provider (PNG)", (dir) => roxifyProviderFactory(dir));
  await runSuiteOptional("RoxifiedCSV provider (PNG)", (dir) => roxifiedCsvProviderFactory(dir));

  // Persistence : réouverture
  console.log("\n=== Persistence (réouverture) ===");
  const dir = mkdtempSync(join(tmpdir(), "fortune-persist-"));
  try {
    const first = new FortuneMemoryManager(autoInit(jsonProviderFactory(dir)));
    await first.remember({ content: "persist me", scope: "personal" });
    const reopened = new FortuneMemoryManager(autoInit(jsonProviderFactory(dir)));
    const persisted = await reopened.search("persist me", { retrieval: "lexical" });
    check("json survive au reopen", persisted.some((m) => m.content === "persist me"));

    const sqDir = mkdtempSync(join(tmpdir(), "fortune-sqlite-"));
    const sq1 = new FortuneMemoryManager(autoInit(sqliteProviderFactory(sqDir)));
    await sq1.remember({ content: "sqlite persist test", scope: "personal" });
    const sq2 = new FortuneMemoryManager(autoInit(sqliteProviderFactory(sqDir)));
    check("sqlite survive au reopen",
      (await sq2.search("sqlite persist test", { retrieval: "lexical" })).length === 1);
    rmSync(sqDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n=== ${passed} passés, ${failed} échoués ===`);
  if (failed) process.exitCode = 1;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runTests();
}
