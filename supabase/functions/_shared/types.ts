// Shared type definitions for the TikTok Recipe Backend

export type CacheStatus = "PENDING" | "READY" | "FAILED";

// Recipe types (from existing schema)
export interface RecipeResponse {
  recipe: Recipe;
  markdown: string;
}

export interface Recipe {
  id: string;
  source_url: string;
  title: string;
  author?: string;
  creator_handle?: string;
  servings?: number;
  macros?: Macros;
  recipe_notes?: string[];
  ingredients: Ingredient[];
  steps: Step[];
  timings?: Timings;
  equipment?: string[];
  media: Media;
  assumptions?: string[];
}

export interface Macros {
  calories?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
}

export interface Ingredient {
  section: string;
  item: string;
  qty?: number | null;
  unit?: 'g' | 'tsp' | 'tbsp' | 'cup' | 'slice' | 'clove' | 'piece' | 'pinch' | 'dash' | 'drizzle' | 'splash' | 'handful' | 'sprig' | 'wedge' | 'knob' | 'pat' | 'drop' | 'dollop' | 'zest' | 'grating' | 'scoop' | 'stick' | null;
  notes?: string | null;
  source: 'caption' | 'transcript' | 'both' | 'inferred';
  confidence: number;
}

export interface Step {
  n: number;
  text: string;
  source: 'caption' | 'transcript' | 'both' | 'inferred';
  confidence: number;
}

export interface Timings {
  prep_min?: number;
  cook_min?: number;
  total_min?: number;
}

export interface Media {
  type: 'oembed';
  video_url?: string | null;
  poster_url?: string | null;
  thumbnail?: {
    url: string;
    width?: number | null;
    height?: number | null;
  };
}

// Cache table types
export interface CacheRow {
  key: string;
  status: CacheStatus;
  value?: Recipe;
  meta?: CacheMeta;
  error?: CacheError;
  updated_at?: string;
}

export interface CacheMeta {
  source_url?: string;
  caption?: string;
  transcript?: string;
  actorRunId?: string;
  timings?: {
    oembed_ms?: number;
    openai_ms?: number;
    apify_ms?: number;
  };
  model?: string;
  source?: "caption" | "transcript";
}

export interface CacheError {
  type: string;
  message: string;
  code?: string;
  raw?: unknown;
}

// API request/response types
export interface ExtractRequest {
  url: string;
  force?: boolean; // Optional: force re-processing even if cached
}

export interface ExtractResponse {
  key: string;
  status: CacheStatus;
  value?: Recipe;
  error?: CacheError;
}

export interface OEmbedResponse {
  version: string;
  type: string;
  title?: string;
  author_name?: string;
  author_url?: string;
  author_unique_id?: string;
  provider_name: string;
  provider_url: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  html?: string;
  description?: string;
  embed_product_id?: string; // Canonical TikTok video ID
  embed_type?: string;
}

export interface ApifyWebhookPayload {
  key: string;
  caption?: string;
  transcript?: string;
  source_url?: string;
  actorRunId?: string;
}
