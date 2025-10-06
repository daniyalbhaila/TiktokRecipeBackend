import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import type { ExtractResponse } from "../_shared/types.ts";

/**
 * GET /result?key=VIDEO_ID
 *
 * Returns the current status and recipe (if ready) for a given TikTok video.
 *
 * This is a read-only polling endpoint for clients to check job status.
 *
 * Response states:
 * - READY: Recipe is complete, returns full recipe object
 * - PENDING: Still processing (Apify or normalization in progress)
 * - FAILED: Processing failed, returns error details
 * - NOT_FOUND: No job found for this key
 */
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  console.log(`[${requestId}] ========== RESULT REQUEST ==========`);
  console.log(`[${requestId}] Method: ${req.method}, URL: ${req.url}`);

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  // Handle OPTIONS for CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  // Only allow GET
  if (req.method !== "GET") {
    console.log(`[${requestId}] ✗ Method not allowed: ${req.method}`);
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Extract key from query params
    const url = new URL(req.url);
    const key = url.searchParams.get("key");

    if (!key) {
      console.log(`[${requestId}] ✗ Missing 'key' query parameter`);
      return new Response(
        JSON.stringify({ error: "Missing 'key' query parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] Fetching result for key: ${key}`);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error(`[${requestId}] ✗ Missing Supabase credentials`);
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Query cache table
    const { data: cached, error: cacheError } = await supabase
      .from("cache")
      .select("*")
      .eq("key", key)
      .maybeSingle();

    if (cacheError) {
      console.error(`[${requestId}] ✗ Database error:`, cacheError);
      return new Response(
        JSON.stringify({ error: "Database error", details: cacheError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const elapsed = performance.now() - startTime;

    // No entry found
    if (!cached) {
      console.log(`[${requestId}] ✗ No entry found for key (${elapsed.toFixed(0)}ms)`);

      const response: ExtractResponse = {
        key,
        status: "FAILED",
        error: {
          type: "not_found",
          message: "No recipe found for this key. Did you call /extract first?",
        },
      };

      return new Response(
        JSON.stringify(response),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build response based on status
    const response: ExtractResponse = {
      key,
      status: cached.status,
    };

    if (cached.status === "READY" && cached.value) {
      response.value = cached.value;
      console.log(`[${requestId}] ✓ READY - returning recipe (${elapsed.toFixed(0)}ms)`);
    } else if (cached.status === "PENDING") {
      console.log(`[${requestId}] ✓ PENDING - job in progress (${elapsed.toFixed(0)}ms)`);
    } else if (cached.status === "FAILED" && cached.error) {
      response.error = cached.error;
      console.log(`[${requestId}] ✓ FAILED - returning error (${elapsed.toFixed(0)}ms)`);
    }

    // Determine HTTP status code
    let statusCode = 200;
    if (cached.status === "PENDING") {
      statusCode = 202; // Accepted (processing)
    } else if (cached.status === "FAILED") {
      statusCode = 200; // Still 200, but with error in body (client can handle)
    }

    return new Response(
      JSON.stringify(response),
      {
        status: statusCode,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[${requestId}] ✗ Unhandled error after ${elapsed.toFixed(0)}ms:`, error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
