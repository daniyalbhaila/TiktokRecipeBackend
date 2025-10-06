/**
 * TikTok URL validation and video ID extraction utilities
 */

export interface TikTokUrlInfo {
  videoId: string;
  url: string;
  username?: string;
}

/**
 * Extracts video ID from various TikTok URL formats
 *
 * Supported formats:
 * - https://www.tiktok.com/@username/video/1234567890
 * - https://vm.tiktok.com/ABCDEF/
 * - https://vt.tiktok.com/ABCDEF/
 * - https://m.tiktok.com/v/1234567890.html
 */
export function extractTikTokVideoId(url: string): TikTokUrlInfo | null {
  try {
    const urlObj = new URL(url);

    // Check if it's a TikTok domain
    const validDomains = ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'];
    if (!validDomains.some(domain => urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`))) {
      console.log(`[TikTok] Invalid domain: ${urlObj.hostname}`);
      return null;
    }

    // Standard format: https://www.tiktok.com/@username/video/1234567890
    const standardMatch = urlObj.pathname.match(/\/@([^/]+)\/video\/(\d+)/);
    if (standardMatch) {
      const [, username, videoId] = standardMatch;
      console.log(`[TikTok] Extracted video ID: ${videoId}, username: @${username}`);
      return {
        videoId,
        url,
        username,
      };
    }

    // Mobile short format: https://vm.tiktok.com/ABCDEF/
    if (urlObj.hostname.includes('vm.tiktok.com') || urlObj.hostname.includes('vt.tiktok.com')) {
      const shortCode = urlObj.pathname.replace(/\//g, '');
      if (shortCode) {
        console.log(`[TikTok] Short URL detected: ${shortCode} - will use full URL as key`);
        // For short URLs, we'll use the full URL as the key since we can't extract video ID directly
        return {
          videoId: shortCode,
          url,
        };
      }
    }

    // Mobile format: https://m.tiktok.com/v/1234567890.html
    const mobileMatch = urlObj.pathname.match(/\/v\/(\d+)/);
    if (mobileMatch) {
      const videoId = mobileMatch[1];
      console.log(`[TikTok] Extracted video ID from mobile URL: ${videoId}`);
      return {
        videoId,
        url,
      };
    }

    console.log(`[TikTok] Could not extract video ID from URL: ${url}`);
    return null;
  } catch (error) {
    console.error(`[TikTok] Error parsing URL: ${url}`, error);
    return null;
  }
}

/**
 * Validates if a string is a valid TikTok URL
 */
export function isValidTikTokUrl(url: string): boolean {
  const info = extractTikTokVideoId(url);
  return info !== null;
}

/**
 * Normalizes TikTok URL to canonical format
 * This helps with deduplication (different URLs for same video)
 */
export function normalizeTikTokUrl(url: string): string | null {
  const info = extractTikTokVideoId(url);
  if (!info) return null;

  // For standard URLs with username, return canonical format
  if (info.username) {
    return `https://www.tiktok.com/@${info.username}/video/${info.videoId}`;
  }

  // For short URLs, return as-is
  return url;
}
