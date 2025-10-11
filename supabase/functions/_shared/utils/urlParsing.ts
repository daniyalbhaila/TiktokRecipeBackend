/**
 * URL validation and parsing utilities for TikTok and YouTube
 */

export type Platform = "tiktok" | "youtube";

export interface ParsedUrl {
  platform: Platform;
  url: string;
  videoId?: string; // May not be available until after API calls
}

/**
 * Validates if a string is a valid TikTok URL
 *
 * Supported formats:
 * - https://www.tiktok.com/@username/video/1234567890
 * - https://vm.tiktok.com/ABCDEF/ (short URLs)
 * - https://vt.tiktok.com/ABCDEF/ (short URLs)
 * - https://m.tiktok.com/v/1234567890.html (mobile)
 */
export function isValidTikTokUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);

    // Valid TikTok domains
    const validDomains = [
      'tiktok.com',
      'www.tiktok.com',
      'vm.tiktok.com',
      'vt.tiktok.com',
      'm.tiktok.com'
    ];

    // Check if domain matches
    const isValidDomain = validDomains.some(domain =>
      urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`)
    );

    if (!isValidDomain) {
      return false;
    }

    // Check if path looks like a TikTok video URL
    const hasVideoPath =
      urlObj.pathname.includes('/video/') ||  // Standard format
      urlObj.pathname.includes('/v/') ||      // Mobile format
      urlObj.hostname.includes('vm.tiktok') || // Short URL
      urlObj.hostname.includes('vt.tiktok');   // Short URL

    return hasVideoPath;
  } catch (error) {
    // Invalid URL
    return false;
  }
}

/**
 * Validates if a string is a valid YouTube URL
 *
 * Supported formats:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID (short URLs)
 * - https://m.youtube.com/watch?v=VIDEO_ID (mobile)
 * - https://www.youtube.com/embed/VIDEO_ID (embed)
 * - https://www.youtube.com/v/VIDEO_ID (old format)
 * - https://www.youtube.com/shorts/VIDEO_ID (shorts)
 */
export function isValidYouTubeUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);

    // Valid YouTube domains
    const validDomains = [
      'youtube.com',
      'www.youtube.com',
      'youtu.be',
      'm.youtube.com'
    ];

    // Check if domain matches
    const isValidDomain = validDomains.some(domain =>
      urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`)
    );

    if (!isValidDomain) {
      return false;
    }

    // For youtu.be short URLs, just check that there's a path
    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.length > 1; // Should have /VIDEO_ID
    }

    // For youtube.com, check various path patterns
    const hasVideoPath =
      urlObj.pathname.includes('/watch') ||    // Standard watch
      urlObj.pathname.includes('/embed/') ||   // Embed
      urlObj.pathname.includes('/v/') ||       // Old format
      urlObj.pathname.includes('/shorts/');    // Shorts

    // Also check for v parameter in query string
    const hasVParam = urlObj.searchParams.has('v');

    return hasVideoPath || hasVParam;
  } catch (error) {
    // Invalid URL
    return false;
  }
}

/**
 * Extracts video ID from YouTube URL
 *
 * Returns null if video ID cannot be extracted
 */
export function extractYouTubeVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);

    // Short URL format: youtu.be/VIDEO_ID
    if (urlObj.hostname === 'youtu.be') {
      const videoId = urlObj.pathname.slice(1).split(/[?#]/)[0]; // Remove leading / and any query/hash
      return videoId || null;
    }

    // Query parameter format: youtube.com/watch?v=VIDEO_ID
    if (urlObj.searchParams.has('v')) {
      return urlObj.searchParams.get('v');
    }

    // Path formats: /embed/VIDEO_ID, /v/VIDEO_ID, /shorts/VIDEO_ID
    const pathMatch = urlObj.pathname.match(/\/(embed|v|shorts)\/([^/?#]+)/);
    if (pathMatch && pathMatch[2]) {
      return pathMatch[2];
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Parses and validates a video URL, returning platform and normalized URL
 *
 * Returns null if URL is not a valid TikTok or YouTube URL
 */
export function parseVideoUrl(url: string): ParsedUrl | null {
  if (isValidTikTokUrl(url)) {
    return {
      platform: "tiktok",
      url: url,
    };
  }

  if (isValidYouTubeUrl(url)) {
    const videoId = extractYouTubeVideoId(url);
    return {
      platform: "youtube",
      url: url,
      videoId: videoId || undefined,
    };
  }

  return null;
}
