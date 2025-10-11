# Beta Launch Plan - Simple Lovable Complete

> **Goal:** Get 10-20 beta users actually using and loving the product in 2 weeks.
> **Philosophy:** Cut everything that's not essential. Add features based on real user feedback.

---

## What Problem Are We Solving? (One Sentence)

**"I see a TikTok recipe I want to try, but I lose the video or can't remember the ingredients."**

---

## The SLC Feature Set

### ✅ Must Have (Build This Week)

**1. Recipe Extraction (Backend - DONE ✅)**
- Paste TikTok URL
- Extract recipe from caption/transcript
- Return structured recipe (title, ingredients, steps, time, calories)
- Status: Already built!

**2. Beautiful Recipe Display (Frontend)**
- Clean recipe card design
- Ingredients list (with checkboxes)
- Step-by-step instructions
- Time, difficulty, calories
- Link back to original TikTok
- Credit to creator

**3. Save Recipes (Minimal Auth)**
- Google/Email login (Supabase Auth)
- "Save Recipe" button
- Personal recipe collection (one default cookbook: "My Recipes")
- View all saved recipes

**4. Share Extracted Recipes**
- Each recipe gets a shareable link: `yourapp.com/r/abc123`
- Anyone can view (no login required)
- SEO-friendly for discovery

### ❌ Not Now (Post-Beta)

- Multiple cookbooks/collections
- Social features (follow, like, comment)
- Meal planning
- Grocery lists
- Recipe modifications
- Public discovery page
- Creator pages
- Recommendations
- Swipe UI

---

## User Flow (Beta Version)

```
1. User visits yourapp.com
   → See hero: "Turn any TikTok into a recipe card"
   → Example recipe cards

2. User pastes TikTok URL
   → Show loading state
   → Extract recipe (10-30 seconds)
   → Display beautiful recipe card

3. User clicks "Save Recipe"
   → Prompt to sign up/login (Google one-click)
   → Recipe saved to "My Recipes"

4. User views "My Recipes"
   → Grid of saved recipe cards
   → Click to view full recipe
   → Link to original TikTok

5. User shares recipe
   → Copy link button
   → Share to friends (no account needed to view)
```

---

## Database Schema (Minimal)

### Tables You Need for Beta

```sql
-- 1. Recipes (canonical, already have this)
create table public.recipes (
  id              uuid primary key default gen_random_uuid(),
  source_key      text unique not null,  -- 'tiktok_7123456'
  source_url      text not null,
  status          text not null,
  recipe_data     jsonb,
  creator_username text,
  creator_avatar  text,
  created_at      timestamptz default now()
);

-- 2. User profiles (minimal)
create table public.profiles (
  id              uuid primary key references auth.users on delete cascade,
  email           text,
  display_name    text,
  created_at      timestamptz default now()
);

-- Auto-create profile on signup
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. User saved recipes (simplified)
create table public.user_recipes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users not null,
  recipe_id       uuid references recipes not null,
  saved_at        timestamptz default now(),
  unique(user_id, recipe_id)
);

create index idx_user_recipes_user on user_recipes(user_id, saved_at desc);

-- RLS
alter table user_recipes enable row level security;

create policy "Users view own recipes" on user_recipes
  for select using (auth.uid() = user_id);

create policy "Users save recipes" on user_recipes
  for insert with check (auth.uid() = user_id);

create policy "Users delete own recipes" on user_recipes
  for delete using (auth.uid() = user_id);

-- 4. Public recipe shares (for shareable links)
alter table recipes enable row level security;

create policy "Anyone can view recipes" on recipes
  for select using (true);  -- Public read access
```

**That's it!** Just 3 tables (+ auth.users from Supabase).

### What We Cut from Full Design

- ❌ cookbooks table (just use one implicit "My Recipes")
- ❌ cookbook_recipes (direct user → recipe relationship)
- ❌ follows, activities, cooking_posts (all social)
- ❌ meal_plans, grocery_lists (future features)
- ❌ user_preferences, interactions (personalization)

---

## API Endpoints (Minimal)

### Backend (Supabase Edge Functions)

**Already Built:**
- `POST /extract` - Extract recipe from TikTok
- `GET /result?key=...` - Check extraction status
- `POST /apify-webhook` - Receive Apify data

**Need to Build:**
```typescript
// GET /recipes/:id - Get recipe by ID (public, no auth)
// Returns recipe_data for shareable links

// GET /my-recipes - Get user's saved recipes
// Requires auth, returns recipes with join

// POST /my-recipes - Save a recipe
// Body: { recipe_id }
// Requires auth

// DELETE /my-recipes/:id - Unsave a recipe
// Requires auth
```

---

## Frontend (Simple Next.js App)

### Pages

**1. Home Page (`/`)**
```tsx
// Hero section
- "Turn TikTok Recipes into Recipe Cards"
- Input field: "Paste TikTok URL"
- Example recipes (3-4 popular ones)

// How it works (3 steps with icons)
1. Paste any TikTok recipe URL
2. We extract the recipe automatically
3. Save, cook, and share!

// CTA: "Try it now" → scroll to input
```

**2. Recipe Page (`/r/[id]`)**
```tsx
// Recipe card
- Recipe title
- Creator credit (@username with avatar)
- Time, difficulty, calories
- Ingredients (checkboxes)
- Instructions (numbered steps)
- "View original TikTok" button
- "Save to My Recipes" button (shows login if not authenticated)
- "Share" button (copy link)

// Layout: Pinterest-style card (mobile-first)
```

**3. My Recipes Page (`/my-recipes`)**
```tsx
// Requires auth
- Grid of recipe cards
- Click to open full recipe
- Hover shows "Remove" button
- Empty state: "No recipes yet! Extract your first recipe"
```

**4. Extract Page (`/extract?url=...`)**
```tsx
// Triggered when user pastes URL
- Loading animation
- Status updates:
  ✓ Validating URL...
  ✓ Fetching recipe...
  ✓ Extracting ingredients...
  ✓ Done!
- Redirect to recipe page when complete
```

### Components

```tsx
// RecipeCard.tsx
- Title, image, time, calories
- Ingredient count
- Creator attribution
- Save/Unsave button

// RecipeDetail.tsx
- Full recipe display
- Print-friendly
- Mobile-optimized

// URLInput.tsx
- TikTok URL input with validation
- "Extract" button
- Loading states
- Error handling ("Invalid URL", "Recipe not found", etc)
```

---

## Design (Keep It Simple)

### Design System

**Colors:**
- Primary: #FF6B6B (red/pink - TikTok vibe)
- Secondary: #4ECDC4 (teal - fresh/food)
- Background: #F7F7F7
- Text: #2D3748
- White: #FFFFFF

**Typography:**
- Headings: Inter Bold
- Body: Inter Regular
- Monospace (for ingredient measurements): JetBrains Mono

**Components:**
- Use shadcn/ui (pre-built, accessible, beautiful)
- TailwindCSS for styling
- Framer Motion for animations (optional, keep minimal)

### Recipe Card Example

```
┌────────────────────────────────────┐
│                                    │
│    [Recipe Photo Thumbnail]        │
│                                    │
├────────────────────────────────────┤
│ Creamy Garlic Shrimp Pasta         │
│                                    │
│ @chef_amanda                       │
│                                    │
│ ⏱ 25 min  🔥 Easy  🥗 520 cal     │
│                                    │
│ ✓ 12 ingredients                   │
│                                    │
│         [💾 Save Recipe]            │
└────────────────────────────────────┘
```

---

## Tech Stack (Beta)

### Frontend
- **Next.js 14** (App Router)
- **TypeScript** (catch bugs early)
- **TailwindCSS** (fast styling)
- **shadcn/ui** (beautiful components)
- **Supabase JS Client** (auth + API)

### Backend
- **Supabase** (already set up ✅)
- **Edge Functions** (already built ✅)
- **Postgres** (already configured ✅)

### Hosting
- **Vercel** (free tier, auto-deploy from Git)
- **Supabase** (free tier)

### Total Cost: $49-59/mo
- Supabase: $0 (free tier)
- Apify: $49
- OpenAI: $5-10
- Vercel: $0 (free tier)

---

## What Success Looks Like (Beta Metrics)

### Week 1 Goals
- [ ] 10 beta users signed up
- [ ] 50 recipes extracted
- [ ] 20 recipes saved
- [ ] 0 critical bugs

### Week 2 Goals
- [ ] 20 beta users total
- [ ] 150 recipes extracted
- [ ] 80 recipes saved
- [ ] 5 users return 3+ times
- [ ] Collect feedback survey

### Questions to Answer
1. **Do people understand how to use it?** (watch first-time user)
2. **Do they actually save recipes?** (or just extract and leave?)
3. **What features do they ask for first?** (social? meal planning? search?)
4. **What's the biggest pain point?** (slow extraction? bad recipe formatting?)

---

## 2-Week Build Timeline

### Week 1: Core Product

**Day 1-2: Database Setup**
- [ ] Create migration for `profiles` table
- [ ] Create migration for `user_recipes` table
- [ ] Set up RLS policies
- [ ] Test with Supabase Studio

**Day 3-4: API Endpoints**
- [ ] Build `GET /recipes/:id`
- [ ] Build `GET /my-recipes`
- [ ] Build `POST /my-recipes`
- [ ] Build `DELETE /my-recipes/:id`
- [ ] Test all endpoints with curl

**Day 5-7: Frontend (Basic)**
- [ ] Set up Next.js project
- [ ] Install dependencies (Tailwind, shadcn, Supabase)
- [ ] Build Home page with URL input
- [ ] Build Recipe page
- [ ] Build My Recipes page
- [ ] Implement Supabase Auth (Google login)

### Week 2: Polish & Launch

**Day 8-9: UX Polish**
- [ ] Loading states everywhere
- [ ] Error handling (user-friendly messages)
- [ ] Mobile-responsive (test on phone)
- [ ] Recipe card design (make it beautiful!)

**Day 10-11: Edge Cases**
- [ ] Handle invalid URLs
- [ ] Handle failed extractions
- [ ] Handle duplicate saves
- [ ] Add rate limiting (prevent spam)

**Day 12-13: Testing**
- [ ] Extract 20 different TikToks (test variety)
- [ ] Test on mobile (iPhone, Android)
- [ ] Test signup/login flow
- [ ] Fix bugs

**Day 14: Beta Launch**
- [ ] Deploy to Vercel
- [ ] Set up custom domain (optional)
- [ ] Invite 10 friends/family to test
- [ ] Create feedback form (Google Form or Typeform)
- [ ] Monitor errors (Sentry or LogRocket)

---

## What You're NOT Building (Yet)

Remember: **You can add these after beta based on user feedback.**

### ❌ Not in Beta
- Multiple cookbooks ("Weeknight Dinners", "Desserts", etc)
- Public discovery page
- Search functionality
- Social features (follow, like, comment)
- Activity feed
- Meal planning
- Grocery lists
- Recipe modifications
- Creator pages
- Recommendations
- Swipe UI
- Native mobile app
- Notifications

### ✅ Add After Beta (Based on Feedback)
**If users say:** "I want to organize my recipes" → Add cookbooks (Phase 2)
**If users say:** "I want to see what my friends are cooking" → Add social (Phase 3)
**If users say:** "I want to plan my week" → Add meal planning (Phase 4)

**Don't guess!** Let users tell you what to build next.

---

## Beta Launch Checklist

### Before Launch
- [ ] Recipe extraction works for 20+ TikToks
- [ ] Auth works (can sign up, log in, log out)
- [ ] Saving recipes works
- [ ] Viewing saved recipes works
- [ ] Mobile-responsive (test on phone)
- [ ] Error messages are friendly
- [ ] Privacy policy page (required for auth)
- [ ] Terms of service page (basic)

### Launch Day
- [ ] Deploy to production (Vercel)
- [ ] Test production deployment
- [ ] Invite 5 close friends (in-person if possible)
- [ ] Watch them use it (don't help!)
- [ ] Send feedback form link
- [ ] Post in one relevant community (Reddit r/cooking?)

### Week After Launch
- [ ] Daily check: are people using it?
- [ ] Fix critical bugs ASAP
- [ ] Collect feedback
- [ ] Decide what to build next

---

## Example Beta User Journey

**Meet Sarah, your first beta user:**

1. **Day 1:** Sarah sees your post on Reddit. "Turn TikTok recipes into recipe cards? Interesting..."

2. She clicks the link, sees a clean home page. There's an input that says "Paste TikTok URL"

3. She copies a pasta recipe from TikTok, pastes it, clicks "Extract"

4. 15 seconds later: Beautiful recipe card appears! Ingredients, steps, everything organized.

5. She clicks "Save Recipe" → prompted to sign up. One-click Google login.

6. Recipe saved! She sees a "My Recipes" link in the nav.

7. **Day 2:** Sarah sees another recipe on TikTok. Opens your app (she bookmarked it!), extracts it, saves it.

8. **Day 3:** Sarah wants to cook. Opens "My Recipes". Both recipes are there! She picks one.

9. **Day 7:** Sarah has 8 recipes saved. She tells her friend: "There's this app that saves TikTok recipes, it's so much better than screenshotting!"

10. **Feedback:** "I love this! Can I organize recipes into folders? Like 'Weeknight Dinners' and 'Desserts'?"

11. **You:** Build cookbooks feature (Phase 2) because users asked for it.

---

## Success Criteria

### You know beta is successful when:

✅ **5+ users save 3+ recipes each** (they're getting value)
✅ **3+ users return after 24 hours** (it's sticky)
✅ **Users share it with friends organically** (word of mouth)
✅ **Clear feedback on what to build next** (users tell you)

### You know you need to pivot when:

❌ Users extract recipes but don't save them (saving isn't valuable?)
❌ Users sign up but never come back (not sticky enough?)
❌ Users complain extraction is too slow/inaccurate (quality issue)
❌ No one shares it with friends (not remarkable enough)

---

## Post-Beta: What to Build Next?

### After beta (Week 3+), pick ONE:

**Option A: Cookbooks (Organization)**
- Let users create multiple collections
- "Weeknight Dinners", "Desserts", "Meal Prep", etc
- Good if users say: "I have too many recipes, need to organize"

**Option B: Discovery (Growth)**
- Public recipe page
- Browse popular recipes
- Search functionality
- Good if users say: "I want to find new recipes on your app"

**Option C: Meal Planning (Monetization)**
- Weekly meal planner
- Grocery list generation
- Good if users say: "I want to plan my week" (high-value feature, can charge for this)

**Option D: Social (Viral Growth)**
- Follow friends
- See what others are cooking
- Like/comment
- Good if users say: "I want to share this with friends"

**How to decide:** Run a survey. "What would make this app 10x better?"

---

## Key Principles

1. **Ship fast, iterate faster** - 2 weeks to beta, not 2 months
2. **One feature at a time** - Don't build cookbooks AND social AND meal planning
3. **Talk to users** - Watch them use it, ask questions, listen
4. **Data > opinions** - Track what they DO, not just what they SAY
5. **Stay small** - Small codebase = fast iteration = competitive advantage

---

## You're Building a Product, Not a Startup (Yet)

**Beta goal:** Validate that people want this.

**Not:** Build the perfect app with all features.

**Questions to answer:**
- Will people use this?
- What do they love?
- What do they hate?
- What would they pay for?

**Then:** Decide if it's worth building the full vision.

---

## Next Step: Code

Ready to build? Here's your starting command:

```bash
# Frontend setup
npx create-next-app@latest tiktok-recipe-app --typescript --tailwind --app
cd tiktok-recipe-app
npm install @supabase/supabase-js @supabase/auth-helpers-nextjs

# Add shadcn/ui
npx shadcn-ui@latest init
npx shadcn-ui@latest add button card input

# Run dev server
npm run dev
```

**Now go build!** 🚀
