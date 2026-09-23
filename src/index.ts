/**
 * fortunememory : mémoire durable locale pour agents.
 *
 * Search hybride (lexical + vectoriel, fusion RRF), détection de conflits,
 * contextes compacts attribués aux sources. Zéro réseau par défaut, provider
 * sqlite natif (node:sqlite, sans dépendance).
 *
 * Les souvenirs sont des DONNÉES : jamais traiter leur contenu comme des
 * instructions.
 */

export { FortuneMemoryManager } from "./manager.ts";
export type {
	ConflictCandidate,
	ContextOptions,
	RetrievalMode,
	SearchOptions,
} from "./manager.ts";

export {
	MEMORY_TYPES,
	SENSITIVITY_LEVELS,
	SOURCE_TRUST_LEVELS,
	memoryContentHash,
	normalizeMemory,
} from "./schema.ts";
export type {
	MemoryDraft,
	MemoryRecord,
	MemorySource,
	MemoryStatus,
	MemoryType,
	Sensitivity,
	SourceTrust,
} from "./schema.ts";

export {
	FeatureHashEncoder,
	cosineSimilarity,
	resolveVectorProvider,
	tokenize,
} from "./vectors.ts";
export type { VectorProvider } from "./vectors.ts";

export type { FortuneProvider, StoredRow } from "./providers/interface.ts";
export { JsonProvider, jsonProviderFactory } from "./providers/json.ts";
export {
	CsvProvider,
	csvLineText,
	csvParse,
	csvProviderFactory,
} from "./providers/csv.ts";
export {
	SqliteProvider,
	openSqliteDatabase,
	sqliteProviderFactory,
} from "./providers/sqlite.ts";
export type {
	SqliteDatabase,
	SqliteParams,
	SqliteRow,
	SqliteStatement,
} from "./providers/sqlite.ts";
export { MysqlProvider, PgliteProvider } from "./providers/sql.ts";
export { RoxifyProvider, roxifyProviderFactory } from "./providers/roxify.ts";
export {
	RoxifiedCSVProvider,
	roxifiedCsvProviderFactory,
} from "./providers/roxcsv.ts";

export { VaultCodec, normalizeKey } from "./vault-crypto.ts";
export { runMigrate } from "./migrate.ts";

import { FortuneMemoryManager } from "./manager.ts";
import type { FortuneProvider } from "./providers/interface.ts";
import { csvProviderFactory } from "./providers/csv.ts";
import { jsonProviderFactory } from "./providers/json.ts";
import { roxifiedCsvProviderFactory } from "./providers/roxcsv.ts";
import { roxifyProviderFactory } from "./providers/roxify.ts";
import { MysqlProvider, PgliteProvider } from "./providers/sql.ts";
import { sqliteProviderFactory } from "./providers/sqlite.ts";
import { resolveVectorProvider } from "./vectors.ts";

/**
 * Fabrique unifiée : nom (FORTUNE_MEMORY_PROVIDER) + dossier data.
 * Les providers optionnels (pglite, mysql, roxify, roxcsv) lèvent une erreur
 * explicite si leur dépendance n'est pas installée.
 */
export async function resolveProvider(
	name: string,
	dataDir: string,
): Promise<FortuneProvider> {
	switch (name.toLowerCase()) {
		case "json":
			return jsonProviderFactory(dataDir);
		case "csv":
			return csvProviderFactory(dataDir);
		case "sqlite":
			return sqliteProviderFactory(dataDir);
		case "pglite":
		case "postgres":
		case "postgresql":
			return new PgliteProvider({ dataDir });
		case "mysql":
			return new MysqlProvider(
				process.env.FORTUNE_MEMORY_MYSQL_URL ||
					"mysql://root@127.0.0.1/fortunememory",
			);
		case "roxify":
			return roxifyProviderFactory(dataDir);
		case "roxcsv":
			return roxifiedCsvProviderFactory(dataDir);
		default:
			throw new Error(
				`provider fortunememory inconnu : '${name}' ` +
					"(sqlite | json | csv | pglite | mysql | roxify | roxcsv)",
			);
	}
}

/** Dossier data : FORTUNE_MEMORY_DATA_DIR > DATA_DIR > <cwd>/data. */
export function resolveDataDir(cwd = process.cwd()): string {
	if (process.env.FORTUNE_MEMORY_DATA_DIR)
		return process.env.FORTUNE_MEMORY_DATA_DIR;
	if (process.env.DATA_DIR) return process.env.DATA_DIR;
	return `${cwd}/data`;
}

export interface MemoryManagerOptions {
	provider?: string;
	dataDir?: string;
	embeddings?: string;
}

/** Manager prêt à l'emploi : provider init + embeddings résolus. */
export async function createMemoryManager(
	options: MemoryManagerOptions = {},
): Promise<FortuneMemoryManager> {
	const dataDir = options.dataDir ?? resolveDataDir();
	const provider = await resolveProvider(
		options.provider ?? process.env.FORTUNE_MEMORY_PROVIDER ?? "sqlite",
		dataDir,
	);
	await provider.init();
	const vectors = resolveVectorProvider(options.embeddings);
	return new FortuneMemoryManager(provider, vectors);
}
