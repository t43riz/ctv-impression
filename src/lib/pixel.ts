/**
 * 1x1 transparent GIF served without Node Buffer.
 * Decoded once at module load into a Uint8Array.
 */
const GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const PIXEL_BYTES = base64ToBytes(GIF_BASE64);

const PIXEL_HEADERS: Record<string, string> = {
  "Content-Type": "image/gif",
  "Cache-Control": "no-cache, no-store, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
};

/**
 * Always return the pixel — we never reveal validation/auth outcome to the
 * client (a beacon that 404s would let an attacker probe which params count).
 */
export function pixelResponse(): Response {
  return new Response(PIXEL_BYTES, { status: 200, headers: PIXEL_HEADERS });
}
