import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import type { ExtractRequest, ExtractResponse, CacheRow, CacheStatus } from "../_shared/types.ts";
import { extractTikTokVideoId, isValidTikTokUrl } from "../_shared/utils/tiktok.ts";
import { fetchOEmbed, extractCaption, shouldNormalizeFromCaption } from "../_shared/utils/oembed.ts";
import { normalizeRecipe } from "../_shared/utils/openai.ts";
import { triggerApifyActor, buildWebhookUrl } from "../_shared/utils/apify.ts";

/**
 * POST /extract
 *
 * Entry point for recipe extraction from TikTok URLs.
 *
 * Flow:
 * 1. Validate TikTok URL and extract video ID
 * 2. Check cache table for existing entry
 * 3. If cached READY → return immediately
 * 4. If cached PENDING → return status without re-triggering
 * 5. If not cached → try oEmbed caption path
 * 6. If caption looks like recipe → normalize with OpenAI → return READY
 * 7. Otherwise → trigger Apify for transcript → return PENDING
 */
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  console.log(`[${requestId}] ========== NEW REQUEST ==========`);
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
    // Parse request body
    const body: ExtractRequest = await req.json();
    console.log(`[${requestId}] Request body:`, body);

    if (!body.url) {
      console.log(`[${requestId}] ✗ Missing URL in request`);
      return new Response(
        JSON.stringify({ error: "Missing 'url' field in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Quick validation: is it a TikTok URL?
    if (!isValidTikTokUrl(body.url)) {
      console.log(`[${requestId}] ✗ Invalid TikTok URL: ${body.url}`);
      return new Response(
        JSON.stringify({
          error: "Invalid TikTok URL",
          message: "Please provide a valid TikTok video URL",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] ✓ Valid TikTok URL, fetching oEmbed for canonical ID`);

    // Fetch oEmbed data first to get canonical embed_product_id
    const oembedData = await fetchOEmbed(body.url);

    if (!oembedData) {
      console.log(`[${requestId}] ✗ Could not fetch oEmbed data for URL`);
      return new Response(
        JSON.stringify({
          error: "Invalid TikTok video",
          message: "Could not fetch video metadata from TikTok",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use embed_product_id as canonical key (handles URL variations)
    const videoId = oembedData.embed_product_id;
    if (!videoId) {
      console.log(`[${requestId}] ✗ No embed_product_id in oEmbed response`);
      return new Response(
        JSON.stringify({
          error: "Invalid video data",
          message: "TikTok video ID not found in response",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] ✓ Canonical video ID from oEmbed: ${videoId}`);

    // Initialize Supabase client with service role
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

    // Check cache
    console.log(`[${requestId}] Checking cache for key: ${videoId}`);
    const { data: cached, error: cacheError } = await supabase
      .from("cache")
      .select("*")
      .eq("key", videoId)
      .maybeSingle();

    if (cacheError) {
      console.error(`[${requestId}] ✗ Cache lookup error:`, cacheError);
      return new Response(
        JSON.stringify({ error: "Database error", details: cacheError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If cached and READY, return immediately
    if (cached && cached.status === "READY") {
      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Cache hit (READY) - returning cached recipe (${elapsed.toFixed(0)}ms)`);

      const response: ExtractResponse = {
        key: videoId,
        status: "READY",
        value: cached.value,
      };

      return new Response(
        JSON.stringify(response),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If cached and PENDING, return status (don't re-trigger)
    if (cached && cached.status === "PENDING") {
      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Cache hit (PENDING) - job already in progress (${elapsed.toFixed(0)}ms)`);

      const response: ExtractResponse = {
        key: videoId,
        status: "PENDING",
      };

      return new Response(
        JSON.stringify(response),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If cached and FAILED, return error (unless force=true)
    if (cached && cached.status === "FAILED" && !body.force) {
      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Cache hit (FAILED) - returning previous error (${elapsed.toFixed(0)}ms)`);

      const response: ExtractResponse = {
        key: videoId,
        status: "FAILED",
        error: cached.error,
      };

      return new Response(
        JSON.stringify(response),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cache miss or force refresh - use oEmbed data we already fetched
    console.log(`[${requestId}] Cache miss - processing oEmbed data`);

    const caption = extractCaption(oembedData);
    const author = oembedData.author_name;
    const thumbnailUrl = oembedData.thumbnail_url;

    // Try caption-based normalization if caption looks like a recipe
    if (caption && shouldNormalizeFromCaption(caption)) {
      console.log(`[${requestId}] Caption path: attempting immediate normalization`);

      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      if (!openaiKey) {
        console.error(`[${requestId}] ✗ Missing OPENAI_API_KEY`);
        return new Response(
          JSON.stringify({ error: "Server configuration error" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      try {
        const normalizeResult = await normalizeRecipe(
          {
            caption,
            source_url: body.url,
            video_id: videoId,
            author,
            author_url: oembedData.author_url,
            creator_handle: oembedData.author_unique_id,
            thumbnail_url: thumbnailUrl,
            thumbnail_width: oembedData.thumbnail_width,
            thumbnail_height: oembedData.thumbnail_height,
          },
          openaiKey
        );

        // Store in cache as READY
        const { error: upsertError } = await supabase
          .from("cache")
          .upsert({
            key: videoId,
            status: "READY" as CacheStatus,
            value: normalizeResult.recipe,
            meta: {
              source_url: body.url,
              caption,
              model: normalizeResult.model,
              source: "caption",
              timings: {
                openai_ms: normalizeResult.elapsed_ms,
              },
            },
          });

        if (upsertError) {
          console.error(`[${requestId}] ✗ Error storing to cache:`, upsertError);
        } else {
          console.log(`[${requestId}] ✓ Stored READY recipe to cache`);
        }

        const elapsed = performance.now() - startTime;
        console.log(`[${requestId}] ✓ Caption path successful - returning READY (${elapsed.toFixed(0)}ms)`);

        const response: ExtractResponse = {
          key: videoId,
          status: "READY",
          value: normalizeResult.recipe,
        };

        return new Response(
          JSON.stringify(response),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (openaiError) {
        console.error(`[${requestId}] ✗ OpenAI normalization failed:`, openaiError);
        // Fall through to Apify path
      }
    }

    // Transcript path: trigger Apify actor
    console.log(`[${requestId}] Transcript path: triggering Apify actor`);

    const apifyToken = Deno.env.get("APIFY_TOKEN");
    const apifyActorId = Deno.env.get("APIFY_TIKTOK_TRANSCRIPT_ACTOR_ID");
    const webhookSecret = Deno.env.get("APIFY_WEBHOOK_SECRET");

    console.log(`[${requestId}] Apify env vars check:`, {
      hasApifyToken: !!apifyToken,
      hasApifyActorId: !!apifyActorId,
      hasWebhookSecret: !!webhookSecret,
    });

    if (!apifyToken || !apifyActorId || !webhookSecret) {
      console.error(`[${requestId}] ✗ Missing Apify configuration:`, {
        APIFY_TOKEN: apifyToken ? "present" : "MISSING",
        APIFY_TIKTOK_TRANSCRIPT_ACTOR_ID: apifyActorId ? "present" : "MISSING",
        APIFY_WEBHOOK_SECRET: webhookSecret ? "present" : "MISSING",
      });
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build webhook URL
    const webhookUrl = buildWebhookUrl(supabaseUrl, videoId, webhookSecret);
    console.log(`[${requestId}] Webhook URL: ${webhookUrl}`);

    try {
      const apifyResult = await triggerApifyActor(
        {
          videoUrl: body.url,
          webhookUrl,
          key: videoId,
        },
        apifyToken,
        apifyActorId
      );

      // Store PENDING status in cache
      const { error: insertError } = await supabase
        .from("cache")
        .upsert({
          key: videoId,
          status: "PENDING" as CacheStatus,
          meta: {
            source_url: body.url,
            caption,
            actorRunId: apifyResult.actorRunId,
          },
        });

      if (insertError) {
        console.error(`[${requestId}] ✗ Error storing PENDING to cache:`, insertError);
      } else {
        console.log(`[${requestId}] ✓ Stored PENDING status to cache`);
      }

      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Apify actor triggered - returning PENDING (${elapsed.toFixed(0)}ms)`);

      const response: ExtractResponse = {
        key: videoId,
        status: "PENDING",
      };

      return new Response(
        JSON.stringify(response),
        { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (apifyError) {
      console.error(`[${requestId}] ✗ Apify trigger failed:`, apifyError);

      // Store FAILED status
      const { error: failError } = await supabase
        .from("cache")
        .upsert({
          key: videoId,
          status: "FAILED" as CacheStatus,
          error: {
            type: "apify_error",
            message: apifyError instanceof Error ? apifyError.message : "Failed to trigger Apify actor",
            raw: apifyError,
          },
          meta: {
            source_url: body.url,
            caption,
          },
        });

      if (failError) {
        console.error(`[${requestId}] ✗ Error storing FAILED to cache:`, failError);
      }

      return new Response(
        JSON.stringify({
          error: "Failed to start extraction",
          message: apifyError instanceof Error ? apifyError.message : "Unknown error",
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
