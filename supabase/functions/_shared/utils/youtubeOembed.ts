/**
 * YouTube oEmbed utilities for fetching video metadata
 */

import type { OEmbedResponse } from "../types.ts";

const YOUTUBE_OEMBED_ENDPOINT = "https://youtube.com/oembed";

/**
 * Fetches oEmbed data from YouTube for a given video URL
 *
 * This provides basic metadata including:
 * - Video title
 * - Author name
 * - Thumbnail URL (used to extract video ID)
 */
export async function fetchYouTubeOEmbed(url: string): Promise<OEmbedResponse | null> {
  const startTime = performance.now();

  try {
    const oembedUrl = `${YOUTUBE_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`;
    console.log(`[YouTube oEmbed] Fetching metadata for: ${url}`);

    const response = await fetch(oembedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecipeBot/1.0)',
      },
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      console.error(`[YouTube oEmbed] Failed to fetch (${response.status}): ${response.statusText} (${elapsed.toFixed(0)}ms)`);
      return null;
    }

    const data = await response.json() as OEmbedResponse;
    console.log(`[YouTube oEmbed] Successfully fetched metadata (${elapsed.toFixed(0)}ms):`, {
      title: data.title?.substring(0, 100),
      author: data.author_name,
      provider: data.provider_name,
      thumbnail: data.thumbnail_url,
    });

    return data;
  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[YouTube oEmbed] Error fetching metadata (${elapsed.toFixed(0)}ms):`, error);
    return null;
  }
}

/**
 * Extracts YouTube video ID from thumbnail URL
 *
 * YouTube thumbnail URLs follow the pattern:
 * https://i.ytimg.com/vi/{VIDEO_ID}/hqdefault.jpg
 *
 * Example: https://i.ytimg.com/vi/iwGFalTRHDA/hqdefault.jpg → iwGFalTRHDA
 */
export function extractVideoIdFromThumbnail(thumbnailUrl: string): string | null {
  try {
    // Pattern: /vi/{VIDEO_ID}/
    const match = thumbnailUrl.match(/\/vi\/([^/]+)\//);
    if (match && match[1]) {
      return match[1];
    }

    console.warn(`[YouTube oEmbed] Could not extract video ID from thumbnail: ${thumbnailUrl}`);
    return null;
  } catch (error) {
    console.error(`[YouTube oEmbed] Error extracting video ID:`, error);
    return null;
  }
}

/**
 * Gets YouTube video ID from oEmbed response
 * Uses thumbnail URL as the most reliable source
 */
export function getVideoIdFromOEmbed(oembedData: OEmbedResponse): string | null {
  if (!oembedData.thumbnail_url) {
    console.error(`[YouTube oEmbed] No thumbnail URL in oEmbed response`);
    return null;
  }

  const videoId = extractVideoIdFromThumbnail(oembedData.thumbnail_url);

  if (videoId) {
    console.log(`[YouTube oEmbed] Extracted video ID: ${videoId}`);
  }

  return videoId;
}
