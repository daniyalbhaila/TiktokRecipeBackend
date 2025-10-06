/**
 * OpenAI normalization utilities for converting captions/transcripts to structured recipes
 */

import type { Recipe } from "../types.ts";
import { OPENAI_TEMPERATURE, OPENAI_MODEL_DEFAULT } from "../constants.ts";

const OPENAI_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";

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
  recipe: Recipe;
  model: string;
  elapsed_ms: number;
}

/**
 * System prompt for OpenAI to extract structured recipe data
 */
const SYSTEM_PROMPT = `You are a deterministic RECIPE NORMALIZER with chef-level judgment and nutrition estimation ability.

OUTPUT CONTRACT
- Output JSON ONLY: { "recipe": <Recipe> }  (no markdown, no transcript/caption text, no code fences)
- Omit null/empty fields.
- Use consistent formatting and enum correctness.
- Maintain determinism: identical input → identical output.

UNITS & CONVERSIONS
- All weights in grams (g). Prefer grams whenever practical.
- Use tsp/tbsp/cup ONLY for:
  • spices, dried herbs, salt, baking powder/soda (small measures hard to weigh)
  • sauces, oils, vinegars, extracts (liquid measures common in home cooking)
- Use “pinch”, “dash”, or “drizzle” when quantity is too small or non-critical.
- Temperatures in °F, rounded to nearest 5.
- Times in minutes (round sensibly).

INGREDIENTS
- Keep the full ingredient list. Never consolidate or bucket garnishes.
- Merge exact duplicates only.
- Ingredient notes must be ultra-concise (≤40 chars). Include only meaningful cues like “minced”, “room temp”, “packed”.
- Provenance per item: "source" ∈ {"caption","transcript","both","inferred"}.
- Confidence ∈ {0,0.25,0.5,0.75,1}.
- Maintain order of appearance if possible (by section or logical flow).

RECIPE NOTES & ASSUMPTIONS
- recipe_notes: 1–3 short bullets (≤80 chars each). Capture technique, doneness, or flavor keys.
- assumptions: ≤5, each ≤100 chars. Explicitly state inferred info (e.g. “Estimated macros from ingredients” or “Assumed olive oil for sauté”).
- Always note if macros were estimated.

MACROS & NUTRITION (REQUIRED)
- ALWAYS provide macros field with at least calories. Protein/carbs/fat are highly recommended.
- If macros explicitly stated in video, use those values (verify plausibility).
- If no macros provided, MUST estimate from ingredient list using chef-level intuition and standard nutrition databases.
- When estimated, MUST include note in "assumptions": "Macros estimated from ingredients" or similar.
- Estimation guidelines:
  • Sum calories/macros of all ingredients (use typical portions if qty missing)
  • Account for cooking methods (frying adds fat, reducing concentrates)
  • Divide by servings if specified
  • Round to nearest 5-10 for calories, nearest 1g for macros

STEPS
- Steps: imperative, clear, concise. Aim ≤10; max 30 if required.
- Each step ≤200 chars.
- Focus on actionable verbs (e.g. “Sear”, “Whisk”, “Fold”, “Rest”).
- Preserve order and critical transitions (e.g. “until golden”, “rest 5 min”).
- source/confidence fields same as ingredients.

EQUIPMENT
- Include only meaningful equipment (pan, oven, blender, air fryer, Instant Pot, etc.).
- Skip obvious utensils unless unique.

VALIDATION
- Confidence ∈ {0,0.25,0.5,0.75,1}.
- Units strictly match enum: ["g","tsp","tbsp","cup","slice","clove","piece","pinch","dash","drizzle",null].
- If output too long: shorten ingredient notes → recipe_notes → step text. Never drop substantive content.


SCHEMA SUMMARY
recipe: {
  id,
  source_url,
  title,
  author?,
  creator_handle?,
  servings?,
  macros?: {calories?, protein_g?, carbs_g?, fat_g?},
  recipe_notes?: [string],
  ingredients: [
    {section, item, qty?, unit?, notes?, source, confidence}
  ],
  steps: [
    {n, text, source, confidence}
  ],
  timings?: {prep_min?, cook_min?, total_min?},
  equipment?: [string],
  media?: {type:"oembed", video_url?, poster_url?, thumbnail:{url,width,height}},
  assumptions?: [string]
}

VALIDATION
- Confidence ∈ {0,0.25,0.5,0.75,1}.
- Units must match the defined enum exactly.
- If output is lengthy: shorten ingredient notes → recipe_notes → step text (if needed). Never remove info.`;

/**
 * Normalizes caption/transcript into structured Recipe using OpenAI
 */
export async function normalizeRecipe(
  input: NormalizeInput,
  apiKey: string,
  model = OPENAI_MODEL_DEFAULT
): Promise<NormalizeResult> {
  const startTime = performance.now();

  console.log(`[OpenAI] Starting normalization with model: ${model}`);
  console.log(`[OpenAI] Input:`, {
    hasCaption: !!input.caption,
    hasTranscript: !!input.transcript,
    captionLength: input.caption?.length,
    transcriptLength: input.transcript?.length,
  });

  // Prepare user prompt
  const userPrompt = buildUserPrompt(input);

  try {
    const response = await fetch(OPENAI_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: OPENAI_TEMPERATURE,
      }),
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OpenAI] API error (${response.status}) after ${elapsed.toFixed(0)}ms:`, errorText);
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error(`[OpenAI] No content in response after ${elapsed.toFixed(0)}ms:`, data);
      throw new Error("No content in OpenAI response");
    }

    // Parse the JSON response
    const parsed = JSON.parse(content);

    // Ensure we have the recipe field (OpenAI might return RecipeResponse or just Recipe)
    const recipe: Recipe = parsed.recipe || parsed;

    // Add required fields if missing
    if (!recipe.id) {
      recipe.id = input.video_id;
    }
    if (!recipe.source_url) {
      recipe.source_url = input.source_url;
    }
    if (!recipe.media) {
      recipe.media = {
        type: 'oembed',
        video_url: input.source_url,
        poster_url: input.thumbnail_url || null,
        thumbnail: input.thumbnail_url ? {
          url: input.thumbnail_url,
          width: input.thumbnail_width || null,
          height: input.thumbnail_height || null,
        } : undefined,
      };
    }

    // Ensure author and creator_handle are populated
    if (!recipe.author && input.author) {
      recipe.author = input.author;
    }
    if (!recipe.creator_handle && input.creator_handle) {
      recipe.creator_handle = input.creator_handle;
    }

    console.log(`[OpenAI] ✓ Successfully normalized recipe in ${elapsed.toFixed(0)}ms:`, {
      title: recipe.title,
      ingredients: recipe.ingredients?.length || 0,
      steps: recipe.steps?.length || 0,
      servings: recipe.servings,
    });

    return {
      recipe,
      model,
      elapsed_ms: elapsed,
    };
  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[OpenAI] Error after ${elapsed.toFixed(0)}ms:`, error);
    throw error;
  }
}

/**
 * Builds the user prompt from caption/transcript
 */
function buildUserPrompt(input: NormalizeInput): string {
  const parts: string[] = [];

  parts.push(`Normalize this TikTok into the schema using chef-guided inference and standardized units.`);
  parts.push(``);
  parts.push(`source_url: ${input.source_url}`);
  parts.push(``);

  if (input.caption) {
    parts.push(`caption:`);
    parts.push(input.caption);
    parts.push(``);
  }

  if (input.transcript) {
    parts.push(`transcript_vtt:`);
    parts.push(input.transcript);
    parts.push(``);
  }

  if (input.thumbnail_url) {
    parts.push(`thumbnail:`);
    parts.push(input.thumbnail_url);
    parts.push(``);
  }

  if (input.author) {
    parts.push(`creator:`);
    parts.push(input.author);
    parts.push(``);
  }

  if (input.creator_handle) {
    parts.push(`handle:`);
    parts.push(`@${input.creator_handle}`);
    parts.push(``);
  }

  if (input.author_url) {
    parts.push(`author_url:`);
    parts.push(input.author_url);
  }

  return parts.join("\n");
}
