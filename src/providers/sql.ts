/**
 * Providers SQL serveur/embedded : PGLite (Postgres embarqué WASM) et MySQL.
 *
 * Utilisent le même dialecte avec paramètrescala $1/$? et lazily importés :
 * si le paquet n'est pas installé, seul ce provider échoue (pas le plugin
 * entier). Schemas identiques à sqlite.ts (colonnes renommées à la main).
 */

import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import {
	encodeVectorBlob,
	parseVectorBlob,
	type NumericVector,
} from "../vectors.ts";
import type {
	FortuneProvider,
	IterateOptions,
	ProviderCapabilities,
	StoredRow,
} from "./interface.ts";

const COLUMNS = [
	"id",
	"type",
	"content",
	"summary",
	"source_kind",
	"source_locator",
	"source_title",
	"scope",
	"sensitivity",
	"source_trust",
	"confidence",
	"valid_from",
	"valid_to",
	"occurred_at",
	"tags",
	"status",
	"created_at",
	"updated_at",
	"forgotten_at",
	"vector",
	"vector_blob",
	"content_hash",
] as const;

const UPSERT_SQL = `INSERT INTO fortune_memories (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${COLUMNS.slice(1)
					.map((column, index) => `${column} = $${index + 2}`)
					.join(", ")}`;

const ORDER_CREATED_DESC = "ORDER BY created_at DESC";
/** Tri récent poussé en SQL : dates normalisées UTC → ordre lexicographique
 * = chronologique. */
const ORDER_RECENT_DESC =
	"ORDER BY COALESCE(occurred_at, valid_from, created_at) DESC";
const CREATE_TABLE_POSTGRES = `
  CREATE TABLE IF NOT EXISTS fortune_memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT 'manual',
    source_locator TEXT NOT NULL DEFAULT '',
    source_title TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'personal',
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    source_trust TEXT NOT NULL DEFAULT 'owner',
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    valid_from TEXT,
    valid_to TEXT,
    occurred_at TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT,
    vector TEXT,
    vector_blob BYTEA,
    content_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS fortune_memories_scope_idx
    ON fortune_memories(scope, status);
`;

const CREATE_TABLE_MYSQL = `
  CREATE TABLE IF NOT EXISTS fortune_memories (
    id VARCHAR(64) PRIMARY KEY,
    type VARCHAR(20) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    summary TEXT NOT NULL,
    source_kind VARCHAR(50) NOT NULL DEFAULT 'manual',
    source_locator TEXT,
    source_title TEXT,
    scope VARCHAR(200) NOT NULL DEFAULT 'personal',
    sensitivity VARCHAR(20) NOT NULL DEFAULT 'personal',
    source_trust VARCHAR(20) NOT NULL DEFAULT 'owner',
    confidence DOUBLE NOT NULL DEFAULT 1,
    valid_from TEXT,
    valid_to TEXT,
    occurred_at TEXT,
    tags TEXT,
    status VARCHAR(12) NOT NULL DEFAULT 'active',
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    forgotten_at TEXT,
    vector LONGTEXT,
    content_hash TEXT,
    INDEX fortune_memories_scope (scope(64), status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export class PgliteProvider implements FortuneProvider {
	readonly name = "pglite";
	readonly capabilities: ProviderCapabilities = { recentFirst: true };
	private client: Awaited<ReturnType<typeof importPGlite>> | null = null;
	private readonly config: { dataDir?: string };

	constructor(options: { dataDir?: string } = {}) {
		this.config = options;
	}

	static async create(
		options: { dataDir?: string } = {},
	): Promise<PgliteProvider> {
		return new PgliteProvider(options);
	}

	private async require(): Promise<Awaited<ReturnType<typeof importPGlite>>> {
		if (!this.client) throw new Error("PgliteProvider pas initialisé");
		return this.client;
	}

	async init(): Promise<void> {
		this.client = await importPGlite(this.config.dataDir);
		await this.client.exec(CREATE_TABLE_POSTGRES);
		try {
			await this.client.exec(
				"ALTER TABLE fortune_memories ADD COLUMN vector_blob BYTEA",
			);
		} catch {
			// Déjà présente.
		}
		try {
			await this.client.exec(
				"ALTER TABLE fortune_memories ADD COLUMN content_hash TEXT",
			);
		} catch {
			// Déjà présente.
		}
		// Index dédup (après ALTER : les bases legacy n'avaient pas la colonne).
		try {
			await this.client.exec(
				"CREATE INDEX IF NOT EXISTS fortune_memories_hash_idx ON fortune_memories(content_hash, scope)",
			);
		} catch {
			// Index déjà présent.
		}
		// Backfill : les lignes legacy n'ont pas de hash - la dédup SQL les
		// trouverait sinon.
		const legacy = await this.client.query(
			"SELECT id, content FROM fortune_memories WHERE content_hash IS NULL",
		);
		for (const row of (legacy.rows ?? []) as Array<{
			id?: unknown;
			content?: unknown;
		}>) {
			await this.client.query(
				"UPDATE fortune_memories SET content_hash=$1 WHERE id=$2",
				[memoryContentHash(String(row.content ?? "")), String(row.id)],
			);
		}
	}

	async close(): Promise<void> {
		await this.client?.close();
		this.client = null;
	}

	private memoryToParams(
		memory: MemoryRecord,
		vector: NumericVector | null,
	): unknown[] {
		return [
			memory.id,
			memory.type,
			memory.content,
			memory.summary,
			memory.source.kind,
			memory.source.locator ?? "",
			memory.source.title ?? "",
			memory.scope,
			memory.sensitivity,
			memory.sourceTrust,
			memory.confidence,
			memory.validFrom ?? null,
			memory.validTo ?? null,
			memory.occurredAt ?? null,
			JSON.stringify(memory.tags),
			memory.status,
			memory.createdAt,
			memory.updatedAt,
			memory.forgottenAt ?? null,
			null, // colonne legacy : le vecteur vit dans vector_blob
			vector ? encodeVectorBlob(vector) : null,
			memory.contentHash ?? memoryContentHash(memory.content),
		];
	}

	async addMemory(
		memory: MemoryRecord,
		vector: NumericVector | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		const client = await this.require();
		await client.query(UPSERT_SQL, this.memoryToParams(memory, vector));
	}

	async addMany(
		entries: Array<{ memory: MemoryRecord; vector: NumericVector | null }>,
	): Promise<void> {
		if (!entries.length) return;
		const width = COLUMNS.length;
		const groups = new Array<string>(entries.length);
		const params: unknown[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			entry.memory.contentHash =
				entry.memory.contentHash ?? memoryContentHash(entry.memory.content);
			const row = this.memoryToParams(entry.memory, entry.vector);
			const base = i * width;
			const placeholders = new Array<string>(width);
			for (let c = 0; c < width; c++) {
				placeholders[c] = `$${base + c + 1}`;
				params.push(row[c]);
			}
			groups[i] = `(${placeholders.join(", ")})`;
		}
		const client = await this.require();
		await client.query(
			`INSERT INTO fortune_memories (${COLUMNS.join(", ")}) VALUES ${groups.join(", ")} ${UPSERT_SQL.slice(UPSERT_SQL.indexOf("ON CONFLICT"))}`,
			params,
		);
	}

	async updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean> {
		const client = await this.require();
		const result = await client.query(
			"UPDATE fortune_memories SET status=$1, forgotten_at=$2, updated_at=$3 WHERE id=$4",
			[status, status === "forgotten" ? at : null, at, id],
		);
		return (result.changes ?? result.rowCount ?? 0) > 0;
	}

	/** Dédup O(1) via fortune_memories_hash_idx (content_hash, scope). */
	async findByContentHash(
		hash: string,
		scope: string,
	): Promise<MemoryRecord | null> {
		if (!hash) return null;
		const client = await this.require();
		const result = await client.query(
			"SELECT * FROM fortune_memories WHERE content_hash=$1 AND status='active' AND (scope=$2 OR scope LIKE $3) ORDER BY created_at DESC LIMIT 1",
			[hash, scope, `${scope}/%`],
		);
		const row = result.rows?.[0];
		return row ? rowToMemory(row as never) : null;
	}

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const client = await this.require();
		const result = await client.query(
			includeForgotten
				? "SELECT * FROM fortune_memories WHERE id=$1"
				: "SELECT * FROM fortune_memories WHERE id=$1 AND status='active'",
			[id],
		);
		const row = result.rows?.[0];
		return row ? rowToMemory(row as never) : null;
	}

	async *iterate(
		includeForgotten = false,
		opts: IterateOptions = {},
	): AsyncIterable<StoredRow> {
		const client = await this.require();
		const columns =
			opts.withVectors === false
				? COLUMNS.filter(
						(column) => column !== "vector" && column !== "vector_blob",
					).join(", ")
				: "*";
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (!includeForgotten) conditions.push("status='active'");
		if (opts.scopePrefix) {
			conditions.push(
				`(scope=$${params.length + 1} OR scope LIKE $${params.length + 2})`,
			);
			params.push(opts.scopePrefix, `${opts.scopePrefix}/%`);
		}
		if (opts.typeFilter) {
			conditions.push(`type=$${params.length + 1}`);
			params.push(opts.typeFilter);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const order = opts.recentFirst ? ORDER_RECENT_DESC : ORDER_CREATED_DESC;
		const result = await client.query(
			`SELECT ${columns} FROM fortune_memories ${where} ${order}`,
			params.length ? params : undefined,
		);
		for (const row of result.rows ?? []) {
			yield {
				memory: rowToMemory(row as never),
				vector: opts.withVectors === false ? null : parseVector(row as never),
			};
		}
	}

	async count(): Promise<{ active: number; forgotten: number }> {
		const client = await this.require();
		const result = await client.query(
			`SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active,
         COUNT(*) FILTER (WHERE status != 'active') AS forgotten
       FROM fortune_memories`,
		);
		const row = (result.rows?.[0] ?? {}) as {
			active?: string | number;
			forgotten?: string | number;
		};
		return {
			active: Number(row.active) || 0,
			forgotten: Number(row.forgotten) || 0,
		};
	}
}

async function importPGlite(dataDir?: string | undefined): Promise<{
	exec(sql: string): Promise<void>;
	query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ rows?: T[]; changes?: number; rowCount?: number }>;
	close(): Promise<void>;
}> {
	let mod: typeof import("@electric-sql/pglite");
	try {
		mod = await import("@electric-sql/pglite");
	} catch {
		throw new Error(
			"provider pglite exige la dépendance optionnelle '@electric-sql/pglite' " +
				"(npm install @electric-sql/pglite)",
		);
	}
	const client = new mod.PGlite(dataDir);
	return client as unknown as {
		exec(sql: string): Promise<void>;
		query<T = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
		): Promise<{ rows?: T[]; changes?: number; rowCount?: number }>;
		close(): Promise<void>;
	};
}

export class MysqlProvider implements FortuneProvider {
	readonly name = "mysql";
	readonly capabilities: ProviderCapabilities = { recentFirst: true };
	private conn: {
		query(sql: string, params?: unknown[]): Promise<unknown[]>;
		end(): Promise<void>;
		execute(sql: string, params?: unknown[]): Promise<unknown>;
	} | null = null;
	private readonly dsn: string;

	constructor(dsn: string) {
		this.dsn = dsn;
	}

	async init(): Promise<void> {
		let mysql: typeof import("mysql2/promise");
		try {
			mysql = await import("mysql2/promise");
		} catch {
			throw new Error(
				"provider mysql exige la dépendance optionnelle 'mysql2' " +
					"(npm install mysql2)",
			);
		}
		this.conn = (await mysql.createConnection(
			this.dsn,
		)) as unknown as NonNullable<typeof this.conn>;
		await this.conn.execute(CREATE_TABLE_MYSQL);
		try {
			await this.conn.execute(
				"ALTER TABLE fortune_memories ADD COLUMN vector_blob LONGBLOB",
			);
		} catch {
			// Déjà présente.
		}
		try {
			await this.conn.execute(
				"ALTER TABLE fortune_memories ADD COLUMN content_hash TEXT",
			);
		} catch {
			// Déjà présente.
		}
		// Index dédup (après ALTER : les bases legacy n'avaient pas la colonne).
		try {
			await this.conn.execute(
				"CREATE INDEX fortune_memories_hash_idx ON fortune_memories (content_hash(64), scope(64))",
			);
		} catch {
			// Index déjà présent.
		}
		// Backfill : les lignes legacy n'ont pas de hash - la dédup SQL les
		// trouverait sinon.
		const legacy = (await this.query(
			"SELECT id, content FROM fortune_memories WHERE content_hash IS NULL",
		)) as Array<{ id?: unknown; content?: unknown }>;
		for (const row of legacy) {
			await this.execute(
				"UPDATE fortune_memories SET content_hash=? WHERE id=?",
				[memoryContentHash(String(row.content ?? "")), String(row.id)],
			);
		}
	}

	async close(): Promise<void> {
		await this.conn?.end();
		this.conn = null;
	}

	private memoryToParams(
		memory: MemoryRecord,
		vector: NumericVector | null,
	): unknown[] {
		return [
			memory.id,
			memory.type,
			memory.content,
			memory.summary,
			memory.source.kind,
			memory.source.locator ?? "",
			memory.source.title ?? "",
			memory.scope,
			memory.sensitivity,
			memory.sourceTrust,
			memory.confidence,
			memory.validFrom ?? null,
			memory.validTo ?? null,
			memory.occurredAt ?? null,
			JSON.stringify(memory.tags),
			memory.status,
			memory.createdAt,
			memory.updatedAt,
			memory.forgottenAt ?? null,
			null, // colonne legacy : le vecteur vit dans vector_blob
			vector ? encodeVectorBlob(vector) : null,
			memory.contentHash ?? memoryContentHash(memory.content),
		];
	}

	private async query(sql: string, params?: unknown[]): Promise<unknown[]> {
		if (!this.conn) throw new Error("MysqlProvider pas initialisé");
		// mysql2/promise renvoie un tuple [rows, fields] : on déballe.
		const result = (await this.conn.query(sql, params)) as unknown;
		if (Array.isArray(result) && Array.isArray(result[0])) {
			return result[0] as unknown[];
		}
		return result as unknown[];
	}

	private async execute(sql: string, params?: unknown[]): Promise<unknown> {
		if (!this.conn) throw new Error("MysqlProvider pas initialisé");
		const result = (await this.conn.execute(sql, params)) as unknown;
		if (Array.isArray(result) && !Array.isArray(result[0])) {
			return result[0];
		}
		return result;
	}

	async addMemory(
		memory: MemoryRecord,
		vector: NumericVector | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		await this.execute(
			`REPLACE INTO fortune_memories (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
			this.memoryToParams(memory, vector),
		);
	}

	async addMany(
		entries: Array<{ memory: MemoryRecord; vector: NumericVector | null }>,
	): Promise<void> {
		if (!entries.length) return;
		const single = `(${COLUMNS.map(() => "?").join(", ")})`;
		const groups = new Array<string>(entries.length).fill(single);
		const params: unknown[] = [];
		for (const entry of entries) {
			entry.memory.contentHash =
				entry.memory.contentHash ?? memoryContentHash(entry.memory.content);
			params.push(...this.memoryToParams(entry.memory, entry.vector));
		}
		await this.execute(
			`REPLACE INTO fortune_memories (${COLUMNS.join(", ")}) VALUES ${groups.join(", ")}`,
			params,
		);
	}

	async updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean> {
		const params = [status, status === "forgotten" ? at : null, at, id];
		const result = (await this.execute(
			"UPDATE fortune_memories SET status=?, forgotten_at=?, updated_at=? WHERE id=?",
			params,
		)) as { affectedRows?: number };
		return (result?.affectedRows ?? 0) > 0;
	}

	/** Dédup O(1) via fortune_memories_hash_idx (content_hash, scope). */
	async findByContentHash(
		hash: string,
		scope: string,
	): Promise<MemoryRecord | null> {
		if (!hash) return null;
		const rows = (await this.query(
			"SELECT * FROM fortune_memories WHERE content_hash=? AND status='active' AND (scope=? OR scope LIKE ?) ORDER BY created_at DESC LIMIT 1",
			[hash, scope, `${scope}/%`],
		)) as Array<Record<string, unknown>>;
		return rows.length ? rowToMemory(rows[0]!) : null;
	}

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const rows = (await this.query(
			includeForgotten
				? "SELECT * FROM fortune_memories WHERE id=?"
				: "SELECT * FROM fortune_memories WHERE id=? AND status='active'",
			[id],
		)) as Array<Record<string, unknown>>;
		return rows.length ? rowToMemory(rows[0]!) : null;
	}

	async *iterate(
		includeForgotten = false,
		opts: IterateOptions = {},
	): AsyncIterable<StoredRow> {
		const columns =
			opts.withVectors === false
				? COLUMNS.filter(
						(column) => column !== "vector" && column !== "vector_blob",
					).join(", ")
				: "*";
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (!includeForgotten) conditions.push("status='active'");
		if (opts.scopePrefix) {
			conditions.push("(scope=? OR scope LIKE ?)");
			params.push(opts.scopePrefix, `${opts.scopePrefix}/%`);
		}
		if (opts.asOf) {
			conditions.push(
				"(valid_from IS NULL OR valid_from <= ?)",
				"(valid_to IS NULL OR valid_to >= ?)",
			);
			params.push(opts.asOf, opts.asOf);
		}
		if (opts.typeFilter) {
			conditions.push("type=?");
			params.push(opts.typeFilter);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const order = opts.recentFirst ? ORDER_RECENT_DESC : ORDER_CREATED_DESC;
		const sql = `SELECT ${columns} FROM fortune_memories ${where} ${order}`;
		const rows = (await this.query(
			sql,
			params.length ? params : undefined,
		)) as Array<Record<string, unknown>>;
		for (const row of rows) {
			yield {
				memory: rowToMemory(row),
				vector: opts.withVectors === false ? null : parseVector(row),
			};
		}
	}

	async count(): Promise<{ active: number; forgotten: number }> {
		const rows = (await this.query(
			`SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS forgotten
       FROM fortune_memories`,
		)) as Array<{ active?: number | string; forgotten?: number | string }>;
		const row = rows[0] ?? {};
		return {
			active: Number(row.active) || 0,
			forgotten: Number(row.forgotten) || 0,
		};
	}
}

function parseVector(row: Record<string, unknown>): NumericVector | null {
	return parseVectorBlob(row.vector_blob, row.vector);
}

function safeTags(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw !== "string") return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
	const content = String(row.content ?? "");
	return {
		id: String(row.id),
		type: String(row.type) as MemoryRecord["type"],
		content,
		contentHash:
			typeof row.content_hash === "string" && row.content_hash
				? row.content_hash
				: memoryContentHash(content),
		summary: String(row.summary ?? ""),
		source: {
			kind: String(row.source_kind ?? "manual"),
			locator: (row.source_locator as string | null) ?? null,
			title: (row.source_title as string | null) ?? null,
		},
		scope: String(row.scope ?? "personal"),
		sensitivity: String(
			row.sensitivity ?? "personal",
		) as MemoryRecord["sensitivity"],
		sourceTrust: String(
			row.source_trust ?? "owner",
		) as MemoryRecord["sourceTrust"],
		confidence: Number(row.confidence ?? 1) || 0,
		validFrom: (row.valid_from as string | null) ?? null,
		validTo: (row.valid_to as string | null) ?? null,
		occurredAt: (row.occurred_at as string | null) ?? null,
		tags: safeTags(row.tags),
		status: String(row.status) === "forgotten" ? "forgotten" : "active",
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		forgottenAt: (row.forgotten_at as string | null) ?? null,
	};
}
