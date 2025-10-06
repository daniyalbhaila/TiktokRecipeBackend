/**
 * Shared constants for the TikTok Recipe Backend
 */

// Recipe detection thresholds
export const MIN_RECIPE_CAPTION_LENGTH = 20;
export const MIN_RECIPE_KEYWORD_MATCHES = 3;

// OpenAI configuration
export const OPENAI_TEMPERATURE = 0.1; // Low temperature for consistency
export const OPENAI_MODEL_DEFAULT = "gpt-4o-mini";

// Timing constants (milliseconds)
export const POLLING_INTERVAL_MS = 2000;
export const MAX_POLLING_ATTEMPTS = 90; // 3 minutes at 2s intervals
