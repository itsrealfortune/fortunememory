/**
 * Provider SQLite sans dépendance, multi-runtime.
 *
 * - Node >= 22.5 : `node:sqlite` natif (cible de la lib publiée).
 * - Bun (runtime opencode) : `bun:sqlite` natif en repli.
 *
 * Le driver est résolu en lazy dans init() : l'import du module n'échoue
 * sur aucun runtime. Schéma : une table fortune_memories, vecteur sérialisé
 * JSON ; cosine reste dans manager.ts (portable à tous les providers).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, StoredRow } from "./interface.ts";

/** Ligne SQLite brute. */
export type SqliteRow = Record<string, unknown>;

/** Valeurs liées nommées (sous-ensemble de SQLInputValue, sans binaires). */
export type SqliteParams = Record<string, string | number | bigint | null>;

export interface SqliteStatement {
	run(params?: SqliteParams): { changes: number };
	get(params?: SqliteParams): SqliteRow | null | undefined;
	all(params?: SqliteParams): SqliteRow[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * Ouvre SQLite sur le runtime courant. Node d'abord (`node:sqlite`),
 * Bun ensuite (`bun:sqlite`) — zéro dépendance dans les deux cas.
 */
export async function openSqliteDatabase(
	path: string,
	readOnly = false,
): Promise<SqliteDatabase> {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = readOnly
			? new DatabaseSync(path, { readOnly: true })
			: new DatabaseSync(path);
		return {
			exec: (sql) => {
				db.exec(sql);
			},
			prepare: (sql) => {
				const stmt = db.prepare(sql);
				return {
					run: (params) => ({
						changes: Number(
							hasParams(params) ? stmt.run(params).changes : stmt.run().changes,
						),
					}),
					get: (params) =>
						(hasParams(params) ? stmt.get(params) : stmt.get()) as
							| SqliteRow
							| undefined,
					all: (params) =>
						(hasParams(params) ? stmt.all(params) : stmt.all()) as SqliteRow[],
				};
			},
			close: () => {
				db.close();
			},
		};
	} catch {
		// Pas Node (ou node:sqlite indisponible) → repli Bun natif.
		return openBunSqlite(path, readOnly);
	}
}

function hasParams(params: SqliteParams | undefined): params is SqliteParams {
	return !!params && Object.keys(params).length > 0;
}

async function openBunSqlite(
	path: string,
	readOnly: boolean,
): Promise<SqliteDatabase> {
	let mod: {
		Database: new (
			path: string,
			options?: { readonly?: boolean },
		) => {
			exec(sql: string): void;
			query(sql: string): {
				run(params?: unknown): { changes: number };
				get(params?: unknown): SqliteRow | null;
				all(params?: unknown): SqliteRow[];
			};
			close(): void;
		};
	};
	try {
		// @ts-expect-error bun:sqlite n'existe que sous Bun (@types/bun non requis par la lib)
		mod = await import("bun:sqlite");
	} catch {
		throw new Error(
			"provider sqlite exige Node >= 22.5 (node:sqlite) ou Bun (bun:sqlite)",
		);
	}
	const db = new mod.Database(path, readOnly ? { readonly: true } : undefined);
	return {
		exec: (sql) => {
			db.exec(sql);
		},
		prepare: (sql) => {
			const stmt = db.query(sql);
			return {
				run: (params) => ({
					changes: Number(
						(hasParams(params) ? stmt.run(params) : stmt.run()).changes,
					),
				}),
				get: (params) => (hasParams(params) ? stmt.get(params) : stmt.get()),
				all: (params) => (hasParams(params) ? stmt.all(params) : stmt.all()),
			};
		},
		close: () => {
			db.close();
		},
	};
}

const SCHEMA = `
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
    confidence REAL NOT NULL DEFAULT 1,
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
  CREATE INDEX IF NOT EXISTS fortune_memories_scope
    ON fortune_memories(scope, status);
`;

const INSERT = `
  INSERT INTO fortune_memories (
    id, type, content, summary, source_kind, source_locator, source_title,
    scope, sensitivity, source_trust, confidence, valid_from, valid_to,
    occurred_at, tags, status, created_at, updated_at, forgotten_at, vector
  ) VALUES (
    $id, $type, $content, $summary, $source_kind, $source_locator, $source_title,
    $scope, $sensitivity, $source_trust, $confidence, $valid_from, $valid_to,
    $occurred_at, $tags, $status, $created_at, $updated_at, $forgotten_at, $vector
  )
  ON CONFLICT(id) DO UPDATE SET
    type=$type, content=$content, summary=$summary, source_kind=$source_kind,
    source_locator=$source_locator, source_title=$source_title, scope=$scope,
    sensitivity=$sensitivity, source_trust=$source_trust, confidence=$confidence,
    valid_from=$valid_from, valid_to=$valid_to, occurred_at=$occurred_at,
    tags=$tags, status=$status, created_at=$created_at, updated_at=$updated_at,
    forgotten_at=$forgotten_at, vector=$vector;
`;

export class SqliteProvider implements FortuneProvider {
	readonly name = "sqlite";
	private readonly dbPath: string;
	private db: SqliteDatabase | null = null;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	private require(): SqliteDatabase {
		if (!this.db)
			throw new Error("SqliteProvider pas initialisé (init() d'abord)");
		return this.db;
	}

	async init(): Promise<void> {
		if (this.dbPath !== ":memory:") {
			mkdirSync(dirname(this.dbPath), { recursive: true });
		}
		this.db = await openSqliteDatabase(this.dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec(SCHEMA);
	}

	async close(): Promise<void> {
		this.db?.close();
		this.db = null;
	}

	private memoryToParams(
		memory: MemoryRecord,
		vectorSubmitted: number[] | null,
	): SqliteParams {
		return {
			$id: memory.id,
			$type: memory.type,
			$content: memory.content,
			$summary: memory.summary,
			$source_kind: memory.source.kind,
			$source_locator: memory.source.locator ?? "",
			$source_title: memory.source.title ?? "",
			$scope: memory.scope,
			$sensitivity: memory.sensitivity,
			$source_trust: memory.sourceTrust,
			$confidence: memory.confidence,
			$valid_from: memory.validFrom ?? null,
			$valid_to: memory.validTo ?? null,
			$occurred_at: memory.occurredAt ?? null,
			$tags: JSON.stringify(memory.tags),
			$status: memory.status,
			$created_at: memory.createdAt,
			$updated_at: memory.updatedAt,
			$forgotten_at: memory.forgottenAt ?? null,
			$vector: vectorSubmitted ? JSON.stringify(vectorSubmitted) : null,
		};
	}

	async addMemory(
		memory: MemoryRecord,
		vector: number[] | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		this.require().prepare(INSERT).run(this.memoryToParams(memory, vector));
	}

	async updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean> {
		const result = this.require()
			.prepare(
				"UPDATE fortune_memories SET status = $status, forgotten_at = $forgotten_at, updated_at = $at WHERE id = $id",
			)
			.run({
				$id: id,
				$status: status,
				$at: at,
				$forgotten_at: status === "forgotten" ? at : null,
			});
		return result.changes > 0;
	}

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const row = this.require()
			.prepare(
				"SELECT *, vector AS vector_raw FROM fortune_memories WHERE id = $id AND (status = 'active' OR $includeForgotten)",
			)
			.get({
				$id: id,
				$includeForgotten: includeForgotten ? 1 : 0,
			});
		return row ? rowToMemory(row) : null;
	}

	async *iterate(includeForgotten = false): AsyncIterable<StoredRow> {
		const db = this.require();
		const sql = includeForgotten
			? "SELECT *, vector AS vector_raw FROM fortune_memories ORDER BY created_at DESC"
			: "SELECT *, vector AS vector_raw FROM fortune_memories WHERE status = 'active' ORDER BY created_at DESC";
		for (const row of db.prepare(sql).all()) {
			yield { memory: rowToMemory(row), vector: parseVector(row.vector_raw) };
		}
	}

	async count(): Promise<{ active: number; forgotten: number }> {
		const row = this.require()
			.prepare(
				`SELECT
           COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
           COALESCE(SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END), 0) AS forgotten
         FROM fortune_memories`,
			)
			.get() as unknown as { active: number; forgotten: number };
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
		tags: safeTags(row.tags),
		status: String(row.status) === "forgotten" ? "forgotten" : "active",
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		forgottenAt: (row.forgotten_at as string | null) ?? null,
	};
}

function safeTags(raw: unknown): string[] {
	try {
		const parsed = JSON.parse(String(raw ?? "[]"));
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** Résout le chemin DB sqlite : <dataDir>/fortunememories.db. */
export function sqliteProviderFactory(dataDir: string): FortuneProvider {
	return new SqliteProvider(join(dataDir, "fortunememories.db"));
}
