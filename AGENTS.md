# Repository Guidelines

## Project Structure & Module Organization
- `supabase/functions/extract`, `apify-webhook`, `result`: Deno edge functions for ingest, webhook handling, and polling.
- `supabase/functions/_shared`: shared types and utilities for TikTok parsing, Apify, and OpenAI; keep cross-function logic here.
- `supabase/migrations`: SQL run by `supabase db reset`; add reversible schema updates only.
- `supabase/config.toml`: local Supabase stack settings; change ports or runtime policy in isolated commits.

## Build, Test, and Development Commands
- `supabase start`: launch Postgres, Auth, Storage, and the edge runtime locally.
- `supabase functions serve extract --env-file supabase/.env`: hot-reload the extract function; swap the function name for `apify-webhook` or `result`.
- `supabase db reset`: rebuild the local database, applying migrations and `supabase/seed.sql`.
- `curl -X POST http://127.0.0.1:54321/functions/v1/extract -H 'Content-Type: application/json' -d '{"url":"https://www.tiktok.com/@chef/video/123"}'`: basic smoke test.

## Coding Style & Naming Conventions
- TypeScript targets Deno 2; use 2-space indentation, trailing commas, camelCase functions, and `PascalCase` types.
- Run `deno fmt` and `deno lint` inside `supabase/functions` before committing to keep imports ordered and catch unused code.
- Keep logs structured with the `requestId` prefix and fail fast with early returns.

## Testing Guidelines
- No automated suites yet; exercise endpoints with `curl` or Postman while tailing function logs.
- Call `/extract` first, then poll `/result?key=<videoId>` to watch the cache progress through `PENDING`, `READY`, or `FAILED`.
- Capture manual checks in the PR until Deno unit tests land.

## Commit & Pull Request Guidelines
- Follow the existing history: concise imperative subject lines (`Fix Apify webhook...`, `Add ...`) ≤70 characters.
- PRs should cover the behaviour change, database or config edits (`supabase/migrations`, `config.toml`), payload screenshots or JSON samples, and verification steps (`supabase` commands, `curl`).
- Link Supabase dashboard runs or relevant tickets when they add context.

## Security & Configuration Tips
- Required secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `APIFY_TOKEN`, `APIFY_TIKTOK_TRANSCRIPT_ACTOR_ID`, `APIFY_WEBHOOK_SECRET`. Load them with `supabase secrets set --env-file supabase/.env`.
- Never commit live keys or webhook secrets; keep them in ignored `.env` files or the hosted secret store.
- Review logs before shipping to ensure no tokens or transcripts leak.
