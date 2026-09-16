import type { ImpressionRecord, MatchGate, MatchResult } from "../types";

/**
 * Pure matching/scoring logic (no platform deps) so it is unit-testable.
 *
 * Inputs are the recent impressions for a single creative within the window,
 * plus the call time and the caller's coarse geo (state/postal derived from the
 * area code, which is a SOFT signal — number portability/mobile makes it
 * unreliable, so geo nudges the score rather than gating the match).
 *
 * We pick ONE best candidate (per product decision) and attach a confidence in
 * [0,1] combining three factors:
 *   - candidate scarcity: fewer candidates in-window => more confident it's them
 *   - time proximity:     closer to the call => more confident
 *   - geo agreement:      impression geo aligning with caller geo => bonus
 */

export interface ScoreWeights {
  scarcity: number;
  time: number;
  geo: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = { scarcity: 0.5, time: 0.3, geo: 0.2 };

/**
 * Default gate for sending device identifiers to a conversion API.
 *
 * NOTE ON INTERPRETATION: `confidence` is a *ranking heuristic*, not a
 * probability. Its additive time and geo terms act as floors, so a weak match
 * plateaus near 0.5 instead of decaying toward 0 — do not read 0.5 as "50%
 * likely to be the right device". See docs/ATTRIBUTION.md §6.
 *
 * Both bounds are enforced and the stricter one applies:
 *   - MIN_MATCH_CONFIDENCE is the practical control. With the default weights
 *     it permits roughly 3 candidates when the caller's state agrees with the
 *     impression, fewer when geo is unknown or disagrees.
 *   - MAX_MATCH_CANDIDATES is a hard, weight-independent backstop, so that
 *     re-tuning `ScoreWeights` later cannot silently widen the gate.
 */
export const DEFAULT_MIN_MATCH_CONFIDENCE = 0.6;
export const DEFAULT_MAX_MATCH_CANDIDATES = 10;

/** Scarcity factor: 1 candidate -> 1.0, decays as candidates grow. */
function scarcityScore(n: number): number {
  if (n <= 1) return 1;
  return 1 / Math.log2(n + 1); // 2->0.63, 4->0.43, 16->0.24
}

/** Time factor: linear from 1.0 at the call instant to 0 at window edge. */
function timeScore(impTs: number, callTs: number, windowSec: number): number {
  const age = Math.max(0, callTs - impTs);
  if (age > windowSec) return 0;
  return 1 - age / windowSec;
}

/** Geo factor: postal match best, then state match, else neutral 0.5. */
function geoScore(
  imp: ImpressionRecord,
  callerState: string,
  callerPostal: string,
): number {
  if (callerPostal && imp.postal && imp.postal === callerPostal) return 1;
  if (callerState && imp.region && imp.region.toUpperCase() === callerState.toUpperCase())
    return 0.8;
  if (!callerState && !callerPostal) return 0.5; // unknown caller geo: neutral
  return 0.2; // geo present but disagreeing: mild penalty, not disqualifying
}

export function scoreOne(
  imp: ImpressionRecord,
  callTs: number,
  windowSec: number,
  candidateCount: number,
  callerState: string,
  callerPostal: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): number {
  const s =
    weights.scarcity * scarcityScore(candidateCount) +
    weights.time * timeScore(imp.ts, callTs, windowSec) +
    weights.geo * geoScore(imp, callerState, callerPostal);
  return Math.max(0, Math.min(1, s));
}

/**
 * Decide whether a match is strong enough to send device identifiers.
 *
 * Two independent bounds: a confidence floor and a candidate ceiling. Either
 * one failing downgrades the call to phone-only attribution.
 */
export function gateForDeviceIds(
  matched: boolean,
  confidence: number,
  candidateCount: number,
  minConfidence = DEFAULT_MIN_MATCH_CONFIDENCE,
  maxCandidates = DEFAULT_MAX_MATCH_CANDIDATES,
): { deviceIds: boolean; gate: MatchGate } {
  if (!matched) return { deviceIds: false, gate: "no_match" };
  if (candidateCount > maxCandidates) {
    return { deviceIds: false, gate: "too_many_candidates" };
  }
  if (confidence < minConfidence) {
    return { deviceIds: false, gate: "low_confidence" };
  }
  return { deviceIds: true, gate: "ok" };
}

export function scoreCandidates(
  candidates: ImpressionRecord[],
  callTs: number,
  windowMin: number,
  callerState: string,
  callerPostal: string,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  minConfidence = DEFAULT_MIN_MATCH_CONFIDENCE,
  maxCandidates = DEFAULT_MAX_MATCH_CANDIDATES,
): MatchResult {
  const windowSec = windowMin * 60;
  const inWindow = candidates.filter(
    (c) => c.ts <= callTs && callTs - c.ts <= windowSec,
  );

  if (inWindow.length === 0) {
    return {
      matched: false,
      best: null,
      candidateCount: 0,
      confidence: 0,
      deviceIds: false,
      gate: "no_match",
    };
  }

  // Prefer geo-agreeing candidates when caller geo is known: rank by score, and
  // on ties prefer the most recent impression.
  let best = inWindow[0];
  let bestScore = -1;
  for (const c of inWindow) {
    const sc = scoreOne(
      c,
      callTs,
      windowSec,
      inWindow.length,
      callerState,
      callerPostal,
      weights,
    );
    if (sc > bestScore || (sc === bestScore && c.ts > best.ts)) {
      best = c;
      bestScore = sc;
    }
  }

  const confidence = Number(bestScore.toFixed(4));
  const { deviceIds, gate } = gateForDeviceIds(
    true,
    confidence,
    inWindow.length,
    minConfidence,
    maxCandidates,
  );

  return {
    matched: true,
    best,
    candidateCount: inWindow.length,
    confidence,
    deviceIds,
    gate,
  };
}
