/**
 * Provider Roxify : le store PERSISTE dans un PNG stéganographié.
 *
 * Schéma demandé par Roxas : decode le PNG en entrée de section écriture,
 * applique la mutation, re-encode le PNG. En pratique :
 *   init   : decode PNG → payload JSON {version, memories} en mémoire
 *            (le vault est donc résident, décodé une fois)
 *   write  : mutation en RAM → re-encode PNG complet → write atomique
 *            (tmp + rename — crash-safe : on ne corrompt JAMAIS le PNG)
 *
 * Format PNG = data/fortunememories.png — visuellement une image, contenu
 * = tout le vault (records + vecteurs). Désactivé par défaut:
 * proto provider = opt-in via FORTUNE_MEMORY_PROVIDER=roxify.
 *
 * Charge : roxify importé dynamiquement — a besoin que le paquet soit
 * installé (postinstall télécharge le binaire Rust natif). Si absent, ce
 * provider seul échoue, le plugin entier reste sain.
 */

import {
	renameSync,
	writeFileSync,
	existsSync,
	readFileSync,
	mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, StoredRow } from "./interface.ts";

interface PersistedPayload {
	version: 1;
	memories: StoredRow[];
}

export class RoxifyProvider implements FortuneProvider {
	readonly name = "roxify";
	private readonly filePath: string;
	private rows: StoredRow[] = [];

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async init(): Promise<void> {
		if (existsSync(this.filePath)) {
			const { decodePngToBinary } = await loadRoxify();
			const png = readFileSync(this.filePath);
			const { buf } = await decodePngToBinary(png);
			const payload = JSON.parse(buf.toString("utf8")) as PersistedPayload;
			this.rows = Array.isArray(payload?.memories) ? payload.memories : [];
		} else {
			this.rows = [];
			await this.flush(); // PNG initial écrit immédiatement
		}
	}

	async close(): Promise<void> {
		// Écriture synchrone à chaque mutation : rien à flusher.
	}

	/** Re-encode le vault complet → PNG stéganographié (atomique). */
	private async flush(): Promise<void> {
		const payload: PersistedPayload = { version: 1, memories: this.rows };
		const binary = Buffer.from(JSON.stringify(payload), "utf8");
		const { encodeBinaryToPng } = await loadRoxify();
		const png = await encodeBinaryToPng(binary, {
			name: "fortunememories.json",
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
		const index = this.rows.findIndex((row) => row.memory.id === memory.id);
		const stored: StoredRow = { memory, vector };
		if (index >= 0) this.rows[index] = stored;
		else this.rows.push(stored);
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
			if (row.memory.status === "active") active += 1;
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
			const mod = await import("roxify");
			cached = mod as never;
		} catch {
			throw new Error(
				"provider roxify exige la dépendance optionnelle 'roxify' " +
					"(npm install roxify)",
			);
		}
	}
	return cached;
}

/** Résout le fichier du provider : <dataDir>/fortunememories.png. */
export function roxifyProviderFactory(dataDir: string): FortuneProvider {
	return new RoxifyProvider(join(dataDir, "fortunememories.png"));
}
