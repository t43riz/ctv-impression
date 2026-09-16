import type { Env } from "../types";

/**
 * Reconciliation ledger (`ingest_recon` in Analytics Engine).
 *
 * One row per *received* beacon plus exactly one *terminal* outcome per beacon
 * (`counted` | `duplicate` | `reject_*` | `disabled` | `call_*`). Comparing the
 * two is the only meaningful health signal available: `writeDataPoint()` is
 * fire-and-forget and cannot report backend drops. Outcomes in the `alert_*`
 * namespace are side-channel signals that may accompany a terminal one and are
 * excluded from the ledger.
 *
 * This must never throw. It is called from the ingest path *and* from that
 * path's error handler, so a throwing recon write would convert a handled
 * failure into an unhandled rejection inside `waitUntil`.
 */
export function recordRecon(env: Env, outcome: string, campaignId: string): void {
  try {
    env.RECON.writeDataPoint({
      blobs: [outcome, campaignId],
      doubles: [1],
      indexes: [campaignId],
    });
  } catch (err) {
    console.log(
      `recon_write_failed outcome=${outcome}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * One-shot terminal-outcome recorder for a single request.
 *
 * A beacon (and a call) must resolve to *exactly one* terminal outcome: the
 * health check gates on `received === accounted`, so a second terminal row
 * would over-credit an outcome and hide the imbalance. Every path in the ingest
 * function deliberately returns immediately after recording, which leaves the
 * guard unreachable from that function by construction — so it lives here, as a
 * pure factory, where it can be exercised directly instead of being asserted
 * only through a path that cannot reach it.
 *
 * Returns true when this call recorded (i.e. it was the first), false when it
 * was suppressed as a repeat.
 */
export function terminalOutcomeRecorder(
  env: Env,
): (outcome: string, campaignId: string) => boolean {
  let recorded = false;
  return (outcome, campaignId) => {
    if (recorded) return false;
    recorded = true;
    recordRecon(env, outcome, campaignId);
    return true;
  };
}

/**
 * `/call` outcomes share the ledger so the conversion path is observable at
 * all: previously a placeholder `CAPI_EVENT_GROUP_ID`, an unset UA endpoint, or
 * a systematic send failure was invisible outside the PBX's own logs. Call
 * outcomes are namespaced `call_*` so they can be counted separately from the
 * beacon ledger (a beacon has exactly one terminal outcome; a call does too,
 * but the two populations are unrelated).
 *
 * `campaignId` is the creative's campaign, or "unknown" when the number could
 * not be resolved.
 */
export function recordCallOutcome(env: Env, outcome: string, campaignId: string): void {
  recordRecon(env, `call_${outcome}`, campaignId);
}
