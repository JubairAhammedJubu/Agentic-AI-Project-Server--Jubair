import Groq from "groq-sdk";

// Built lazily (on first real use) rather than at module-import time.
// index.ts calls dotenv.config() *after* its imports run, and imports are
// hoisted above other code when TypeScript compiles to CommonJS — so a
// client constructed at module load time here would capture
// process.env.GROQ_API_KEY before .env has actually been read, silently
// baking in an empty key for the client's entire lifetime.
let groq: Groq | null = null;
function getClient(): Groq {
  if (!groq) {
    groq = new Groq({apiKey: process.env.GROQ_API_KEY});
  }
  return groq;
}

// Model choice: Llama 3.3 70B on Groq is fast (Groq's LPU inference),
// free-tier friendly (30 req/min, 1000 req/day at time of writing), and
// supports response_format: {type: "json_object"} for reliable structured
// output — exactly what the itinerary/recommendation/follow-up prompts need.
const MODEL = "llama-3.3-70b-versatile";

export interface ActivityInput {
  time: string;
  name: string;
  description: string;
  location?: string;
}

export interface DayInput {
  day: number;
  title: string;
  activities: ActivityInput[];
}

export interface EstimatedBudget {
  stay: number;
  food: number;
  activities: number;
  transport: number;
  total: number;
}

export interface GeneratedItinerary {
  estimatedBudget: EstimatedBudget;
  bestTimeToVisit: string;
  days: DayInput[];
}

export class AiGenerationError extends Error {}

// Thrown specifically for Groq 429s (either per-minute rate limits or the
// free tier's daily token cap). Kept separate from AiGenerationError so
// routes can surface a clear "try again in N minutes" message instead of a
// generic failure.
export class AiRateLimitError extends Error {
  retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Strips ```json fences in case the model wraps its output despite
// instructions (rare with response_format: json_object, but cheap to guard
// against), then parses. Throws AiGenerationError on any failure so routes
// can surface a clean 502 instead of a raw parse exception.
function parseJsonResponse<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AiGenerationError("The AI response wasn't valid JSON.");
  }
}

// Single-turn JSON call: system instruction + one user prompt, forced to
// return JSON via Groq's OpenAI-compatible response_format: json_object.
// Note: Groq's JSON mode requires the word "json" to appear somewhere in
// the prompt (system or user) — all the system prompts below already
// mention JSON explicitly, so this is satisfied everywhere it's used.
async function callGroqJson(system: string, userPrompt: string, maxTokens: number, temperature = 1) {
  if (!process.env.GROQ_API_KEY) {
    throw new AiGenerationError("GROQ_API_KEY is not configured on the server.");
  }

  try {
    const response = await getClient().chat.completions.create({
      model: MODEL,
      messages: [
        {role: "system", content: system},
        {role: "user", content: userPrompt},
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: {type: "json_object"},
    });

    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new AiGenerationError("The AI returned no text content.");
    }
    return text;
  } catch (err: any) {
    if (err?.status === 429) {
      const retryAfterHeader = err?.headers?.["retry-after"];
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const isDailyLimit = err?.error?.error?.code === "rate_limit_exceeded" && /tokens per day|TPD/i.test(err?.error?.error?.message || "");
      const friendlyWait = retryAfterSeconds
        ? retryAfterSeconds >= 60
          ? `${Math.ceil(retryAfterSeconds / 60)} minute(s)`
          : `${retryAfterSeconds} second(s)`
        : "a few minutes";
      throw new AiRateLimitError(
        isDailyLimit
          ? `The AI provider's daily free-tier limit has been reached. Please try again in about ${friendlyWait}, or upgrade the Groq plan.`
          : `The AI is receiving too many requests right now. Please try again in about ${friendlyWait}.`,
        retryAfterSeconds,
      );
    }
    throw err;
  }
}

const ITINERARY_SYSTEM_PROMPT = `You are a travel-planning assistant embedded in an app called AI Travel Planner. Given a set of trip parameters, produce a complete, realistic day-by-day itinerary and a budget estimate.

Return ONLY valid JSON matching exactly this shape, no prose, no markdown code fences, no commentary before or after:
{
  "estimatedBudget": {"stay": number, "food": number, "activities": number, "transport": number, "total": number},
  "bestTimeToVisit": string,
  "days": [
    {"day": number, "title": string, "activities": [{"time": string, "name": string, "description": string, "location": string}]}
  ]
}

Rules:
- estimatedBudget values are totals for the whole trip (not per day), in USD, and "total" must equal the sum of the other four.
- Use these as the realistic USD-per-person-per-day ranges when estimating stay+food+activities (transport is separate, one-time, and covers getting around the destination — not international flights): low budget ≈ $30-60/day, medium budget ≈ $60-150/day, high budget ≈ $150-400/day. Pick a specific, consistent value inside the given range for the given destination and duration rather than the extremes — do not deviate far from a typical mid-point of the range for the same inputs.
- Produce exactly as many entries in "days" as the requested duration.
- Each day should have 3-5 activities spread across the day (morning/afternoon/evening), with realistic times (e.g. "9:00 AM").
- "location" should be a specific place name within the destination, not a repeat of the destination itself.
- Tailor activities to the requested trip type(s), budget level, and any interests given.
- Do not include any keys other than the ones specified above.`;

export async function generateItinerary(input: {
  destination: string;
  region?: string;
  startDate?: string;
  endDate?: string;
  durationDays: number;
  budgetLevel: string;
  tripType: string[];
  groupSize?: number;
  interests?: string;
}): Promise<GeneratedItinerary> {
  if (!input.destination || !input.durationDays || input.durationDays < 1) {
    throw new AiGenerationError("destination and a positive durationDays are required.");
  }
  if (input.durationDays > 21) {
    throw new AiGenerationError("Trips longer than 21 days aren't supported yet.");
  }

  const prompt = `Trip parameters:
- Destination: ${input.destination}${input.region ? ` (${input.region})` : ""}
- Duration: ${input.durationDays} day(s)${input.startDate ? `, starting ${input.startDate}` : ""}${input.endDate ? ` ending ${input.endDate}` : ""}
- Budget level: ${input.budgetLevel}
- Trip type(s): ${input.tripType.length ? input.tripType.join(", ") : "general"}
- Group size: ${input.groupSize || 1}
${input.interests ? `- Traveler interests: ${input.interests}` : ""}

Generate the full itinerary now.`;

  const text = await callGroqJson(ITINERARY_SYSTEM_PROMPT, prompt, 4096, 0.4);
  const parsed = parseJsonResponse<GeneratedItinerary>(text);

  if (!Array.isArray(parsed.days) || parsed.days.length === 0) {
    throw new AiGenerationError("The AI response was missing itinerary days.");
  }

  return parsed;
}

const REGENERATE_DAY_SYSTEM_PROMPT = `You are a travel-planning assistant embedded in an app called AI Travel Planner. You are regenerating ONE day of an existing itinerary based on the traveler's instructions.

Return ONLY valid JSON matching exactly this shape, no prose, no markdown code fences, no commentary before or after:
{"day": number, "title": string, "activities": [{"time": string, "name": string, "description": string, "location": string}]}

Rules:
- Keep the same "day" number you were given.
- Produce 3-5 activities spread across the day with realistic times.
- Follow the traveler's instructions for what to change; keep anything they didn't ask to change reasonably similar in spirit.
- Do not include any keys other than the ones specified above.`;

export async function regenerateDay(input: {
  destination: string;
  budgetLevel: string;
  tripType: string[];
  day: number;
  currentDay?: DayInput;
  instructions: string;
}): Promise<DayInput> {
  if (!input.destination || !input.day || !input.instructions) {
    throw new AiGenerationError("destination, day, and instructions are required.");
  }

  const prompt = `Destination: ${input.destination}
Budget level: ${input.budgetLevel}
Trip type(s): ${input.tripType.length ? input.tripType.join(", ") : "general"}
Day number to regenerate: ${input.day}
${input.currentDay ? `Current plan for this day: ${JSON.stringify(input.currentDay)}` : ""}
Traveler's instructions: ${input.instructions}

Regenerate this day now.`;

  const text = await callGroqJson(REGENERATE_DAY_SYSTEM_PROMPT, prompt, 1536);
  const parsed = parseJsonResponse<DayInput>(text);

  if (!parsed.title || !Array.isArray(parsed.activities)) {
    throw new AiGenerationError("The AI response was missing required day fields.");
  }
  parsed.day = input.day;

  return parsed;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatTripContext {
  title: string;
  destination: string;
  budgetLevel: string;
  durationDays: number;
  tripType: string[];
  itinerary: DayInput[];
}

function buildChatSystemPrompt(trip?: ChatTripContext): string {
  const base = `You are the AI Travel Planner assistant — a friendly, knowledgeable travel-planning chat assistant embedded in the app. Answer questions about destinations, logistics, packing, budgeting, and itinerary tweaks. Keep replies conversational and concise (a few short paragraphs at most, use lists when helpful). You are not generating structured JSON here — just talk normally.`;

  if (!trip) {
    return `${base}\n\nThe traveler hasn't opened this chat from a specific trip, so answer generally. If their question would be better answered in the context of a specific saved trip, suggest they open the assistant from that trip's page.`;
  }

  return `${base}\n\nThe traveler has this trip open right now — use it as context and refer to it specifically when relevant:
${JSON.stringify(trip)}`;
}

// Groq's chat completions API is OpenAI-compatible, so history maps
// straight across — "assistant" is already the right role name (no
// "model" translation needed like with Gemini).
function toGroqMessages(history: ChatMessage[]): Groq.Chat.ChatCompletionMessageParam[] {
  return history.map((m) => ({role: m.role, content: m.content}));
}

// Streams the assistant's reply via onDelta callbacks and returns the full
// text once the stream completes, so the caller can persist it.
export async function streamChatReply(
  history: ChatMessage[],
  trip: ChatTripContext | undefined,
  onDelta: (text: string) => void,
): Promise<string> {
  if (!process.env.GROQ_API_KEY) {
    throw new AiGenerationError("GROQ_API_KEY is not configured on the server.");
  }

  let stream;
  try {
    stream = await getClient().chat.completions.create({
      model: MODEL,
      messages: [
        {role: "system", content: buildChatSystemPrompt(trip)},
        ...toGroqMessages(history),
      ],
      max_tokens: 1024,
      stream: true,
    });
  } catch (err: any) {
    if (err?.status === 429) {
      const retryAfterHeader = err?.headers?.["retry-after"];
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const friendlyWait = retryAfterSeconds
        ? retryAfterSeconds >= 60
          ? `${Math.ceil(retryAfterSeconds / 60)} minute(s)`
          : `${retryAfterSeconds} second(s)`
        : "a few minutes";
      throw new AiRateLimitError(
        `The AI provider's usage limit has been reached. Please try again in about ${friendlyWait}.`,
        retryAfterSeconds,
      );
    }
    throw err;
  }

  let fullText = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onDelta(delta);
    }
  }

  if (!fullText) {
    throw new AiGenerationError("The AI returned no text content.");
  }
  return fullText;
}

const FOLLOW_UPS_SYSTEM_PROMPT = `Given a travel-planning chat conversation, suggest 3 short follow-up questions or requests the traveler might naturally send next. Return ONLY valid JSON, no prose, no markdown fences: {"suggestions": [string, string, string]}. Each suggestion should be under 10 words and phrased as something the traveler would type (first person or imperative), not a question you'd ask them.`;

export async function generateFollowUps(history: ChatMessage[]): Promise<string[]> {
  try {
    const transcript = history
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Traveler" : "Assistant"}: ${m.content}`)
      .join("\n");
    const text = await callGroqJson(FOLLOW_UPS_SYSTEM_PROMPT, transcript, 256);
    const parsed = parseJsonResponse<{suggestions: string[]}>(text);
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [];
  } catch {
    // Follow-up suggestions are a nice-to-have; never fail the chat over them.
    return [];
  }
}

export interface RecommendationCandidate {
  id: string;
  title: string;
  destination: string;
  region?: string;
  tripType: string[];
  budgetLevel: string;
  avgRating: number;
  shortDescription: string;
}

export interface Recommendation {
  tripId: string;
  reason: string;
}

const RECOMMENDATIONS_SYSTEM_PROMPT = `You are a recommendation engine embedded in an app called AI Travel Planner. Given a traveler's preferences and history, and a pool of candidate public trips, pick the best matches for them.

Return ONLY valid JSON matching exactly this shape, no prose, no markdown code fences, no commentary before or after:
{"recommendations": [{"tripId": string, "reason": string}]}

Rules:
- "tripId" must be one of the exact id values given in the candidate list — never invent an id.
- Return at most 6 recommendations, ordered best-match first.
- "reason" is a single short sentence (under 20 words) explaining specifically why this trip fits this traveler — reference their stated interests, budget, or history where relevant.
- If nothing in the candidate list is a reasonable fit, return fewer recommendations rather than forcing weak matches.
- Do not include any keys other than the ones specified above.`;

export async function recommendTrips(input: {
  preferredBudgetLevel?: string | null;
  preferredTripTypes: string[];
  favoriteDestinations: string[];
  ownTripDestinations: string[];
  savedTripTitles: string[];
  candidates: RecommendationCandidate[];
}): Promise<Recommendation[]> {
  if (input.candidates.length === 0) return [];

  const prompt = `Traveler profile:
- Preferred budget level: ${input.preferredBudgetLevel || "not specified"}
- Preferred trip types: ${input.preferredTripTypes.length ? input.preferredTripTypes.join(", ") : "not specified"}
- Favorite destinations: ${input.favoriteDestinations.length ? input.favoriteDestinations.join(", ") : "none listed"}
- Destinations of trips they've created: ${input.ownTripDestinations.length ? input.ownTripDestinations.join(", ") : "none yet"}
- Trips they've saved: ${input.savedTripTitles.length ? input.savedTripTitles.join(", ") : "none yet"}

Candidate public trips (choose from these only):
${JSON.stringify(input.candidates)}

Return the best recommendations now.`;

  const text = await callGroqJson(RECOMMENDATIONS_SYSTEM_PROMPT, prompt, 1024);
  const parsed = parseJsonResponse<{recommendations: Recommendation[]}>(text);

  if (!Array.isArray(parsed.recommendations)) {
    throw new AiGenerationError("The AI response was missing recommendations.");
  }

  const validIds = new Set(input.candidates.map((c) => c.id));
  return parsed.recommendations.filter((r) => validIds.has(r.tripId)).slice(0, 6);
}
