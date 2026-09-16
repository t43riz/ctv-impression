import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Durable Object tests that run inside `workerd` rather than against the fakes
 * in `test/helpers/fakes.ts`.
 *
 * The dedup guarantee rests on `SqlStorage.exec` not yielding between the
 * SELECT and the INSERT in `DedupStore`. A hand-written fake cannot test that:
 * its `exec` is an ordinary synchronous function, so it holds the property by
 * construction no matter what the real runtime does. These specs are the only
 * place that assertion is made against the runtime that actually enforces it.
 *
 * Bindings are declared here rather than read from `wrangler.toml`, because the
 * pool requires the `nodejs_compat` flag and the deployed Worker does not use
 * it. Adding it to `wrangler.toml` to satisfy the test runner would change the
 * production runtime, so the test environment is configured in isolation and
 * only the DO classes under test are bound.
 *
 * Kept separate from `vitest.config.ts` (Node) because the two pools cannot
 * share a process; `npm test` runs both.
 */
export default defineWorkersConfig({
  test: {
    include: ["test/workers/**/*.test.ts"],
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2024-12-18",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            // SQLite-backed, matching the `new_sqlite_classes` migration.
            DEDUP: { className: "DedupStore", useSQLite: true },
            RECENT: { className: "RecentImpressions", useSQLite: true },
          },
        },
      },
    },
  },
});
