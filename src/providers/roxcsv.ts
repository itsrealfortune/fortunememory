/**
 * Provider RoxifiedCSV : le format canonique = notre CSV (lisible, diffable),
 * le support = un PNG stéganographié via roxify (zstd + Rust).
 *
 * Cercle de vie demandé par Roxas : à chaque write, le store est serialisé en
 * CSV textuel, ce texte est roxifié dans data/fortunememories.roxcsv.png ;
 * à l'init, décodage du PNG → parse du CSV → store résident en RAM.
 *
 * Pourquoi un CSV plutôt que du JSON : le CSV compresse mieux (pas de clés
 * répétées, un payload de texte déjà tabulaire) et reste extractible en
 * clair pour inspection. Format le plus compact des trois (sqlite / csv / db).
 *
 * roxify importé lazy : provider mort si le paquet n'est pas installé.
 * Désactivé par défaut (FORTUNE_MEMORY_PROVIDER=roxcsv).
 */

import {
	renameSync,
	writeFileSync,
	existsSync,
	readFileSync,
	mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	HEADER,
	csvParse,
	csvLineText,
	memoryToCells,
	rowToMemory,
	parseVector,
} from "./csv.ts";
import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, StoredRow } from "./interface.ts";

export class RoxifiedCSVProvider implements FortuneProvider {
	readonly name = "roxcsv";
	private readonly filePath: string;
	private rows: StoredRow[] = [];

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async init(): Promise<void> {
		if (existsSync(this.filePath)) {
			const { decodePngToBinary } = await loadRoxify();
			const { buf } = await decodePngToBinary(readFileSync(this.filePath));
			const text = buf.toString("utf8");
			for (const cells of csvParse(text).slice(1)) {
				try {
					const record: Record<string, string | null> = {};
					HEADER.forEach((name, index) => {
						record[name] = cells[index] ?? null;
					});
					this.rows.push({
						memory: rowToMemory(record),
						vector: parseVector(record.vector ?? null),
					});
				} catch {
					// ligne corrompue : on la saute (le PNG reste jouable)
				}
			}
		} else {
			this.rows = [];
			await this.flush();
		}
	}

	async close(): Promise<void> {
		// Écritures synchrones au fil ; rien à flusher.
	}

	/** CSV complet reconstruit depuis la RAM → roxify → PNG atomique. */
	private async flush(): Promise<void> {
		const csv =
			`${HEADER.join(",")}\n` +
			this.rows.map((row) => csvLineText(memoryToCells(row))).join("");
		const { encodeBinaryToPng } = await loadRoxify();
		const png = await encodeBinaryToPng(Buffer.from(csv, "utf8"), {
			name: "fortunememories.csv",
		});
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, png);
		renameSync(tmp, this.filePath);
	}

	async addMemory(
		memory: MemoryRecord,
		vector: number[] | null,
	): Promise<void> {
		memory.contentHash =
			memory.contentHash ?? memoryContentHash(memory.content);
		const row: StoredRow = { memory, vector };
		const index = this.rows.findIndex(
			(candidate) => candidate.memory.id === memory.id,
		);
		if (index >= 0) this.rows[index] = row;
		else this.rows.push(row);
		await this.flush();
	}

	async updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean> {
		const row = this.rows.find((candidate) => candidate.memory.id === id);
		if (!row) return false;
		row.memory.status = status;
		row.memory.forgottenAt = status === "forgotten" ? at : null;
		row.memory.updatedAt = at;
		await this.flush();
		return true;
	}

	async getMemory(
		id: string,
		includeForgotten = false,
	): Promise<MemoryRecord | null> {
		const row = this.rows.find(
			(candidate) =>
				candidate.memory.id === id &&
				(includeForgotten || candidate.memory.status === "active"),
		);
		if (row && !row.memory.contentHash) {
			row.memory.contentHash = memoryContentHash(row.memory.content);
		}
		return row?.memory ?? null;
	}

	async *iterate(includeForgotten = false): AsyncIterable<StoredRow> {
		for (const row of [...this.rows]) {
			if (!includeForgotten && row.memory.status !== "active") continue;
			yield row;
		}
	}

	async count(): Promise<{ active: number; forgotten: number }> {
		let active = 0;
		let forgotten = 0;
		for (const row of this.rows) {
			if (row.memory.status === "active") active++;
			else forgotten += 1;
		}
		return { active, forgotten };
	}
}

let cached: {
	encodeBinaryToPng(buf: Buffer, opts: { name: string }): Promise<Buffer>;
	decodePngToBinary(
		png: Buffer,
	): Promise<{ buf: Buffer; meta: { name: string } }>;
} | null = null;

async function loadRoxify(): Promise<NonNullable<typeof cached>> {
	if (!cached) {
		try {
			cached = (await import("roxify")) as never;
		} catch {
			throw new Error(
				"provider roxcsv exige la dépendance optionnelle 'roxify' " +
					"(npm install roxify)",
			);
		}
	}
	return cached;
}

/** Résout le fichier du provider : <dataDir>/fortunememories.roxcsv (PNG stégano). */
export function roxifiedCsvProviderFactory(dataDir: string): FortuneProvider {
	return new RoxifiedCSVProvider(join(dataDir, "fortunememories.roxcsv"));
}
