/**
 * Shared HTTP utilities for edge functions
 */

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Handle CORS preflight requests
 * Returns Response if it's an OPTIONS request, null otherwise
 */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS, status: 204 });
  }
  return null;
}

/**
 * Validate request method
 * Returns error Response if method doesn't match, null if valid
 */
export function validateMethod(req: Request, allowedMethod: string): Response | null {
  if (req.method !== allowedMethod) {
    return jsonError(`Method not allowed: ${req.method}`, 405);
  }
  return null;
}

/**
 * Create JSON response with CORS headers
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

/**
 * Create error response with CORS headers
 */
export function jsonError(error: string, status = 500, details?: unknown): Response {
  const body = details ? { error, details } : { error };
  return jsonResponse(body, status);
}
