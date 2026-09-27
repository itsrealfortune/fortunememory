/**
 * Provider CSV : un fichier CSV RFC-4180 (compte quotes, guillemets doublés),
 * lisible hors bot. Vector sérialisé en JSON dans la dernière colonne.
 */

import {
	mkdirSync,
	existsSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, IterateOptions, StoredRow } from "./interface.ts";

export const HEADER = [
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
];

const CSV_NEEDS_QUOTE_RE = /[",\r\n]/;
const CSV_QUOTE_RE = /"/g;

function csvEscape(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return CSV_NEEDS_QUOTE_RE.test(text)
		? `"${text.replace(CSV_QUOTE_RE, '""')}"`
		: text;
}

/** Texte → tableau de cellules (parser minuscule, sans dépendance). */
export function csvParse(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let segments: string[] = [];
	let field = "";
	let inQuotes = false;
	const pushField = (): void => {
		row.push(segments.length ? segments.join("") + field : field);
		segments = [];
		field = "";
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else if (char === "\n" || char === "\r") {
				segments.push(field);
				field = "";
				// Newlines dans quotes : on garde le char tel quel via segments.
				segments.push(char);
			} else {
				field += char;
				if (field.length >= 1024) {
					segments.push(field);
					field = "";
				}
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			pushField();
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			pushField();
			if (row.length > 1 || row[0] !== "") rows.push(row);
			row = [];
		} else {
			field += char;
			if (field.length >= 1024) {
				segments.push(field);
				field = "";
			}
		}
	}
	if (field || segments.length || row.length) {
		pushField();
		if (row.length > 1 || row[0] !== "") rows.push(row);
	}
	return rows;
}

// Encoding CSV avec l'ordre HEADER.
export function memoryToCells(row: {
	memory: MemoryRecord;
	vector: number[] | null;
}): string[] {
	const memory = row.memory;
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
		String(memory.confidence),
		memory.validFrom ?? "",
		memory.validTo ?? "",
		memory.occurredAt ?? "",
		memory.tags.join("|"),
		memory.status,
		memory.createdAt,
		memory.updatedAt,
		memory.forgottenAt ?? "",
		row.vector ? JSON.stringify(row.vector) : "",
	];
}

export class CsvProvider implements FortuneProvider {
	readonly name = "csv";
	private readonly filePath: string;
	private rows: StoredRow[] = [];
	private readonly index = new Map<string, number>();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async init(): Promise<void> {
		if (existsSync(this.filePath)) {
			const table = csvParse(readFileSync(this.filePath, "utf8"));
			const header = table.shift() ?? [];
			for (const cells of table) {
				try {
					const record: Record<string, string | null> = {};
					header.forEach((name, index) => {
						record[name] = cells[index] ?? null;
					});
					this.rows.push({
						memory: rowToMemory(record),
						vector: parseVector(record.vector ?? null),
					});
					this.index.set(this.rows[this.rows.length - 1]!.memory.id, this.rows.length - 1);
				} catch {
					// ligne corrompue : on la saute, on ne crash pas tout le vault
				}
			}
			return;
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, `${HEADER.join(",")}\n`);
	}

	async close(): Promise<void> {
		// Appends + rewrites sont atomiques au fil ; rien à flusher.
	}

	async addMemory(
		memory: MemoryRecord,
		vector: number[] | null,
	): Promise<void> {
		const row: StoredRow = { memory, vector };
		this.index.set(memory.id, this.rows.length);
		this.rows.push(row);
		appendFileSync(this.filePath, csvLine(row));
	}

	async updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean> {
		const slot = this.index.get(id);
		const row = slot !== undefined ? this.rows[slot] : undefined;
		if (!row) return false;
		row.memory.status = status;
		row.memory.forgottenAt = status === "forgotten" ? at : null;
		row.memory.updatedAt = at;
		rewriteFile(this.filePath, this.rows);
		return true;
	}

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const slot = this.index.get(id);
		const row = slot !== undefined ? this.rows[slot] : undefined;
		if (row && (includeForgotten || row.memory.status === "active")) {
			return row.memory;
		}
		return null;
	}

	async *iterate(
		includeForgotten = false,
		opts: IterateOptions = {},
	): AsyncIterable<StoredRow> {
		const prefix = opts.scopePrefix;
		for (const row of this.rows) {
			if (!includeForgotten && row.memory.status !== "active") continue;
			if (
				prefix &&
				row.memory.scope !== prefix &&
				!row.memory.scope.startsWith(`${prefix}/`)
			)
				continue;
			yield row;
		}
	}

	async count(): Promise<{ active: number; forgotten: number }> {
		let active = 0;
		let forgotten = 0;
		for (const row of this.rows) {
			if (row.memory.status === "active") active += 1;
			else forgotten += 1;
		}
		return { active, forgotten };
	}
}

function csvLine(row: {
	memory: MemoryRecord;
	vector: number[] | null;
}): string {
	return csvLineText(memoryToCells(row));
}

export function csvLineText(cells: string[]): string {
	return `${cells.map(csvEscape).join(",")}\n`;
}

/** Réécriture atomique complète du CSV. */
function rewriteFile(
	filePath: string,
	rows: Array<{ memory: MemoryRecord; vector: number[] | null }>,
): void {
	const tmp = `${filePath}.tmp`;
	const lines = new Array<string>(rows.length + 1);
	lines[0] = `${HEADER.join(",")}\n`;
	for (let i = 0; i < rows.length; i++) {
		lines[i + 1] = csvLineText(memoryToCells(rows[i]!));
	}
	writeFileSync(tmp, lines.join(""));
	renameSync(tmp, filePath);
}

export function rowToMemory(row: Record<string, string | null>): MemoryRecord {
	const content = row.content ?? "";
	return {
		id: row.id!,
		type: (row.type ?? "note") as MemoryRecord["type"],
		content,
		contentHash: memoryContentHash(content),
		summary: row.summary ?? "",
		source: {
			kind: row.source_kind ?? "manual",
			locator: row.source_locator ?? null,
			title: row.source_title ?? null,
		},
		scope: row.scope ?? "personal",
		sensitivity: (row.sensitivity ?? "personal") as MemoryRecord["sensitivity"],
		sourceTrust: (row.source_trust ?? "owner") as MemoryRecord["sourceTrust"],
		confidence: Number(row.confidence ?? 1) || 0,
		validFrom: row.valid_from || null,
		validTo: row.valid_to || null,
		occurredAt: row.occurred_at || null,
		tags: (row.tags || "").split("|").filter(Boolean),
		status: row.status === "forgotten" ? "forgotten" : "active",
		createdAt: row.created_at!,
		updatedAt: row.updated_at!,
		forgottenAt: row.forgotten_at || null,
	};
}

export function parseVector(text: string | null): number[] | null {
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Résout le fichier du provider CSV : <dataDir>/fortunememories.csv. */
export function csvProviderFactory(dataDir: string): FortuneProvider {
	return new CsvProvider(join(dataDir, "fortunememories.csv"));
}
