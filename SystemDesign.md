# TikTok Recipe App - System Design

> **For:** Solo indie hacker learning backend/system design
> **Focus:** Fast iteration, low cost, scalable architecture
> **Philosophy:** Start simple, add complexity only when needed

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Core Architecture](#core-architecture)
3. [Database Design](#database-design)
4. [Storage Optimization Strategy](#storage-optimization-strategy)
5. [Technology Stack](#technology-stack)
6. [Feature Rollout Plan](#feature-rollout-plan)
7. [Mobile Strategy](#mobile-strategy)
8. [Recommendation System](#recommendation-system)
9. [Cost Analysis](#cost-analysis)
10. [Scaling Considerations](#scaling-considerations)

---

## Executive Summary

### What We're Building

A social recipe discovery platform where users:
1. Extract recipes from TikTok videos (caption/transcript → structured recipe)
2. Save recipes to personal cookbooks/collections
3. Follow creators and friends to see what they're cooking
4. Plan weekly meals with Tinder-style recipe swiping
5. Generate smart grocery lists with one-click export
6. Share photos of dishes they've made
7. Get personalized recommendations based on preferences + fitness goals

### Why This Architecture?

**Core Principle: Canonical Source + User Snapshots**

```
TikTok Video → Extracted Once → Stored in `recipes` (canonical)
                                      ↓
                    1000 users save it → 1000 rows in `user_recipes` (snapshots)
                                      ↓
                    User modifies their copy → Their snapshot diverges
                                      ↓
                    Original stays unchanged for others
```

**Key Design Decisions:**

| Decision | Why | Cost Savings |
|----------|-----|--------------|
| Supabase Edge Functions | Serverless = zero idle cost | ~$0-20/mo vs $50-200/mo VPS |
| Deno Runtime | Fast cold starts, TypeScript native | Better UX, less DevOps |
| Recipe deduplication | One TikTok = one canonical recipe | 1000x storage reduction |
| User snapshots | Users can modify without affecting others | Best of both worlds |
| RLS (Row Level Security) | Database enforces permissions | Less backend code |
| PWA before native app | 90% of mobile UX, 10% of dev time | Ship faster |

---

## Core Architecture

### High-Level System Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INTERACTIONS                          │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React/Next.js)                      │
│  • Paste TikTok link                                                 │
│  • Swipe through recipes (Tinder UI)                                 │
│  • Create cookbooks/meal plans                                       │
│  • Follow users, like/comment                                        │
└────────────┬────────────────────────────────────────────────────────┘
             │ HTTPS (REST API)
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  SUPABASE EDGE FUNCTIONS (API Layer)                 │
│                                                                       │
│  POST   /extract          → Extract recipe from TikTok               │
│  GET    /result           → Poll extraction status                   │
│  POST   /apify-webhook    → Receive transcript from Apify            │
│                                                                       │
│  GET    /recipes/:id      → Get canonical recipe                     │
│  POST   /user-recipes     → Save recipe to cookbook                  │
│  PATCH  /user-recipes/:id → Modify saved recipe                      │
│                                                                       │
│  GET    /feed             → Activity feed (following)                │
│  GET    /discover         → Explore public recipes/cookbooks         │
│  GET    /recommendations  → Personalized recipe suggestions          │
│                                                                       │
│  POST   /meal-plans       → Create weekly meal plan                  │
│  POST   /grocery-lists    → Generate grocery list                    │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    SUPABASE POSTGRES (Database)                      │
│                                                                       │
│  ┌─────────────────────────────────────────────────────┐             │
│  │  CORE TABLES (Recipe Storage & Deduplication)      │             │
│  ├─────────────────────────────────────────────────────┤             │
│  │  • recipes (canonical TikTok recipes)               │             │
│  │  • user_recipes (user's saved/modified copies)      │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  ┌─────────────────────────────────────────────────────┐             │
│  │  SOCIAL TABLES                                      │             │
│  ├─────────────────────────────────────────────────────┤             │
│  │  • profiles (public user info)                      │             │
│  │  • follows (who follows who)                        │             │
│  │  • activities (feed events)                         │             │
│  │  • cooking_posts (photos of dishes made)            │             │
│  │  • likes, comments                                  │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  ┌─────────────────────────────────────────────────────┐             │
│  │  ORGANIZATION TABLES                                │             │
│  ├─────────────────────────────────────────────────────┤             │
│  │  • cookbooks (user collections)                     │             │
│  │  • cookbook_recipes (many-to-many join)             │             │
│  │  • meal_plans (weekly planning)                     │             │
│  │  • grocery_lists (shopping lists)                   │             │
│  └─────────────────────────────────────────────────────┘             │
│                                                                       │
│  ┌─────────────────────────────────────────────────────┐             │
│  │  PERSONALIZATION TABLES                             │             │
│  ├─────────────────────────────────────────────────────┤             │
│  │  • user_preferences (dietary restrictions, goals)   │             │
│  │  • user_interactions (swipes, views, cooks)         │             │
│  │  • recipe_embeddings (vector search for similarity) │             │
│  └─────────────────────────────────────────────────────┘             │
└────────────┬────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL SERVICES                              │
│                                                                       │
│  • Apify (TikTok scraping - transcript extraction)                   │
│  • OpenAI (Recipe normalization + embeddings)                        │
│  • Instacart API (Grocery export)                                    │
│  • Supabase Storage (User photos, avatars)                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Design

### Core Philosophy: "Cache" IS the Recipe Table

**You're right!** The `cache` table is really a **canonical recipes table**. Let's rename it:

```sql
-- OLD NAME: cache (confusing)
-- NEW NAME: recipes (clear)

create table public.recipes (
  id              uuid primary key default gen_random_uuid(),

  -- Deduplication key (TikTok video ID)
  source_key      text unique not null,  -- 'tiktok_7123456789'
  source_type     text not null check (source_type in ('tiktok', 'youtube', 'instagram')),
  source_url      text not null,

  -- Extraction status
  status          text not null check (status in ('PENDING', 'READY', 'FAILED')),

  -- Canonical recipe data (from OpenAI normalization)
  recipe_data     jsonb,  -- Structured: {title, ingredients, steps, nutrition, time, etc}

  -- TikTok creator attribution
  creator_username text,
  creator_url      text,
  creator_avatar   text,

  -- Extraction metadata
  extraction_method text,  -- 'caption' or 'transcript'
  raw_caption      text,
  raw_transcript   text,
  model_used       text,   -- 'gpt-4o-mini', etc

  -- Engagement stats (denormalized for discovery page)
  save_count       int default 0,
  cook_count       int default 0,  -- How many users posted "I made this"
  view_count       int default 0,

  -- Timestamps
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),

  -- Error tracking
  error_message    text,
  error_type       text
);

-- Indexes for performance
create index idx_recipes_source_key on recipes(source_key);
create index idx_recipes_status on recipes(status);
create index idx_recipes_creator on recipes(creator_username);
create index idx_recipes_popularity on recipes(save_count desc, cook_count desc);
```

**Why this design?**
- ✅ One TikTok video = one row (deduplication)
- ✅ Clear naming: "recipes" not "cache"
- ✅ Stores original creator attribution
- ✅ Tracks engagement for discovery/trending
- ✅ No RLS (server-owned canonical data)

### User's Personal Recipe Storage

```sql
-- User's saved recipes (can be modified)
create table public.user_recipes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  recipe_id       uuid references recipes not null,

  -- User's snapshot of recipe data
  recipe_data     jsonb not null,  -- Copy of recipes.recipe_data at save time

  -- Has user modified it?
  is_modified     boolean default false,
  modified_at     timestamptz,

  -- User's metadata
  personal_notes  text,
  personal_rating int check (personal_rating between 1 and 5),
  times_cooked    int default 0,

  -- Which cookbook(s) is this in?
  -- (handled by cookbook_recipes join table)

  saved_at        timestamptz default now(),
  last_viewed_at  timestamptz,

  unique(user_id, recipe_id)  -- Can't save same recipe twice
);

create index idx_user_recipes_user on user_recipes(user_id);
create index idx_user_recipes_recipe on user_recipes(recipe_id);

-- RLS: users only see their own saved recipes
alter table user_recipes enable row level security;

create policy "Users manage own saved recipes" on user_recipes
  for all using (auth.uid() = user_id);
```

**Why separate tables?**

```
┌─────────────────────────────────────────────────────────┐
│  recipes (1 row per TikTok video)                       │
│  • id: abc-123                                           │
│  • source_key: tiktok_7123456                            │
│  • recipe_data: {original recipe JSON}                   │
│  • save_count: 1000                                      │
└─────────────────────────────────────────────────────────┘
                          ↓
         Saved by 1000 users → 1000 rows in user_recipes
                          ↓
┌─────────────────────────────────────────────────────────┐
│  user_recipes (1000 rows, one per user)                 │
├─────────────────────────────────────────────────────────┤
│  User A: recipe_data: {original}, is_modified: false    │
│  User B: recipe_data: {modified: +garlic}, modified: true│
│  User C: recipe_data: {original}, notes: "delicious!"   │
│  ...                                                     │
└─────────────────────────────────────────────────────────┘
```

**Storage cost:**
- **Without deduplication:** 1000 users × 10KB recipe = 10MB
- **With deduplication:** 1 canonical × 10KB + 1000 refs × 0.1KB = 110KB
- **Savings: 99%** 🎉

### Cookbooks (Collections)

```sql
create table public.cookbooks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,

  name            text not null,
  description     text,
  cover_image     text,

  -- Visibility
  visibility      text not null check (visibility in ('private', 'public', 'unlisted')) default 'private',

  -- Official/featured (only you as admin can set)
  is_official     boolean default false,
  featured_at     timestamptz,

  -- Stats
  recipe_count    int default 0,
  follower_count  int default 0,

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Many-to-many: user_recipes ←→ cookbooks
create table public.cookbook_recipes (
  cookbook_id     uuid references cookbooks on delete cascade,
  user_recipe_id  uuid references user_recipes on delete cascade,

  sort_order      int default 0,
  added_at        timestamptz default now(),

  primary key (cookbook_id, user_recipe_id)
);
```

### Social Tables

```sql
-- User profiles (extends auth.users)
create table public.profiles (
  id              uuid primary key references auth.users on delete cascade,
  username        text unique not null,
  display_name    text not null,
  bio             text,
  avatar_url      text,

  -- Stats
  follower_count  int default 0,
  following_count int default 0,
  recipe_count    int default 0,  -- Recipes they've extracted

  -- Settings
  is_private      boolean default false,
  is_verified     boolean default false,

  created_at      timestamptz default now()
);

-- Follows
create table public.follows (
  follower_id     uuid references auth.users,
  following_id    uuid references auth.users,
  followed_at     timestamptz default now(),
  primary key (follower_id, following_id)
);

-- Activity feed
create table public.activities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  activity_type   text not null,  -- 'saved_recipe', 'cooked_recipe', 'created_cookbook'

  -- Polymorphic references
  recipe_id       uuid references recipes,
  user_recipe_id  uuid references user_recipes,
  cookbook_id     uuid references cookbooks,
  cooking_post_id uuid references cooking_posts,

  created_at      timestamptz default now()
);

-- "I cooked this" posts
create table public.cooking_posts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  user_recipe_id  uuid references user_recipes not null,

  photo_url       text not null,
  caption         text,
  rating          int check (rating between 1 and 5),

  like_count      int default 0,
  comment_count   int default 0,

  created_at      timestamptz default now()
);
```

### Meal Planning Tables

```sql
create table public.meal_plans (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  name            text not null,
  start_date      date not null,
  end_date        date,
  created_at      timestamptz default now()
);

create table public.meal_plan_recipes (
  id              uuid primary key default gen_random_uuid(),
  meal_plan_id    uuid references meal_plans on delete cascade,
  user_recipe_id  uuid references user_recipes on delete cascade,

  scheduled_date  date not null,
  meal_type       text check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  servings        int default 1
);

create table public.grocery_lists (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  meal_plan_id    uuid references meal_plans,
  name            text not null,
  status          text default 'draft',
  created_at      timestamptz default now()
);

create table public.grocery_list_items (
  id              uuid primary key default gen_random_uuid(),
  grocery_list_id uuid references grocery_lists on delete cascade,
  ingredient      text not null,
  quantity        decimal,
  unit            text,
  category        text,
  checked         boolean default false
);
```

### Personalization Tables (Future)

```sql
-- User preferences for recommendations
create table public.user_preferences (
  user_id         uuid primary key references auth.users,

  -- Dietary restrictions
  dietary_restrictions jsonb,  -- ['vegetarian', 'gluten-free', 'dairy-free']
  allergies       jsonb,
  cuisine_preferences jsonb,  -- ['italian', 'mexican', 'asian']

  -- Fitness goals
  fitness_goal    text check (fitness_goal in ('lose_weight', 'maintain', 'gain_muscle', 'performance')),
  target_calories int,
  target_protein  int,
  target_carbs    int,
  target_fat      int,

  -- Cooking preferences
  max_cook_time   int,  -- minutes
  skill_level     text check (skill_level in ('beginner', 'intermediate', 'advanced')),

  updated_at      timestamptz default now()
);

-- Track user interactions for recommendation engine
create table public.user_interactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  recipe_id       uuid references recipes not null,

  interaction_type text not null,  -- 'view', 'save', 'cook', 'like', 'swipe_right', 'swipe_left'

  -- For swipe interactions
  swipe_direction text,  -- 'right' (like), 'left' (pass)

  created_at      timestamptz default now()
);

create index idx_user_interactions_user on user_interactions(user_id, created_at desc);
create index idx_user_interactions_recipe on user_interactions(recipe_id);

-- Recipe embeddings for similarity search (vector DB)
-- Using pgvector extension
create extension if not exists vector;

create table public.recipe_embeddings (
  recipe_id       uuid primary key references recipes,
  embedding       vector(1536),  -- OpenAI ada-002 embedding size
  generated_at    timestamptz default now()
);

create index on recipe_embeddings using ivfflat (embedding vector_cosine_ops);
```

---

## Storage Optimization Strategy

### The Deduplication Problem

**Scenario:** 10,000 users save the same viral TikTok pasta recipe.

**Bad approach (no deduplication):**
```sql
-- Store full recipe 10,000 times
user_recipes:
  user1: {full recipe JSON - 10KB}
  user2: {full recipe JSON - 10KB}
  ...
  user10000: {full recipe JSON - 10KB}

Total: 10,000 × 10KB = 100MB for ONE recipe! 😱
```

**Good approach (our design):**
```sql
-- Store recipe once
recipes:
  id: abc-123
  recipe_data: {full recipe JSON - 10KB}

-- Store only references + modifications
user_recipes:
  user1: {recipe_id: abc-123, is_modified: false} - 0.2KB
  user2: {recipe_id: abc-123, is_modified: false} - 0.2KB
  ...
  user10000: {recipe_id: abc-123, is_modified: false} - 0.2KB

Total: 10KB + (10,000 × 0.2KB) = 2MB savings: 98%! 🎉
```

### But Wait: Why Store `recipe_data` in `user_recipes` at All?

**Great question!** Here's the tradeoff:

**Option A: Store reference only (max deduplication)**
```sql
user_recipes:
  recipe_id: abc-123  -- Just a foreign key
  is_modified: false
  personal_notes: "loved it!"
```

**Pros:** Maximum storage efficiency
**Cons:**
- User modifications require complex JSON patching
- Can't show "your version" vs "original" easily
- Harder to query "show all my saved recipes" (needs join)

**Option B: Snapshot at save time (our approach)**
```sql
user_recipes:
  recipe_id: abc-123
  recipe_data: {snapshot of recipe at save time}
  is_modified: false
```

**Pros:**
- Fast queries (no joins needed)
- User can modify freely without affecting original
- Can detect when original was updated (compare timestamps)
- Better UX: "This recipe was updated. View changes?"

**Cons:**
- Uses more storage (~10KB per save instead of 0.2KB)

### The Hybrid Approach (Best of Both Worlds)

```sql
create table public.user_recipes (
  recipe_id       uuid references recipes not null,

  -- Only store snapshot IF user has modified it
  recipe_data     jsonb,  -- NULL if unmodified (saves storage)
  is_modified     boolean default false,

  -- Always store these (lightweight)
  personal_notes  text,
  personal_rating int
);

-- Query logic:
-- If recipe_data IS NULL → fetch from recipes table (canonical)
-- If recipe_data IS NOT NULL → use user's modified version
```

**Storage for 10,000 unmodified saves:**
```
recipes: 10KB (canonical)
user_recipes: 10,000 × 0.5KB = 5MB (refs only, no recipe_data)
Total: 5.01MB
```

**If 100 users modify it:**
```
recipes: 10KB (canonical)
user_recipes:
  - 9,900 unmodified × 0.5KB = 5MB
  - 100 modified × 10KB = 1MB
Total: 6.01MB
```

**Decision: Start with Option B (always snapshot), optimize later if needed.**

Why? You're a solo dev - premature optimization is evil. Storage is cheap ($0.021/GB on Supabase). Developer time is expensive.

---

## Technology Stack

### Why These Choices?

| Technology | Alternative | Why This One | Cost |
|------------|-------------|--------------|------|
| **Supabase** | Firebase, AWS Amplify | Postgres (not NoSQL), RLS built-in, open source | $0-25/mo |
| **Edge Functions** | Express on VPS, Lambda | Zero cold start cost, auto-scaling | $0-10/mo |
| **Deno** | Node.js | Faster cold starts, TypeScript native, better DX | Free |
| **Next.js** | Vite, CRA | SSR for SEO, API routes, image optimization | Free (Vercel) |
| **React** | Vue, Svelte | Largest ecosystem, easier to hire help | Free |
| **TailwindCSS** | Bootstrap, MUI | Faster development, smaller bundle | Free |
| **Postgres** | MongoDB, MySQL | Best SQL DB, JSON support, vector search | Included |
| **Row Level Security** | Writing auth middleware | Database enforces it, fewer bugs | Free |
| **OpenAI** | Anthropic, local models | Best structured output, embeddings | $5-50/mo |
| **Apify** | Build scraper yourself | Pre-built TikTok actor, maintains scraper | $49+/mo |

### Total Monthly Cost Estimate

**MVP (0-1000 users):**
- Supabase: $0 (free tier: 500MB DB, 2GB storage, 50GB bandwidth)
- Edge Functions: $0 (free tier: 500K invocations)
- OpenAI: $10 (100 recipe extractions/day)
- Apify: $49 (starter plan)
- **Total: ~$60/mo**

**Growth (1K-10K users):**
- Supabase: $25 (Pro tier: 8GB DB, 100GB storage)
- Edge Functions: $10 (5M invocations)
- OpenAI: $50 (1000 recipes/day)
- Apify: $149 (scale plan)
- **Total: ~$234/mo**

**Scale (10K-100K users):**
- Supabase: $599 (Team tier: 32GB DB, 250GB storage)
- OpenAI: $200
- Apify: $499
- **Total: ~$1,298/mo**

**Compare to traditional stack:**
- AWS EC2 + RDS: $150-500/mo minimum (always-on servers)
- Heroku: $250+/mo
- Digital Ocean: $100+/mo

---

## Feature Rollout Plan

### Phase 1: Core Product (MVP) - Weeks 1-2

**Goal:** User can extract recipes and save to cookbooks.

**Features:**
- ✅ User signup/login (Supabase Auth)
- ✅ Paste TikTok link → extract recipe
- ✅ Save recipe to personal cookbook
- ✅ View saved recipes

**Tables needed:**
- `profiles`
- `recipes` (renamed from cache)
- `user_recipes`
- `cookbooks`
- `cookbook_recipes`

**Endpoints:**
- `POST /extract`
- `GET /result`
- `POST /cookbooks`
- `POST /user-recipes`

**Success metric:** 10 beta users extract and save 50 recipes.

---

### Phase 2: Discovery & Sharing - Week 3

**Goal:** Users can find and share recipes.

**Features:**
- Public cookbooks (set visibility)
- Browse/search public recipes
- Creator attribution pages (see all recipes from @gordonramsay)
- Share links to recipes/cookbooks

**New tables:**
- None (use existing with visibility)

**New endpoints:**
- `GET /discover/recipes?sort=popular`
- `GET /discover/cookbooks`
- `GET /creators/:username`

**UI needed:**
- Discovery page with filters
- Creator profile page
- Share button

**Success metric:** 30% of users browse discovery page.

---

### Phase 3: Social Features - Week 4

**Goal:** Users can follow others and see activity.

**Features:**
- Follow/unfollow users
- Activity feed (see what people you follow are cooking)
- "I cooked this" posts with photos

**New tables:**
- `follows`
- `activities`
- `cooking_posts`

**New endpoints:**
- `POST /users/:id/follow`
- `GET /feed`
- `POST /cooking-posts`

**UI needed:**
- Follow button
- Feed page (Instagram-style)
- Camera upload for cooking posts

**Success metric:** 20% of users follow someone.

---

### Phase 4: Tinder-Style Meal Planning - Week 5-6

**Goal:** Users swipe through recipes to plan their week.

**Features:**
- Swipe right (add to meal plan), left (skip)
- Weekly calendar view
- Drag recipes to specific days/meals
- Smart suggestions based on swipe history

**New tables:**
- `meal_plans`
- `meal_plan_recipes`
- `user_interactions` (track swipes)

**New endpoints:**
- `GET /recommendations/swipe?day=monday&meal=dinner`
- `POST /meal-plans`
- `POST /interactions` (track swipe)

**UI needed:**
- Tinder card component
- Weekly calendar view
- Swipe gestures (mobile-first)

**Algorithm (simple v1):**
```typescript
// Recommend recipes user hasn't seen + match their past saves
function getSwipeRecommendations(userId: string) {
  // 1. Get recipes user hasn't interacted with
  // 2. Prioritize:
  //    - Similar to recipes they've saved (cuisine, time, difficulty)
  //    - Popular recipes (high save_count)
  //    - From creators they follow
  // 3. Randomize a bit to avoid echo chamber
  return recipes.slice(0, 20)  // Show 20 cards per session
}
```

**Success metric:** 40% of users create a meal plan.

---

### Phase 5: Grocery Lists - Week 7

**Goal:** One-click grocery list from meal plan.

**Features:**
- Auto-generate list from meal plan
- Aggregate duplicate ingredients ("2 eggs" + "4 eggs" = "6 eggs")
- Categorize by aisle (produce, meat, dairy)
- Export to Instacart

**New tables:**
- `grocery_lists`
- `grocery_list_items`

**Algorithm:**
```typescript
async function generateGroceryList(mealPlanId: string) {
  const recipes = await getMealPlanRecipes(mealPlanId)

  // Extract all ingredients
  const allIngredients = recipes.flatMap(r =>
    r.recipe_data.ingredients.map(ing => ({
      item: ing.item,
      quantity: ing.quantity * r.servings,
      unit: ing.unit
    }))
  )

  // Aggregate duplicates
  const aggregated = aggregateIngredients(allIngredients)

  // Categorize (simple keyword matching, later use AI)
  const categorized = categorizeByAisle(aggregated)

  return categorized
}
```

**Success metric:** 60% of meal planners generate a grocery list.

---

### Phase 6: Personalization - Week 8+

**Goal:** Recommendations get smarter based on user preferences.

**Features:**
- Onboarding: dietary restrictions, fitness goals
- Smart recommendations (ML-based)
- "Because you liked X" sections
- Calorie/macro tracking integration

**New tables:**
- `user_preferences`
- `recipe_embeddings` (vector search)

**Algorithm (advanced v2):**
```typescript
// Use OpenAI embeddings for semantic similarity
async function getPersonalizedRecommendations(userId: string) {
  const prefs = await getUserPreferences(userId)
  const liked = await getUserLikedRecipes(userId)

  // 1. Filter by dietary restrictions
  let candidates = await getRecipes({
    excludeIngredients: prefs.allergies,
    matchCuisines: prefs.cuisine_preferences
  })

  // 2. Find similar recipes using vector search
  const likedEmbeddings = await getRecipeEmbeddings(liked.map(r => r.id))
  const avgEmbedding = average(likedEmbeddings)

  const similar = await db.from('recipe_embeddings')
    .select('recipe_id')
    .order('embedding <=> $1', avgEmbedding)  // Vector distance
    .limit(50)

  // 3. Filter by fitness goals (calories, protein, etc)
  if (prefs.fitness_goal === 'lose_weight') {
    candidates = candidates.filter(r => r.calories < prefs.target_calories)
  }

  return candidates
}
```

**Success metric:** 70% click-through rate on recommendations.

---

## Mobile Strategy

### PWA First (Progressive Web App)

**What is PWA?**
A web app that works like a native app:
- Install to home screen
- Works offline
- Push notifications
- Camera access
- Gestures (swipe, pull to refresh)

**Why PWA before native app?**

| Feature | PWA | Native App | Winner |
|---------|-----|------------|--------|
| Development time | 1 week | 6 weeks | PWA |
| Maintenance | One codebase | Two codebases (iOS + Android) | PWA |
| Distribution | URL link | App Store approval (1-2 weeks) | PWA |
| Updates | Instant | Re-download app | PWA |
| SEO | Excellent | None | PWA |
| Performance | 90% native | 100% native | Tie |
| Device features | Camera, GPS, push | Everything | Native (barely) |
| User trust | Lower (not in App Store) | Higher | Native |

**Decision: Build PWA first, native app when:**
- You have 10K+ monthly active users
- Users explicitly ask for it
- You need features PWA can't do (background processing, advanced AR, etc)

### PWA Implementation Checklist

```typescript
// 1. Add manifest.json
{
  "name": "TikTok Recipes",
  "short_name": "Recipes",
  "start_url": "/",
  "display": "standalone",  // Hides browser chrome
  "theme_color": "#FF6B6B",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192" },
    { "src": "/icon-512.png", "sizes": "512x512" }
  ]
}

// 2. Add service worker for offline
// next.config.js
const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true
})

module.exports = withPWA({
  // Your Next.js config
})

// 3. Optimize for mobile gestures
// Use react-swipeable for Tinder cards
import { useSwipeable } from 'react-swipeable'

const handlers = useSwipeable({
  onSwipedLeft: () => skipRecipe(),
  onSwipedRight: () => saveRecipe(),
})
```

### When to Build Native App

**Trigger: 10K MAU (monthly active users) OR user complaints about performance.**

**Why wait?**
- Native apps are 5-10x more expensive to maintain
- App Store approval delays your velocity
- Most food/recipe apps work fine as PWA (Tasty, AllRecipes, etc)

**When you do build native:**
- Use React Native (reuse your React code)
- Or Flutter (better performance, but new language)
- Focus on iOS first (US users, higher revenue)

---

## Recommendation System

### Evolution: Simple → Smart → ML

### V1: Simple Heuristics (Week 1)

**Goal:** Show popular recipes user hasn't seen.

```typescript
function getRecommendations(userId: string) {
  return db.from('recipes')
    .select('*')
    .where('status', 'READY')
    .where('id', 'not in', userSeenRecipeIds)
    .order('save_count', 'desc')
    .limit(20)
}
```

**Pros:** Dead simple, works immediately
**Cons:** Everyone sees the same recipes (no personalization)

---

### V2: Collaborative Filtering (Week 4)

**Goal:** "Users who saved X also saved Y"

```typescript
function getRecommendations(userId: string) {
  // 1. Find similar users (users who saved same recipes as me)
  const similarUsers = await db.from('user_recipes')
    .select('user_id')
    .where('recipe_id', 'in', myRecipeIds)
    .where('user_id', '!=', userId)
    .groupBy('user_id')
    .orderBy('count(*)', 'desc')
    .limit(100)

  // 2. Get recipes those users saved (that I haven't)
  const recommendations = await db.from('user_recipes')
    .select('recipe_id, count(*) as score')
    .where('user_id', 'in', similarUsers)
    .where('recipe_id', 'not in', myRecipeIds)
    .groupBy('recipe_id')
    .orderBy('score', 'desc')
    .limit(20)

  return recommendations
}
```

**Pros:** Personalized, easy to implement
**Cons:** Cold start problem (new users have no data)

---

### V3: Content-Based + Swipe History (Week 5)

**Goal:** Learn from swipes (instant feedback).

```typescript
function getSwipeRecommendations(userId: string) {
  // Track every swipe
  await db.from('user_interactions').insert({
    user_id: userId,
    recipe_id: recipeId,
    interaction_type: 'swipe',
    swipe_direction: direction  // 'left' or 'right'
  })

  // Get user's swipe patterns
  const liked = await getLikedRecipeFeatures(userId)
  // liked = [
  //   { cuisine: 'italian', cook_time: 30, difficulty: 'easy' },
  //   { cuisine: 'mexican', cook_time: 20, difficulty: 'easy' },
  //   ...
  // ]

  // Find recipes matching those patterns
  const recommendations = await db.from('recipes')
    .select('*')
    .where('cuisine', 'in', liked.cuisines)
    .where('cook_time', '<', avg(liked.cook_times) + 10)
    .where('id', 'not in', seenRecipeIds)
    .limit(20)

  return recommendations
}
```

**Pros:** Fast learning, works for new users
**Cons:** Still rule-based (not true ML)

---

### V4: Vector Embeddings + Semantic Search (Week 8+)

**Goal:** Find semantically similar recipes using AI.

```typescript
// 1. Generate embeddings for all recipes (one-time job)
async function generateEmbeddings() {
  const recipes = await db.from('recipes').select('*')

  for (const recipe of recipes) {
    // Create text representation
    const text = `
      ${recipe.recipe_data.title}
      ${recipe.recipe_data.description}
      Ingredients: ${recipe.recipe_data.ingredients.join(', ')}
      Cuisine: ${recipe.recipe_data.cuisine}
      Time: ${recipe.recipe_data.total_time} minutes
    `

    // Get embedding from OpenAI
    const embedding = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    })

    // Store in DB
    await db.from('recipe_embeddings').insert({
      recipe_id: recipe.id,
      embedding: embedding.data[0].embedding
    })
  }
}

// 2. Find similar recipes using vector search
async function getSimilarRecipes(recipeId: string) {
  const target = await db.from('recipe_embeddings')
    .select('embedding')
    .eq('recipe_id', recipeId)
    .single()

  // pgvector cosine similarity search
  const similar = await db.from('recipe_embeddings')
    .select('recipe_id, embedding <=> $1 as distance')
    .order('distance', 'asc')
    .limit(20)

  return similar
}

// 3. Personalized recommendations
async function getPersonalizedRecommendations(userId: string) {
  // Get user's liked recipes
  const liked = await getUserLikedRecipes(userId)

  // Average their embeddings (user taste profile)
  const userEmbedding = averageEmbeddings(liked.map(r => r.embedding))

  // Find recipes close to user's taste
  const recommendations = await db.from('recipe_embeddings')
    .select('recipe_id, embedding <=> $1 as score')
    .order('score', 'asc')
    .limit(50)

  // Blend with popularity (80% personalized, 20% popular)
  return blendRecommendations(recommendations, popularRecipes, 0.8)
}
```

**Pros:**
- Understands semantic similarity ("pasta carbonara" similar to "spaghetti alla gricia")
- No manual feature engineering
- Works across languages

**Cons:**
- Costs money (OpenAI API)
- Requires pgvector extension
- More complex

**Cost:** ~$0.0001 per recipe embedding (one-time). For 10K recipes = $1.

---

### V5: Full ML Model (When you have 100K+ users)

At scale, train your own model:
- Use TensorFlow or PyTorch
- Input: user history + recipe features
- Output: predicted rating
- Host on Modal, Replicate, or AWS SageMaker

**But honestly?** V4 (embeddings) is probably enough for years.

---

## Creator Pages & Discovery

### Creator Attribution Page

**URL:** `/creators/@gordonramsay` or `/creators/tiktok-gordonramsay`

**Features:**
- Show all recipes from this TikTok creator
- Creator bio (scraped from TikTok)
- Follow button (get notified when they post new recipes)
- Stats: X recipes, Y saves, Z cooks

**Query:**
```typescript
// Get all recipes from creator
const recipes = await db.from('recipes')
  .select('*')
  .eq('creator_username', 'gordonramsay')
  .order('created_at', 'desc')
```

**Why this matters:**
- SEO: "Gordon Ramsay TikTok recipes" → your site
- User trust: Attribute to original creator
- Discovery: Users can binge a creator's content

---

### Home Page for Meal Planning

**Layout:**

```
┌────────────────────────────────────┐
│  Plan Your Week                    │
│                                    │
│  [Monday Dinner]                   │
│                                    │
│  ┌──────────────────────────────┐ │
│  │                              │ │
│  │   Creamy Garlic Shrimp Pasta │ │
│  │                              │ │
│  │   ⏱ 25 min  🔥 Easy          │ │
│  │   🥗 520 cal  ⭐ 4.8         │ │
│  │                              │ │
│  │   [@chef_amanda]             │ │
│  │                              │ │
│  └──────────────────────────────┘ │
│                                    │
│    👍 Save     ❌ Skip    💡 Swap  │
│                                    │
│  ▢ ▢ ▢ ▢ ▢ ▢ ▢  (7 days progress) │
└────────────────────────────────────┘
```

**UX Flow:**
1. User opens app → "Plan your week?"
2. Picks day + meal type (Monday Dinner)
3. Swipes through 10-20 recipe cards
4. Right swipe = add to Monday dinner
5. Left swipe = skip
6. Up swipe = "save for later" (not this week)
7. Repeat for each meal

**Algorithm:**
```typescript
function getSwipeRecommendations(userId: string, day: string, mealType: string) {
  const userPrefs = await getUserPreferences(userId)
  const mealPlan = await getCurrentMealPlan(userId)

  // Smart filtering based on context
  let recipes = await db.from('recipes')
    .select('*')
    .where('total_time', '<', getTimeForMeal(mealType))  // Breakfast < 20 min, Dinner < 45 min
    .where('id', 'not in', mealPlan.recipeIds)  // Don't repeat same week

  // Monday = try something new, Friday = quick & easy
  if (day === 'monday') {
    recipes = recipes.order('cook_count', 'desc')  // Popular
  } else if (day === 'friday') {
    recipes = recipes.where('difficulty', 'easy')
  }

  // Match user preferences
  if (userPrefs.dietary_restrictions?.includes('vegetarian')) {
    recipes = recipes.where('is_vegetarian', true)
  }

  return recipes.limit(20)
}
```

**Gamification:**
- Progress bar: "4/7 days planned 🎯"
- Streak: "🔥 3 weeks planned in a row!"
- Badges: "🏆 Meal Prep Master" (5 meal plans completed)

---

## Cost Analysis

### Storage Costs (Postgres)

**Supabase Pricing:**
- Free tier: 500MB
- Pro tier ($25/mo): 8GB included, then $0.125/GB
- Team tier ($599/mo): 32GB included

**Storage estimates:**

| Item | Size | Count | Total |
|------|------|-------|-------|
| Recipe (JSON) | 10KB | 10,000 | 100MB |
| User recipe (ref only) | 500B | 100,000 | 50MB |
| User recipe (modified) | 10KB | 10,000 | 100MB |
| Activity | 200B | 500,000 | 100MB |
| Cooking post (metadata) | 1KB | 50,000 | 50MB |
| Photos (S3) | 500KB | 50,000 | 25GB* |
| Total DB | | | **400MB** |

*Photos stored in Supabase Storage (separate from DB): $0.021/GB = $0.50/mo

**Takeaway:** You'll stay on free tier until ~50K recipes extracted.

---

### API Costs

**OpenAI:**
- GPT-4o-mini: $0.15/1M input tokens, $0.60/1M output tokens
- Per recipe extraction: ~2K input + 1K output = $0.0009
- 1000 recipes/day = $0.90/day = $27/mo

**Apify:**
- Starter: $49/mo (400 Actor hours)
- Per TikTok scrape: ~30 seconds = 0.0083 hours
- 400 hours = 48,000 scrapes/mo
- If you do 1000 scrapes/day = 30K/mo → fits starter plan

**Edge Functions:**
- Free tier: 500K invocations
- Pro tier: 2M invocations included
- Each recipe extraction = 3 invocations (extract + webhook + result) = ~150K recipes/mo on free tier

**Total API costs for 1000 recipes/day:**
- OpenAI: $27
- Apify: $49
- Edge Functions: $0 (within free tier)
- **Total: $76/mo**

---

### Bandwidth Costs

**Supabase:**
- Free tier: 50GB egress/mo
- Pro tier: 250GB included

**Average request:**
- Recipe JSON: 10KB
- Image thumbnail: 50KB
- API response: 60KB total

**At 10K daily active users:**
- 10K users × 20 requests/day × 60KB = 12GB/day = 360GB/mo
- Need Pro tier ($25/mo for 250GB + $0.09/GB overage)
- Overage: 110GB × $0.09 = $10
- **Total: $35/mo**

---

### Total Cost Breakdown

**At launch (0-100 users):**
- Supabase: $0
- OpenAI: $5
- Apify: $49
- **Total: $54/mo**

**At 1K users:**
- Supabase: $25
- OpenAI: $20
- Apify: $49
- **Total: $94/mo**

**At 10K users:**
- Supabase: $35
- OpenAI: $50
- Apify: $149
- **Total: $234/mo**

**At 100K users:**
- Supabase: $599
- OpenAI: $200
- Apify: $499
- CDN (Cloudflare): $50
- **Total: $1,348/mo**

**Revenue needed:**
- At 10K users: $234/mo = $0.02/user/mo (easy with ads or $3/mo premium)
- At 100K users: $1,348/mo = $0.01/user/mo (even easier)

---

## Scaling Considerations

### When to Optimize?

**Don't optimize until you have:**
- 10K+ daily active users
- $500+/mo infrastructure costs
- Actual performance complaints

**Why?** Developer time > server costs at small scale.

---

### Performance Bottlenecks (In Order of Likelihood)

**1. Database Queries (Most likely first bottleneck)**

**Symptom:** API responses slow (>500ms)

**Solution:**
```sql
-- Add indexes
create index idx_recipes_creator on recipes(creator_username);
create index idx_user_recipes_user on user_recipes(user_id);
create index idx_activities_user_created on activities(user_id, created_at desc);

-- Denormalize counts
-- Instead of: select count(*) from follows where following_id = $1
-- Do: select follower_count from profiles where id = $1
```

**2. External API Calls (OpenAI, Apify)**

**Symptom:** Recipe extraction slow (>10s)

**Solution:**
- Already async (webhook-based) ✅
- Add caching layer (Redis) for repeated requests
- Batch OpenAI calls (normalize 10 recipes at once)

**3. Feed Generation**

**Symptom:** Loading feed takes >2s

**Solution:**
```typescript
// Bad: Generate feed on-demand
async function getFeed(userId: string) {
  const following = await getFollowing(userId)  // 100 users
  const activities = await getActivities(following)  // 10K activities
  return activities.sort().slice(0, 50)  // Slow!
}

// Good: Pre-generate feed (background job)
// Run every 15 minutes:
async function generateFeeds() {
  const allUsers = await getActiveUsers()

  for (const user of allUsers) {
    const feed = await computeFeed(user.id)
    await redis.set(`feed:${user.id}`, feed, { ex: 900 })  // Cache 15 min
  }
}

// API just reads from cache
async function getFeed(userId: string) {
  return await redis.get(`feed:${user.id}`)  // Fast!
}
```

**4. Image Loading**

**Symptom:** Photos load slowly

**Solution:**
- Use Supabase Storage's built-in image transformations
- Serve thumbnails (not full res)
- Use Next.js Image component (auto-optimization)
- Consider Cloudflare Images ($5/mo for 100K transformations)

---

### Database Scaling Path

**Phase 1: Single Postgres (0-100K users)** ← You are here
- Supabase managed Postgres
- Vertical scaling (bigger instance)
- Cost: $25-599/mo

**Phase 2: Read Replicas (100K-1M users)**
- Write to primary, read from replicas
- Supabase supports this on Team plan
- Cost: +$200/mo per replica

**Phase 3: Sharding (1M+ users)**
- Shard by user_id (user 1-100K on DB1, 100K-200K on DB2)
- Honestly? You're making $100K+/mo at this point, hire a DBA

---

### Caching Strategy

**What to cache:**
- Public recipes (rarely change): 1 hour TTL
- User feeds (change frequently): 15 min TTL
- User profiles (change rarely): 1 day TTL
- Discovery pages (popular recipes): 1 hour TTL

**Where to cache:**
- **Level 1:** Browser (Cache-Control headers)
- **Level 2:** CDN (Cloudflare, Vercel Edge)
- **Level 3:** Redis (Upstash on Supabase)
- **Level 4:** Postgres (already fast with indexes)

**Example:**
```typescript
// API route with caching
export async function GET(req: Request) {
  const { data, error } = await supabase
    .from('recipes')
    .select('*')
    .order('save_count', 'desc')
    .limit(50)

  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200'
      // Cache for 1 hour, serve stale for 2 hours while revalidating
    }
  })
}
```

---

## Diagrams

### Data Flow: Recipe Extraction

```
┌─────────┐
│  User   │
└────┬────┘
     │ 1. Paste TikTok URL
     ▼
┌──────────────────┐
│  POST /extract   │
│  (Edge Function) │
└────┬─────────────┘
     │
     │ 2. Parse URL → video_id = "tiktok_7123456"
     ▼
┌──────────────────────────────────────┐
│  SELECT * FROM recipes               │
│  WHERE source_key = 'tiktok_7123456' │
└────┬─────────────────────────────────┘
     │
     ├─ IF FOUND (cache hit) ──────┐
     │                              │
     │ IF NOT FOUND (cache miss)    │
     ▼                              │
┌──────────────────────┐            │
│  Try TikTok oEmbed   │            │
│  GET tiktok.com/oembed?url=...   │
└────┬─────────────────┘            │
     │                              │
     ├─ IF has caption ─────┐       │
     │                      │       │
     │ IF no caption        │       │
     ▼                      │       │
┌──────────────────────┐   │       │
│  Start Apify Actor   │   │       │
│  (async, webhook)    │   │       │
└────┬─────────────────┘   │       │
     │                     │       │
     │ 3. INSERT INTO      │       │
     │    recipes          │       │
     │    status=PENDING   │       │
     ▼                     │       │
┌──────────────────────┐   │       │
│  Return 202          │   │       │
│  {status: PENDING}   │   │       │
└──────────────────────┘   │       │
                           │       │
     ┌─────────────────────┘       │
     │ 4. Normalize with OpenAI    │
     ▼                             │
┌──────────────────────┐           │
│  POST OpenAI API     │           │
│  (structured output) │           │
└────┬─────────────────┘           │
     │                             │
     │ 5. UPDATE recipes           │
     │    status=READY             │
     ▼                             │
┌──────────────────────┐           │
│  Return 200          │◄──────────┘
│  {status: READY,     │
│   recipe: {...}}     │
└──────────────────────┘
```

---

### Data Flow: User Saves Recipe

```
User clicks "Save to Cookbook"
        │
        ▼
POST /user-recipes
  { recipe_id, cookbook_id }
        │
        ▼
┌──────────────────────────────┐
│ SELECT FROM recipes          │
│ WHERE id = recipe_id         │
└────┬─────────────────────────┘
     │
     │ Get canonical recipe
     ▼
┌──────────────────────────────┐
│ INSERT INTO user_recipes     │
│   user_id                    │
│   recipe_id                  │
│   recipe_data (snapshot)     │
│   is_modified = false        │
└────┬─────────────────────────┘
     │
     ▼
┌──────────────────────────────┐
│ INSERT INTO cookbook_recipes │
│   cookbook_id                │
│   user_recipe_id             │
└────┬─────────────────────────┘
     │
     ▼
┌──────────────────────────────┐
│ UPDATE recipes               │
│ SET save_count += 1          │
└────┬─────────────────────────┘
     │
     ▼
┌──────────────────────────────┐
│ INSERT INTO activities       │
│   type = 'saved_recipe'      │
└────┬─────────────────────────┘
     │
     ▼
┌──────────────────────────────┐
│ Return saved recipe          │
└──────────────────────────────┘
```

---

### Data Flow: Feed Generation

```
User opens app
     │
     ▼
GET /feed
     │
     ▼
┌────────────────────────────────┐
│ Check Redis cache              │
│ key = "feed:{user_id}"         │
└────┬───────────────────────────┘
     │
     ├─ IF CACHE HIT ────────┐
     │                        │
     │ IF CACHE MISS          │
     ▼                        │
┌────────────────────────────┐  │
│ SELECT FROM follows        │  │
│ WHERE follower_id = $1     │  │
└────┬───────────────────────┘  │
     │ following_ids = [...]    │
     ▼                          │
┌────────────────────────────┐  │
│ SELECT FROM activities     │  │
│ WHERE user_id IN (...)     │  │
│ ORDER BY created_at DESC   │  │
│ LIMIT 50                   │  │
└────┬───────────────────────┘  │
     │                          │
     │ JOIN with recipes,       │
     │ profiles, etc            │
     ▼                          │
┌────────────────────────────┐  │
│ Store in Redis             │  │
│ TTL = 15 minutes           │  │
└────┬───────────────────────┘  │
     │                          │
     ▼                          │
┌────────────────────────────┐  │
│ Return feed items          │◄─┘
└────────────────────────────┘
```

---

### Entity Relationship Diagram (Simplified)

```
┌──────────────┐
│ auth.users   │
│ (Supabase)   │
└───────┬──────┘
        │ 1:1
        ▼
┌──────────────┐       ┌──────────────┐
│  profiles    │       │   recipes    │
│              │       │ (canonical)  │
│ username     │       │              │
│ avatar_url   │       │ source_key   │
│ bio          │       │ recipe_data  │
└───┬──────────┘       │ creator      │
    │                  │ save_count   │
    │ 1:N              └───────┬──────┘
    ▼                          │
┌──────────────┐               │ 1:N
│  cookbooks   │               ▼
│              │       ┌──────────────┐
│ name         │       │user_recipes  │
│ visibility   │       │              │
└───┬──────────┘       │ recipe_data  │◄──┐
    │                  │ is_modified  │   │
    │ M:N via          └───────┬──────┘   │
    │ cookbook_recipes         │          │
    │                          │ 1:N      │
    ▼                          ▼          │
┌──────────────┐       ┌──────────────┐  │
│ cookbook_    │       │cooking_posts │  │
│   recipes    │       │              │  │
│              │       │ photo_url    │  │
│ cookbook_id  │       │ caption      │  │
│ user_recipe_id│      └──────────────┘  │
└──────────────┘                         │
                                         │
┌──────────────┐       ┌──────────────┐ │
│   follows    │       │ activities   │ │
│              │       │              │ │
│ follower_id  │       │ activity_type│ │
│ following_id │       │ user_recipe_id├─┘
└──────────────┘       └──────────────┘

┌──────────────┐
│ meal_plans   │
│              │
│ start_date   │
└───┬──────────┘
    │ 1:N
    ▼
┌──────────────┐
│ meal_plan_   │
│   recipes    │
│              │
│ scheduled_   │
│   date       │
└───┬──────────┘
    │ generates
    ▼
┌──────────────┐
│ grocery_     │
│   lists      │
│              │
└───┬──────────┘
    │ 1:N
    ▼
┌──────────────┐
│ grocery_list_│
│   items      │
│              │
│ ingredient   │
│ quantity     │
└──────────────┘
```

---

## Key Takeaways

### Design Principles

1. **Canonical + Snapshots:** One source of truth (`recipes`), user copies (`user_recipes`)
2. **Async by default:** Long-running tasks (scraping) use webhooks, never block API
3. **Denormalize stats:** Store counts on parent tables, update with triggers
4. **Progressive complexity:** Start simple (heuristics), add ML later
5. **Mobile-first UX:** PWA before native, swipe gestures, offline support

### Solo Dev Optimizations

1. **Use managed services:** Supabase > self-hosted Postgres
2. **Serverless > always-on:** Edge Functions > VPS
3. **RLS > auth middleware:** Database enforces permissions
4. **Postgres JSON > microservices:** Store flexible data in JSONB
5. **OpenAI > custom ML:** Use APIs before training models

### When to Build What

| Feature | Build When | Why Wait |
|---------|-----------|----------|
| PWA | Week 1 | Critical for mobile |
| Native app | 10K MAU | Expensive to maintain |
| Recommendations (basic) | Week 2 | Easy wins |
| Recommendations (ML) | 100K users | Need data to train |
| Meal planning | Week 5 | Core differentiator |
| Grocery export | Week 7 | Viral growth hack |
| Creator pages | Week 3 | SEO + attribution |
| Social feed | Week 4 | Engagement/retention |

---

## Next Steps

1. **Read this doc** → Understand the system
2. **Implement Phase 1** → Get to MVP (auth + recipe extraction)
3. **Ship to beta users** → Validate people want this
4. **Iterate based on usage** → Don't build Phase 5 if Phase 2 isn't working
5. **Raise prices** → $3-5/mo premium tier for meal planning + grocery lists

**Remember:** Perfect architecture doesn't matter if no one uses it. Ship fast, learn, iterate.

Good luck! 🚀
