import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { isFirstSeen, eraseByHash } from "../../src/dedup";

/**
 * The invariant these specs exist for:
 *
 *   `DedupStore.fetch` reads `seen` and then inserts into it. Nothing holds a
 *   lock across the two statements — the guarantee is that `SqlStorage.exec` is
 *   synchronous, so no concurrent request can observe the gap between them.
 *
 * The Node suite covers half of that. Adding an `await` between the two
 * statements fails there too, because the fake's promise scheduling is real.
 * What the fake *cannot* fail on is the other half: `exec` itself acquiring a
 * yield point, or DO input-gate semantics changing. Its `exec` is an ordinary
 * synchronous function, so it satisfies the property by construction no matter
 * what `workerd` does — the suite would stay green while every impression
 * silently double-counted.
 *
 * These specs bind the assertion to the runtime that actually enforces it, and
 * exercise the real stub/RPC path and real SQLite rather than a model of them.
 */

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DEDUP: DurableObjectNamespace;
  }
}

const TTL = 86_400;

describe("DedupStore under workerd", () => {
  it("admits exactly one winner when the same key arrives concurrently", async () => {
    // The assertion the fake cannot make: 50 genuinely concurrent requests
    // against one instance, through the real stub/RPC path and real SQLite.
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        isFirstSeen(env.DEDUP, "camp-concurrency", "same-key", TTL),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(49);
  });

  it("keeps distinct keys independent under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        isFirstSeen(env.DEDUP, "camp-distinct", `key-${i}`, TTL),
      ),
    );

    expect(results.every(Boolean)).toBe(true);
  });

  it("counts a device once across a salt rotation, then once more after it", async () => {
    // Rotation: the previous-salt key is the live one, the current-salt key is
    // seeded on the alias hit. When the window closes the device must not be
    // counted again just because the alias expired.
    const shard = "camp-rotation";
    expect(await isFirstSeen(env.DEDUP, shard, "old-hash", TTL)).toBe(true);

    // Same device, now hashed with the new salt, old hash supplied as the alias.
    expect(await isFirstSeen(env.DEDUP, shard, "new-hash", TTL, "old-hash")).toBe(false);

    // Rotation window has closed; the alias is no longer consulted.
    expect(await isFirstSeen(env.DEDUP, shard, "new-hash", TTL)).toBe(false);
  });

  it("erases only the subject's keys, leaving a lookalike prefix intact", async () => {
    // Real SQLite LIKE/ESCAPE, not the regex compiler in the fake. `a_c` must
    // not match `abc` once the underscore is escaped.
    const shard = "camp-erase";
    await isFirstSeen(env.DEDUP, shard, "a_c|camp|cre", TTL);
    await isFirstSeen(env.DEDUP, shard, "abc|camp|cre", TTL);

    const deleted = await eraseByHash(env.DEDUP, shard, "a_c");

    expect(deleted).toBe(1);
    // The lookalike survived, so it is still a duplicate.
    expect(await isFirstSeen(env.DEDUP, shard, "abc|camp|cre", TTL)).toBe(false);
    // The erased subject is counted fresh.
    expect(await isFirstSeen(env.DEDUP, shard, "a_c|camp|cre", TTL)).toBe(true);
  });

  it("expires a key once its TTL has passed", async () => {
    // A 1-second TTL, then a real wait: the expiry comparison runs against
    // SQLite's stored integer, not a fake's in-memory map.
    const shard = "camp-ttl";
    expect(await isFirstSeen(env.DEDUP, shard, "short-lived", 1)).toBe(true);
    expect(await isFirstSeen(env.DEDUP, shard, "short-lived", 1)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    // The window has closed, so the device counts again rather than being
    // suppressed forever.
    expect(await isFirstSeen(env.DEDUP, shard, "short-lived", TTL)).toBe(true);
  });
});
