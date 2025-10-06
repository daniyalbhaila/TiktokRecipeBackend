/**
 * TikTok URL validation utilities
 *
 * Note: We use oEmbed API to get canonical video IDs (embed_product_id),
 * so we don't need to parse video IDs from URLs ourselves.
 */

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
