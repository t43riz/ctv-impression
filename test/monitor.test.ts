import { describe, it, expect } from "vitest";
import { computeReconHealth, reconHealthOptions, checkExportFreshness } from "../src/monitor";
import type { ReconRow } from "../src/query";
import type { Env } from "../src/types";
import { fakeR2 } from "./helpers/fakes";

const rows = (...pairs: [string, number][]): ReconRow[] =>
  pairs.map(([outcome, events]) => ({ outcome, events }));

describe("computeReconHealth", () => {
  it("does not treat duplicates as failures", () => {
    // A 90% duplicate share is ordinary for CTV under a 24h dedup window, not a
    // fault. Scoring it as failure made this metric alarm on healthy traffic.
    const h = computeReconHealth(
      rows(["received", 1000], ["counted", 100], ["duplicate", 900]),
    );
    expect(h.counted).toBe(100);
    expect(h.duplicates).toBe(900);
    expect(h.unexpected).toBe(0);
    expect(h.countedRatio).toBeCloseTo(0.1);
    expect(h.healthy).toBe(true);
  });

  it("fails on a single scheduled-job alert regardless of beacon volume", () => {
    // A cron alert fires at most once per run, so against a day of healthy
    // beacon traffic its ratio rounds to ~0 and clears any sane ceiling — while
    // the only durable record of that day was never written. Gate on the count.
    const h = computeReconHealth(
      rows(["received", 1_000_000], ["counted", 1_000_000], ["alert_export_failed", 1]),
    );
    expect(h.infraAlerts).toBe(1);
    expect(h.alertRatio).toBeLessThan(0.01); // would have passed the ratio gate
    expect(h.healthy).toBe(false);
  });

  it("fails on a failed health check for the same reason", () => {
    const h = computeReconHealth(
      rows(["received", 500_000], ["counted", 500_000], ["alert_health_check_failed", 1]),
    );
    expect(h.infraAlerts).toBe(1);
    expect(h.healthy).toBe(false);
  });

  it("fails when the health artifact itself could not be written", () => {
    // R2 refusing the artifact cannot be reported inside the artifact, so the
    // ledger is the only place left to see it.
    const h = computeReconHealth(rows(["alert_health_write_failed", 1]));
    expect(h.infraAlerts).toBe(1);
    expect(h.healthy).toBe(false);
  });

  it("does not treat per-beacon alerts as scheduled-job failures", () => {
    // alert_raw_write_error is best-effort and proportional to traffic, so it
    // stays on the ratio gate rather than failing the first occurrence.
    const h = computeReconHealth(
      rows(["received", 1000], ["counted", 1000], ["alert_raw_write_error", 1]),
    );
    expect(h.infraAlerts).toBe(0);
    expect(h.healthy).toBe(true);
  });

  it("counts a /call budget refusal as a conversion-path rejection", () => {
    const h = computeReconHealth(rows(["call_rate_limited", 10]));
    expect(h.callRejections).toBe(10);
    expect(h.callRejectRatio).toBe(1);
    expect(h.healthy).toBe(false);
  });

  it("tracks rejects separately instead of folding them into the counted ratio", () => {
    const h = computeReconHealth(
      rows(
        ["received", 100],
        ["counted", 60],
        ["duplicate", 20],
        ["reject_not_allowlisted", 20],
      ),
    );
    expect(h.rejects).toBe(20);
    expect(h.rejectRatio).toBeCloseTo(0.2);
    expect(h.countedRatio).toBeCloseTo(0.6);
    expect(h.healthy).toBe(true);
  });

  it("flags beacons that produced no terminal outcome", () => {
    const h = computeReconHealth(rows(["received", 100], ["counted", 80]));
    expect(h.unexpected).toBe(20);
    expect(h.countedRatio).toBeCloseTo(0.8);
    expect(h.healthy).toBe(false);
  });

  it("flags a ledger that over-accounts (a beacon recorded twice)", () => {
    // The single-terminal-outcome guard exists to prevent this; if it ever
    // regresses the ledger closes past `received` and only the exact equality
    // catches it.
    const h = computeReconHealth(rows(["received", 10], ["counted", 10], ["duplicate", 3]));
    expect(h.unexpected).toBe(0);
    expect(h.healthy).toBe(false);
  });

  it("flags unhandled ingest errors", () => {
    const h = computeReconHealth(
      rows(
        ["received", 100],
        ["counted", 90],
        ["reject_internal", 5],
        ["reject_not_allowlisted", 5],
      ),
    );
    expect(h.internalErrors).toBe(5);
    expect(h.unexpected).toBe(0);
    expect(h.healthy).toBe(false);
  });

  it("flags a reject storm", () => {
    const h = computeReconHealth(
      rows(["received", 100], ["counted", 1], ["reject_bad_signature", 99]),
    );
    expect(h.rejectRatio).toBeCloseTo(0.99);
    expect(h.healthy).toBe(false);
  });

  it("flags raw-tier write failures without unbalancing the ledger", () => {
    const h = computeReconHealth(
      rows(["received", 10], ["counted", 10], ["alert_raw_write_error", 3]),
    );
    expect(h.alerts).toBe(3);
    expect(h.unexpected).toBe(0);
    expect(h.countedRatio).toBe(1);
    expect(h.healthy).toBe(false);
  });

  it("tolerates a small absolute alert rate instead of paging on one blip", () => {
    // A single transient R2 error in a 24h window used to flip health to red
    // for the whole day, which is how an alert gets muted.
    const h = computeReconHealth(
      rows(["received", 10_000], ["counted", 10_000], ["alert_raw_write_error", 1]),
    );
    expect(h.alerts).toBe(1);
    expect(h.healthy).toBe(true);
  });

  it("still trips on a sustained alert rate", () => {
    const h = computeReconHealth(
      rows(["received", 1_000], ["counted", 1_000], ["alert_recent_write_error", 100]),
    );
    expect(h.healthy).toBe(false);
  });

  it("reports call outcomes without disturbing the beacon ledger", () => {
    const h = computeReconHealth(
      rows(["received", 10], ["counted", 10], ["call_fired", 5]),
    );
    expect(h.callFired).toBe(5);
    expect(h.callSkipped).toBe(0);
    expect(h.callAttempts).toBe(5);
    expect(h.healthy).toBe(true);
  });

  it("surfaces an all-skipped conversion path", () => {
    // A placeholder event group or an unconfigured UA endpoint never sends
    // anything, and the conversion path has no other observability.
    const h = computeReconHealth(
      rows(["received", 10], ["counted", 10], ["call_skipped", 7]),
    );
    expect(h.callSkipped).toBe(7);
    expect(h.callFired).toBe(0);
    expect(h.callErrors).toBe(0);
    expect(h.healthy).toBe(true); // reported, not gated: test mode is intentional
  });

  it("trips when most conversion sends fail, even with no beacon traffic", () => {
    // The two populations are independent: an idle pixel path must not mask a
    // failing conversion path.
    const h = computeReconHealth(rows(["call_fired", 1], ["call_internal_error", 3]));
    expect(h.callFired).toBe(1);
    expect(h.callErrors).toBe(3);
    expect(h.callAttempts).toBe(4);
    expect(h.healthy).toBe(false);
  });

  it("stays healthy when a minority of conversion sends fail", () => {
    const h = computeReconHealth(rows(["call_fired", 9], ["call_capi_error", 1]));
    expect(h.callAttempts).toBe(10);
    expect(h.healthy).toBe(true);
  });

  it("does not count a test-mode send as a delivered conversion", () => {
    // CAPI_MODE=test is validated by the platform but delivers nothing. Folding
    // it into call_fired made a Worker left on test mode look like a healthy,
    // fully-delivered conversion path.
    const h = computeReconHealth(rows(["call_dry_run", 9], ["call_fired", 1]));
    expect(h.callFired).toBe(1);
    expect(h.callDryRun).toBe(9);
    expect(h.callAttempts).toBe(10);
    expect(h.healthy).toBe(true); // a dry run is not a failure
  });

  it("trips when every call is refused before a send is attempted", () => {
    // Each of these is how a broken integration presents itself: a wrong shared
    // HMAC key (unauthorized), a stale number registry (unknown number), a PBX
    // sending a payload that fails validation (bad request), a mis-set duration
    // threshold (not qualified), a corrupt registry entry, or a placeholder
    // signing key. Counting only send failures left all of them green.
    const refusals = [
      "call_unauthorized",
      "call_unknown_number",
      "call_bad_request",
      "call_not_qualified",
      "call_bad_number_mapping",
      "call_not_configured",
    ];
    for (const outcome of refusals) {
      const h = computeReconHealth(rows([outcome, 10]));
      expect(h.callRejections, outcome).toBe(10);
      expect(h.callRejectRatio, outcome).toBe(1);
      expect(h.healthy, outcome).toBe(false);
    }
  });

  it("does not gate on absorbed replays or an intentionally skipped path", () => {
    // `duplicate` is the idempotency claim working; `skipped` is a dry-run or an
    // unconfigured platform client. Neither is a failure.
    const h = computeReconHealth(rows(["call_duplicate", 9], ["call_skipped", 1]));
    expect(h.callDuplicates).toBe(9);
    expect(h.callSkipped).toBe(1);
    expect(h.callAttempts).toBe(10);
    expect(h.healthy).toBe(true);
  });

  it("honours a configurable call-reject ceiling", () => {
    const refusal = rows(["call_fired", 1], ["call_not_qualified", 9]);
    expect(computeReconHealth(refusal).healthy).toBe(false);
    expect(computeReconHealth(refusal, { maxCallRejectRatio: 0.95 }).healthy).toBe(true);
  });

  it("reports alerts as a full-rate failure when no beacon ever arrived", () => {
    // `received === 0` with alerts is not a quiet healthy hour: the alert
    // outcomes can only be produced by a path that got past `received`, so this
    // state means the ledger itself is missing rows. Reporting 0 made it
    // invisible.
    const h = computeReconHealth(rows(["alert_raw_write_error", 2]));
    expect(h.alerts).toBe(2);
    expect(h.alertRatio).toBe(1);
    expect(h.healthy).toBe(false);
  });

  it("treats the kill switch as accounted, not as failure", () => {
    const h = computeReconHealth(rows(["received", 100], ["disabled", 100]));
    expect(h.disabled).toBe(100);
    expect(h.unexpected).toBe(0);
    expect(h.healthy).toBe(true);
  });

  it("counts rate-limited beacons as rejects", () => {
    const h = computeReconHealth(
      rows(["received", 100], ["counted", 40], ["reject_rate_limited", 60]),
    );
    expect(h.rejects).toBe(60);
    expect(h.healthy).toBe(false); // reject storm threshold
  });

  it("is healthy with no traffic", () => {
    const h = computeReconHealth([]);
    expect(h.received).toBe(0);
    expect(h.healthy).toBe(true);
  });

  it("honours a configurable reject ceiling", () => {
    const storm = rows(["received", 100], ["counted", 1], ["reject_bad_signature", 99]);
    expect(computeReconHealth(storm).healthy).toBe(false);
    expect(computeReconHealth(storm, { maxRejectRatio: 0.995 }).healthy).toBe(true);
  });

  it("does not gate health on the counted/received throughput ratio", () => {
    // A 40% duplicate share is ordinary CTV traffic; a ledger that closes is
    // healthy however low counted/received lands.
    const closed = rows(["received", 100], ["counted", 60], ["duplicate", 40]);
    expect(computeReconHealth(closed).countedRatio).toBeCloseTo(0.6);
    expect(computeReconHealth(closed).healthy).toBe(true);
  });
});

describe("reconHealthOptions", () => {
  const env = (over: Record<string, string>) => over as unknown as Env;

  it("falls back to the documented defaults", () => {
    expect(reconHealthOptions(env({}))).toEqual({
      maxRejectRatio: 0.5,
      maxAlertRatio: 0.01,
      maxCallErrorRatio: 0.5,
      maxCallRejectRatio: 0.5,
    });
  });

  it("reads an override and ignores a blank or unparseable one", () => {
    const o = reconHealthOptions(
      env({
        HEALTH_MAX_ALERT_RATIO: "0.2",
        HEALTH_MAX_REJECT_RATIO: "",
        HEALTH_MAX_CALL_REJECT_RATIO: "not-a-number",
      }),
    );
    expect(o.maxAlertRatio).toBe(0.2);
    // Blank must not parse as 0: a 0 ceiling would alert on any reject at all.
    expect(o.maxRejectRatio).toBe(0.5);
    expect(o.maxCallRejectRatio).toBe(0.5);
  });

  it("clamps an out-of-range ratio into [0, 1]", () => {
    const o = reconHealthOptions(env({ HEALTH_MAX_ALERT_RATIO: "5", HEALTH_MAX_CALL_ERROR_RATIO: "-1" }));
    expect(o.maxAlertRatio).toBe(1);
    expect(o.maxCallErrorRatio).toBe(0);
  });
});

describe("checkExportFreshness", () => {
  /** 2026-09-15T03:00:00Z, i.e. just after the nightly run. */
  const NOW = Date.UTC(2026, 8, 15, 3, 0);
  const tsAt = (iso: string) => new Date(iso).toISOString();

  const withMarker = async (marker: object | null) => {
    const archive = fakeR2();
    if (marker !== null) {
      await archive.put("_status/last_export.json", JSON.stringify(marker));
    }
    return checkExportFreshness({ ARCHIVE: archive } as unknown as Env, 26, NOW);
  };

  it("is fresh when the marker is recent and for the expected day", async () => {
    const f = await withMarker({ date: "2026-09-14", ts: tsAt("2026-09-15T02:00:00Z"), rows: 12 });
    expect(f.fresh).toBe(true);
    expect(f.lastDate).toBe("2026-09-14");
    expect(f.expectedDate).toBe("2026-09-14");
    expect(f.rows).toBe(12);
  });

  it("accepts the day before, for a check that runs before 02:00", async () => {
    // At 01:00 the newest legitimate marker is the one the previous run wrote,
    // which covers the day before that.
    const f = await withMarker({ date: "2026-09-13", ts: tsAt("2026-09-14T02:00:00Z") });
    expect(f.fresh).toBe(true);
    expect(f.ageHours).toBeCloseTo(25);
  });

  it("is not fresh when a fresh marker describes a stale day", async () => {
    // A backfill rewrites this marker for whatever date it was asked to export,
    // so the ts can be seconds old while the daily job has been dead for weeks.
    // An age-only check called that healthy.
    const f = await withMarker({ date: "2026-08-15", ts: tsAt("2026-09-15T02:59:00Z") });
    expect(f.lastDate).toBe("2026-08-15");
    expect(f.fresh).toBe(false);
  });

  it("is not fresh when the marker is older than the ceiling", async () => {
    const f = await withMarker({ date: "2026-09-14", ts: tsAt("2026-09-13T02:00:00Z") });
    expect(f.ageHours).toBeCloseTo(49);
    expect(f.fresh).toBe(false);
  });

  it("is not fresh when no marker was ever written", async () => {
    const f = await withMarker(null);
    expect(f.fresh).toBe(false);
    expect(f.lastDate).toBeNull();
    expect(f.rows).toBeNull();
  });
});
