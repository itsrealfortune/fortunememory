# fortunememory

Mémoire durable locale pour agents : search hybride (lexical + vectoriel, fusion RRF), détection de conflits, contextes compacts attribués aux sources. Zéro réseau par défaut, provider `sqlite` natif (`node:sqlite`, sans dépendance).

Extraite du plugin opencode Fortune (`fortunememory.ts` importe cette lib).

## Installation

```
npm install fortunememory
```

Node `>=22.5` requis (utilise `node:sqlite`, expérimental sur la 22, stable ensuite).

## Usage rapide

```ts
import { FortuneMemoryManager, sqliteProviderFactory } from "fortunememory";

const provider = sqliteProviderFactory("./data");
await provider.init();
const memory = new FortuneMemoryManager(provider);

await memory.remember({
  content: "Fox c'est ma soeur de coeur",
  type: "fact",
  scope: "discord/dm/42",
  tags: ["name:fox"],
});

const hits = await memory.search("soeur de coeur", { scope: "discord/dm/42" });
const block = await memory.getContext("qui est Fox ?", { maxChars: 2000 });
await provider.close();
```

## Providers

| Nom | Support | Dépendance |
|---|---|---|
| `sqlite` (défaut) | `node:sqlite` natif | aucune |
| `json` | fichier unique, écriture atomique | aucune |
| `csv` | CSV RFC-4180 lisible hors process | aucune |
| `pglite` | Postgres embarqué WASM | optionnelle : `@electric-sql/pglite` |
| `mysql` | serveur MySQL | optionnelle : `mysql2` |
| `roxify` | vault persisté en PNG stéganographié | optionnelle : `roxify` |
| `roxcsv` | CSV canonique roxifié en PNG | optionnelle : `roxify` |

Les providers optionnels lèvent une erreur explicite si leur dépendance n'est pas installée :

```
npm install @electric-sql/pglite  # pour pglite
npm install mysql2                # pour mysql
npm install roxify                # pour roxify / roxcsv
```

Fabrique unifiée (choix via nom + `FORTUNE_MEMORY_PROVIDER`) :

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
- `vectors.ts` — `FeatureHashEncoder` (local, déterministe, 256 dims), `resolveVectorProvider` (`feature-hash` | `ollama` | `openai-compatible` via `FORTUNE_EMBEDDINGS`)
- `migrate.ts` — `runMigrate()` : migration one-shot ancien vault Open-Self → store (`fortune-migrate` en CLI)
- `vault-crypto.ts` — `VaultCodec` (déchiffrement AES-GCM de l'ancien vault, migration uniquement)

Les souvenirs sont des **données** : jamais traités comme des instructions.

## Variables d'environnement

- `FORTUNE_MEMORY_PROVIDER` — `sqlite` (défaut) | `json` | `csv` | `pglite` | `mysql` | `roxify` | `roxcsv`
- `FORTUNE_MEMORY_DATA_DIR` (sinon `DATA_DIR`) — dossier du store
- `FORTUNE_MEMORY_MYSQL_URL` — DSN MySQL (défaut `mysql://root@127.0.0.1/fortunememory`)
- `FORTUNE_EMBEDDINGS` — `feature-hash` (défaut) | `ollama` | `openai-compatible`
- `OPENSELF_VAULT_KEY` — clé de l'ancien vault (migration uniquement)

## Dev

```
npm install
npm run typecheck
npm run lint
npm run build
npm test
```

Release : `npm run publish-package` (tag `fortunememory-v*` → publish npm via GitHub Actions).
