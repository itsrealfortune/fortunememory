/**
 * Contrat commun à tous les stores FortuneMemory.
 *
 * Principe : le provider PERSISTE - les filtres (scope, sensibilité, type,
 * validité), le scoring (lexical, vectoriel, hybride RRF) et le rangement
 * vivent dans manager.ts. Les providers peuvent ensuite exposer des
 * pushdowns optionnels (findByContentHash, searchLexical FTS5,
 * recentFirst/stream/typeFilter) : le manager les détecte via les
 * méthodes/capabilities et garde le chemin portable en repli. Volume visé :
 * quelques dizaines de milliers de souvenirs, filtres corrects à toute
 * échelle.
 */

import type { MemoryRecord } from "../schema.ts";
import type { NumericVector } from "../vectors.ts";

export interface StoredRow {
	memory: MemoryRecord;
	vector: NumericVector | null;
}

/** Capacités optionnelles advertis par un provider (permettent des
 * optimisations côté manager sans casser les providers minimalistes). */
export interface ProviderCapabilities {
	/** iterate() respecte IterateOptions.recentFirst (ordre garanti). */
	recentFirst?: boolean;
	/** searchLexical() poussé en SQL (FTS5) disponible. */
	lexicalSearch?: boolean;
}

/** Options du search lexical poussé en SQL. Filtres déjà résolus par le
 * manager (rangs de sensibilité/confiance → listes explicites). */
export interface LexicalSearchOptions extends IterateOptions {
	/** Top-K renvoyés, déjà triés (bm25 + tie-breaks) par le provider. */
	limit: number;
	/** Filtre type exact (poussé en SQL). */
	type?: string;
	/** Sensibilités autorisées (rang ≤ maxSensitivity, résolu par le manager). */
	allowedSensitivities?: string[];
	/** Rang minimal de confiance source (index dans SOURCE_TRUST_LEVELS). */
	minTrustRank?: number;
	/** Exclure ce contenu exact. */
	excludeContent?: string;
}

export interface IterateOptions {
	/** Ne pas charger/parser les vecteurs (chemins lexical/list/dedup). */
	withVectors?: boolean;
	/** Restreint au scope exact ou préfixe `scope/` (poussé en SQL si possible). */
	scopePrefix?: string;
	/** Fenêtre temporelle ISO UTC (poussée en SQL si possible ; les dates
	 * stockées sont normalisées UTC donc l'ordre lexicographique vaut
	 * chronologique). */
	asOf?: string;
	/** Ordonne du plus récent au plus ancien (occurredAt || validFrom ||
	 * createdAt, décroissant) - tri poussé en SQL. Les providers qui ne
	 * peuvent pas garantir l'ordre ignorent l'option (le manager détecte
	 * capabilities.recentFirst avant de s'y fier). */
	recentFirst?: boolean;
	/** Le consommateur peut interrompre l'itération tôt (break) : préférer le
	 * fetch paresseux du driver (stmt.iterate) à .all(). Sans effet sur les
	 * full scans - iterate() coûte plus cher par ligne que .all() quand tout
	 * est consommé (mesuré : +25% sur search à 10k). */
	stream?: boolean;
	/** Filtre type exact (poussé en SQL quand possible ; le manager revérifie). */
	typeFilter?: string;
}

export interface FortuneProvider {
	readonly name: string;

	/** Capacités optionnelles (cf. ProviderCapabilities). */
	readonly capabilities?: ProviderCapabilities;

	/** Création idempotente des tables / fichiers. */
	init(): Promise<void>;

	close(): Promise<void>;

	/** Insertion complète (record déjà normalisé + vecteur encodé ou null). */
	addMemory(memory: MemoryRecord, vector: NumericVector | null): Promise<void>;

	/** Insertion groupée (défaut : boucle addMemory). Les providers fichier
	 * ne flushent qu'une fois ; les providers SQL en une transaction. */
	addMany?(
		entries: Array<{ memory: MemoryRecord; vector: NumericVector | null }>,
	): Promise<void>;

	/**
	 * Dédup (optionnel) : premier souvenir ACTIF du scope donné (exact ou
	 * sous-scope `scope/`) dont le contentHash correspond. Poussé en SQL
	 * quand la colonne + l'index existent ; sinon le manager rescanne via
	 * iterate() (comportement historique, O(n)).
	 */
	findByContentHash?(hash: string, scope: string): Promise<MemoryRecord | null>;

	/**
	 * Recherche lexical poussée en SQL (FTS5) : tokens déjà filtrés par le
	 * manager (stopwords, longueur), résultats triés bm25 + tie-breaks.
	 * Ranking voisin du chemin portable mais pas strictement identique
	 * (bm25 vs recouvrement de tokens) - la fusion RRF n'utilise que les
	 * rangs, donc interchangeable.
	 */
	searchLexical?(
		tokens: string[],
		opts: LexicalSearchOptions,
	): Promise<MemoryRecord[]>;

	/** Soft-delete : status=forgotten + forgottenAt. Retourne false si id inconnu. */
	updateStatus(
		id: string,
		status: "active" | "forgotten",
		at: string,
	): Promise<boolean>;

	/** Un record ou null (includeForgotten pour ressortir un oublié). */
	getMemory(
		id: string,
		includeForgotten?: boolean,
	): Promise<MemoryRecord | null>;

	/** Itère les souvenirs (status actif par défaut). withVectors=false
	 * évite le transfert/parse des vecteurs ; scopePrefix pousse le filtre
	 * scope en SQL quand le backend le supporte. */
	iterate(
		includeForgotten?: boolean,
		opts?: IterateOptions,
	): AsyncIterable<StoredRow>;

	/** Nombre de souvenirs actifs (stats). */
	count(): Promise<{ active: number; forgotten: number }>;
}
