/**
 * TikTok oEmbed utilities for fetching video metadata and captions
 */

import type { OEmbedResponse } from "../types.ts";
import { MIN_RECIPE_CAPTION_LENGTH, MIN_RECIPE_KEYWORD_MATCHES } from "../constants.ts";

const TIKTOK_OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

/**
 * Fetches oEmbed data from TikTok for a given video URL
 *
 * This provides basic metadata including:
 * - Video title
 * - Author name
 * - Thumbnail
 * - Caption (in the title field usually)
 */
export async function fetchOEmbed(url: string): Promise<OEmbedResponse | null> {
  const startTime = performance.now();

  try {
    const oembedUrl = `${TIKTOK_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`;
    console.log(`[oEmbed] Fetching metadata for: ${url}`);

    const response = await fetch(oembedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TikTokRecipeBot/1.0)',
      },
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      console.error(`[oEmbed] Failed to fetch (${response.status}): ${response.statusText} (${elapsed.toFixed(0)}ms)`);
      return null;
    }

    const data = await response.json() as OEmbedResponse;
    console.log(`[oEmbed] Successfully fetched metadata (${elapsed.toFixed(0)}ms):`, {
      title: data.title?.substring(0, 100),
      author: data.author_name,
      provider: data.provider_name,
    });

    return data;
  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[oEmbed] Error fetching metadata (${elapsed.toFixed(0)}ms):`, error);
    return null;
  }
}

/**
 * Extracts caption from oEmbed response
 * The caption is usually in the 'title' field for TikTok
 */
export function extractCaption(oembedData: OEmbedResponse): string | null {
  // Try title first (most common location for caption)
  if (oembedData.title && oembedData.title.trim()) {
    return oembedData.title.trim();
  }

  // Fallback to description if available
  if (oembedData.description && oembedData.description.trim()) {
    return oembedData.description.trim();
  }

  console.log('[oEmbed] No caption found in response');
  return null;
}

/**
 * Heuristic to determine if a caption looks like it contains recipe content
 *
 * Checks for:
 * - Recipe-related keywords (ingredients, recipe, cook, etc.)
 * - Food-related terms
 * - Measurements or cooking verbs
 * - Length (recipes tend to be longer than typical captions)
 */
export function looksLikeRecipe(caption: string): boolean {
  if (!caption || caption.trim().length < MIN_RECIPE_CAPTION_LENGTH) {
    console.log('[oEmbed] Caption too short to be a recipe');
    return false;
  }

  const lower = caption.toLowerCase();

  // Recipe indicator keywords
  const recipeKeywords = [
    'recipe', 'ingredient', 'cook', 'bake', 'prep', 'serve',
    'mix', 'stir', 'heat', 'add', 'combine', 'whisk', 'chop',
    'cup', 'tbsp', 'tsp', 'oz', 'gram', 'ml', 'tablespoon', 'teaspoon',
    'minutes', 'min', 'hour', 'temperature', 'degrees', '°',
    'salt', 'pepper', 'oil', 'butter', 'garlic', 'onion',
  ];

  // Count how many keywords appear
  const keywordMatches = recipeKeywords.filter(keyword => lower.includes(keyword));
  const matchCount = keywordMatches.length;

  // Determine if this looks like a recipe based on keyword threshold
  const isRecipe = matchCount >= MIN_RECIPE_KEYWORD_MATCHES;

  console.log(`[oEmbed] Recipe heuristic: ${matchCount} keywords found`, {
    isRecipe,
    keywords: keywordMatches.slice(0, 5),
    captionLength: caption.length,
  });

  return isRecipe;
}

/**
 * Determines if we should try to extract a recipe from the caption immediately
 * vs. waiting for the full transcript from Apify
 */
export function shouldNormalizeFromCaption(caption: string | null): boolean {
  if (!caption) {
    console.log('[oEmbed] No caption available - will use transcript path');
    return false;
  }

  const isRecipeLike = looksLikeRecipe(caption);

  if (isRecipeLike) {
    console.log('[oEmbed] ✓ Caption looks like a recipe - will normalize immediately');
  } else {
    console.log('[oEmbed] ✗ Caption does not look like a recipe - will use transcript path');
  }

  return isRecipeLike;
}
