import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import type { ApifyWebhookPayload, CacheMeta, CacheStatus } from "../_shared/types.ts";
import { normalizeRecipe } from "../_shared/utils/openai.ts";
import { verifyWebhookSecret } from "../_shared/utils/apify.ts";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

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

    // Parse request body
    const payload: ApifyWebhookPayload = await req.json();
    console.log(`[${requestId}] Webhook payload:`, {
      datasetId: payload.datasetId,
      actorRunId: payload.actorRunId,
    });
    console.log(`[${requestId}] Full payload:`, JSON.stringify(payload));

    // Fetch dataset results from Apify
    const apifyToken = Deno.env.get("APIFY_TOKEN");
    if (!apifyToken) {
      console.error(`[${requestId}] ✗ Missing APIFY_TOKEN`);
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Try to get dataset ID from payload first (recommended way)
    let datasetId = payload.datasetId;

    // Fallback: fetch from actor run if not in payload
    if (!datasetId) {
      if (!payload.actorRunId) {
        console.error(`[${requestId}] ✗ No datasetId or actorRunId in webhook payload`);
        return new Response(
          JSON.stringify({ error: "Missing datasetId and actorRunId" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[${requestId}] No datasetId in payload, fetching from actor run: ${payload.actorRunId}`);
      const runUrl = `https://api.apify.com/v2/actor-runs/${payload.actorRunId}?token=${apifyToken}`;
      const runResponse = await fetch(runUrl);

      if (!runResponse.ok) {
        const errorText = await runResponse.text();
        console.error(`[${requestId}] ✗ Failed to fetch actor run: ${runResponse.status}`);
        console.error(`[${requestId}] Error:`, errorText);
        return new Response(
          JSON.stringify({ error: "Failed to fetch actor run", details: errorText }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const runData = await runResponse.json();
      datasetId = runData.data?.defaultDatasetId;

      if (!datasetId) {
        console.error(`[${requestId}] ✗ No defaultDatasetId in actor run`);
        console.error(`[${requestId}] Run data:`, JSON.stringify(runData.data));
        return new Response(
          JSON.stringify({ error: "No dataset in actor run" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[${requestId}] Got datasetId from run: ${datasetId}`);
    } else {
      console.log(`[${requestId}] Using datasetId from payload: ${datasetId}`);
    }

    // Fetch the dataset items
    console.log(`[${requestId}] Fetching dataset: ${datasetId}`);
    const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`;
    const datasetResponse = await fetch(datasetUrl);

    if (!datasetResponse.ok) {
      const errorText = await datasetResponse.text();
      console.error(`[${requestId}] ✗ Failed to fetch dataset: ${datasetResponse.status}`);
      console.error(`[${requestId}] Dataset URL (token redacted):`, datasetUrl.replace(apifyToken || '', 'REDACTED'));
      console.error(`[${requestId}] Error response:`, errorText);
      return new Response(
        JSON.stringify({
          error: "Failed to fetch Apify dataset",
          status: datasetResponse.status,
          details: errorText
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const datasetItems = await datasetResponse.json();
    console.log(`[${requestId}] Dataset items count:`, datasetItems.length);

    // Extract caption and transcript from first item
    const firstItem = datasetItems[0];
    if (!firstItem) {
      console.error(`[${requestId}] ✗ Empty dataset`);
      return new Response(
        JSON.stringify({ error: "No data in dataset" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const firstItemRecord = asRecord(firstItem) ?? {};

    console.log(`[${requestId}] First dataset item keys:`, Object.keys(firstItemRecord));

    // Extract key from dataset (the actor returns {id, url, transcript})
    const key = asString(firstItemRecord["id"]) || asString(firstItemRecord["videoId"]) || asString(firstItemRecord["key"]);
    if (!key) {
      console.error(`[${requestId}] ✗ No video ID in dataset`);
      return new Response(
        JSON.stringify({ error: "No video ID in dataset" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] Processing webhook for video key: ${key}`);

    // This actor returns: { id, url, transcript }
    // transcript is in WebVTT format
    const caption = asString(firstItemRecord["caption"]) || asString(firstItemRecord["text"]) || asString(firstItemRecord["description"]) || null;
    const transcript = asString(firstItemRecord["transcript"]) || asString(firstItemRecord["subtitles"]) || asString(firstItemRecord["videoTranscript"]) || null;

    const authorObj = asRecord(firstItemRecord["author"]) || asRecord(firstItemRecord["authorMeta"]);
    const covers = asRecord(firstItemRecord["covers"]);

    const datasetAuthor =
      asString(firstItemRecord["authorName"]) ||
      asString(firstItemRecord["author"]) ||
      asString(firstItemRecord["creator"]) ||
      asString(firstItemRecord["nickname"]) ||
      asString(authorObj?.["name"]) ||
      asString(authorObj?.["nickname"]);

    const datasetCreatorHandle =
      asString(firstItemRecord["authorUniqueId"]) ||
      asString(firstItemRecord["creatorHandle"]) ||
      asString(authorObj?.["uniqueId"]) ||
      asString(authorObj?.["id"]);

    const datasetAuthorUrl =
      asString(firstItemRecord["authorUrl"]) ||
      asString(firstItemRecord["authorLink"]) ||
      asString(authorObj?.["url"]) ||
      asString(authorObj?.["profileUrl"]);

    const datasetThumbnailUrl =
      asString(firstItemRecord["thumbnailUrl"]) ||
      asString(firstItemRecord["cover"]) ||
      asString(firstItemRecord["videoCover"]) ||
      asString(firstItemRecord["dynamicCover"]) ||
      asString(firstItemRecord["coverUrl"]) ||
      asString(covers?.["origin"]) ||
      asString(covers?.["dynamic"]) ||
      asString(covers?.["static"]);

    const datasetThumbnailWidth =
      asNumber(firstItemRecord["thumbnailWidth"]) ||
      asNumber(firstItemRecord["width"]) ||
      asNumber(covers?.["width"]);

    const datasetThumbnailHeight =
      asNumber(firstItemRecord["thumbnailHeight"]) ||
      asNumber(firstItemRecord["height"]) ||
      asNumber(covers?.["height"]);

    console.log(`[${requestId}] Extracted data:`, {
      hasCaption: !!caption,
      hasTranscript: !!transcript,
      captionLength: caption?.length,
      transcriptLength: transcript?.length,
    });

    // Validate we have at least caption or transcript
    if (!caption && !transcript) {
      console.error(`[${requestId}] ✗ No caption or transcript in dataset`);

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
      .select("status, meta")
      .eq("key", key)
      .maybeSingle();

    const existingMeta = (existing?.meta as CacheMeta | null) ?? {};

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

    const resolvedSourceUrl =
      payload.source_url ||
      asString(firstItemRecord["url"]) ||
      asString(firstItemRecord["videoUrl"]) ||
      asString(firstItemRecord["href"]) ||
      existingMeta.source_url ||
      `https://www.tiktok.com/video/${key}`;

    const author = datasetAuthor || existingMeta.author;
    const authorUrl = datasetAuthorUrl || existingMeta.author_url;
    const creatorHandle = datasetCreatorHandle || existingMeta.creator_handle;
    const thumbnailUrl = datasetThumbnailUrl || existingMeta.thumbnail_url;
    const thumbnailWidth = datasetThumbnailWidth ?? existingMeta.thumbnail_width;
    const thumbnailHeight = datasetThumbnailHeight ?? existingMeta.thumbnail_height;

    try {
      const normalizeResult = await normalizeRecipe(
        {
          caption,
          transcript,
          source_url: resolvedSourceUrl,
          video_id: key,
          author,
          author_url: authorUrl,
          creator_handle: creatorHandle,
          thumbnail_url: thumbnailUrl,
          thumbnail_width: thumbnailWidth,
          thumbnail_height: thumbnailHeight,
        },
        openaiKey
      );

      const updatedMeta: CacheMeta = {
        ...existingMeta,
        source_url: resolvedSourceUrl,
        caption,
        transcript,
        actorRunId: payload.actorRunId || existingMeta.actorRunId,
        datasetId: datasetId || existingMeta.datasetId,
        model: normalizeResult.model,
        source: "transcript",
        author,
        author_url: authorUrl,
        creator_handle: creatorHandle,
        thumbnail_url: thumbnailUrl,
        thumbnail_width: thumbnailWidth,
        thumbnail_height: thumbnailHeight,
        timings: {
          ...existingMeta.timings,
          openai_ms: normalizeResult.elapsed_ms,
        },
      };

      // Update cache as READY
      const { error: upsertError } = await supabase
        .from("cache")
        .upsert({
          key,
          status: "READY" as CacheStatus,
          value: normalizeResult.recipe,
          meta: updatedMeta,
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
