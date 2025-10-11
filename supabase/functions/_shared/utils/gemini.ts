/**
 * Google Gemini normalization utilities for converting captions/transcripts to structured recipes
 */

import type { Recipe } from "../types.ts";
import { RECIPE_SYSTEM_PROMPT } from "./openai.ts";
import { GEMINI_TEMPERATURE, GEMINI_MODEL_DEFAULT } from "../constants.ts";

const GEMINI_API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

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
 * Normalizes caption/transcript into structured Recipe using Gemini
 */
export async function normalizeRecipe(
  input: NormalizeInput,
  apiKey: string,
  model = GEMINI_MODEL_DEFAULT
): Promise<NormalizeResult> {
  const startTime = performance.now();

  console.log(`[Gemini] Starting normalization with model: ${model}`);
  console.log(`[Gemini] Input:`, {
    hasCaption: !!input.caption,
    hasTranscript: !!input.transcript,
    captionLength: input.caption?.length,
    transcriptLength: input.transcript?.length,
  });

  // Prepare user prompt
  const userPrompt = buildUserPrompt(input);

  try {
    const url = `${GEMINI_API_ENDPOINT}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: RECIPE_SYSTEM_PROMPT
          }]
        },
        contents: [{
          parts: [{
            text: userPrompt
          }]
        }],
        generationConfig: {
          temperature: GEMINI_TEMPERATURE,
          responseMimeType: "application/json",
        },
      }),
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Gemini] API error (${response.status}) after ${elapsed.toFixed(0)}ms:`, errorText);
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      console.error(`[Gemini] No content in response after ${elapsed.toFixed(0)}ms:`, data);
      throw new Error("No content in Gemini response");
    }

    // Parse the JSON response
    const parsed = JSON.parse(content);

    // Ensure we have the recipe field (Gemini might return RecipeResponse or just Recipe)
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

    console.log(`[Gemini] ✓ Successfully normalized recipe in ${elapsed.toFixed(0)}ms:`, {
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
    console.error(`[Gemini] Error after ${elapsed.toFixed(0)}ms:`, error);
    throw error;
  }
}

/**
 * Builds the user prompt from caption/transcript
 */
function buildUserPrompt(input: NormalizeInput): string {
  const parts: string[] = [];

  parts.push(`Normalize this video into the schema using chef-guided inference and standardized units.`);
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

/**
 * Normalizes a YouTube video into structured Recipe using Gemini's video analysis
 * This sends the YouTube video URL directly to Gemini which will watch and analyze it
 */
export async function normalizeRecipeFromYouTubeVideo(
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
  apiKey: string,
  model = GEMINI_MODEL_DEFAULT
): Promise<NormalizeResult> {
  const startTime = performance.now();

  console.log(`[Gemini Video] Starting YouTube video analysis with model: ${model}`);
  console.log(`[Gemini Video] Video URL: ${videoUrl}`);
  console.log(`[Gemini Video] Video ID: ${videoId}`);

  try {
    const url = `${GEMINI_API_ENDPOINT}/${model}:generateContent?key=${apiKey}`;

    // Build the user prompt for video analysis
    const userPrompt = `Analyze this YouTube cooking video and extract the recipe using chef-guided inference and standardized units.

source_url: ${videoUrl}
video_id: ${videoId}
${metadata.title ? `title: ${metadata.title}` : ''}
${metadata.author ? `creator: ${metadata.author}` : ''}
${metadata.thumbnail_url ? `thumbnail: ${metadata.thumbnail_url}` : ''}

Watch the video and extract:
- All ingredients with quantities and units
- Step-by-step cooking instructions
- Timing, temperature, and equipment
- Servings and estimated macros
- Any tips or notes mentioned

Return the recipe in the exact JSON schema specified in the system prompt.`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: RECIPE_SYSTEM_PROMPT
          }]
        },
        contents: [{
          parts: [
            {
              text: userPrompt
            },
            {
              fileData: {
                mimeType: "video/*",
                fileUri: videoUrl
              }
            }
          ]
        }],
        generationConfig: {
          temperature: GEMINI_TEMPERATURE,
          responseMimeType: "application/json",
        },
      }),
    });

    const elapsed = performance.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Gemini Video] API error (${response.status}) after ${elapsed.toFixed(0)}ms:`, errorText);
      throw new Error(`Gemini Video API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      console.error(`[Gemini Video] No content in response after ${elapsed.toFixed(0)}ms:`, data);
      throw new Error("No content in Gemini video response");
    }

    // Parse the JSON response
    const parsed = JSON.parse(content);

    // Ensure we have the recipe field
    const recipe: Recipe = parsed.recipe || parsed;

    // Add required fields if missing
    if (!recipe.id) {
      recipe.id = videoId;
    }
    if (!recipe.source_url) {
      recipe.source_url = videoUrl;
    }
    if (!recipe.media) {
      recipe.media = {
        type: 'oembed',
        video_url: videoUrl,
        poster_url: metadata.thumbnail_url || null,
        thumbnail: metadata.thumbnail_url ? {
          url: metadata.thumbnail_url,
          width: metadata.thumbnail_width || null,
          height: metadata.thumbnail_height || null,
        } : undefined,
      };
    }

    // Ensure author is populated
    if (!recipe.author && metadata.author) {
      recipe.author = metadata.author;
    }

    console.log(`[Gemini Video] ✓ Successfully analyzed YouTube video in ${elapsed.toFixed(0)}ms:`, {
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
    console.error(`[Gemini Video] Error after ${elapsed.toFixed(0)}ms:`, error);
    throw error;
  }
}
