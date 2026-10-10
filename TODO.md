# TODO

Perf backlog, priority order. Baseline: v1.1.0 (PR #8) — bench `BENCH_N=10000`, sqlite, feature-hash.

## vs openself (v1.0.1)

`npm run bench:vs-openself` at N=10 000 — **every row green since round4**: vector **2.73×** (205 vs 561 ms), hybrid **2.55×**, context **2.78×**, remember **2.40×**, lexical **1.82×** (30 vs 54 ms, FTS5 vs FTS5), list **1.47×** (15 vs 22 ms).

## Performance

- [x] **Stream SQLite reads with `stmt.iterate()` instead of `.all()`** — done (round4): `IterateOptions.stream` opt-in, consumed by `list` (breaks at `limit`). Measured: iterate() costs +25% per row on full scans, so it is NOT the default — only early-exit consumers set it. List at 10k: 43.8 → 15.5 ms.
- [x] **FTS5 for the lexical leg** — done (round4): optional `FortuneProvider.searchLexical()` (capability `lexicalSearch`), bm25 ranking + LIMIT + business filters in SQL, FTS maintained delete+insert with idempotent legacy backfill. `search-lexical` at 10k: 90.7 → 30.0 ms, ahead of openself's FTS5 (54 ms).
- [x] **Diagnose the 2× list gap vs openself** — diagnosed and closed: the gap was eager materialization (`.all()` fetched all 10k rows before the `limit` break), not driver overhead nor column selection. Streaming fetch fixed it (43.8 → 15.5 ms); we now lead openself 1.47× on list.
- [x] LRU eviction instead of full `clear()` in `lexicalCache` (`src/manager.ts`) and `FEATURE_CACHE` (`src/vectors.ts`) — done (round4): shared `TinyLru` in `vectors.ts`, eviction of the oldest entry, no more full-cache drop.
- [x] Debounced/batched flush in `JsonProvider` — **decided against**: durability wins for a memory vault (a never-lost write is the point); a crash must not lose a memory already returned to the caller. Write-heavy use goes to sqlite, bulk import uses `addMany` (single flush). Rationale documented on `JsonProvider.flush()`.
- [x] Dedup `STOPWORDS` in `src/manager.ts` — done (round4): second `"a"` and `"elle"` removed.

## Verification

- [ ] Run `scripts/test-mysql.mjs` against a live MySQL 8.x — the v1.1.0 changes (content_hash dedup, recentFirst ordering) mirror pglite, which is covered, but mysql has no local coverage without a server.

## Ideas (unscoped)

- [ ] `search()` currently scores every surviving row; a bounded top-K heap during scoring would cap work when `candidateLimit` grows.
- [ ] `findConflicts` could push the `type IN (fact, preference, decision)` filter into SQL instead of filtering in the manager.
