/**
 * Contrat commun à tous les stores FortuneMemory.
 *
 * Principe : le provider se contente de PERSISTER — les filtres (scope,
 * sensibilité, type, validité), le scoring (lexical, vectoriel, hybride RRF)
 * et le rangement vivent dans manager.ts. Volume visé : quelques milliers de
 * souvenirs → mais ces filtres restent corrects à toute échelle.
 */

import type { MemoryRecord } from "../schema.ts";

export interface StoredRow {
  memory: MemoryRecord;
  vector: number[] | null;
}

export interface FortuneProvider {
  readonly name: string;

  /** Création idempotente des tables / fichiers. */
  init(): Promise<void>;

  close(): Promise<void>;

  /** Insertion complète (record déjà normalisé + vecteur encodé ou null). */
  addMemory(memory: MemoryRecord, vector: number[] | null): Promise<void>;

  /** Soft-delete : status=forgotten + forgottenAt. Retourne false si id inconnu. */
  updateStatus(
    id: string,
    status: "active" | "forgotten",
    at: string,
  ): Promise<boolean>;

  /** Un record ou null (includeForgotten pour ressortir un oublié). */
  getMemory(id: string, includeForgotten?: boolean): Promise<MemoryRecord | null>;

  /** Itère tous les souvenirs (status actif par défaut). */
  iterate(includeForgotten?: boolean): AsyncIterable<StoredRow>;

  /** Nombre de souvenirs actifs (stats). */
  count(): Promise<{ active: number; forgotten: number }>;
}
