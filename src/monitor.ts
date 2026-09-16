import type { Env } from "./types";
import { reconSummary, type ReconRow } from "./query";
import { configFloat } from "./lib/http";

/**
 * Observability helpers.
 *
 * Two checks the original spec could not actually implement:
 *  1. "AE write failures > 0" is impossible to observe (writeDataPoint is
 *     fire-and-forget). Instead we reconcile received-vs-counted beacons.
 *  2. "100% daily export" needs enforcement: a freshness check on the export
 *     status marker, alerting if no fresh NDJSON by the cutoff.
 *
 * Outcome ledger: every received beacon is expected to produce exactly one
 * *terminal* outcome (counted, duplicate, reject_*, disabled). Outcomes in the
 * `alert_` namespace are side-channel signals that can fire zero or more times
 * per beacon, so they are reported separately and excluded from the ledger.
 * A gap between received and accounted means a beacon died mid-flight, which
 * is the signature of an unhandled exception in the ingest path.
 */

export interface ReconHealth {
  received: number;
  counted: number;
  duplicates: number;
  rejects: number;
  disabled: number;
  /** reject_internal: unhandled ingest failures. Any value above 0 is a bug. */
  internalErrors: number;
  /** alert_* outcomes (e.g. raw-tier write failures). */
  alerts: number;
  /**
   * Scheduled-job failures (failed export, failed health check). Gated on an
   * absolute count rather than a ratio: one per cron run can never register
   * against beacon volume, and the export is the only permanent record.
   */
  infraAlerts: number;
  /** received that produced no terminal outcome. Must be 0. */
  unexpected: number;
  /**
   * counted / received. Informational throughput only — deliberately *not* a
   * health gate (see computeReconHealth).
   */
  countedRatio: number;
  /** rejects / received. A spike means a broken tag or a probe. */
  rejectRatio: number;
  /** alerts / received; 1 when alerts exist with no received beacons at all. */
  alertRatio: number;
  /**
   * `/call` outcomes, counted separately from the beacon ledger. Reported so a
   * silent "every qualified call was skipped" state (placeholder event group,
   * unconfigured UA endpoint) is visible at all: the conversion path previously
   * had no observability outside the PBX's own logs.
   */
  callFired: number;
  /** Validated by the platform but NOT delivered (`CAPI_MODE=test`). */
  callDryRun: number;
  callSkipped: number;
  /**
   * Calls refused before any send was attempted: unauthorized, unknown_number,
   * bad_request, not_qualified, bad_number_mapping, not_configured. These are
   * the outcomes that reveal a misconfigured PBX or number registry, so they
   * are gated on — a path that answers 401 to every call is not healthy.
   */
  callRejections: number;
  /** Replays absorbed by the idempotency claim. Reported, never gated. */
  callDuplicates: number;
  /** Sends that failed: capi_error | internal_error. */
  callErrors: number;
  /** Every `/call` outcome (fired + dry-run + skipped + duplicates + rejections + errors). */
  callAttempts: number;
  callErrorRatio: number;
  callRejectRatio: number;
  healthy: boolean;
}

export interface ReconHealthOptions {
  /** Ceiling on rejects/received. */
  maxRejectRatio?: number;
  /**
   * Ceiling on alerts/received. Raw-tier writes are best-effort and a single
   * transient R2 error used to flip health to red for a whole day, which is how
   * an alert gets muted. Small absolute noise is tolerated; a sustained rate is
   * not.
   */
  maxAlertRatio?: number;
  /** Ceiling on failed `/call` sends per outcome. */
  maxCallErrorRatio?: number;
  /** Ceiling on calls refused before a send was attempted. */
  maxCallRejectRatio?: number;
}

/**
 * Thresholds from the environment, so an operator can retune a ceiling without
 * a code change. Every value falls back to the documented default when unset,
 * blank, non-numeric or out of [0, 1].
 */
export function reconHealthOptions(env: Env): Required<ReconHealthOptions> {
  return {
    maxRejectRatio: configFloat(env.HEALTH_MAX_REJECT_RATIO, 0.5, 0, 1),
    maxAlertRatio: configFloat(env.HEALTH_MAX_ALERT_RATIO, 0.01, 0, 1),
    maxCallErrorRatio: configFloat(env.HEALTH_MAX_CALL_ERROR_RATIO, 0.5, 0, 1),
    maxCallRejectRatio: configFloat(env.HEALTH_MAX_CALL_REJECT_RATIO, 0.5, 0, 1),
  };
}

/** `/call` outcomes that mean a call was refused before a send was attempted. */
const CALL_REJECTIONS = [
  "call_unauthorized",
  "call_unknown_number",
  "call_bad_request",
  "call_not_qualified",
  "call_bad_number_mapping",
  "call_not_configured",
  // Budget refusals belong here too: a PBX that trips the per-IP limit is
  // having its conversions dropped, which must not read as a healthy path.
  "call_rate_limited",
] as const;

/** `/call` outcomes that mean an attempted send failed. */
const CALL_SEND_ERRORS = ["call_capi_error", "call_internal_error"] as const;

/**
 * Alerts raised by the scheduled jobs rather than by per-beacon work. Any
 * occurrence is a failure: these fire once per cron run, so they can never
 * reach a meaningful ratio against beacon volume.
 */
const INFRA_ALERTS = [
  "alert_export_failed",
  "alert_health_check_failed",
  // R2 refused the health artifact itself, so the only remaining signal is here.
  "alert_health_write_failed",
  // A /call claim that could not be released. The PBX's retry will be answered
  // "duplicate" and the conversion lost, and `call_duplicate` is deliberately
  // never gated — so this row is the only thing standing between a stranded
  // claim and silent revenue loss. Never proportional to beacon volume.
  "alert_claim_release_failed",
  // A DSAR erasure threw. Operator-initiated rather than scheduled, but it
  // shares the property this list actually requires: bounded occurrence. A
  // legally-obligated erasure that failed part-way must be fatal to health.
  // Its read-only sibling `alert_admin_error` is deliberately NOT here — that
  // one is unbounded (any dashboard refresh can raise it) so it stays on the
  // ratio gate, where a genuine outage still clears the ceiling but a single
  // transient blip does not red-light the day.
  "alert_admin_dsar_error",
  // The alert webhook refused the notification. Reachable only when the check
  // was already red, so this is the delivery of a real failure failing. It fires
  // at most once per run, exactly like the rows above: left on the ratio gate it
  // is invisible (one failure against a day of beacon traffic rounds to zero),
  // and the next run that comes back green pushes nothing, so nothing ever tells
  // a human that the alerting path itself is down.
  "alert_notify_failed",
] as const;

/**
 * Reconcile ingest outcomes from raw `ingest_recon` rows. Pure, so the
 * thresholds are unit-testable without an Analytics Engine round trip.
 *
 * Beacon health is gated on the ledger closing exactly — every received beacon
 * must resolve to exactly one terminal outcome — plus zero internal errors, a
 * bounded alert ratio, and a bounded reject ratio. It is deliberately not gated
 * on a counted/received ratio: with a 24h dedup window a healthy CTV creative
 * legitimately sees a large duplicate share, so any floor there would either be
 * permanently red or so low as to be meaningless. `countedRatio` is still
 * reported for visibility.
 *
 * The conversion path is gated separately (it is an independent population) on
 * both failed sends and calls refused before a send was attempted.
 */
export function computeReconHealth(
  rows: ReconRow[],
  opts: ReconHealthOptions = {},
): ReconHealth {
  const maxRejectRatio = opts.maxRejectRatio ?? 0.5;
  const maxAlertRatio = opts.maxAlertRatio ?? 0.01;
  const maxCallErrorRatio = opts.maxCallErrorRatio ?? 0.5;
  const maxCallRejectRatio = opts.maxCallRejectRatio ?? 0.5;

  const sum = (pred: (outcome: string) => boolean) =>
    rows.filter((r) => pred(r.outcome)).reduce((a, r) => a + r.events, 0);

  const received = sum((o) => o === "received");
  const counted = sum((o) => o === "counted");
  const duplicates = sum((o) => o === "duplicate");
  const rejects = sum((o) => o.startsWith("reject_"));
  const disabled = sum((o) => o === "disabled");
  const internalErrors = sum((o) => o === "reject_internal");
  const alerts = sum((o) => o.startsWith("alert_"));
  // Scheduled-job failures are not proportional to beacon volume, so a ratio is
  // the wrong instrument: one failed nightly export against a day of healthy
  // traffic rounds to ~0 and stays under any sane ceiling, while the only
  // durable record of that day never got written. Gate them on absolute count.
  const infraAlerts = sum((o) => (INFRA_ALERTS as readonly string[]).includes(o));

  const accounted = counted + duplicates + rejects + disabled;
  // max(0, ...) so a ledger that over-accounts (a double-recorded beacon) shows
  // up as unexpected === 0 but fails the exact equality below rather than as a
  // nonsensical negative gap.
  const unexpected = Math.max(0, received - accounted);

  const countedRatio = received > 0 ? counted / received : 0;
  const rejectRatio = received > 0 ? rejects / received : 0;
  // Alerts with no received beacon at all is not "0%": it is a raw-tier /
  // matching-store failure that produced no ledger traffic, and reporting it as
  // 0 made it indistinguishable from a quiet healthy hour.
  const alertRatio = received > 0 ? alerts / received : alerts > 0 ? 1 : 0;

  const callFired = sum((o) => o === "call_fired");
  const callDryRun = sum((o) => o === "call_dry_run");
  const callSkipped = sum((o) => o === "call_skipped");
  const callDuplicates = sum((o) => o === "call_duplicate");
  const callRejections = sum((o) => (CALL_REJECTIONS as readonly string[]).includes(o));
  const callErrors = sum((o) => (CALL_SEND_ERRORS as readonly string[]).includes(o));
  const callAttempts =
    callFired + callDryRun + callSkipped + callDuplicates + callRejections + callErrors;
  const callErrorRatio = callAttempts > 0 ? callErrors / callAttempts : 0;
  const callRejectRatio = callAttempts > 0 ? callRejections / callAttempts : 0;

  // The beacon ledger and the conversion path are independent populations, so
  // they are evaluated separately: an idle pixel path must not mask a failing
  // conversion path.
  //
  // Note the ledger terms are exact-equality checks, not ratios: with
  // `received === accounted` (and both zero when idle) the `received === 0`
  // case needs no special short-circuit.
  const beaconHealthy =
    internalErrors === 0 &&
    unexpected === 0 &&
    received === accounted &&
    infraAlerts === 0 &&
    alertRatio <= maxAlertRatio &&
    rejectRatio <= maxRejectRatio;
  // Both halves of the conversion path are gated: sends that failed *and* calls
  // refused before a send was ever attempted. Refusals are how a wrong share
  // HMAC key (100% unauthorized) or a stale number registry (100% unknown
  // number) presents itself, and counting only send failures made that state
  // green.
  const callHealthy =
    callErrorRatio <= maxCallErrorRatio && callRejectRatio <= maxCallRejectRatio;

  const healthy = beaconHealthy && callHealthy;

  return {
    received,
    counted,
    duplicates,
    rejects,
    disabled,
    internalErrors,
    alerts,
    infraAlerts,
    unexpected,
    countedRatio,
    rejectRatio,
    alertRatio,
    callFired,
    callDryRun,
    callSkipped,
    callRejections,
    callDuplicates,
    callErrors,
    callAttempts,
    callErrorRatio,
    callRejectRatio,
    healthy,
  };
}

export async function checkReconHealth(
  env: Env,
  hours = 24,
  opts: ReconHealthOptions = {},
): Promise<ReconHealth> {
  const rows = await reconSummary(env, hours);
  return computeReconHealth(rows, { ...reconHealthOptions(env), ...opts });
}

/** YYYY-MM-DD, `daysBack` days before `atMs` (UTC). */
function utcDate(atMs: number, daysBack: number): string {
  return new Date(atMs - daysBack * 86_400_000).toISOString().slice(0, 10);
}

export interface ExportFreshness {
  fresh: boolean;
  lastDate: string | null;
  /** The date the most recent nightly run should have exported. */
  expectedDate: string | null;
  ageHours: number | null;
  rows: number | null;
}

/**
 * Check that the most recent export ran *for the right day*.
 *
 * The age of the status marker alone is not enough. `runExport` writes this
 * marker for any date it is asked to export, including a backfill, so exporting
 * a month-old day today produces a marker with a fresh `ts` and an ancient
 * `date` — the age check calls that healthy while the daily job could be broken
 * and nobody would know. Both the age and the date therefore have to hold.
 *
 * The nightly run at 02:00 UTC on day D exports D-1, so between midnight and
 * 02:00 the newest legitimate marker is D-2; both are accepted.
 */
export async function checkExportFreshness(
  env: Env,
  maxAgeHours = 26,
  now = Date.now(),
): Promise<ExportFreshness> {
  const expected = [utcDate(now, 1), utcDate(now, 2)];
  const obj = await env.ARCHIVE.get("_status/last_export.json");
  if (obj === null) {
    return {
      fresh: false,
      lastDate: null,
      expectedDate: expected[0],
      ageHours: null,
      rows: null,
    };
  }

  const status = (await obj.json()) as { date: string; ts: string; rows?: number };
  const ageHours = (now - new Date(status.ts).getTime()) / 3_600_000;
  return {
    fresh: ageHours <= maxAgeHours && expected.includes(status.date),
    lastDate: status.date,
    expectedDate: expected[0],
    ageHours,
    rows: status.rows ?? null,
  };
}
