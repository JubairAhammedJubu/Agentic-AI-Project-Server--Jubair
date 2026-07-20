# AI Travel Planner — Server

Express + TypeScript API backing the AI Travel Planner app. Uses MongoDB (native
driver, no ODM), opaque DB-backed session tokens for auth, and the Groq API
for itinerary generation, recommendations, and the chat assistant.

## Stack

- Express 5 + TypeScript
- MongoDB (native `mongodb` driver)
- bcrypt for password hashing
- `groq-sdk` for all AI features (model: `llama-3.3-70b-versatile` — fast, free-tier friendly, and supports `response_format: json_object` for reliable structured output)
- Session auth via a `session` collection (bearer token, not JWT)

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run dev             # tsx watch src/index.ts, http://localhost:8000
```

Other scripts:

```bash
npm run build   # tsc -> dist/
npm run start   # node dist/index.js (run build first)
npm run seed     # creates the demo user + sample published trips
```

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | Defaults to `8000`. |
| `CLIENT_URL` | Yes | Used for CORS. Should match the client's URL exactly (e.g. `http://localhost:3000`). |
| `MONGODB_URI` | Yes | Connection string. The app uses a database named `ai-travel-planner`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Only for Google login | From a Google Cloud OAuth client. Authorized redirect URI must be `<CLIENT_URL>/auth/callback`. |
| `GROQ_API_KEY` | Yes, for any AI feature | Powers itinerary generation, recommendations, and the chat assistant. Get one free (no credit card) at [console.groq.com/keys](https://console.groq.com/keys) — rate-limited on the free tier (see "AI provider" below). Without it, those three endpoints return a 502/422 — everything else (auth, trips CRUD, reviews) still works. |

## Demo login

Run the seed script once you have `MONGODB_URI` set:

```bash
npm run seed
```

This creates:

- A demo user — **email:** `demo@travelplanner.app`, **password:** `demo1234`
- 4 published sample trips (Kyoto, Lisbon, Reykjavik, Bangkok) with seeded reviews, so
  `/explore` isn't empty on a fresh database

The script is idempotent — safe to re-run; it skips the user/trips if they already exist.

## Feature bullets (what's actually implemented)

- **Auth** — register/login (bcrypt + session tokens), Google OAuth, demo login (client-side button + this seed script), `verifyToken`/`verifyAdmin` middleware
- **Trips CRUD** — create/edit/delete (owner-or-admin only), public list with search/filter/sort/pagination, single trip (private trips hidden from non-owners), related trips
- **Reviews** — post/list per trip, auto-recomputes the trip's `avgRating`/`reviewCount`
- **AI Content Generator** — `POST /api/ai/generate-itinerary`, `POST /api/ai/regenerate-day` (single-day regeneration, works with or without a saved trip)
- **AI Smart Recommendations** — `POST /api/ai/recommendations`, using the user's preferences, own trips, and saved trips as signal; `POST`/`DELETE /api/users/saved-trips/:tripId` to build that signal (not in the original endpoint plan — added because nothing else populated `savedTrips`)
- **AI Chat Assistant** — session CRUD under `/api/ai/chat/sessions`, streamed replies over Server-Sent Events, trip-aware system prompt when a session is tied to a `tripId`, AI-generated follow-up suggestions

## AI provider

This app calls Groq's API (`llama-3.3-70b-versatile`) via the `groq-sdk` package,
chosen for its generous free tier and low-latency inference (Groq runs on custom
LPU hardware rather than GPUs, so responses come back noticeably faster than most
alternatives). Trade-offs worth knowing:

- **Rate limits** — the free tier allows roughly 30 requests/minute and 1,000
  requests/day on this model (subject to change on Groq's side without much
  notice). Expect occasional 429s under any real traffic; there's no retry/backoff
  logic built in yet.
- **JSON output** — all four structured calls (itinerary generation, day
  regeneration, recommendations, follow-ups) use `response_format: {type:
  "json_object"}` to force valid JSON, with a defensive fence-stripping fallback in
  `parseJsonResponse()` in case a response ever comes back wrapped in markdown
  anyway. Groq's JSON mode requires the word "json" to appear in the prompt, which
  every system prompt here already does.
- **Swapping providers again** — every function in `src/ai.ts` exports the same
  signature regardless of provider, so swapping to another provider later only
  means rewriting this one file.

## Known gaps / deliberate deviations

- `regenerate-day` doesn't strictly require a `tripId` (the plan assumed one always exists) — it's optional so it works during trip creation, before anything is saved.
- No rate limiting or per-user usage caps on the AI endpoints in this app's own code — Groq's free-tier throttling is the only limit in effect, and it will return 429s under real load with no retry logic here to smooth that over.
- `chatSessions` has no automatic cleanup — old sessions accumulate indefinitely.
- No admin-role routes exist yet beyond the `role` field and `verifyAdmin` middleware being wired up; there's no moderation UI on top of it.

## Live URL

_Not deployed yet — fill in once you have a hosting URL._
