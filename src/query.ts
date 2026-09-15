import type { Env } from "./types";
import { querySql, sqlString } from "./lib/sql";

/**
 * Reporting queries over the impression dataset.
 *
 * Counting rule: WAE samples, so every impression total uses
 * `sum(_sample_interval)` — NOT `sum(double0)` and NOT `count()`.
 *
 * Reach caveat: `count(DISTINCT blobN)` on a NON-index field (ifa_hash) is an
 * ESTIMATE under sampling and is not accreditable. Trustworthy reach/frequency
 * comes from the dedup store or the raw R2 rows, not from AE. The reach helper
 * below is explicitly labeled an estimate.
 */

const DATASET = "impression_events";

export interface CampaignTotal {
  campaign_id: string;
  impressions: number;
}

export async function impressionsByCampaign(
  env: Env,
  days = 7,
): Promise<CampaignTotal[]> {
  const sql = `
    SELECT
      blob1 AS campaign_id,
      sum(_sample_interval) AS impressions
    FROM ${DATASET}
    WHERE timestamp > now() - INTERVAL '${days}' DAY
    GROUP BY campaign_id
    ORDER BY impressions DESC
    FORMAT JSON`;
  const { data } = await querySql<CampaignTotal>(env, sql);
  return data;
}

export interface CountryTotal {
  country: string;
  impressions: number;
}

export async function impressionsByCountry(
  env: Env,
  hours = 24,
): Promise<CountryTotal[]> {
  const sql = `
    SELECT
      blob4 AS country,
      sum(_sample_interval) AS impressions
    FROM ${DATASET}
    WHERE timestamp > now() - INTERVAL '${hours}' HOUR
    GROUP BY country
    ORDER BY impressions DESC
    FORMAT JSON`;
  const { data } = await querySql<CountryTotal>(env, sql);
  return data;
}

export interface HourlyPoint {
  hour: string;
  impressions: number;
}

export async function hourlyTrend(env: Env, hours = 24): Promise<HourlyPoint[]> {
  const sql = `
    SELECT
      toStartOfHour(timestamp) AS hour,
      sum(_sample_interval) AS impressions
    FROM ${DATASET}
    WHERE timestamp > now() - INTERVAL '${hours}' HOUR
    GROUP BY hour
    ORDER BY hour
    FORMAT JSON`;
  const { data } = await querySql<HourlyPoint>(env, sql);
  return data;
}

export interface ReachEstimate {
  campaign_id: string;
  unique_devices_estimate: number;
}

/**
 * ESTIMATE ONLY. count(DISTINCT) on a non-index, sampled field is unreliable.
 * Only counts attributable rows (ifa_present = '1'). For accreditable reach,
 * use the raw R2 export instead.
 */
export async function reachEstimate(
  env: Env,
  campaignId: string,
  days = 30,
): Promise<ReachEstimate> {
  const sql = `
    SELECT
      blob1 AS campaign_id,
      count(DISTINCT blob3) AS unique_devices_estimate
    FROM ${DATASET}
    WHERE timestamp > now() - INTERVAL '${days}' DAY
      AND blob1 = ${sqlString(campaignId)}
      AND blob7 = '1'
    GROUP BY campaign_id
    FORMAT JSON`;
  const { data } = await querySql<ReachEstimate>(env, sql);
  return data[0] ?? { campaign_id: campaignId, unique_devices_estimate: 0 };
}

/**
 * Reconciliation: compare beacons received vs counted for a window.
 * Drives the ingest health alert (no fire-and-forget write status exists).
 */
export interface ReconRow {
  outcome: string;
  events: number;
}

export async function reconSummary(env: Env, hours = 24): Promise<ReconRow[]> {
  const sql = `
    SELECT
      blob1 AS outcome,
      sum(_sample_interval) AS events
    FROM ingest_recon
    WHERE timestamp > now() - INTERVAL '${hours}' HOUR
    GROUP BY outcome
    ORDER BY events DESC
    FORMAT JSON`;
  const { data } = await querySql<ReconRow>(env, sql);
  return data;
}
