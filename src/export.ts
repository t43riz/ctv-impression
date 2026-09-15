import type { Env } from "./types";
import { querySql } from "./lib/sql";

/**
 * Daily export Worker (Cron trigger).
 *
 * Corrects the original spec's broken export:
 *  - Reads via the SQL API (the binding is write-only).
 *  - Aggregates by HOUR bucket, not raw millisecond timestamp (which produced
 *    ~one row per event and defeated aggregation).
 *  - Weights counts by sum(_sample_interval), not sum(double0).
 *  - Idempotent: deterministic object key per day, overwrite-safe.
 *  - Paginated to bound memory inside the isolate.
 *
 * Output: newline-delimited JSON (NDJSON) per day. NDJSON keeps the Worker
 * memory-light and is trivially loadable by DuckDB/Athena/Spark. A Parquet
 * conversion step can run downstream where memory is not a 128 MB isolate.
 */

const DATASET = "impression_events";
const PAGE_SIZE = 10_000;

interface AggRow {
  hour: string;
  campaign_id: string;
  creative_id: string;
  country: string;
  app_id: string;
  advertiser_id: string;
  ifa_present: string;
  platform: string; // '' on rows written before the blob9 addition
  impressions: number;
}

/** YYYY-MM-DD for the day *before* the scheduled run (UTC). */
function exportDate(scheduledTime: number): string {
  const d = new Date(scheduledTime - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function buildQuery(date: string, offset: number, limit: number): string {
  // Aggregate to hour buckets across all dimensions for the target day.
  //
  // ORDER BY must list every GROUP BY key. Ordering by a subset leaves ties,
  // and row order within ties is undefined, so a LIMIT/OFFSET walk over such a
  // result can silently skip or duplicate rows. That would make the export
  // quietly lossy, which matters because this file is the long-term record.
  return `
    SELECT
      toStartOfHour(timestamp) AS hour,
      blob1 AS campaign_id,
      blob2 AS creative_id,
      blob4 AS country,
      blob5 AS app_id,
      blob6 AS advertiser_id,
      blob7 AS ifa_present,
      blob9 AS platform,
      sum(_sample_interval) AS impressions
    FROM ${DATASET}
    WHERE timestamp >= toDateTime('${date} 00:00:00')
      AND timestamp <  toDateTime('${date} 00:00:00') + INTERVAL '1' DAY
    GROUP BY hour, campaign_id, creative_id, country, app_id, advertiser_id, ifa_present, platform
    ORDER BY hour, campaign_id, creative_id, country, app_id, advertiser_id, ifa_present, platform
    LIMIT ${limit} OFFSET ${offset}
    FORMAT JSON`;
}

export interface ExportResult {
  date: string;
  rows: number;
  key: string;
}

export async function runExport(
  env: Env,
  scheduledTime: number,
): Promise<ExportResult> {
  const date = exportDate(scheduledTime);
  const key = `dt=${date}/impressions.ndjson`;

  let offset = 0;
  let total = 0;
  const chunks: string[] = [];
  // `rows_before_limit_at_least` is the pre-LIMIT row count the SQL API reports.
  // If it exceeds what we actually read, the API capped a page below the
  // requested LIMIT and the walk stopped early, which would silently truncate
  // the long-term record for the day.
  let rowsBeforeLimit: number | null = null;

  // Page through the aggregated result to keep memory bounded.
  for (;;) {
    const page = await querySql<AggRow>(env, buildQuery(date, offset, PAGE_SIZE));
    if (typeof page.rows_before_limit_at_least === "number") {
      rowsBeforeLimit = Math.max(rowsBeforeLimit ?? 0, page.rows_before_limit_at_least);
    }
    const data = page.data;
    if (data.length === 0) break;
    for (const row of data) chunks.push(JSON.stringify(row));
    total += data.length;
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (rowsBeforeLimit !== null && total < rowsBeforeLimit) {
    throw new Error(
      `export for ${date} read ${total} rows but the query reported ${rowsBeforeLimit}; ` +
        "refusing to publish a truncated aggregate — re-run the export",
    );
  }

  const body = chunks.length > 0 ? chunks.join("\n") + "\n" : "";

  // Idempotent overwrite: re-running for the same day replaces the object.
  await env.ARCHIVE.put(key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: {
      exportDate: date,
      rowCount: String(total),
      generatedAt: new Date().toISOString(),
    },
  });

  // Freshness marker for the observability check.
  await env.ARCHIVE.put(
    "_status/last_export.json",
    JSON.stringify({ date, rows: total, key, ts: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } },
  );

  return { date, rows: total, key };
}

/**
 * Backfill a specific date (operational tool, invoked from a one-off Worker
 * route or `wrangler` script). Reuses the same idempotent writer.
 */
export async function backfill(env: Env, date: string): Promise<ExportResult> {
  // scheduledTime = date + 1 day, so exportDate() resolves back to `date`.
  const t = new Date(`${date}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
  return runExport(env, t);
}
