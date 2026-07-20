# AI Travel Planner

An AI-powered travel planning app. Describe a trip in plain language and get a full
day-by-day itinerary back — budget breakdown, activities, timing — ready to edit and
publish to a public gallery that other travelers can browse, save, and clone.

Built as a full-stack project: a Next.js frontend and an Express/MongoDB API, with
Groq-powered AI for itinerary generation, personalized recommendations, and a
trip-aware chat assistant.

## Screenshot

<!--
  Add a screenshot here once you have one running locally, e.g.:
  ![Home page](./docs/screenshot-home.png)
  A good shot: the home page hero, or the trip detail page with the AI-generated itinerary.
-->
_Add a screenshot of the home page or a generated itinerary here._

## Tech stack

**Frontend**
- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4, with a custom "boarding pass" design system (CSS-variable tokens)
- TanStack Query for data fetching/caching
- React Hook Form for forms
- Framer Motion for animation, Recharts for charts
- Radix UI primitives (dialog, tooltip, label) + `class-variance-authority`
- Custom session-token auth (no NextAuth) via `src/providers/authProvider.tsx`

**Backend**
- Express 5 + TypeScript
- MongoDB (native `mongodb` driver, no ODM)
- bcrypt for password hashing, opaque DB-backed session tokens (not JWT) for auth
- Groq API (`groq-sdk`, model `llama-3.3-70b-versatile`) for all AI features

## Core features

- **Authentication** — email/password registration and login, Google OAuth, a one-click demo login, and route protection for signed-in-only pages
- **AI itinerary generation** — describe a trip and get a complete day-by-day plan (activities, timing, budget breakdown); regenerate a single day or the whole itinerary without losing edits
- **Explore gallery** — search, filter (budget/trip type/duration), sort, and paginate public trips, with deep-linkable search via URL params
- **Trip details** — photo gallery, day-by-day accordion, budget/best-time/group-size sidebar, reviews, related trips, save/clone, and a trip-scoped AI chat
- **Manage trips** — a dashboard table of your own trips with draft/published status, editing, publish/unpublish, and delete
- **AI recommendations** — a personalized "For You" section on the home page, with a one-line reason per suggested trip
- **AI chat assistant** — multi-session chat with streamed responses and AI-generated follow-up suggestions, optionally scoped to a specific trip
- **Admin dashboard** — manage users and moderate trips (role-gated via `verifyAdmin` middleware)
- **Reviews** — post and read reviews per trip, with the trip's average rating and review count kept in sync automatically

## Dependencies

**Frontend** (`client/package.json`)

| Package | Purpose |
|---|---|
| `next`, `react`, `react-dom` | Framework/runtime |
| `@tanstack/react-query` | Server-state fetching/caching |
| `react-hook-form` | Form state and validation |
| `framer-motion` | Animation |
| `recharts` | Charts (admin dashboard) |
| `@radix-ui/react-dialog`, `-label`, `-slot`, `-tooltip` | Accessible UI primitives |
| `class-variance-authority`, `clsx`, `tailwind-merge` | Class-name composition utilities |
| `lucide-react` | Icon set |
| `react-hot-toast` | Toast notifications |
| `tailwindcss`, `@tailwindcss/postcss`, `tw-animate-css` | Styling (dev) |
| `typescript`, `eslint`, `eslint-config-next` | Tooling (dev) |

**Backend** (`server/package.json`)

| Package | Purpose |
|---|---|
| `express` | HTTP server / routing |
| `mongodb` | Database driver |
| `bcrypt` | Password hashing |
| `groq-sdk` | AI itinerary generation, recommendations, chat |
| `cors` | Cross-origin requests from the client |
| `dotenv` | Environment variable loading |
| `tsx`, `typescript`, `@types/*` | Dev/build tooling |

## Running locally

You'll need **Node.js 18+**, a **MongoDB** connection string (local or [Atlas](https://www.mongodb.com/atlas)), and optionally a free **Groq API key** for the AI features and a **Google OAuth client** for Google login.

### 1. Clone and install

```bash
git clone <this-repo-url>
cd ai-travel-planner

cd server && npm install
cd ../client && npm install
```

### 2. Configure the server

```bash
cd server
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | Defaults to `8000` |
| `CLIENT_URL` | Yes | e.g. `http://localhost:3000`, must match the client exactly (used for CORS) |
| `MONGODB_URI` | Yes | Your MongoDB connection string |
| `GROQ_API_KEY` | For AI features | Free tier, no credit card — [console.groq.com/keys](https://console.groq.com/keys) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Only for Google login | From a Google Cloud OAuth client; authorized redirect URI must be `<CLIENT_URL>/auth/callback` |

### 3. Configure the client

```bash
cd ../client
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Yes | The server's URL, e.g. `http://localhost:8000` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Only for Google login | Same OAuth client ID as the server's `GOOGLE_CLIENT_ID` |

### 4. Seed some data (optional, recommended)

From `server/`:

```bash
npm run seed
```

Creates a demo user (`demo@travelplanner.app` / `demo1234`) and a handful of published
sample trips, so `/explore` isn't empty on a fresh database. Safe to re-run.

### 5. Run both apps

```bash
# terminal 1
cd server && npm run dev      # http://localhost:8000

# terminal 2
cd client && npm run dev      # http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) and either register a new account,
sign in with Google, or use the **"Try the demo account"** button on the login page.

### Other scripts

```bash
# server
npm run build     # tsc -> dist/
npm run start     # node dist/index.js (run build first)

# client
npm run build
npm run start
npm run lint
```

## Live links & resources

| Resource | Link |
|---|---|
| Admin Email | Jubair34@gmail.com |
| Admin Password | Jubair34 |
| Live app | https://agentic-ai-client-project.vercel.app |
| API base URL | https://agentic-ai-client-project.vercel.app |
| Frontend repo | https://github.com/JubairAhammedJubu/Agentic-AI-Project-Client---Jubair |
| Backend repo | https://github.com/JubairAhammedJubu/Agentic-AI-Project-Server--Jubair |
| Design reference | Boarding-pass visual system — see `client/src/app/globals.css` for the full token set |
| Groq API keys | [console.groq.com/keys](https://console.groq.com/keys) |
| MongoDB Atlas | [mongodb.com/atlas](https://www.mongodb.com/atlas) |
| Google Cloud Console (OAuth setup) | [console.cloud.google.com](https://console.cloud.google.com) |
