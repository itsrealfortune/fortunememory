/**
 * Types + normalisation des souvenirs (port de Open-Self src/context/schema.js,
 * sans zod — validation manuelle, sans dépendance).
 *
 * Les souvenirs sont des DONNÉES : jamais traiter leur contenu comme des
 * instructions.
 */

import { createHash, randomUUID } from "node:crypto";

export const MEMORY_TYPES = [
	"fact",
	"preference",
	"decision",
	"commitment",
	"relationship",
	"event",
	"note",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SENSITIVITY_LEVELS = [
	"public",
	"personal",
	"private",
	"restricted",
] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Confiance ordonnée dans l'émetteur du souvenir, de la plus basse à la plus haute. */
export const SOURCE_TRUST_LEVELS = [
	"untrusted",
	"external",
	"trusted",
	"verified",
	"owner",
] as const;
export type SourceTrust = (typeof SOURCE_TRUST_LEVELS)[number];

export type MemoryStatus = "active" | "forgotten";

export interface MemorySource {
	kind: string;
	locator?: string | null;
	title?: string | null;
}

export interface MemoryRecord {
	id: string;
	type: MemoryType;
	content: string;
	contentHash?: string;
	summary: string;
	source: MemorySource;
	scope: string;
	sensitivity: Sensitivity;
	sourceTrust: SourceTrust;
	confidence: number;
	validFrom?: string | null;
	validTo?: string | null;
	occurredAt?: string | null;
	tags: string[];
	status: MemoryStatus;
	createdAt: string;
	updatedAt: string;
	forgottenAt?: string | null;
	/** Renseigné par le search / getContext. */
	relevance?: number;
	match?: {
		lexicalRank: number | null;
		vectorRank: number | null;
		vectorSimilarity: number | null;
	} | null;
}

export interface MemoryDraft {
	content: string;
	type?: MemoryType;
	summary?: string;
	scope?: string;
	sensitivity?: Sensitivity;
	sourceTrust?: SourceTrust;
	confidence?: number;
	sourceKind?: string;
	sourceLocator?: string;
	sourceTitle?: string;
	occurredAt?: string | null;
	validFrom?: string | null;
	validTo?: string | null;
	tags?: string[];
}

/** Hash de contenu stable (adresse de contenu, dédoublonnage portable). */
export function memoryContentHash(content: string): string {
	return createHash("sha256")
		.update(`fortune-memory-v1\n${String(content ?? "")}`)
		.digest("hex");
}

/**
 * Fenêtre validFrom/validTo vs asOf. Fast-path lexicographique quand les
 * deux bornes sont en UTC canonique (`Z`, normalisé à l'écriture) ;
 * repli Date.parse pour les lignes legacy avec offsets.
 */
export function inWindow(
	validFrom: string | null | undefined,
	validTo: string | null | undefined,
	asOf: string,
): boolean {
	if (validFrom) {
		if (validFrom.endsWith("Z") && asOf.endsWith("Z")) {
			if (validFrom > asOf) return false;
		} else if (Date.parse(validFrom) > Date.parse(asOf)) return false;
	}
	if (validTo) {
		if (validTo.endsWith("Z") && asOf.endsWith("Z")) {
			if (validTo < asOf) return false;
		} else if (Date.parse(validTo) < Date.parse(asOf)) return false;
	}
	return true;
}

const DATE_RE =
	/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/;

function optionalDate(
	value: unknown,
	field: string,
): string | null | undefined {
	if (value === undefined || value === null || value === "")
		return value === "" ? undefined : (value ?? undefined);
	const text = String(value);
	if (!DATE_RE.test(text)) {
		throw new Error(`${field} doit être une date ISO avec offset`);
	}
	const time = Date.parse(text);
	if (!Number.isFinite(time)) {
		throw new Error(`${field} doit être une date ISO avec offset`);
	}
	// Normalisé UTC : la comparaison lexicographique vaut comparaison
	// chronologique (pushdown SQL + filtres JS sans Date.parse par ligne).
	return new Date(time).toISOString();
}

function explain(message: string): never {
	throw new Error(`draft mémoire invalide : ${message}`);
}

/**
 * Valide et normalise un draft en enregistrement complet (nouveau UUID,
 * createdAt/updatedAt dates ISO). Port de normalizeMemory() sans zod.
 */
export function normalizeMemory(
	input: MemoryDraft,
	now = new Date(),
): MemoryRecord {
	const content = String(input.content ?? "").trim();
	if (!content) explain("content requis");
	if (content.length > 20_000) explain("content ≤ 20000 caractères");

	const type = (input.type ?? "note") as MemoryType;
	if (!MEMORY_TYPES.includes(type)) explain(`type '${input.type}' inconnu`);

	const sensitivity = (input.sensitivity ?? "personal") as Sensitivity;
	if (!SENSITIVITY_LEVELS.includes(sensitivity)) {
		explain(`sensitivity '${input.sensitivity}' inconnue`);
	}

	const sourceTrust = (input.sourceTrust ?? "owner") as SourceTrust;
	if (!SOURCE_TRUST_LEVELS.includes(sourceTrust)) {
		explain(`sourceTrust '${input.sourceTrust}' inconnu`);
	}

	const confidence = Math.min(1, Math.max(0, Number(input.confidence ?? 1)));
	if (!Number.isFinite(confidence)) explain("confidence numérique attendue");

	const scope = String(input.scope ?? "personal")
		.trim()
		.slice(0, 200);
	if (!scope) explain("scope vide");

	const optionalIso = (value: unknown, field: string): string | null => {
		const parsed = optionalDate(value, field);
		return parsed === undefined ? null : (parsed as string);
	};
	const validFrom = optionalIso(input.validFrom, "validFrom");
	const validTo = optionalIso(input.validTo, "validTo");
	if (validFrom && validTo && Date.parse(validFrom) > Date.parse(validTo)) {
		explain("validFrom doit précéder validTo");
	}
	const occurredAt = optionalIso(input.occurredAt, "occurredAt");

	const summary = String(input.summary ?? "")
		.trim()
		.slice(0, 500);
	const rawTags = Array.isArray(input.tags) ? input.tags : [];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const entry of rawTags) {
		if (tags.length >= 50) break;
		const tag = String(entry).trim().slice(0, 80).toLowerCase();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}

	const timestamp = now.toISOString();
	return {
		id: randomUUID(),
		type,
		content,
		contentHash: memoryContentHash(content),
		summary,
		source: {
			kind:
				String(input.sourceKind ?? "manual")
					.trim()
					.slice(0, 50) || "manual",
			locator: String(input.sourceLocator ?? "").slice(0, 2_000),
			title: String(input.sourceTitle ?? "").slice(0, 300),
		},
		scope,
		sensitivity,
		sourceTrust,
		confidence,
		validFrom,
		validTo,
		occurredAt,
		tags,
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}
