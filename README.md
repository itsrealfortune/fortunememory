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

Release: `npm run publish-package` (tag `fortunememory-v*` → npm publish via GitHub Actions).
