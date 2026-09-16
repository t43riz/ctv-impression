import { AREA_CODE_STATE } from "./areacodes";

/**
 * Phone normalization + hashing per Roku CAPI rules:
 *   - remove all special chars including "+" and "-"
 *   - remove leading zeros
 *   - trim whitespace
 *   - SHA-256, lowercase hex (NOT base64)
 *
 * For US numbers the normalized form includes the country code "1"
 * (e.g. "+1 (415) 555-0142" -> "14155550142").
 */
const encoder = new TextEncoder();

export function normalizePhone(raw: string): string {
  let digits = (raw ?? "").replace(/[^0-9]/g, "");
  digits = digits.replace(/^0+/, "");
  return digits;
}

export async function hashPhone(raw: string): Promise<string> {
  const normalized = normalizePhone(raw);
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(normalized));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Best-effort caller geo from a North American number's area code (NANP).
 * SOFT signal only — mobile portability means this is approximate; it nudges
 * the match score, never gates it. Returns "" when not derivable.
 */
export function areaCodeToState(ani: string): string {
  const d = normalizePhone(ani);
  // Strip leading US country code if present (11 digits starting with 1).
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length < 3) return "";
  const npa = ten.slice(0, 3);
  return AREA_CODE_STATE[npa] ?? "";
}
