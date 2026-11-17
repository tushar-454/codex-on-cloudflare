/**
 * Bearer-token authentication against the SNOWY_API_KEY Wrangler secret.
 *
 * - No secret configured  -> every request is rejected (no empty-token bypass).
 * - Tokens are compared via SHA-256 digests + crypto.subtle.timingSafeEqual, so the
 *   comparison is constant-time and does not leak the secret's length.
 * - The secret is never logged or echoed back.
 */

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; code: string; message: string };

const MIN_SECRET_LENGTH = 16;
const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export async function authenticate(request: Request, secret: string | undefined): Promise<AuthResult> {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      status: 500,
      code: "server_misconfigured",
      message: "Server authentication is not configured.",
    };
  }

  const header = request.headers.get("Authorization");
  if (header === null) {
    return { ok: false, status: 401, code: "missing_api_key", message: "Missing Authorization header." };
  }

  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header.trim());
  if (match === null || match[1] === undefined) {
    return {
      ok: false,
      status: 401,
      code: "invalid_api_key",
      message: "Malformed Authorization header; expected 'Bearer <token>'.",
    };
  }

  if (!(await tokensEqual(match[1], secret.trim()))) {
    return { ok: false, status: 401, code: "invalid_api_key", message: "Incorrect API key provided." };
  }
  return { ok: true };
}
