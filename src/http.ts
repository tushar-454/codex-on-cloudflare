/** OpenAI-style JSON error responses. Never include stack traces or secrets. */

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers },
  });
}

export function errorResponse(err: HttpError): Response {
  return jsonResponse(
    { error: { message: err.message, type: err.type, code: err.code, param: err.param } },
    err.status,
    err.headers,
  );
}

export function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Read the request body with a hard byte cap, without trusting Content-Length alone
 * (chunked bodies have none). Aborts reading as soon as the cap is exceeded.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "invalid_request_error", "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
  }
  const encoding = (request.headers.get("Content-Encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity") {
    throw new HttpError(415, "invalid_request_error", "unsupported_content_encoding", `Unsupported Content-Encoding '${encoding}'.`);
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "invalid_request_error", "request_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
