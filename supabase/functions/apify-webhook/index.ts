import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import type { ApifyWebhookPayload, CacheStatus } from "../_shared/types.ts";
import { normalizeRecipe } from "../_shared/utils/openai.ts";
import { verifyWebhookSecret } from "../_shared/utils/apify.ts";

/**
 * POST /apify-webhook?key=VIDEO_ID&secret=WEBHOOK_SECRET
 *
 * Receives callback from Apify when TikTok scraping is complete.
 *
 * Flow:
 * 1. Verify webhook secret
 * 2. Extract key from query params
 * 3. Parse caption/transcript from payload
 * 4. Normalize with OpenAI
 * 5. Update cache table: PENDING → READY (or FAILED)
 */
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  console.log(`[${requestId}] ========== APIFY WEBHOOK ==========`);
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

  // Only allow POST
  if (req.method !== "POST") {
    console.log(`[${requestId}] ✗ Method not allowed: ${req.method}`);
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Verify webhook secret
    const webhookSecret = Deno.env.get("APIFY_WEBHOOK_SECRET");
    if (!webhookSecret) {
      console.error(`[${requestId}] ✗ Missing APIFY_WEBHOOK_SECRET`);
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isValidSecret = verifyWebhookSecret(req.url, webhookSecret);
    if (!isValidSecret) {
      console.error(`[${requestId}] ✗ Invalid webhook secret`);
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] ✓ Webhook secret verified`);

    // Extract key from query params
    const url = new URL(req.url);
    const key = url.searchParams.get("key");

    if (!key) {
      console.error(`[${requestId}] ✗ Missing 'key' query parameter`);
      return new Response(
        JSON.stringify({ error: "Missing 'key' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] Processing webhook for key: ${key}`);

    // Parse request body
    const payload: ApifyWebhookPayload = await req.json();
    console.log(`[${requestId}] Payload:`, {
      hasCaption: !!payload.caption,
      hasTranscript: !!payload.transcript,
      captionLength: payload.caption?.length,
      transcriptLength: payload.transcript?.length,
      actorRunId: payload.actorRunId,
    });

    // Validate we have at least caption or transcript
    if (!payload.caption && !payload.transcript) {
      console.error(`[${requestId}] ✗ No caption or transcript in payload`);

      // Initialize Supabase to update cache with error
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (supabaseUrl && supabaseServiceKey) {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        await supabase
          .from("cache")
          .upsert({
            key,
            status: "FAILED" as CacheStatus,
            error: {
              type: "apify_no_content",
              message: "Apify returned no caption or transcript",
            },
            meta: {
              actorRunId: payload.actorRunId,
              source_url: payload.source_url,
            },
          });
      }

      return new Response(
        JSON.stringify({ error: "No content to process" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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

    // Check if already processed (idempotency check)
    const { data: existing } = await supabase
      .from("cache")
      .select("status")
      .eq("key", key)
      .maybeSingle();

    if (existing?.status === "READY") {
      console.log(`[${requestId}] ✓ Already processed (status: READY) - skipping`);
      return new Response(
        JSON.stringify({ status: "already_processed", key }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get OpenAI API key
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      console.error(`[${requestId}] ✗ Missing OPENAI_API_KEY`);

      await supabase
        .from("cache")
        .upsert({
          key,
          status: "FAILED" as CacheStatus,
          error: {
            type: "config_error",
            message: "OpenAI API key not configured",
          },
        });

      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Normalize recipe with OpenAI
    console.log(`[${requestId}] Normalizing recipe with OpenAI...`);

    try {
      const normalizeResult = await normalizeRecipe(
        {
          caption: payload.caption,
          transcript: payload.transcript,
          source_url: payload.source_url || `https://www.tiktok.com/video/${key}`,
          video_id: key,
        },
        openaiKey
      );

      // Update cache as READY
      const { error: upsertError } = await supabase
        .from("cache")
        .upsert({
          key,
          status: "READY" as CacheStatus,
          value: normalizeResult.recipe,
          meta: {
            source_url: payload.source_url,
            caption: payload.caption,
            transcript: payload.transcript,
            actorRunId: payload.actorRunId,
            model: normalizeResult.model,
            source: "transcript",
            timings: {
              openai_ms: normalizeResult.elapsed_ms,
            },
          },
        });

      if (upsertError) {
        console.error(`[${requestId}] ✗ Error storing READY to cache:`, upsertError);
        throw new Error(`Database error: ${upsertError.message}`);
      }

      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Successfully processed webhook (${elapsed.toFixed(0)}ms)`);
      console.log(`[${requestId}] Recipe: ${normalizeResult.recipe.title}`);

      return new Response(
        JSON.stringify({
          status: "success",
          key,
          recipe_title: normalizeResult.recipe.title,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    } catch (openaiError) {
      console.error(`[${requestId}] ✗ OpenAI normalization failed:`, openaiError);

      // Store FAILED status
      await supabase
        .from("cache")
        .upsert({
          key,
          status: "FAILED" as CacheStatus,
          error: {
            type: "normalization_error",
            message: openaiError instanceof Error ? openaiError.message : "OpenAI normalization failed",
            raw: openaiError,
          },
          meta: {
            source_url: payload.source_url,
            caption: payload.caption,
            transcript: payload.transcript,
            actorRunId: payload.actorRunId,
          },
        });

      return new Response(
        JSON.stringify({
          error: "Normalization failed",
          message: openaiError instanceof Error ? openaiError.message : "Unknown error",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

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
