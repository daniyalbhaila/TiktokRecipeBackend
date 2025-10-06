/**
 * Apify actor utilities for triggering TikTok transcript extraction
 */

const APIFY_API_BASE = "https://api.apify.com/v2";

export interface ApifyActorInput {
  videoUrl: string;
  webhookUrl: string;
  key: string; // Video ID for webhook callback
}

export interface ApifyRunResult {
  actorRunId: string;
  status: string;
}

/**
 * Triggers an Apify actor to scrape TikTok video transcript
 *
 * The actor will:
 * 1. Load the TikTok video in a browser
 * 2. Extract caption and transcript
 * 3. Call the webhook URL with the results
 */
export async function triggerApifyActor(
  input: ApifyActorInput,
  apifyToken: string,
  actorId: string
): Promise<ApifyRunResult> {
  const startTime = performance.now();

  console.log(`[Apify] Triggering actor: ${actorId}`);
  console.log(`[Apify] Input:`, {
    videoUrl: input.videoUrl,
    webhookUrl: input.webhookUrl,
    key: input.key,
  });

  try {
    // Webhook is configured in Apify UI (persistent webhook for this actor)
    // No need to pass webhooks via API
    const endpoint = `${APIFY_API_BASE}/acts/${actorId}/runs?token=${apifyToken}`;

    // Build input for the actor
    // The TikTok transcript actor expects "videos" field
    // We also pass the key so the webhook can reference it
    const actorInput = {
      videos: [input.videoUrl],
      customData: {
        videoKey: input.key,
      }
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(actorInput),
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Apify] Failed to trigger actor (${response.status}) after ${elapsed.toFixed(0)}ms:`);
      console.error(`[Apify] Error response:`, errorText);
      console.error(`[Apify] Request URL:`, endpoint.substring(0, 200) + '...');
      console.error(`[Apify] Request body:`, JSON.stringify(actorInput));
      throw new Error(`Apify API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const runId = data.data?.id;

    if (!runId) {
      console.error(`[Apify] No run ID in response after ${elapsed.toFixed(0)}ms:`, data);
      throw new Error("No run ID in Apify response");
    }

    console.log(`[Apify] ✓ Actor triggered successfully in ${elapsed.toFixed(0)}ms:`, {
      runId,
      status: data.data?.status,
    });

    return {
      actorRunId: runId,
      status: data.data?.status || "RUNNING",
    };
  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[Apify] Error after ${elapsed.toFixed(0)}ms:`, error);
    throw error;
  }
}

/**
 * Builds the webhook URL for Apify to call when scraping is complete
 */
export function buildWebhookUrl(baseUrl: string, key: string, secret: string): string {
  // Include the key in query params for easy routing
  // Include a secret for verification
  const url = new URL(`${baseUrl}/apify-webhook`);
  url.searchParams.set("key", key);
  url.searchParams.set("secret", secret);

  return url.toString();
}

/**
 * Verifies that a webhook request came from Apify
 * Checks the secret parameter
 */
export function verifyWebhookSecret(requestUrl: string, expectedSecret: string): boolean {
  try {
    const url = new URL(requestUrl);
    const secret = url.searchParams.get("secret");

    if (!secret) {
      console.error("[Apify] No secret in webhook request");
      return false;
    }

    const isValid = secret === expectedSecret;

    if (!isValid) {
      console.error("[Apify] Invalid webhook secret");
    }

    return isValid;
  } catch (error) {
    console.error("[Apify] Error verifying webhook secret:", error);
    return false;
  }
}
