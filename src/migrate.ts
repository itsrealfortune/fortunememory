#!/usr/bin/env node
/**
 * Migration one-shot : ancien vault Open-Self (context.db, AES-GCM si clé)
 * → store fortunememory choisi (FORTUNE_MEMORY_PROVIDER / TARGET_DATA_DIR).
 *
 * CLI (bin `fortune-migrate`) :
 *   fortune-migrate [--source <dataDir>] [--target <dir>]
 *
 * Lib : `import { runMigrate } from "fortunememory"`.
 *
 * Clé : OPENSELF_VAULT_KEY (si l'ancien vault était chiffré). La cible
 * fortunememory n'encrypte pas.
 */

import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSqliteDatabase } from "./providers/sqlite.ts";
import { VaultCodec, normalizeKey } from "./vault-crypto.ts";
import { normalizeMemory } from "./schema.ts";
import { jsonProviderFactory } from "./providers/json.ts";
import { csvProviderFactory } from "./providers/csv.ts";
import { sqliteProviderFactory } from "./providers/sqlite.ts";
import { MysqlProvider, PgliteProvider } from "./providers/sql.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveTarget(name: string, dataDir: string) {
  switch (name) {
    case "json":
      return jsonProviderFactory(dataDir);
    case "csv":
      return csvProviderFactory(dataDir);
    case "sqlite":
      return sqliteProviderFactory(dataDir);
    case "pglite":
      return new PgliteProvider({ dataDir });
    case "mysql":
      return new MysqlProvider(
        process.env.FORTUNE_MEMORY_MYSQL_URL || "mysql://root@127.0.0.1/fortunememory",
      );
    default:
      throw new Error(`provider cible inconnu : '${name}'`);
  }
}

export async function runMigrate(): Promise<number> {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(pluginDir, "..", "..", "..");
  const sourceDir = resolve(arg("source") ?? join(projectRoot, "data"));
  const targetDir = resolve(arg("target") ?? join(projectRoot, "fortune-data"));
  const vaultPath = join(sourceDir, "context.db");

  if (!existsSync(vaultPath)) {
    console.error(`✗ vault source introuvable : ${vaultPath}`);
    return 1;
  }

  const keyEnv = process.env.OPENSELF_VAULT_KEY;
  let codec: VaultCodec | null = null;
  if (keyEnv) {
    codec = new VaultCodec(normalizeKey(keyEnv));
  }

  const db = await openSqliteDatabase(vaultPath, true);
  const rows = db
    .prepare("SELECT * FROM memories WHERE status = 'active'")
    .all() as Array<Record<string, unknown>>;
  console.log(`⇒ ${rows.length} souvenirs actifs à migrer depuis ${vaultPath}`);

  const provider = await resolveTarget(
    (process.env.FORTUNE_MEMORY_PROVIDER || "sqlite").toLowerCase(),
    targetDir,
  );
  await provider.init();

  const decode = (value: unknown, purpose = "field"): string => {
    const text = String(value ?? "");
    if (codec) return codec.decode(text, purpose);
    return text;
  };

  const now = new Date();
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const draft = {
        id: undefined,
        type: String(row.type ?? "note"),
        content: decode(row.content, "content"),
        summary: decode(row.summary ?? "", "summary"),
        scope: String(row.scope ?? "personal"),
        sensitivity: String(row.sensitivity ?? "personal"),
        sourceTrust: String(row.source_trust ?? "external"),
        confidence: Number(row.confidence ?? 1),
        sourceKind: decode(row.source_kind, "source-kind") || "openself",
        sourceLocator: decode(row.source_locator, "source-locator") || "",
        sourceTitle: decode(row.source_title, "source-title") || "",
        validFrom: row.valid_from ? String(row.valid_from) : null,
        validTo: row.valid_to ? String(row.valid_to) : null,
        occurredAt: row.occurred_at ? String(row.occurred_at) : null,
        tags: safeTags(decode(row.tags ?? "[]", "tags")),
      };
      const memory = normalizeMemory(draft as never, new Date(String(row.created_at ?? now.toISOString())));
      // Préserve les dates originelles createdAt/updatedAt (portabilité).
      memory.createdAt = String(row.created_at ?? memory.createdAt);
      memory.updatedAt = String(row.updated_at ?? memory.updatedAt);
      memory.forgottenAt = (row.forgotten_at as string | null) ?? null;
      const vector = parseVector(decode(row.vector ?? "", "vector"));
      await provider.addMemory(memory, vector);
      migrated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  ✗ id=${String(row.id).slice(0, 8)} : ${(error as Error).message}`);
    }
  }
  await provider.close();

  console.log(
    `✓ Migration terminée : ${migrated} migrés, ${failed} échecs → ${(provider as { name?: string }).name} ${targetDir}`,
  );
  db.close();
  return failed ? 1 : 0;
}

function safeTags(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseVector(text: string): number[] | null {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runMigrate().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
