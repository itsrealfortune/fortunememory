# TODO

Perf backlog, priority order. Baseline: v1.1.0 (PR #8) — bench `BENCH_N=10000`, sqlite, feature-hash.

## Performance

- [ ] **Stream SQLite reads with `stmt.iterate()` instead of `.all()`** — after v1.1.0, search is dominated by row fetch + `rowToMemory` (~8.8 µs/row, 88 ms at 10k). Streaming keeps memory constant and skips driver-level materialization. Trigger: vault approaching 50k+ memories.
- [ ] **FTS5 for the lexical leg** — `search-lexical` still costs ~95 ms/op at 10k because every row is scored in JS. Push candidate selection into SQL. Trigger: 100k+ memories, or search-per-message latency becoming noticeable.
- [ ] LRU eviction instead of full `clear()` in `lexicalCache` (`src/manager.ts`) and `FEATURE_CACHE` (`src/vectors.ts`) — both currently drop everything at the limit.
- [ ] Debounced/batched flush in `JsonProvider` — it rewrites the whole file on every `addMemory` (crash-safety vs throughput tradeoff, decide consciously).
- [ ] Dedup `STOPWORDS` in `src/manager.ts` (`"a"` and `"elle"` appear twice).

## Verification

- [ ] Run `scripts/test-mysql.mjs` against a live MySQL 8.x — the v1.1.0 changes (content_hash dedup, recentFirst ordering) mirror pglite, which is covered, but mysql has no local coverage without a server.

## Ideas (unscoped)

- [ ] `search()` currently scores every surviving row; a bounded top-K heap during scoring would cap work when `candidateLimit` grows.
- [ ] `findConflicts` could push the `type IN (fact, preference, decision)` filter into SQL instead of filtering in the manager.
