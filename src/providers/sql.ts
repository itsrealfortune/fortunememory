/**
 * Providers SQL serveur/embedded : PGLite (Postgres embarqué WASM) et MySQL.
 *
 * Utilisent le même dialecte avec paramètrescala $1/$? et lazily importés :
 * si le paquet n'est pas installé, seul ce provider échoue (pas le plugin
 * entier). Schemas identiques à sqlite.ts (colonnes renommées à la main).
 */

import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, StoredRow } from "./interface.ts";

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
] as const;

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
    vector TEXT
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
    INDEX fortune_memories_scope (scope(64), status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export class PgliteProvider implements FortuneProvider {
	readonly name = "pglite";
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
	}

	async close(): Promise<void> {
		await this.client?.close();
		this.client = null;
	}

	private memoryToParams(
		memory: MemoryRecord,
		vector: number[] | null,
		dollar = true,
	): unknown[] {
		void dollar;
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
			vector ? JSON.stringify(vector) : null,
		];
	}

	async addMemory(
		memory: MemoryRecord,
		vector: number[] | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		const placeholder = (index: number): string => `$${index}`;
		const client = await this.require();
		await client.query(
			`INSERT INTO fortune_memories (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, index) => placeholder(index + 1)).join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${COLUMNS.slice(1)
					.map((column, index) => `${column} = ${placeholder(index + 2)}`)
					.join(", ")}`,
			this.memoryToParams(memory, vector),
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

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const client = await this.require();
		const result = await client.query(
			"SELECT * FROM fortune_memories WHERE id=$1 AND (status='active' OR $2)",
			[id, includeForgotten],
		);
		const row = result.rows?.[0];
		return row ? rowToMemory(row as never) : null;
	}

	async *iterate(includeForgotten = false): AsyncIterable<StoredRow> {
		const client = await this.require();
		const sql = includeForgotten
			? "SELECT * FROM fortune_memories ORDER BY created_at DESC"
			: "SELECT * FROM fortune_memories WHERE status='active' ORDER BY created_at DESC";
		const result = await client.query(sql);
		for (const row of result.rows ?? []) {
			yield {
				memory: rowToMemory(row as never),
				vector: parseVector((row as never as { vector?: unknown }).vector),
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
	}

	async close(): Promise<void> {
		await this.conn?.end();
		this.conn = null;
	}

	private memoryToParams(
		memory: MemoryRecord,
		vector: number[] | null,
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
			vector ? JSON.stringify(vector) : null,
		];
	}

	private query(sql: string, params?: unknown[]): Promise<unknown[]> {
		if (!this.conn) throw new Error("MysqlProvider pas initialisé");
		return this.conn.query(sql, params) as unknown as Promise<unknown[]>;
	}

	private execute(sql: string, params?: unknown[]): Promise<unknown> {
		if (!this.conn) throw new Error("MysqlProvider pas initialisé");
		return this.conn.execute(sql, params) as unknown as Promise<unknown>;
	}

	async addMemory(
		memory: MemoryRecord,
		vector: number[] | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		await this.execute(
			`REPLACE INTO fortune_memories (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
			this.memoryToParams(memory, vector),
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

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const rows = (await this.query(
			"SELECT * FROM fortune_memories WHERE id=? AND (status='active' OR ?)",
			[id, includeForgotten],
		)) as Array<Record<string, unknown>>;
		return rows.length ? rowToMemory(rows[0]!) : null;
	}

	async *iterate(includeForgotten = false): AsyncIterable<StoredRow> {
		const sql = includeForgotten
			? "SELECT * FROM fortune_memories ORDER BY created_at DESC"
			: "SELECT * FROM fortune_memories WHERE status='active' ORDER BY created_at DESC";
		const rows = (await this.query(sql)) as Array<Record<string, unknown>>;
		for (const row of rows) {
			yield {
				memory: rowToMemory(row),
				vector: parseVector(row.vector),
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

function parseVector(raw: unknown): number[] | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
	const content = String(row.content ?? "");
	return {
		id: String(row.id),
		type: String(row.type) as MemoryRecord["type"],
		content,
		contentHash: memoryContentHash(content),
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
		tags: Array.isArray(row.tags)
			? row.tags.map(String)
			: typeof row.tags === "string"
				? (JSON.parse(row.tags) as string[])
				: [],
		status: String(row.status) === "forgotten" ? "forgotten" : "active",
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		forgottenAt: (row.forgotten_at as string | null) ?? null,
	};
}
