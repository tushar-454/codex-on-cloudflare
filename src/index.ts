/**
 * SNOWy: an OpenAI Responses API-compatible proxy that lets the unmodified Codex CLI
 * use Cloudflare Workers AI models through the AI binding.
 *
 * Routes:
 *   GET  /health        -> {"status":"ok"} (no auth, no details)
 *   GET  /v1/models     -> registered models (auth)
 *   POST /v1/responses  -> Responses API, streaming (SSE) or JSON (auth)
 */

import { authenticate } from "./auth";
import { errorResponse, HttpError, jsonResponse, readBodyLimited } from "./http";
import { handleResponses } from "./inference";
import { listModels } from "./responses";

const DEFAULT_MAX_BODY_BYTES = 4_000_000;

const ROUTES: Record<string, readonly string[]> = {
  "/health": ["GET", "HEAD"],
  "/v1/models": ["GET"],
  "/v1/responses": ["POST"],
};

export interface SnowyEnv {
  AI: Pick<Ai, "run">;
  SNOWY_API_KEY?: string;
  RATE_LIMITER?: Pick<RateLimit, "limit">;
  MAX_BODY_BYTES?: string;
  DEFAULT_MODEL?: string;
}

export async function handleRequest(request: Request, env: SnowyEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const allowed = ROUTES[path];
  if (allowed === undefined) {
    throw new HttpError(404, "not_found_error", "not_found", "Not found.");
  }
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, "invalid_request_error", "method_not_allowed", `Method ${request.method} not allowed.`, null, {
      Allow: allowed.join(", "),
    });
  }

  if (path === "/health") {
    return jsonResponse({ status: "ok" });
  }

  const auth = await authenticate(request, env.SNOWY_API_KEY);
  if (!auth.ok) {
    if (auth.status === 500) console.error("SNOWY_API_KEY secret is not configured (or too short).");
    throw new HttpError(auth.status, auth.status === 401 ? "authentication_error" : "server_error", auth.code, auth.message);
  }

  // Abuse protection: rate limit per client IP *after* auth so unauthenticated floods
  // cannot exhaust the legitimate user's quota. (Cloudflare WAF rules handle the rest.)
  if (env.RATE_LIMITER !== undefined) {
    const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) {
      throw new HttpError(429, "rate_limit_error", "rate_limit_exceeded", "Rate limit exceeded. Please try again in 60s.", null, {
        "Retry-After": "60",
      });
    }
  }

  if (path === "/v1/models") {
    return jsonResponse(listModels());
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    throw new HttpError(415, "invalid_request_error", "unsupported_media_type", "Content-Type must be application/json.");
  }
  const maxBytes = Number(env.MAX_BODY_BYTES) > 0 ? Number(env.MAX_BODY_BYTES) : DEFAULT_MAX_BODY_BYTES;
  const raw = await readBodyLimited(request, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_request_error", "invalid_json", "Request body is not valid JSON.");
  }
  return handleResponses(body, env, request.signal);
}

export default {
  async fetch(request: Request, env: SnowyEnv): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        // Error metadata only (never request content or credentials).
        if (err.status !== 401 && err.status !== 404) console.warn(`snowy error ${err.status} ${err.code}: ${err.message.slice(0, 300)}`);
        return errorResponse(err);
      }
      console.error("Unhandled error:", err instanceof Error ? err.name : typeof err);
      return errorResponse(new HttpError(500, "server_error", "internal_error", "Internal server error."));
    }
  },
} satisfies ExportedHandler<SnowyEnv>;
