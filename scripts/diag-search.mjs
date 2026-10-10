// Diagnostic temporaire : répartition du coût d'un search à N lignes (sqlite).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FortuneMemoryManager,
	sqliteProviderFactory,
} from "../dist/index.js";
import { decodeVectorBlob } from "../dist/vectors.js";

const N = Number(process.env.DIAG_N || 10000);
const dir = mkdtempSync(join(tmpdir(), "fm-diag-"));
const provider = sqliteProviderFactory(dir);
await provider.init();
const mgr = new FortuneMemoryManager(provider);

const t0 = performance.now();
for (let i = 0; i < N; i++) {
	await mgr.remember({
		content: `Memory number ${i} about database pricing deadline meeting decision preference project alpha ${i % 100}`,
		type: i % 3 === 0 ? "fact" : "note",
		scope: `bench/scope${i % 10}`,
		tags: [`tag${i % 50}`],
	});
}
console.log(`seed ${N} lignes : ${(performance.now() - t0).toFixed(0)}ms`);

async function measure(label, fn, iters = 20) {
	await fn(0);
	const s = performance.now();
	for (let i = 0; i < iters; i++) await fn(i);
	const ms = (performance.now() - s) / iters;
	console.log(`${label.padEnd(48)} ${ms.toFixed(2)}ms/op`);
	return ms;
}

// 1. Itération seule SANS vecteurs (= fetch SQL + rowToMemory)
await measure("iterate withVectors=false (fetch+parse)", async () => {
	let n = 0;
	for await (const row of provider.iterate(false, { withVectors: false })) {
		n += row.memory.content.length;
	}
	return n;
});

// 2. Itération AVEC vecteurs (= + blob + decodeVectorBlob par ligne)
await measure("iterate withVectors=true  (fetch+parse+blob)", async () => {
	let n = 0;
	for await (const row of provider.iterate(false, { withVectors: true })) {
		n += (row.vector?.length ?? 0) + row.memory.content.length;
	}
	return n;
});

// 3. decodeVectorBlob seul (micro)
{
	const floats = new Float32Array(256).fill(0.5);
	const blob = new Uint8Array(1 + floats.byteLength);
	blob[0] = 1;
	blob.set(new Uint8Array(floats.buffer), 1);
	const s = performance.now();
	for (let i = 0; i < N; i++) decodeVectorBlob(blob);
	const ms = performance.now() - s;
	console.log(
		`${"decodeVectorBlob xN (micro)".padEnd(48)} ${ms.toFixed(2)}ms total (${((ms / N) * 1000).toFixed(2)}µs/ligne)`,
	);
}

// 4. Le search complet pour comparaison
await measure("search-hybrid complet", (i) =>
	mgr.search(`database pricing decision project ${i}`, { limit: 10 }),
);

// 5. remember complet (dédup scan + insert)
await measure(
	"remember (dédup scan + insert)",
	(i) => mgr.remember({ content: `diag ${i} unique ${Math.random()}`, scope: `bench/scope${i % 10}` }),
	100,
);

rmSync(dir, { recursive: true, force: true });
