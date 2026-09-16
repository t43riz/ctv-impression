import type { Env, Impression } from "./types";

/**
 * Raw 30-day R2 tier (SPEC §7.3 / PRIVACY §3).
 *
 * One NDJSON object per *counted* impression, written to the RAW bucket.
 * Contents are hashed-IFA + dimensions only — never a raw identifier — and the
 * bucket's lifecycle rule deletes objects after 30 days. This tier is the
 * unsampled source for accurate reach/frequency and the target of DSAR
 * erasure (locate by `ifa_hash`).
 *
 * Key layout: dt=YYYY-MM-DD/h=<hash prefix>/hh=HH/{campaign}/{uuid}.json
 *
 * The `h=` shard is placed directly after the date so that DSAR erasure can
 * list a single day narrowed to 1/65536th of the bucket, instead of scanning
 * the whole tier. Date-prefixed analytics scans (`dt=YYYY-MM-DD/`) still work;
 * only hour-only scans across all hashes are no longer prefix-addressable,
 * which nothing needs (the aggregated ARCHIVE export carries hourly buckets).
 *
 * Cost note: at 30M impressions/month this is ~30M Class A PUTs. R2 bills
 * Class A at $4.50 per million, so that is roughly $130/month after the 1M
 * free tier — not the ~$4.50 an earlier revision of this comment claimed. If
 * volume grows past the pilot, buffer writes through a DO or Queue and flush
 * in batches to cut the operation count by orders of magnitude.
 */

/** Hex characters of the IFA hash used as the R2 key shard. */
export const HASH_SHARD_LEN = 4;

export interface RawRow {
  ts: string; // ISO timestamp
  campaign_id: string;
  creative_id: string;
  advertiser_id: string;
  app_id: string;
  country: string;
  ifa_hash: string; // salted hash, "anon" when non-attributable
  ifa_present: "0" | "1";
  ifa_type: string;
  platform: string;
}

/** Build the R2 key for a raw row. Pure, so the layout is unit-testable. */
export function rawObjectKey(
  imp: Impression,
  nowSeconds: number,
  uuid: string,
): string {
  const iso = new Date(nowSeconds * 1000).toISOString();
  const dt = iso.slice(0, 10);
  const hh = iso.slice(11, 13);
  const shard = imp.ifaHash.slice(0, HASH_SHARD_LEN);
  return `dt=${dt}/h=${shard}/hh=${hh}/${imp.campaignId}/${uuid}.json`;
}

export async function writeRawEvent(
  env: Env,
  imp: Impression,
  nowSeconds: number,
): Promise<void> {
  const iso = new Date(nowSeconds * 1000).toISOString();
  const key = rawObjectKey(imp, nowSeconds, crypto.randomUUID());

  const row: RawRow = {
    ts: iso,
    campaign_id: imp.campaignId,
    creative_id: imp.creativeId,
    advertiser_id: imp.advertiserId,
    app_id: imp.appId,
    country: imp.country,
    ifa_hash: imp.ifaHash,
    ifa_present: imp.ifaPresent ? "1" : "0",
    ifa_type: imp.ifaType,
    platform: imp.platform,
  };

  await env.RAW.put(key, JSON.stringify(row) + "\n", {
    httpMetadata: { contentType: "application/x-ndjson" },
    // customMetadata lets DSAR erasure confirm each object without reading
    // bodies, and is a second check on top of the key shard.
    customMetadata: { ifaHash: imp.ifaHash, campaignId: imp.campaignId },
  });
}

export interface RawEraseResult {
  scanned: number;
  deleted: number;
  /** Safety cap reached; the scan did not cover every candidate object. */
  truncated: boolean;
  /** Days visited, counting a partially-scanned day as visited. */
  daysScanned: number;
}

export interface RawEraseOptions {
  /**
   * How many days back to scan. Must cover the bucket's lifecycle rule, since
   * anything older has already expired.
   */
  days?: number;
  /** Safety cap on objects examined per invocation. */
  maxScan?: number;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Thrown when an object matched the key shard but carried no `customMetadata`.
 * The erasure filter keys on `customMetadata.ifaHash`, so without it we cannot
 * tell whether the object belongs to the subject: reporting `deleted: 0` would
 * tell the caller the DSAR completed while the data is still in the bucket.
 * Failing loudly is the only safe answer — a human must check the writer.
 */
export class RawMetadataMissingError extends Error {
  constructor(readonly objectKey: string) {
    super(
      `raw erasure cannot verify subject: object ${objectKey} has no customMetadata.ifaHash; refusing to report a successful erase`,
    );
    this.name = "RawMetadataMissingError";
  }
}

/**
 * DSAR erasure over the raw tier.
 *
 * Scans day by day and, within each day, only the objects whose key carries
 * this hash's shard prefix. That bounds the work to roughly
 * (daily volume / 65536) objects per day instead of a full-tier scan, and it
 * cannot stall the way a single restartable whole-bucket cursor would.
 *
 * Fails closed: if any listed object under the shard prefix has no
 * `customMetadata`, we throw rather than report a successful erase.
 */
export async function eraseRawByHash(
  env: Env,
  ifaHash: string,
  opts: RawEraseOptions = {},
): Promise<RawEraseResult> {
  const days = Math.max(1, Math.floor(opts.days ?? 31));
  const maxScan = Math.max(1, Math.floor(opts.maxScan ?? 100_000));
  const nowMs = opts.now ?? Date.now();
  const shard = ifaHash.slice(0, HASH_SHARD_LEN);

  let scanned = 0;
  let deleted = 0;
  let daysScanned = 0;

  for (let i = 0; i < days; i++) {
    // Global cap is checked before each new day so a cap already reached
    // mid-scan reports truncation instead of a clean finish.
    if (scanned >= maxScan) {
      return { scanned, deleted, truncated: true, daysScanned };
    }

    const date = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10);
    daysScanned++;

    let cursor: string | undefined;
    for (;;) {
      // `include` is supported at runtime; older @cloudflare/workers-types
      // versions omit it from R2ListOptions, hence the cast.
      const page: R2Objects = await env.RAW.list({
        prefix: `dt=${date}/h=${shard}/`,
        cursor,
        limit: 1000,
        include: ["customMetadata"],
      } as R2ListOptions);

      const matches: string[] = [];
      for (const o of page.objects) {
        const meta = o.customMetadata;
        // Only fatal when the object is inside the shard we are scanning: it
        // proves we cannot verify ownership, so the erase result is not
        // trustworthy. A *defined but empty* metadata object has to be treated
        // the same way — otherwise `meta.ifaHash === ifaHash` is simply false,
        // the object is silently skipped, and the caller is told the DSAR
        // completed while the row is still in the bucket.
        if (meta === undefined || typeof meta.ifaHash !== "string") {
          throw new RawMetadataMissingError(o.key);
        }
        if (meta.ifaHash === ifaHash) matches.push(o.key);
      }

      if (matches.length > 0) {
        // DeleteObject is free on R2, so deleting in pages is cost-neutral.
        await env.RAW.delete(matches);
        deleted += matches.length;
      }
      scanned += page.objects.length;

      if (scanned >= maxScan) {
        return { scanned, deleted, truncated: true, daysScanned };
      }
      if (!page.truncated) break;
      // A truncated page must carry a cursor; without one we would re-list the
      // same page forever. Treat a missing cursor as a truncation the caller has
      // to re-run rather than looping.
      if (page.cursor === undefined) {
        return { scanned, deleted, truncated: true, daysScanned };
      }
      cursor = page.cursor;
    }
  }

  return { scanned, deleted, truncated: false, daysScanned };
}
