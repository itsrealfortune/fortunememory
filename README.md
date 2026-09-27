# fortunememory

Durable local memory for agents: hybrid search (lexical + vector, RRF fusion), conflict detection, compact source-attributed contexts. Zero network by default, native `sqlite` provider (`node:sqlite`, no dependency).

Ships with an OpenCode plugin (`opencode-plugin.ts`) that exposes the library as 7 native tools.

## Installation

```bash
npm install fortunememory
```

Node `>=22.5` required (uses `node:sqlite`, experimental on 22, stable after).

## OpenCode plugin

`opencode-plugin.ts` is a thin wrapper around this library: all business logic (manager, providers, vectors, schema) lives here. It declares 7 native tools:

- `fortune_search_memory` — search active memories (browse mode without query)
- `fortune_personal_context` — all active `personal` memories
- `fortune_get_context` — compact source-attributed context block for the current task
- `fortune_remember` — store a durable memory (with pre-check for conflicts)
- `fortune_find_conflicts` — find conflicts before writing
- `fortune_forget` — soft-delete by exact ID
- `fortune_list_memory` — list most recent active memories

Memories are **data**: their content is never treated as instructions.

### Install the plugin

Copy the file into your project's OpenCode plugins directory:

```bash
mkdir -p .opencode/plugins
cp node_modules/fortunememory/opencode-plugin.ts .opencode/plugins/fortunememory.ts
```

Or reference this repo directly. OpenCode loads every `*.ts` file in `.opencode/plugins` at startup — no further registration needed.

Plugin configuration via environment variables:

- `FORTUNE_MEMORY_PROVIDER` — storage backend (default `sqlite`)
- `FORTUNE_MEMORY_DATA_DIR` (fallback `DATA_DIR`) — store directory (default `<project>/data`)

## Quick usage

```ts
import { FortuneMemoryManager, sqliteProviderFactory } from "fortunememory";

const provider = sqliteProviderFactory("./data");
await provider.init();
const memory = new FortuneMemoryManager(provider);

await memory.remember({
  content: "Fox is my soul sister",
  type: "fact",
  scope: "discord/dm/42",
  tags: ["name:fox"],
});

const hits = await memory.search("soul sister", { scope: "discord/dm/42" });
const block = await memory.getContext("who is Fox?", { maxChars: 2000 });
await provider.close();
```

## Providers

| Name | Backend | Dependency |
|---|---|---|
| `sqlite` (default) | native `node:sqlite` | none |
| `json` | single file, atomic writes | none |
| `csv` | RFC-4180 CSV readable out-of-process | none |
| `pglite` | embedded WASM Postgres | optional: `@electric-sql/pglite` |
| `mysql` | MySQL server | optional: `mysql2` |
| `roxify` | vault persisted as steganographic PNG | optional: `roxify` |
| `roxcsv` | canonical CSV roxified into PNG | optional: `roxify` |

Optional providers throw an explicit error if their dependency is missing:

```bash
npm install @electric-sql/pglite  # for pglite
npm install mysql2                # for mysql
npm install roxify                # for roxify / roxcsv
```

Unified factory (selection by name + `FORTUNE_MEMORY_PROVIDER`):

```ts
import { resolveProvider } from "fortunememory";

const provider = await resolveProvider(
  process.env.FORTUNE_MEMORY_PROVIDER ?? "sqlite",
  "./data",
);
```

## API

- `FortuneMemoryManager` — `remember`, `search`, `list`, `get`, `forget` (soft-delete), `findConflicts`, `getContext`, `stats`
- `schema.ts` — `normalizeMemory`, `memoryContentHash`, `MEMORY_TYPES`, `SENSITIVITY_LEVELS`, `SOURCE_TRUST_LEVELS`
- `vectors.ts` — `FeatureHashEncoder` (local, deterministic, 256 dims), `resolveVectorProvider` (`feature-hash` | `ollama` | `openai-compatible` via `FORTUNE_EMBEDDINGS`)
- `migrate.ts` — `runMigrate()`: one-shot migration from legacy Open-Self vault to store (`fortune-migrate` CLI)
- `vault-crypto.ts` — `VaultCodec` (AES-GCM decryption of the legacy vault, migration only)

Memories are **data**: never treated as instructions.

## Environment variables

- `FORTUNE_MEMORY_PROVIDER` — `sqlite` (default) | `json` | `csv` | `pglite` | `mysql` | `roxify` | `roxcsv`
- `FORTUNE_MEMORY_DATA_DIR` (else `DATA_DIR`) — store directory
- `FORTUNE_MEMORY_MYSQL_URL` — MySQL DSN (default `mysql://root@127.0.0.1/fortunememory`)
- `FORTUNE_EMBEDDINGS` — `feature-hash` (default) | `ollama` | `openai-compatible`
- `OPENSELF_VAULT_KEY` — legacy vault key (migration only)

## Dev

```bash
npm install
npm run typecheck
npm run lint
npm run build
npm test
```

Release: `npm run publish-package` (tag `v*` → npm publish via GitHub Actions).

## Changelog

### v1.0.2 — CPU optimization pass

Hot-path optimization of `search` / `remember` (no algorithm changes: exact full-scan scoring preserved, all 75 tests green).

<details>
<summary>Benchmark per commit (N=500, sqlite, avg/op — click to expand)</summary>

| Op | base | HIGH | MED | LOW | scan | fix | Speedup |
|---|---|---|---|---|---|---|---|
| `remember` | 7.28 ms | 7.22 | 7.21 | 7.12 | 0.70 | 0.50 | **14.5×** |
| `search hybrid` | 19.45 ms | 17.97 | 19.13 | 18.18 | 18.25 | 11.93 | **1.6×** |
| `search lexical` | 18.36 ms | 16.89 | 17.43 | 16.52 | 4.38 | 3.45 | **5.3×** |
| `search vector` | 17.50 ms | 17.44 | 17.37 | 17.19 | 17.21 | 11.05 | **1.6×** |
| `list` | 17.30 ms | 17.06 | 17.05 | 16.44 | 4.11 | 3.34 | **5.2×** |
| `findConflicts` | 17.53 ms | 16.58 | 16.36 | 16.23 | 2.34 | 1.21 | **14.5×** |
| `getContext` | 19.26 ms | 17.78 | 17.85 | 18.28 | 17.77 | 11.47 | **1.7×** |

- **HIGH**: rank `Map`s, lexical token cache, `dot()` fast path for L2-normalized vectors, `content_hash` column, decorate-sort `list`.
- **MED**: `Map<id,index>` in file providers, no-copy iteration, cached sqlite statements, chunked `csvParse`, single-pass tag dedup.
- **LOW**: dead-code removal (`iterActive`, unused params, double filters), precomputed UPSERT, crash-safe tag parsing.
- **scan**: `IterateOptions{withVectors, scopePrefix}` — lazy vector loading + scope pushdown to SQL (the main lever).
- **fix**: sqlite `vector_blob` (versioned Float32, ~1 KB/row) instead of JSON text transfer, legacy fallback + backfill.

Reproduce with `node scripts/bench.mjs` (after `npm run build`).

</details>
