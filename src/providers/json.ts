/** Provider JSON : un fichier unique, écriture atomique temp + rename. */

import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { memoryContentHash, type MemoryRecord } from "../schema.ts";
import type { FortuneProvider, StoredRow } from "./interface.ts";

interface PersistedPayload {
  version: 1;
  memories: StoredRow[];
}

export class JsonProvider implements FortuneProvider {
  readonly name = "json";
  private readonly filePath: string;
  private rows: StoredRow[] = [];
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    if (existsSync(this.filePath)) {
      try {
        const payload = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedPayload;
        this.rows = Array.isArray(payload?.memories) ? payload.memories : [];
        return;
      } catch (error) {
        throw new Error(`JSON store illisible (${this.filePath}) : ${(error as Error).message}`);
      }
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.flush();
  }

  async close(): Promise<void> {
    if (this.dirty) this.flush();
  }

  private flush(): void {
    const payload: PersistedPayload = { version: 1, memories: this.rows };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 1));
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  private setRow(record: MemoryRecord, vector: number[] | null): void {
    const index = this.rows.findIndex((row) => row.memory.id === record.id);
    const stored: StoredRow = { memory: record, vector };
    if (index >= 0) this.rows[index] = stored;
    else this.rows.push(stored);
    this.dirty = true;
    this.flush();
  }

  async addMemory(memory: MemoryRecord, vector: number[] | null): Promise<void> {
    this.setRow(memory, vector);
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
    this.dirty = true;
    this.flush();
    return true;
  }

  async getMemory(id: string, includeForgotten = false): Promise<MemoryRecord | null> {
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

/** Résout le fichier du provider JSON : <dataDir>/fortunememories.json. */
export function jsonProviderFactory(dataDir: string): FortuneProvider {
  return new JsonProvider(join(dataDir, "fortunememories.json"));
}
