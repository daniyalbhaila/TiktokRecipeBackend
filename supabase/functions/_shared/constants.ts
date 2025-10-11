/**
 * Shared constants for the Recipe Backend
 */

// Recipe detection thresholds
export const MIN_RECIPE_CAPTION_LENGTH = 20;
export const MIN_RECIPE_KEYWORD_MATCHES = 3;

// OpenAI configuration
export const OPENAI_TEMPERATURE = 0.1; // Low temperature for consistency
export const OPENAI_MODEL_DEFAULT = "gpt-4o-mini";

// Gemini configuration
export const GEMINI_TEMPERATURE = 0.1; // Low temperature for consistency
export const GEMINI_MODEL_DEFAULT = "gemini-2.0-flash-exp"; // Gemini 2.5 Flash (no thinking mode)

// oEmbed endpoints
export const TIKTOK_OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";
export const YOUTUBE_OEMBED_ENDPOINT = "https://youtube.com/oembed";

// Timing constants (milliseconds)
export const POLLING_INTERVAL_MS = 2000;
export const MAX_POLLING_ATTEMPTS = 90; // 3 minutes at 2s intervals
