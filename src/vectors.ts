/**
 * Encodage vectoriel local + providers embeddings (port de Open-Self
 * src/context/vectors.js + embeddings.js).
 *
 * `feature-hash` (défaut) : 100% local, déterministe, réseau zéro - tokens,
 * bigrammes, trigrammes de caractères vers un hash d'empreinte 256 dims.
 * `ollama` / `openai-compatible` : optionnels via FORTUNE_EMBEDDINGS.
 */

const CONCEPT_ALIASES = new Map([
	["db", "database"],
	["database", "database"],
	["postgres", "database"],
	["postgresql", "database"],
	["sqlite", "database"],
	["mysql", "database"],
	["price", "pricing"],
	["prices", "pricing"],
	["pricing", "pricing"],
	["cost", "pricing"],
	["meeting", "meeting"],
	["meet", "meeting"],
	["call", "meeting"],
	["decision", "decision"],
	["decide", "decision"],
	["decided", "decision"],
	["choose", "decision"],
	["chosen", "decision"],
	["preference", "preference"],
	["prefer", "preference"],
	["preferred", "preference"],
	["deadline", "deadline"],
	["due", "deadline"],
]);

const DIACRITICS_RE = /[̀-ͯ]/g;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text: unknown): string[] {
	const raw = String(text ?? "");
	if (!raw) return [];
	return (
		raw
			.normalize("NFKD")
			.replace(DIACRITICS_RE, "")
			.toLowerCase()
			.match(TOKEN_RE) || []
	).slice(0, 500);
}

export interface VectorProvider {
	readonly name: string;
	readonly model: string;
	/** true = encode() est bloquant-sûr et le manager peut l'utiliser tel quel. */
	encode(text: string): Promise<number[]>;
	budgetNote?: string;
}

export class FeatureHashEncoder implements VectorProvider {
	readonly name = "feature-hash";
	readonly model: string;
	private readonly dimensions: number;

	constructor(options: { dimensions?: number } = {}) {
		this.dimensions = options.dimensions ?? 256;
		this.model = `fortune-feature-hash-v1-${this.dimensions}`;
	}

	async encode(text: string): Promise<number[]> {
		return this.encodeSync(text);
	}

	encodeSync(text: string): number[] {
		const tokens = tokenize(text);
		const vector = new Array<number>(this.dimensions).fill(0);

		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			addFeature(vector, `word:${token}`, 1);
			const concept = CONCEPT_ALIASES.get(token);
			if (concept) addFeature(vector, `concept:${concept}`, 1.4);
			if (index > 0) {
				addFeature(vector, `bigram:${tokens[index - 1]}_${token}`, 0.7);
			}
			if (token.length >= 4) {
				const padded = `^${token}$`;
				for (let offset = 0; offset <= padded.length - 3; offset++) {
					addFeature(vector, `char:${padded.slice(offset, offset + 3)}`, 0.2);
				}
			}
		}

		let sum = 0;
		for (let index = 0; index < vector.length; index++) {
			const value = vector[index] ?? 0;
			sum += value * value;
		}
		const norm = Math.sqrt(sum);
		if (norm) {
			for (let index = 0; index < vector.length; index++) {
				vector[index] = (vector[index] ?? 0) / norm;
			}
		}
		return vector;
	}
}

/**
 * Produit scalaire : exact pour les vecteurs L2-normés (FeatureHashEncoder),
 * évite 2 normes + 2 sqrt par comparaison dans le chemin search.
 */
export function dotProduct(left: number[], right: number[]): number {
	let dot = 0;
	for (let index = 0; index < left.length; index++) {
		dot += (left[index] ?? 0) * (right[index] ?? 0);
	}
	return dot;
}

export function cosineSimilarity(left: number[], right: number[]): number {
	if (
		!Array.isArray(left) ||
		!Array.isArray(right) ||
		left.length !== right.length
	)
		return 0;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		const l = left[index];
		const r = right[index];
		if (l === undefined || r === undefined) return 0;
		dot += l * r;
		leftNorm += l * l;
		rightNorm += r * r;
	}
	const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
	return denominator ? dot / denominator : 0;
}

const FEATURE_CACHE = new Map<string, number>();
const FEATURE_CACHE_LIMIT = 20_000;

function addFeature(vector: number[], feature: string, weight: number): void {
	let hash = FEATURE_CACHE.get(feature);
	if (hash === undefined) {
		hash = hashFeature(feature);
		if (FEATURE_CACHE.size >= FEATURE_CACHE_LIMIT) FEATURE_CACHE.clear();
		FEATURE_CACHE.set(feature, hash);
	}
	const index = (hash >>> 1) % vector.length;
	const current = vector[index] ?? 0;
	vector[index] = current + (hash & 1 ? weight : -weight);
}

function hashFeature(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

class OllamaEmbeddings implements VectorProvider {
	readonly name = "ollama";
	readonly model: string;
	private readonly baseUrl: string;

	constructor(options: { baseUrl: string; model: string }) {
		this.baseUrl = options.baseUrl;
		this.model = options.model;
	}

	async encode(text: string): Promise<number[]> {
		const response = await fetch(`${this.baseUrl}/api/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: this.model, prompt: text }),
		});
		if (!response.ok)
			throw new Error(`ollama embeddings HTTP ${response.status}`);
		const payload = (await response.json()) as { embedding?: number[] };
		if (!Array.isArray(payload.embedding))
			throw new Error("ollama embeddings: payload invalide");
		return payload.embedding;
	}
}

class OpenAICompatibleEmbeddings implements VectorProvider {
	readonly name = "openai-compatible";
	readonly model: string;
	private readonly baseUrl: string;
	private readonly apiKey?: string;

	constructor(options: { baseUrl: string; model: string; apiKey?: string }) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.model = options.model;
		this.apiKey = options.apiKey;
	}

	async encode(text: string): Promise<number[]> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: this.model, input: text }),
		});
		if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
		const payload = (await response.json()) as {
			data?: Array<{ embedding?: number[] }>;
		};
		const embedding = payload.data?.[0]?.embedding;
		if (!Array.isArray(embedding))
			throw new Error("embeddings: payload invalide");
		return embedding;
	}
}

/**
 * Résolution du provider embeddings : option explicite > env
 * FORTUNE_EMBEDDINGS > feature-hash (local, déterministe).
 */
export function resolveVectorProvider(
	spec?: string,
	env: Record<string, string | undefined> = process.env as never,
): VectorProvider {
	const name = String(
		spec || env.FORTUNE_EMBEDDINGS || env.OPENSELF_EMBEDDINGS || "feature-hash",
	).toLowerCase();
	switch (name) {
		case "feature-hash":
		case "hash":
		case "local":
			return new FeatureHashEncoder();
		case "ollama":
			return new OllamaEmbeddings({
				baseUrl:
					env.FORTUNE_OLLAMA_URL ||
					env.OPENSELF_OLLAMA_URL ||
					"http://127.0.0.1:11434",
				model:
					env.FORTUNE_EMBEDDINGS_MODEL ||
					env.OPENSELF_EMBEDDINGS_MODEL ||
					"nomic-embed-text",
			});
		case "openai-compatible":
		case "openai": {
			const baseUrl =
				env.FORTUNE_EMBEDDINGS_BASE_URL ||
				env.OPENAI_BASE_URL ||
				"https://api.openai.com/v1";
			const apiKey = env.FORTUNE_EMBEDDINGS_API_KEY || env.OPENAI_API_KEY;
			if (!apiKey) {
				throw new Error(
					"openai-compatible embeddings exige FORTUNE_EMBEDDINGS_API_KEY",
				);
			}
			return new OpenAICompatibleEmbeddings({
				baseUrl,
				model: env.FORTUNE_EMBEDDINGS_MODEL || "text-embedding-3-small",
				apiKey,
			});
		}
		default:
			throw new Error(
				`embeddings inconnu : '${name}' (feature-hash | ollama | openai-compatible)`,
			);
	}
}

/**
 * Sérialisation binaire des vecteurs : 1 octet de version + Float32.
 * ~1 Ko/ligne vs ~5 Ko en JSON, parse sans JSON.parse.
 */
export function encodeVectorBlob(vector: number[]): Uint8Array {
	const floats = new Float32Array(vector);
	const out = new Uint8Array(1 + floats.byteLength);
	out[0] = 1; // version 1 = Float32
	out.set(
		new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength),
		1,
	);
	return out;
}

export function decodeVectorBlob(raw: Uint8Array): number[] | null {
	if (raw.byteLength === 0) return null;
	if (raw[0] === 1 && (raw.byteLength - 1) % 4 === 0) {
		const count = (raw.byteLength - 1) / 4;
		const aligned = new Uint8Array(count * 4);
		aligned.set(raw.subarray(1));
		return Array.from(
			new Float32Array(aligned.buffer, aligned.byteOffset, count),
		);
	}
	// Legacy : Float64 brut sans header (8 octets/composante).
	if (raw.byteLength % 8 !== 0) return null;
	const floats = new Float64Array(
		raw.buffer,
		raw.byteOffset,
		raw.byteLength / 8,
	);
	return Array.from(floats);
}

/** Blob binaire préféré, repli JSON legacy. */
export function parseVectorBlob(blob: unknown, json: unknown): number[] | null {
	if (
		typeof Uint8Array !== "undefined" &&
		(blob instanceof Uint8Array ||
			(typeof Buffer !== "undefined" && Buffer.isBuffer(blob)))
	) {
		return decodeVectorBlob(blob as Uint8Array);
	}
	if (typeof json !== "string") return null;
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
