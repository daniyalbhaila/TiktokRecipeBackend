# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Supabase backend project for a recipe extraction application. The project uses Supabase Edge Functions (Deno runtime) to handle serverless API endpoints.

**Core Product Flow**: User pastes a TikTok or YouTube link → backend extracts recipe from caption/transcript → returns standardized recipe card with ingredients, steps, and nutrition info.

### Supported Platforms

- **TikTok**: Full support with oEmbed and Apify scraping
- **YouTube**: Full support with configurable AI provider (always uses Gemini)

### SLC (Simple Lovable Complete) Scope

**✅ In Scope (MVP/SLC)**
- Paste TikTok or YouTube link → return clean recipe card
- Extract from caption → transcript fallback → error if neither available (no OCR)
- Standardized ingredients + steps format
- Nutrition info (stubbed macros acceptable for MVP)
- Error handling with friendly user messages
- Basic caching for instant repeat requests
- Flexible AI provider (OpenAI or Gemini) based on platform and configuration

**❌ Out of Scope (Post-MVP)**
- OCR for on-screen text / carousel images
- User accounts or saved recipe history
- Grocery list export (beyond simple stub)
- Advanced SEO/content marketing features

## Architecture

### Overall Flow

```
Clients (web/app/CLI) → /extract → Cache check → oEmbed fast path → Apify slow path (webhook) → Normalizer (OpenAI/Gemini) → Cache READY → /result read
```

**Why this architecture?** Keeps code tiny, zero-ops, cheap, and resilient by splitting sync/async work and using cache as both job state + idempotency layer.

### AI Provider Selection

The system supports both OpenAI and Google Gemini for recipe normalization:

**Provider Rules:**
- **YouTube videos**: ALWAYS use Gemini (requires `GEMINI_API_KEY`)
- **TikTok videos**: Configurable via `AI_PROVIDER` environment variable
  - `AI_PROVIDER=gemini` → Use Gemini (requires `GEMINI_API_KEY`)
  - `AI_PROVIDER=openai` or not set → Use OpenAI (requires `OPENAI_API_KEY`)

**Shared System Prompt**: Both providers use the same system prompt (`RECIPE_SYSTEM_PROMPT` in `_shared/utils/openai.ts`) to ensure consistent recipe extraction quality across providers.

### Supabase Edge Functions (Stateless Glue)

The project contains three edge functions in `supabase/functions/`:

- **`POST /extract`** - Entry point. Validates TikTok/YouTube URL, computes key (video_id), checks cache
  - Supports both TikTok and YouTube URLs
  - If cached READY → return value immediately
  - Else try oEmbed (caption). If caption looks recipe-ish → normalize now with appropriate AI provider
  - Otherwise → start Apify actor with webhook, return PENDING
  - Uses `aiProvider.ts` to route to OpenAI or Gemini based on platform

- **`POST /apify-webhook`** - Receives `{key, caption?, transcript?}` from Apify. Calls AI provider to normalize. Upserts READY
  - Determines platform from source URL
  - Routes to appropriate AI provider (OpenAI or Gemini)

- **`GET /result?key=...`** - Returns `{status, value?, error?}` from cache (for polling)

All functions:
- Run on Deno v2 runtime
- Use TypeScript
- Have JWT verification enabled
- Are configured in `supabase/config.toml`

### Database Schema (MVP)

**Table: `cache`** (public schema, no RLS - server-owned)

```sql
create table public.cache (
  key         text primary key,                    -- Video ID (TikTok or YouTube) - idempotency key
  status      text not null check (status in ('PENDING','READY','FAILED')),
  value       jsonb,                               -- normalized recipe JSON when READY
  meta        jsonb,                               -- {source_url, caption?, transcript?, actorRunId?, timings?, model?, ai_provider?, platform?}
  error       jsonb,                               -- {type, message, code?, raw?}
  updated_at  timestamptz default now()
);
```

**Why these columns?**
- `key`: Deduplication + idempotency (same video never reprocessed unless forced)
- `status`: Simple FSM (PENDING→READY/FAILED)
- `value`: Final, canonical recipe JSON your frontend consumes
- `meta`: Diagnostics/observability (timings, inputs, model used, AI provider, platform)
  - `ai_provider`: "openai" or "gemini" - which AI was used
  - `platform`: "tiktok" or "youtube" - which platform the video is from
- `error`: Failure details for UX + debugging
- `updated_at`: Ops & TTL cleanup

**Database access patterns:**
- `/extract`: SELECT by key; on miss, INSERT key,PENDING (or UPSERT)
- `/apify-webhook`: UPSERT key→READY,value,meta; no-op if already READY
- `/result`: SELECT by key

### External Services

**Apify** - Async scraping (heavy lifting: browser automation, transcript extraction)
- Calls back via webhook so edge functions never block
- Triggered when oEmbed caption is insufficient
- Supports both TikTok and YouTube video scraping

**AI Providers** - Recipe Normalization
- **OpenAI (GPT-4o-mini)**: Default for TikTok, optional for all platforms
- **Google Gemini (2.0 Flash)**: Required for YouTube, optional for TikTok
- Both use identical system prompts for consistent quality
- Deterministic, single call per video
- Converts caption/transcript → strict recipe JSON

### Security & Secrets

Secrets stored in Supabase → Settings → Secrets:
- `OPENAI_API_KEY` - Required when using OpenAI (TikTok default)
- `GEMINI_API_KEY` - Required for YouTube videos and optional for TikTok
- `AI_PROVIDER` - Optional, set to "gemini" or "openai" (defaults to "openai" for TikTok)
- `APIFY_TOKEN`
- `APIFY_WEBHOOK_SECRET`

No RLS on cache table (server-owned). Functions use service role client.
JWT verification enabled on functions for access control.

### Development Environment

- Uses Deno for edge functions (not Node.js)
- Deno LSP is enabled for the `supabase/functions` directory
- Deno unstable features are enabled (see `.vscode/settings.json` for list)

## Common Commands

### Start Local Development

```bash
supabase start
```

This starts the entire Supabase stack locally:
- API server on port 54321
- Database on port 54322
- Studio (web UI) on port 54323
- Inbucket (email testing) on port 54324

### Stop Local Development

```bash
supabase stop
```

### Database Migrations

```bash
# Create a new migration
supabase migration new <migration_name>

# Apply migrations
supabase db push

# Reset database (applies migrations and seeds)
supabase db reset
```

### Edge Functions

```bash
# Deploy a specific function
supabase functions deploy <function_name>

# Test a function locally (after supabase start)
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/<function_name>' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"key":"value"}'
```

### Link to Remote Project

```bash
supabase link --project-ref <project-ref>
```

## Configuration

### Environment Variables

Edge functions can access environment variables through the Supabase dashboard or local `.env` files. The config uses `env()` syntax for sensitive values.

### Local Development URLs

- API: http://127.0.0.1:54321
- Database: postgresql://postgres:postgres@127.0.0.1:54322/postgres
- Studio: http://127.0.0.1:54323
- Inbucket (email): http://127.0.0.1:54324

### Auth Configuration

- Site URL: http://127.0.0.1:3000
- Email confirmations: disabled
- Signups: enabled
- JWT expiry: 3600 seconds (1 hour)

## Important Notes

- This is a Deno project for edge functions, NOT a Node.js project
- Do not use npm/yarn/pnpm commands
- Use Deno import maps in each function's `deno.json` file for dependencies
- The edge runtime uses `per_worker` policy for hot reload during development
- All functions require JWT verification by default
