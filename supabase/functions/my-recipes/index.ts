import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

/**
 * /my-recipes - Manage user's saved recipes
 *
 * GET /my-recipes
 *   - Returns all recipes saved by the authenticated user
 *   - Requires JWT auth
 *   - Joins user_recipes + cache tables
 *
 * POST /my-recipes
 *   - Save a recipe to user's collection
 *   - Body: { key: "video_id" }
 *   - Requires JWT auth
 *   - Idempotent (duplicate saves ignored)
 *
 * DELETE /my-recipes/:key
 *   - Remove a recipe from user's collection
 *   - Requires JWT auth
 */

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  console.log(`[${requestId}] ========== MY-RECIPES REQUEST ==========`);
  console.log(`[${requestId}] Method: ${req.method}, URL: ${req.url}`);

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };

  // Handle OPTIONS for CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders, status: 204 });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error(`[${requestId}] ✗ Missing Supabase credentials`);
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with user's JWT (passed in Authorization header)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log(`[${requestId}] ✗ Missing Authorization header`);
      return new Response(
        JSON.stringify({ error: "Unauthorized - Missing auth token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Verify JWT and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.log(`[${requestId}] ✗ Invalid or expired token:`, authError?.message);
      return new Response(
        JSON.stringify({ error: "Unauthorized - Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[${requestId}] ✓ Authenticated user: ${user.id}`);

    // Route based on method
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // GET /my-recipes - List all saved recipes
    if (req.method === "GET") {
      console.log(`[${requestId}] Fetching saved recipes for user ${user.id}`);

      const { data: savedRecipes, error: fetchError } = await supabase
        .from("user_recipes")
        .select(`
          id,
          key,
          saved_at,
          cache:key (
            key,
            status,
            value,
            meta
          )
        `)
        .eq("user_id", user.id)
        .order("saved_at", { ascending: false });

      if (fetchError) {
        console.error(`[${requestId}] ✗ Database error:`, fetchError);
        return new Response(
          JSON.stringify({ error: "Failed to fetch recipes", details: fetchError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Found ${savedRecipes.length} saved recipes (${elapsed.toFixed(0)}ms)`);

      return new Response(
        JSON.stringify({
          recipes: savedRecipes.map((sr) => ({
            id: sr.id,
            key: sr.key,
            saved_at: sr.saved_at,
            recipe: sr.cache,
          })),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST /my-recipes - Save a recipe
    if (req.method === "POST") {
      const body = await req.json();
      const { key } = body;

      if (!key || typeof key !== "string") {
        console.log(`[${requestId}] ✗ Missing or invalid 'key' in request body`);
        return new Response(
          JSON.stringify({ error: "Missing 'key' in request body" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[${requestId}] Saving recipe ${key} for user ${user.id}`);

      // Check if recipe exists in cache
      const { data: recipe, error: recipeError } = await supabase
        .from("cache")
        .select("key, status")
        .eq("key", key)
        .maybeSingle();

      if (recipeError) {
        console.error(`[${requestId}] ✗ Database error:`, recipeError);
        return new Response(
          JSON.stringify({ error: "Database error", details: recipeError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!recipe) {
        console.log(`[${requestId}] ✗ Recipe not found in cache: ${key}`);
        return new Response(
          JSON.stringify({ error: "Recipe not found. Extract it first using /extract" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Save to user_recipes (upsert for idempotency)
      const { data: saved, error: saveError } = await supabase
        .from("user_recipes")
        .upsert(
          { user_id: user.id, key },
          { onConflict: "user_id,key" }
        )
        .select()
        .single();

      if (saveError) {
        console.error(`[${requestId}] ✗ Failed to save recipe:`, saveError);
        return new Response(
          JSON.stringify({ error: "Failed to save recipe", details: saveError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Recipe saved (${elapsed.toFixed(0)}ms)`);

      return new Response(
        JSON.stringify({
          message: "Recipe saved successfully",
          saved_recipe: saved,
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // DELETE /my-recipes/:key - Unsave a recipe
    if (req.method === "DELETE") {
      // Extract key from path: /my-recipes/:key
      const key = pathParts[pathParts.length - 1];

      if (!key) {
        console.log(`[${requestId}] ✗ Missing key in DELETE path`);
        return new Response(
          JSON.stringify({ error: "Missing recipe key in path" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      console.log(`[${requestId}] Deleting recipe ${key} for user ${user.id}`);

      const { error: deleteError } = await supabase
        .from("user_recipes")
        .delete()
        .eq("user_id", user.id)
        .eq("key", key);

      if (deleteError) {
        console.error(`[${requestId}] ✗ Failed to delete recipe:`, deleteError);
        return new Response(
          JSON.stringify({ error: "Failed to delete recipe", details: deleteError.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const elapsed = performance.now() - startTime;
      console.log(`[${requestId}] ✓ Recipe deleted (${elapsed.toFixed(0)}ms)`);

      return new Response(
        JSON.stringify({ message: "Recipe removed successfully" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Method not allowed
    console.log(`[${requestId}] ✗ Method not allowed: ${req.method}`);
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const elapsed = performance.now() - startTime;
    console.error(`[${requestId}] ✗ Unhandled error after ${elapsed.toFixed(0)}ms:`, error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
