/**
 * AI Provider abstraction layer
 * Routes normalization requests to OpenAI or Gemini based on platform and configuration
 */

import * as OpenAI from "./openai.ts";
import * as Gemini from "./gemini.ts";
import type { Platform } from "./urlParsing.ts";

export type AIProvider = "openai" | "gemini";

export interface NormalizeInput {
  caption?: string;
  transcript?: string;
  source_url: string;
  video_id: string;
  author?: string;
  author_url?: string;
  creator_handle?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
}

export interface NormalizeResult {
  recipe: any; // Recipe type from types.ts
  model: string;
  elapsed_ms: number;
  provider: AIProvider;
}

/**
 * Determines which AI provider to use based on platform and environment
 *
 * Rules:
 * - YouTube videos ALWAYS use Gemini (requires GEMINI_API_KEY)
 * - TikTok videos use AI_PROVIDER env var (defaults to "openai")
 *   - If AI_PROVIDER="gemini", use Gemini (requires GEMINI_API_KEY)
 *   - If AI_PROVIDER="openai" or not set, use OpenAI (requires OPENAI_API_KEY)
 */
function getAIProvider(platform: Platform): { provider: AIProvider; apiKey: string } {
  // YouTube always uses Gemini
  if (platform === "youtube") {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      throw new Error("GEMINI_API_KEY is required for YouTube videos");
    }
    return { provider: "gemini", apiKey: geminiKey };
  }

  // For TikTok, check AI_PROVIDER env var
  const preferredProvider = (Deno.env.get("AI_PROVIDER") || "openai").toLowerCase();

  if (preferredProvider === "gemini") {
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
    }
    return { provider: "gemini", apiKey: geminiKey };
  }

  // Default to OpenAI
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai or not set");
  }
  return { provider: "openai", apiKey: openaiKey };
}

/**
 * Normalizes caption/transcript into structured Recipe using the appropriate AI provider
 * For TikTok videos only (text-based normalization)
 *
 * @param input - The normalization input (caption, transcript, metadata)
 * @param platform - The video platform (tiktok only)
 * @param model - Optional model override (uses default for provider if not specified)
 * @returns Normalized recipe with provider information
 */
export async function normalizeRecipe(
  input: NormalizeInput,
  platform: Platform,
  model?: string
): Promise<NormalizeResult> {
  const { provider, apiKey } = getAIProvider(platform);

  console.log(`[AIProvider] Using ${provider} for ${platform} video (text-based)`);

  if (provider === "gemini") {
    const result = await Gemini.normalizeRecipe(input, apiKey, model);
    return {
      ...result,
      provider: "gemini",
    };
  } else {
    const result = await OpenAI.normalizeRecipe(input, apiKey, model);
    return {
      ...result,
      provider: "openai",
    };
  }
}

/**
 * Normalizes a YouTube video directly using Gemini's video analysis capabilities
 * YouTube videos are always processed via Gemini's multimodal API
 *
 * @param videoUrl - The YouTube video URL
 * @param videoId - The YouTube video ID
 * @param metadata - Video metadata from oEmbed
 * @param model - Optional model override
 * @returns Normalized recipe with provider information
 */
export async function normalizeYouTubeVideo(
  videoUrl: string,
  videoId: string,
  metadata: {
    title?: string;
    author?: string;
    author_url?: string;
    thumbnail_url?: string;
    thumbnail_width?: number;
    thumbnail_height?: number;
  },
  model?: string
): Promise<NormalizeResult> {
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) {
    throw new Error("GEMINI_API_KEY is required for YouTube videos");
  }

  console.log(`[AIProvider] Using Gemini video analysis for YouTube video`);

  const result = await Gemini.normalizeRecipeFromYouTubeVideo(
    videoUrl,
    videoId,
    metadata,
    geminiKey,
    model
  );

  return {
    ...result,
    provider: "gemini",
  };
}
