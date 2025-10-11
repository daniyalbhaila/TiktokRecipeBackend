# TikTok Recipe App: Complete System Architecture

I'm going to break this down like I'm explaining it to my junior dev. Let's start with your **excellent observation** about the cache table.

---

## Part 1: Understanding the Recipe Storage Problem

### Your Question: "Why duplicate recipes if users don't modify them?"

You're 100% right to question this! Let me show you both approaches:

### ❌ **Bad Design: Full Duplication**

```sql
-- Every user gets full copy
cookbook_recipes:
  user_id: 'alice'
  recipe_data: { /* 50KB of JSON */ }

cookbook_recipes:
  user_id: 'bob'
  recipe_data: { /* Same 50KB of JSON */ }  -- WASTE!

-- 1000 users save same recipe = 50MB wasted
```

### ✅ **Good Design: Single Source of Truth + User Metadata**

```sql
-- ONE canonical recipe (your "cache" table, but let's rename it)
recipes:
  id: 'tiktok_7123456'
  data: { /* 50KB of JSON - stored ONCE */ }
  source: 'tiktok'
  creator: '@gordonramsay'

-- Users just "reference" it with metadata
user_saved_recipes:
  user_id: 'alice'
  recipe_id: 'tiktok_7123456'  -- Just a pointer!
  notes: 'Try with extra garlic'
  saved_at: timestamp

-- 1000 users = 50KB + (1000 × tiny pointers) = ~50KB total
```

**But what about modifications?**

```sql
-- When user modifies, THEN we copy
user_saved_recipes:
  user_id: 'alice'
  recipe_id: 'tiktok_7123456'
  modified_data: null  -- No modification, uses canonical recipe

user_saved_recipes:
  user_id: 'bob'
  recipe_id: 'tiktok_7123456'
  modified_data: { /* His version with changes */ }  -- Only copy when modified!
```

**This is called "Copy-on-Write" (COW)** - a fundamental CS pattern used by Git, Docker, filesystems, etc.

---

## Part 2: Complete Database Schema

Let me give you the **final, production-ready schema** with proper naming:

```sql
-- ============================================================================
-- CORE: RECIPES (Single Source of Truth)
-- ============================================================================

-- Canonical recipes extracted from TikTok/Instagram/etc
create table public.recipes (
  id                text primary key,  -- 'tiktok_7123456' or 'instagram_abc'

  -- Recipe data (normalized format)
  data              jsonb not null,  -- {title, ingredients, steps, nutrition, etc}

  -- Source attribution
  source_platform   text not null,  -- 'tiktok', 'instagram', 'youtube'
  source_url        text not null,
  creator_handle    text,  -- '@gordonramsay'
  creator_name      text,  -- 'Gordon Ramsay'

  -- Metadata for discovery
  cuisine_type      text[],  -- ['italian', 'pasta']
  meal_type         text[],  -- ['dinner', 'lunch']
  dietary_tags      text[],  -- ['vegetarian', 'gluten-free']
  prep_time_min     int,
  cook_time_min     int,
  difficulty        text,  -- 'easy', 'medium', 'hard'

  -- Extraction pipeline state
  extraction_status text check (extraction_status in ('PENDING', 'READY', 'FAILED')),
  extraction_meta   jsonb,  -- {apify_run_id, model_used, timings, etc}
  extraction_error  jsonb,

  -- Stats (denormalized)
  save_count        int default 0,  -- How many users saved this
  cook_count        int default 0,  -- How many "I cooked this" posts
  view_count        int default 0,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index idx_recipes_creator on recipes(creator_handle);
create index idx_recipes_status on recipes(extraction_status);
create index idx_recipes_cuisine on recipes using gin(cuisine_type);
create index idx_recipes_dietary on recipes using gin(dietary_tags);


-- ============================================================================
-- USERS: PROFILES & AUTH
-- ============================================================================

-- Public user profiles (extends Supabase auth.users)
create table public.profiles (
  id                uuid primary key references auth.users on delete cascade,

  -- Identity
  username          text unique not null,
  display_name      text not null,
  bio               text,
  avatar_url        text,

  -- Fitness goals (for AI recommendations)
  fitness_goal      text,  -- 'weight_loss', 'muscle_gain', 'maintenance'
  dietary_prefs     text[],  -- ['vegetarian', 'dairy-free']
  daily_calorie_target int,

  -- Social stats
  follower_count    int default 0,
  following_count   int default 0,
  recipe_count      int default 0,
  cookbook_count    int default 0,

  -- Settings
  is_private        boolean default false,
  is_verified       boolean default false,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Auto-create profile on signup
create function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, 'user_' || substr(new.id::text, 1, 8), 'User');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================================
-- USER LIBRARY: SAVED RECIPES & COOKBOOKS
-- ============================================================================

-- User's saved recipes (references canonical recipes)
create table public.user_saved_recipes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,
  recipe_id         text references recipes not null,

  -- Copy-on-Write: only populated if user modifies
  modified_data     jsonb,  -- null = use canonical, non-null = user's version

  -- User metadata
  notes             text,
  rating            int check (rating between 1 and 5),
  times_cooked      int default 0,
  last_cooked_at    timestamptz,

  -- Organization
  is_favorite       boolean default false,
  tags              text[],  -- User's custom tags

  saved_at          timestamptz default now(),

  unique(user_id, recipe_id)
);

create index idx_user_recipes_user on user_saved_recipes(user_id);
create index idx_user_recipes_recipe on user_saved_recipes(recipe_id);

-- Update recipe save count
create function update_recipe_save_count() returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    update recipes set save_count = save_count + 1 where id = new.recipe_id;
  elsif TG_OP = 'DELETE' then
    update recipes set save_count = save_count - 1 where id = old.recipe_id;
  end if;
  return null;
end;
$$ language plpgsql;

create trigger on_recipe_save_change
  after insert or delete on user_saved_recipes
  for each row execute function update_recipe_save_count();


-- Cookbooks (collections of recipes)
create table public.cookbooks (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid references auth.users not null,

  name              text not null,
  description       text,
  cover_image       text,

  visibility        text check (visibility in ('private', 'public', 'unlisted')) default 'private',
  is_official       boolean default false,  -- Admin curated
  featured_at       timestamptz,

  recipe_count      int default 0,
  follower_count    int default 0,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index idx_cookbooks_owner on cookbooks(owner_id);
create index idx_cookbooks_visibility on cookbooks(visibility) where visibility = 'public';


-- Many-to-many: recipes in cookbooks
create table public.cookbook_recipes (
  cookbook_id       uuid references cookbooks on delete cascade,
  recipe_id         text references recipes not null,
  sort_order        int default 0,
  added_at          timestamptz default now(),
  primary key (cookbook_id, recipe_id)
);


-- ============================================================================
-- SOCIAL: FOLLOWS, FEED, ENGAGEMENT
-- ============================================================================

-- User follows
create table public.follows (
  follower_id       uuid references auth.users on delete cascade,
  following_id      uuid references auth.users on delete cascade,
  followed_at       timestamptz default now(),
  primary key (follower_id, following_id),
  check (follower_id != following_id)
);

create index idx_follows_follower on follows(follower_id);
create index idx_follows_following on follows(following_id);


-- Cooking posts (user shares photo of dish they made)
create table public.cooking_posts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,
  recipe_id         text references recipes not null,

  photo_url         text not null,
  caption           text,
  rating            int check (rating between 1 and 5),

  -- What they changed
  modifications     text,
  actual_time_min   int,

  -- Engagement
  like_count        int default 0,
  comment_count     int default 0,

  visibility        text check (visibility in ('public', 'followers', 'private')) default 'public',

  created_at        timestamptz default now()
);

create index idx_cooking_posts_user on cooking_posts(user_id, created_at desc);
create index idx_cooking_posts_recipe on cooking_posts(recipe_id);


-- Activity feed (chronological stream)
create table public.activities (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,

  activity_type     text not null check (activity_type in (
    'cooked_recipe',
    'created_cookbook',
    'followed_user',
    'saved_recipe'
  )),

  -- Polymorphic references
  cooking_post_id   uuid references cooking_posts on delete cascade,
  cookbook_id       uuid references cookbooks on delete cascade,
  recipe_id         text references recipes,
  target_user_id    uuid references auth.users on delete cascade,

  created_at        timestamptz default now()
);

create index idx_activities_user on activities(user_id, created_at desc);
create index idx_activities_type on activities(activity_type);


-- Likes (polymorphic: can like posts, cookbooks, comments)
create table public.likes (
  user_id           uuid references auth.users on delete cascade,
  cooking_post_id   uuid references cooking_posts on delete cascade,
  cookbook_id       uuid references cookbooks on delete cascade,
  liked_at          timestamptz default now(),
  check (num_nonnulls(cooking_post_id, cookbook_id) = 1),
  unique (user_id, cooking_post_id),
  unique (user_id, cookbook_id)
);


-- Comments
create table public.comments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,

  -- Can comment on posts or cookbooks
  cooking_post_id   uuid references cooking_posts on delete cascade,
  cookbook_id       uuid references cookbooks on delete cascade,

  content           text not null,
  parent_comment_id uuid references comments on delete cascade,  -- Threading

  like_count        int default 0,

  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),

  check (num_nonnulls(cooking_post_id, cookbook_id) = 1)
);


-- ============================================================================
-- MEAL PLANNING: WEEKLY PLANS & GROCERY LISTS
-- ============================================================================

create table public.meal_plans (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,

  name              text not null,
  start_date        date not null,
  end_date          date,

  created_at        timestamptz default now()
);


create table public.meal_plan_recipes (
  id                uuid primary key default gen_random_uuid(),
  meal_plan_id      uuid references meal_plans on delete cascade not null,
  recipe_id         text references recipes not null,

  scheduled_date    date not null,
  meal_type         text check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  servings          int default 1,

  added_at          timestamptz default now()
);


create table public.grocery_lists (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users not null,
  meal_plan_id      uuid references meal_plans on delete set null,

  name              text not null,
  status            text check (status in ('draft', 'ready', 'exported')) default 'draft',

  exported_to       text,
  exported_at       timestamptz,

  created_at        timestamptz default now()
);


create table public.grocery_list_items (
  id                uuid primary key default gen_random_uuid(),
  grocery_list_id   uuid references grocery_lists on delete cascade not null,

  ingredient        text not null,
  quantity          decimal,
  unit              text,
  category          text,  -- 'produce', 'meat', 'dairy'

  checked           boolean default false,
  notes             text,

  created_at        timestamptz default now()
);


-- ============================================================================
-- DISCOVERY: SEARCH & RECOMMENDATIONS
-- ============================================================================

-- User's recipe interactions (for ML recommendations)
create table public.user_recipe_interactions (
  user_id           uuid references auth.users,
  recipe_id         text references recipes,

  -- Interaction types
  viewed_at         timestamptz,
  swiped_right      boolean,  -- Tinder-style: liked/passed
  dwell_time_sec    int,      -- How long they looked at it
  saved             boolean,
  cooked            boolean,

  created_at        timestamptz default now(),

  primary key (user_id, recipe_id, created_at)
);

-- This feeds your recommendation engine
create index idx_interactions_user on user_recipe_interactions(user_id, created_at desc);
```

---

## Part 3: Visual Architecture Diagrams

### Diagram 1: Data Model (Entity Relationship)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CORE: RECIPES                               │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ recipes (Single Source of Truth)                            │    │
│  │ • id (tiktok_7123456)                                       │    │
│  │ • data (canonical JSON)                                     │    │
│  │ • creator_handle, source_url                                │    │
│  │ • cuisine_type[], dietary_tags[]                            │    │
│  │ • save_count, cook_count, view_count                        │    │
│  └────────────────┬───────────────────────────────────────────┘    │
└───────────────────┼──────────────────────────────────────────────────┘
                    │
                    │ references (many users → one recipe)
                    │
┌───────────────────┼──────────────────────────────────────────────────┐
│                   ▼           USERS & LIBRARY                        │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐   │
│  │ auth.users           │◄───│ profiles                         │   │
│  │ (Supabase built-in)  │    │ • username, bio, avatar          │   │
│  └──────┬───────────────┘    │ • fitness_goal, dietary_prefs    │   │
│         │                    │ • follower_count, recipe_count   │   │
│         │ owns               └──────────────────────────────────┘   │
│         │                                                            │
│         ├──► user_saved_recipes (Copy-on-Write)                     │
│         │    • recipe_id → recipes                                  │
│         │    • modified_data (null if unmodified)                   │
│         │    • notes, rating, times_cooked                          │
│         │                                                            │
│         ├──► cookbooks                                              │
│         │    • name, visibility (private/public)                    │
│         │    • is_official (admin curated)                          │
│         │    │                                                       │
│         │    └──► cookbook_recipes (many-to-many)                   │
│         │         • recipe_id → recipes                             │
│         │         • sort_order                                      │
│         │                                                            │
│         ├──► meal_plans                                             │
│         │    • start_date, end_date                                 │
│         │    │                                                       │
│         │    ├──► meal_plan_recipes                                 │
│         │    │    • recipe_id → recipes                             │
│         │    │    • scheduled_date, meal_type                       │
│         │    │                                                       │
│         │    └──► grocery_lists                                     │
│         │         • exported_to (instacart)                         │
│         │         │                                                 │
│         │         └──► grocery_list_items                           │
│         │              • ingredient, quantity, checked              │
│         │                                                            │
│         └──► user_recipe_interactions (for ML)                      │
│              • viewed_at, swiped_right, dwell_time                  │
│              • Feeds recommendation engine                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                          SOCIAL LAYER                                │
│  ┌──────────────────────┐                                           │
│  │ auth.users           │                                           │
│  └──┬──────────┬────────┘                                           │
│     │          │                                                     │
│     │          └──► follows (many-to-many)                           │
│     │               • follower_id, following_id                      │
│     │                                                                │
│     ├──► cooking_posts (user shares dish photo)                     │
│     │    • recipe_id → recipes                                      │
│     │    • photo_url, caption, rating                               │
│     │    • modifications (what they changed)                        │
│     │    • like_count, comment_count                                │
│     │                                                                │
│     ├──► activities (chronological feed)                            │
│     │    • activity_type (cooked_recipe, created_cookbook, etc)     │
│     │    • polymorphic refs (cooking_post_id, cookbook_id, etc)     │
│     │                                                                │
│     ├──► likes (polymorphic)                                        │
│     │    • cooking_post_id OR cookbook_id                           │
│     │                                                                │
│     └──► comments (threaded)                                        │
│          • cooking_post_id OR cookbook_id                           │
│          • parent_comment_id (for replies)                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Diagram 2: System Architecture (Services & Data Flow)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Web App    │  │ Mobile App   │  │   CLI Tool   │              │
│  │  (Next.js)   │  │(React Native)│  │   (Debug)    │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                      │
│         └──────────────────┴──────────────────┘                      │
│                            │                                         │
│                            │ HTTPS + JWT                             │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────────────┐
│                         SUPABASE                                      │
│                            ▼                                         │
│  ┌────────────────────────────────────────────────────────┐         │
│  │              Edge Functions (Deno Runtime)              │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ Recipe Extraction Pipeline                        │  │         │
│  │  │  • POST /extract (entry point)                    │  │         │
│  │  │  • POST /apify-webhook (async callback)           │  │         │
│  │  │  • GET /result (polling)                          │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ User Library                                      │  │         │
│  │  │  • POST /recipes/save                             │  │         │
│  │  │  • GET /recipes/saved                             │  │         │
│  │  │  • PATCH /recipes/:id (modify user copy)          │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ Cookbooks                                         │  │         │
│  │  │  • POST /cookbooks                                │  │         │
│  │  │  • POST /cookbooks/:id/recipes                    │  │         │
│  │  │  • GET /discover/cookbooks                        │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ Social                                            │  │         │
│  │  │  • POST /posts (cooking post)                     │  │         │
│  │  │  • GET /feed (activity feed)                      │  │         │
│  │  │  • POST /@:username/follow                        │  │         │
│  │  │  • POST /posts/:id/like                           │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ Discovery & Search                                │  │         │
│  │  │  • GET /search (recipes, users, cookbooks)        │  │         │
│  │  │  • GET /discover/swipe (Tinder-style feed)        │  │         │
│  │  │  • POST /interactions (track swipes for ML)       │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  │  ┌──────────────────────────────────────────────────┐  │         │
│  │  │ Meal Planning                                     │  │         │
│  │  │  • POST /meal-plans                               │  │         │
│  │  │  • GET /meal-plans/:id/grocery-list               │  │         │
│  │  │  • POST /grocery-lists/:id/export (Instacart)     │  │         │
│  │  └──────────────────────────────────────────────────┘  │         │
│  └────────────────────────────────────────────────────────┘         │
│                            │                                         │
│                            ▼                                         │
│  ┌────────────────────────────────────────────────────────┐         │
│  │              PostgreSQL Database                        │         │
│  │  (All tables from schema above)                        │         │
│  │  • Row Level Security (RLS) enforces access control    │         │
│  └────────────────────────────────────────────────────────┘         │
│                            │                                         │
│  ┌────────────────────────────────────────────────────────┐         │
│  │              Supabase Auth (JWT)                        │         │
│  │  • Signup, login, session management                   │         │
│  │  • JWT contains user_id, passed to edge functions      │         │
│  └────────────────────────────────────────────────────────┘         │
│                            │                                         │
│  ┌────────────────────────────────────────────────────────┐         │
│  │              Supabase Storage (Optional)                │         │
│  │  • User avatars, cooking post photos                   │         │
│  │  • Alternative: Cloudflare R2, S3                      │         │
│  └────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
                             │
                             │ Webhooks & API calls
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Apify      │  │   OpenAI     │  │  Instacart   │              │
│  │  (Scraper)   │  │(Normalizer)  │  │   (Export)   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  ┌──────────────┐  ┌──────────────┐                                │
│  │  TikTok API  │  │   PostHog    │                                │
│  │  (oEmbed)    │  │ (Analytics)  │                                │
│  └──────────────┘  └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Diagram 3: Recipe Extraction Flow (Async Pipeline)

```
┌───────────┐
│   User    │
│ pastes    │
│ TikTok URL│
└─────┬─────┘
      │
      │ 1. POST /extract
      ▼
┌────────────────────────────────────────────────────────┐
│  Edge Function: /extract                               │
│  • Parse URL → extract video_id                        │
│  • Check recipes table: SELECT WHERE id = video_id     │
└─────┬──────────────────────────────────────────────────┘
      │
      ├─► Found READY? → Return recipe immediately ✅
      │
      ├─► Found PENDING? → Return {status: 'PENDING', job_id} ⏳
      │
      └─► Not found?
          │
          │ 2. Try oEmbed (fast path)
          ▼
      ┌─────────────────────────────────────┐
      │ TikTok oEmbed API                   │
      │ GET https://tiktok.com/oembed?url=  │
      └─────┬───────────────────────────────┘
            │
            ├─► Has caption? → Normalize with OpenAI → INSERT READY → Return ✅
            │
            └─► No caption? → Start Apify
                │
                │ 3. INSERT INTO recipes (id, status='PENDING')
                │ 4. Trigger Apify actor with webhook URL
                ▼
            ┌─────────────────────────────────────────┐
            │  Apify (Async, runs in background)      │
            │  • Open TikTok in browser                │
            │  • Extract video transcript (if exists)  │
            │  • Extract on-screen text (OCR)          │
            │  • POST to /apify-webhook when done      │
            └─────┬───────────────────────────────────┘
                  │
                  │ 5. POST /apify-webhook
                  │    {video_id, caption, transcript}
                  ▼
            ┌───────────────────────────────────────────┐
            │  Edge Function: /apify-webhook            │
            │  • Verify webhook secret                  │
            │  • Normalize with OpenAI                  │
            │  • UPDATE recipes SET status='READY'      │
            └───────────────────────────────────────────┘
                  │
                  │ 6. User polls: GET /result?id=video_id
                  ▼
            ┌───────────────────────────────────────────┐
            │  Edge Function: /result                   │
            │  SELECT * FROM recipes WHERE id = video_id│
            │  → Returns {status: 'READY', data: {...}} │
            └───────────────────────────────────────────┘
```

### Diagram 4: Social Feed Algorithm

```
User opens feed:
  GET /feed
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Edge Function: /feed                                   │
│  1. Get user's follows:                                 │
│     SELECT following_id FROM follows WHERE follower_id  │
│                                                          │
│  2. Get recent activities from those users:             │
│     SELECT * FROM activities                            │
│     WHERE user_id IN (following_ids)                    │
│     ORDER BY created_at DESC                            │
│     LIMIT 50                                            │
│                                                          │
│  3. Hydrate activities (join related data):             │
│     • cooking_posts → recipe data, user profile, photos │
│     • created_cookbook → cookbook name, recipe count    │
│                                                          │
│  4. Apply ranking (optional):                           │
│     • Engagement score (likes + comments)               │
│     • Recency (newer = higher)                          │
│     • User affinity (how often you interact)            │
│                                                          │
│  5. Return feed items:                                  │
│     [                                                    │
│       {                                                  │
│         type: 'cooked_recipe',                          │
│         user: {username, avatar},                       │
│         recipe: {title, cuisine},                       │
│         post: {photo, caption, likes},                  │
│         timestamp: '2 hours ago'                        │
│       },                                                 │
│       ...                                                │
│     ]                                                    │
└─────────────────────────────────────────────────────────┘
```

---

## Part 4: Why This Architecture?

### Storage Efficiency: Copy-on-Write

```
Scenario: 10,000 users save the same viral TikTok recipe

❌ Full Duplication:
10,000 × 50KB = 500MB

✅ Copy-on-Write:
1 × 50KB (canonical) + 10,000 × 0.1KB (pointers) = 51MB

Savings: 90% reduction!

If 1% modify it:
51MB + (100 × 50KB) = 56MB
Still 89% savings!
```

### Why Keep `modified_data` in `user_saved_recipes`?

```sql
-- User's view of a recipe:
SELECT
  COALESCE(usr.modified_data, r.data) as recipe_data,  -- Use modified if exists, else canonical
  usr.notes,
  usr.rating,
  r.creator_handle,
  r.source_url
FROM user_saved_recipes usr
JOIN recipes r ON usr.recipe_id = r.id
WHERE usr.user_id = $1 AND usr.id = $2
```

**This gives you:**
- ✅ Single query (fast)
- ✅ User sees their version
- ✅ Can detect if canonical was updated (compare timestamps)
- ✅ Can show "🔄 Original recipe updated" notification

### Why Separate `recipes` from `cooking_posts`?

```
recipes = What the TikTok creator made (source of truth)
  "Gordon Ramsay's Carbonara"
  • Official instructions
  • Never modified (except re-extraction)

cooking_posts = What users actually made (social proof)
  "I made Gordon's Carbonara!"
  • User's photo
  • "I used bacon instead of guanciale"
  • Rating: 4/5 stars

Think: recipes = Wikipedia, cooking_posts = Instagram
```

This lets you show:
- Recipe page: "412 people cooked this" + photo gallery
- User can see others' modifications before trying it
- Social proof: "Your friend @alice made this last week!"

---

## Part 5: Web App vs Mobile App (When to Build What)

### Phase 1: Web App First (Months 1-3) ✅

**Why start with web:**
- ✅ Faster iteration (no app store approval)
- ✅ One codebase
- ✅ Easier to test with users
- ✅ SEO (Google can index recipes)
- ✅ Shareable links work everywhere

**Tech stack:**
```
Next.js (React) + Tailwind CSS
  ├─ /app/page.tsx                 → Homepage
  ├─ /app/extract/page.tsx         → Paste TikTok link
  ├─ /app/recipes/[id]/page.tsx    → Recipe detail
  ├─ /app/cookbooks/page.tsx       → User's cookbooks
  ├─ /app/@[username]/page.tsx     → User profile
  ├─ /app/feed/page.tsx            → Social feed
  └─ /app/discover/page.tsx        → Swipe UI (works on mobile web!)
```

**Mobile-responsive from day 1:**
- Use Tailwind's `sm:`, `md:`, `lg:` breakpoints
- Test on iPhone/Android browsers
- PWA (Progressive Web App) for "add to home screen"

### Phase 2: Mobile App (Months 4-6)

**When to build mobile:**
- ✅ You have 1,000+ active users who love the web version
- ✅ Users ask "when's the app coming?"
- ✅ You need native features:
  - Push notifications ("Your friend cooked a recipe!")
  - Camera integration (take photo → post immediately)
  - Offline mode (save recipes without internet)
  - Grocery list on lockscreen widget

**Tech stack:**
```
React Native (Expo)
  ├─ Reuse 80% of logic from web app
  ├─ Share API calls (same Supabase functions)
  └─ Only rebuild UI layer for mobile
```

### Phase 3: Why NOT "Mobile-First"?

**Common misconception:** "Recipe app = mobile app"

**Reality:**
- Users paste TikTok links from desktop too
- Recipe pages need SEO (Google search traffic)
- Easier to show complex UI (meal planning) on desktop
- Web app = free marketing (shareable links)

**Best approach:** Mobile-responsive web first, native app later.

---

## Part 6: New Features You Mentioned

### Feature 1: Creator Pages

```
URL: /creators/@gordonramsay

┌─────────────────────────────────────────┐
│  @gordonramsay                          │
│  ┌─────┐  Gordon Ramsay                │
│  │     │  TikTok creator                │
│  └─────┘  412 recipes extracted         │
│                                         │
│  [Follow on TikTok] [View All Recipes] │
├─────────────────────────────────────────┤
│  Most Popular Recipes:                  │
│  ┌───────┐ ┌───────┐ ┌───────┐         │
│  │Carbo- │ │Beef   │ │Choco- │         │
│  │nara   │ │Welling│ │late   │         │
│  │       │ │ton    │ │Soufflé│         │
│  │⭐ 4.8 │ │⭐ 4.9 │ │⭐ 4.7 │         │
│  │💾 1.2k│ │💾 890 │ │💾 760 │         │
│  └───────┘ └───────┘ └───────┘         │
└─────────────────────────────────────────┘
```

**Database query:**
```sql
-- Get all recipes by creator
SELECT * FROM recipes
WHERE creator_handle = '@gordonramsay'
ORDER BY save_count DESC  -- Most popular first
LIMIT 20
```

**Auto-create creator pages:**
```sql
-- Materialized view for performance
create materialized view creator_stats as
select
  creator_handle,
  creator_name,
  count(*) as recipe_count,
  sum(save_count) as total_saves,
  avg((data->>'rating')::float) as avg_rating
from recipes
where creator_handle is not null
group by creator_handle, creator_name;

-- Refresh periodically
refresh materialized view creator_stats;
```

### Feature 2: Tinder-Style Swipe Feed

```
GET /discover/swipe
  → Returns 20 recipes personalized for you

┌─────────────────────────────────────────┐
│           Recipe Card                    │
│  ┌─────────────────────────────────┐    │
│  │                                 │    │
│  │   [Full-screen recipe photo]    │    │
│  │                                 │    │
│  └─────────────────────────────────┘    │
│                                          │
│  🍝 Creamy Garlic Parmesan Pasta        │
│  by @cookingwithchloe                   │
│                                          │
│  ⏱️ 20 min  🔥 Easy  🥬 Vegetarian      │
│                                          │
│  412 people saved this                   │
│                                          │
│  [Swipe ← to pass]  [Swipe → to save]  │
└─────────────────────────────────────────┘
```

**Frontend (React/React Native):**
```tsx
import { useState } from 'react'
import { motion } from 'framer-motion'  // For animations

function SwipeCard({ recipe, onSwipe }) {
  const handleSwipe = (direction) => {
    // Track interaction for ML
    fetch('/api/interactions', {
      method: 'POST',
      body: JSON.stringify({
        recipe_id: recipe.id,
        swiped_right: direction === 'right'
      })
    })

    if (direction === 'right') {
      // Auto-save to "Swipe Saves" cookbook
      fetch('/api/recipes/save', {
        method: 'POST',
        body: JSON.stringify({ recipe_id: recipe.id })
      })
    }

    onSwipe(direction)
  }

  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      onDragEnd={(e, info) => {
        if (info.offset.x > 100) handleSwipe('right')
        if (info.offset.x < -100) handleSwipe('left')
      }}
    >
      <img src={recipe.photo} />
      <h2>{recipe.title}</h2>
      {/* ... */}
    </motion.div>
  )
}
```

**Backend (Recommendation Algorithm):**
```sql
-- Simple version: popular + personalized
create function get_swipe_feed(p_user_id uuid)
returns table (recipe_id text, score float) as $$
begin
  return query
  select
    r.id,
    (
      -- Base popularity score
      log(r.save_count + 1) * 10 +

      -- Match user's dietary preferences
      case when r.dietary_tags && (
        select dietary_prefs from profiles where id = p_user_id
      ) then 20 else 0 end +

      -- Match user's favorite cuisines (from past saves)
      case when r.cuisine_type && (
        select array_agg(distinct (data->>'cuisine')::text)
        from user_saved_recipes usr
        join recipes r2 on usr.recipe_id = r2.id
        where usr.user_id = p_user_id
      ) then 15 else 0 end +

      -- Penalize already saved recipes
      case when exists (
        select 1 from user_saved_recipes
        where user_id = p_user_id and recipe_id = r.id
      ) then -1000 else 0 end

    ) as score
  from recipes r
  where r.extraction_status = 'READY'
  order by score desc
  limit 20;
end;
$$ language plpgsql;
```

### Feature 3: AI Recommendations (Future)

**Track user behavior:**
```sql
-- Every interaction is logged
insert into user_recipe_interactions (
  user_id, recipe_id,
  swiped_right, dwell_time_sec, saved, cooked
) values (
  $user_id, $recipe_id,
  true, 12, true, false
)
```

**Feed to ML model (Python/scikit-learn):**
```python
# Weekly batch job (Supabase Edge Function calling Python Lambda)
from sklearn.neighbors import NearestNeighbors

# 1. Build user-recipe matrix
# Users × Recipes = Interactions (1 = liked, 0 = passed, -1 = unseen)

# 2. Collaborative filtering
# "Users who liked Recipe A also liked Recipe B"

# 3. Content-based filtering
# "You liked Italian → recommend more Italian"

# 4. Store recommendations
# INSERT INTO user_recommendations (user_id, recipe_id, score)
```

**Or use OpenAI embeddings (simpler):**
```typescript
// Generate embedding for user's preferences
const userPrefsText = `
  User likes: ${savedRecipes.map(r => r.title).join(', ')}
  Dietary: ${profile.dietary_prefs.join(', ')}
  Goal: ${profile.fitness_goal}
`

const userEmbedding = await openai.embeddings.create({
  input: userPrefsText,
  model: 'text-embedding-3-small'
})

// Find similar recipes (pgvector extension)
const recommendations = await supabase.rpc('match_recipes', {
  query_embedding: userEmbedding.data[0].embedding,
  match_threshold: 0.7,
  match_count: 20
})
```

---

## Part 7: Incremental Build Plan (Sprint by Sprint)

### ✅ **Sprint 1-2: Foundation (DONE)**
- Auth + basic recipe extraction
- Private cookbooks
- `/extract`, `/apify-webhook`, `/result` endpoints

### 🔨 **Sprint 3: Public Sharing (Week 3)**
```sql
-- Tables: profiles, cookbooks (with visibility)
-- Endpoints:
POST /cookbooks/:id/publish
GET /discover/cookbooks
GET /@username
GET /creators/:handle
```

### 🔨 **Sprint 4: Following (Week 4)**
```sql
-- Tables: follows
-- Endpoints:
POST /@username/follow
DELETE /@username/follow
GET /@username/followers
```

### 🔨 **Sprint 5: Social Feed (Week 5)**
```sql
-- Tables: cooking_posts, activities
-- Endpoints:
POST /posts (upload cooking photo)
GET /feed (see what friends cooked)
```

### 🔨 **Sprint 6: Engagement (Week 6)**
```sql
-- Tables: likes, comments
-- Endpoints:
POST /posts/:id/like
POST /posts/:id/comment
```

### 🔨 **Sprint 7: Discovery (Week 7)**
```sql
-- Tables: user_recipe_interactions
-- Endpoints:
GET /discover/swipe (Tinder UI)
POST /interactions (track swipes)
GET /search (search recipes/users/cookbooks)
```

### 🔨 **Sprint 8: Meal Planning (Week 8-9)**
```sql
-- Tables: meal_plans, grocery_lists
-- Endpoints:
POST /meal-plans
POST /meal-plans/:id/recipes
GET /meal-plans/:id/grocery-list
POST /grocery-lists/:id/export
```

### 🔨 **Sprint 9: AI Recommendations (Week 10+)**
```python
-- ML pipeline (batch job)
-- Endpoint:
GET /discover/for-you (personalized feed)
```

---

## Part 8: Mobile App Decision Point

### Metrics to Track (Web App)

```
Launch web app → measure for 2-3 months:

📊 Core Metrics:
- DAU (Daily Active Users)
- Recipe extraction rate (% success)
- Save rate (% of extractions → saved)
- Retention (% users return after 7/30 days)

📊 Mobile Signals (when to build app):
- % mobile web traffic > 70%  ← If true, users want mobile!
- User feedback: "I wish this was an app"
- Feature requests needing native:
  - "Push notifications for new posts"
  - "Offline access to recipes"
  - "Camera integration"
```

### When to Build Mobile App

**Build if:**
- ✅ Web app has 1,000+ weekly active users
- ✅ 70%+ traffic is mobile browsers
- ✅ Users explicitly asking for app
- ✅ You have budget ($5k-10k for contractor, or 2-3 months your time)
- ✅ Core features are polished on web

**Don't build if:**
- ❌ <500 users (premature optimization)
- ❌ Web app still has bugs/incomplete features
- ❌ Most traffic is desktop (meal planning use case)

### Hybrid Approach: PWA (Progressive Web App)

```typescript
// Add to your Next.js app (takes 1 day)
// next.config.js
const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
})

module.exports = withPWA({
  // your config
})
```

**PWA gives you:**
- ✅ "Add to Home Screen" (looks like native app)
- ✅ Offline support (cache recipes)
- ✅ Push notifications (with service worker)
- ✅ Fast loading (pre-caching)

**70% of native app benefits, 5% of the effort!**

---

## Part 9: Why This Design is Scalable

### Scenario 1: 1 Million Users

```
1M users × 20 saved recipes each = 20M saved recipes

❌ Full duplication:
20M × 50KB = 1TB

✅ Copy-on-Write (assuming 100K unique TikToks):
100K × 50KB (canonical) + 20M × 0.1KB (pointers) = 7GB

Savings: 99.3%!
```

### Scenario 2: Viral Recipe

```
1 TikTok goes viral → 50,000 users save it in 1 day

❌ Bad design:
- 50,000 separate recipe rows
- 50,000 × 50KB = 2.5GB written
- Database chokes

✅ Your design:
- 1 recipe row (50KB)
- 50,000 tiny user_saved_recipes rows (5MB)
- Total: 5.05MB written
- Database happy!
```

### Scenario 3: User Modifies Recipe

```
Alice modifies "use almond milk instead of regular"

❌ If you stored in recipes table:
- Breaks for all other users!

✅ Your design:
user_saved_recipes:
  user_id: alice
  recipe_id: tiktok_123
  modified_data: { /* her version */ }

- Only Alice sees modified version
- Everyone else sees original
- Perfect isolation!
```

---

## Part 10: Summary & Next Steps

### Architecture Decision: ✅ Approved

```
✅ recipes table = single source of truth (not "cache")
✅ user_saved_recipes = copy-on-write pointers
✅ Separate cooking_posts for social proof
✅ Activity feed for chronological social stream
✅ Creator pages auto-generated from recipes table
✅ Tinder swipe UI with ML recommendations
✅ Web app first, mobile app later (when metrics prove demand)
```

### Database Size Estimates

```
100K unique recipes × 50KB         = 5GB
1M users × 100 bytes (profile)     = 100MB
1M users × 20 saved recipes × 1KB  = 20GB
1M cooking posts × 2KB             = 2GB
10M activities × 500 bytes         = 5GB
                              Total = 32GB

PostgreSQL can handle this easily (Supabase free tier = 500MB, paid = unlimited)
```

### Your Next Steps

1. **Rename `cache` → `recipes`** in your existing code (just mental model)
2. **Add `profiles` table** (foundation for social)
3. **Add `user_saved_recipes` table** (copy-on-write pattern)
4. **Build web app** (Next.js + Tailwind)
5. **Launch + measure** (2-3 months)
6. **Add social features** (if users engage)
7. **Consider mobile app** (if 70%+ mobile traffic)

Want me to generate:
- [ ] Full migration SQL file with all tables?
- [ ] Sample Next.js pages (homepage, recipe detail, swipe UI)?
- [ ] Edge function code for new endpoints?
- [ ] ML recommendation algorithm (simple version)?

Let me know what to build next! 🚀
