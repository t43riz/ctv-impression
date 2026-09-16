import { describe, it, expect } from "vitest";
import { recordRecon, recordCallOutcome, terminalOutcomeRecorder } from "../src/lib/recon";
import type { Env } from "../src/types";
import { fakeAnalytics, type FakeAnalytics } from "./helpers/fakes";

const envWith = (recon: FakeAnalytics) => ({ RECON: recon }) as unknown as Env;

const outcomes = (recon: FakeAnalytics) => recon.points.map((p) => p.blobs?.[0] ?? "");

describe("terminalOutcomeRecorder", () => {
  it("records only the first terminal outcome for a request", () => {
    // The ledger invariant the health check gates on: exactly one terminal row
    // per beacon. Without this guard a failure after counting emits both
    // `counted` and `reject_internal`, over-credits an outcome, and leaves
    // received === accounted false in a way the health check cannot attribute.
    const recon = fakeAnalytics();
    const end = terminalOutcomeRecorder(envWith(recon));

    expect(end("counted", "camp1")).toBe(true);
    expect(end("reject_internal", "camp1")).toBe(false);
    expect(end("duplicate", "camp1")).toBe(false);

    expect(outcomes(recon)).toEqual(["counted"]);
  });

  it("keeps the campaign of the outcome that actually happened", () => {
    const recon = fakeAnalytics();
    const end = terminalOutcomeRecorder(envWith(recon));

    end("reject_rate_limited", "camp7");
    end("counted", "camp1");

    expect(recon.points[0].blobs?.[1]).toBe("camp7");
    expect(recon.points).toHaveLength(1);
  });

  it("scopes the guard to one request, not the process", () => {
    // Two beacons are two ledgers. A module-level flag would suppress the
    // second beacon's outcome entirely and freeze the health check's view of
    // the world after the first request.
    const recon = fakeAnalytics();
    const env = envWith(recon);

    terminalOutcomeRecorder(env)("counted", "camp1");
    terminalOutcomeRecorder(env)("counted", "camp1");

    expect(outcomes(recon)).toEqual(["counted", "counted"]);
  });
});

describe("recordRecon", () => {
  it("uses the campaign id as the Analytics Engine index", () => {
    const recon = fakeAnalytics();
    recordRecon(envWith(recon), "counted", "camp1");
    expect(recon.points[0]).toEqual({
      blobs: ["counted", "camp1"],
      doubles: [1],
      indexes: ["camp1"],
    });
  });

  it("never throws when the Analytics Engine write fails", () => {
    // Called from the ingest path *and* that path's error handler, so a throw
    // here would convert a handled failure into an unhandled rejection inside
    // waitUntil — losing the beacon and its outcome row.
    const recon = fakeAnalytics();
    recon.failWith(new Error("analytics engine down"));

    expect(() => recordRecon(envWith(recon), "counted", "camp1")).not.toThrow();
    expect(() => terminalOutcomeRecorder(envWith(recon))("counted", "camp1")).not.toThrow();
  });

  it("namespaces call outcomes so the two populations stay separable", () => {
    const recon = fakeAnalytics();
    recordCallOutcome(envWith(recon), "fired", "camp1");
    recordCallOutcome(envWith(recon), "not_qualified", "camp1");
    expect(outcomes(recon)).toEqual(["call_fired", "call_not_qualified"]);
  });
});
