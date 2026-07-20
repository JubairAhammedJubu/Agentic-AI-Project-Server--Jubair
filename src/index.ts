import express, {Request, Response, NextFunction} from "express";
import dotenv from "dotenv";
import cors from "cors";
import {MongoClient, ServerApiVersion, ObjectId} from "mongodb";
import bcrypt from "bcrypt";
import crypto from "crypto";
import {
  generateItinerary,
  regenerateDay,
  recommendTrips,
  streamChatReply,
  generateFollowUps,
  AiGenerationError,
  AiRateLimitError,
  type RecommendationCandidate,
  type ChatMessage,
  type ChatTripContext,
} from "./ai";

dotenv.config({path: ".env"});

console.log(" Environment Check:");
console.log("  - CLIENT_URL:", process.env.CLIENT_URL || "Not set");
console.log("  - PORT:", process.env.PORT || 8000);
console.log(
  "  - MONGODB_URI:",
  process.env.MONGODB_URI ? " Present" : " Missing",
);
console.log(
  "  - GOOGLE_CLIENT_ID:",
  process.env.GOOGLE_CLIENT_ID ? " Present" : " Missing",
);
console.log(
  "  - GROQ_API_KEY:",
  process.env.GROQ_API_KEY ? " Present" : " Missing",
);

const uri = process.env.MONGODB_URI as string;

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  }),
);

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const db = client.db("ai-travel-planner");
const usersCollection = db.collection("users");
const sessionCollection = db.collection("session");
const tripsCollection = db.collection("trips");
const reviewsCollection = db.collection("reviews");
const chatSessionsCollection = db.collection("chatSessions");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ===== MIDDLEWARE =====

// Verifies the bearer token against the session collection. We use a
// DB-backed opaque token (random bytes stored server-side with an
// expiry) rather than a signed JWT so that logout / session revocation
// is immediate — a JWT would stay valid until it naturally expired.
const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers?.authorization;
    if (!authHeader)
      return res.status(401).send({message: "unauthorized access"});

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).send({message: "unauthorized access"});

    const session = await sessionCollection.findOne({token});
    if (!session) return res.status(401).send({message: "unauthorized access"});

    if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
      await sessionCollection.deleteOne({_id: session._id});
      return res.status(401).send({message: "unauthorized access"});
    }

    const user = await usersCollection.findOne({_id: session.userId});
    if (!user) return res.status(401).send({message: "unauthorized access"});

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).send({message: "unauthorized access"});
  }
};

const verifyAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin")
    return res.status(403).send({message: "forbidden"});
  next();
};

// Trip ownership is checked inline inside each PUT/DELETE handler rather
// than as a standalone middleware, since the handler needs the trip
// document loaded first in order to compare it against req.user._id.

// ===== HELPERS =====

async function createSession(user: {_id: ObjectId}) {
  const token = crypto.randomBytes(32).toString("hex");
  await sessionCollection.insertOne({
    token,
    userId: user._id,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

function publicUser(user: any) {
  const {passwordHash, ...safe} = user;
  return safe;
}

function isValidObjectId(id: string) {
  return ObjectId.isValid(id);
}

// ===== AUTH ROUTES =====

app.post("/api/auth/register", async (req: Request, res: Response) => {
  try {
    const {name, email, password} = req.body;
    if (!name || !email || !password)
      return res.status(400).send({message: "All fields are required"});

    const existingUser = await usersCollection.findOne({email});
    if (existingUser)
      return res.status(400).send({message: "User already exists"});

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = {
      name,
      email,
      passwordHash,
      image: "",
      role: "traveler",
      preferences: {
        budgetLevel: null,
        tripTypes: [] as string[],
        favoriteDestinations: [] as string[],
      },
      savedTrips: [] as ObjectId[],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await usersCollection.insertOne(newUser);
    const token = await createSession({_id: result.insertedId});

    res.status(201).send({
      success: true,
      message: "User registered",
      token,
      user: publicUser({...newUser, _id: result.insertedId}),
    });
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const {email, password} = req.body;
    if (!email || !password)
      return res.status(400).send({message: "Email and password are required"});

    const user = await usersCollection.findOne({email});
    if (!user || !user.passwordHash)
      return res.status(401).send({message: "Invalid credentials"});

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid)
      return res.status(401).send({message: "Invalid credentials"});

    const token = await createSession({_id: user._id});

    res.send({
      success: true,
      message: "Login successful",
      token,
      user: publicUser(user),
    });
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.post(
  "/api/auth/logout",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.split(" ")[1];
      if (token) await sessionCollection.deleteOne({token});
      res.send({success: true, message: "Logged out"});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Exchanges a Google OAuth authorization code for a session token.
// The client builds the consent-screen URL and redirects the user there;
// Google then redirects back to the client with a `code`, which the client
// forwards here.
app.post("/api/auth/google", async (req: Request, res: Response) => {
  try {
    const {code, redirectUri} = req.body;
    if (!code || !redirectUri)
      return res
        .status(400)
        .send({message: "code and redirectUri are required"});

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      return res
        .status(500)
        .send({message: "Google OAuth is not configured on the server"});

    // 1. Exchange the authorization code for an access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = (await tokenRes.json()) as {access_token?: string};
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("Google token exchange failed:", tokenData);
      return res
        .status(401)
        .send({message: "Failed to authenticate with Google"});
    }

    // 2. Fetch the Google profile
    const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: {Authorization: `Bearer ${tokenData.access_token}`},
      },
    );
    const profile = (await profileRes.json()) as {
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!profileRes.ok || !profile.email) {
      return res
        .status(401)
        .send({message: "Could not retrieve Google profile"});
    }
    console.log("Google profile payload:", profile);

    // 3. Find or create the local user
    let user = await usersCollection.findOne({email: profile.email});
    if (!user) {
      const newUser = {
        name: profile.name || profile.email.split("@")[0],
        email: profile.email,
        passwordHash: null,
        provider: "google",
        image: profile.picture || "",
        role: "traveler",
        preferences: {
          budgetLevel: null,
          tripTypes: [] as string[],
          favoriteDestinations: [] as string[],
        },
        savedTrips: [] as ObjectId[],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await usersCollection.insertOne(newUser);
      user = {...newUser, _id: result.insertedId};
    } else if (!user.image && profile.picture) {
      await usersCollection.updateOne(
        {_id: user._id},
        {$set: {image: profile.picture}},
      );
      user.image = profile.picture;
    }

    // 4. Create a session, same as normal login
    const token = await createSession({_id: user._id});

    res.send({
      success: true,
      message: "Google login successful",
      token,
      user: publicUser(user),
    });
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.get("/api/auth/me", verifyToken, async (req: Request, res: Response) => {
  try {
    const freshUser = await usersCollection.findOne({_id: req.user!._id});
    res.send(publicUser(freshUser));
  } catch (err: any) {
    res.status(500).send({message: err.message});
  }
});

// ===== USER ROUTES =====

// Profile self-service update — name, avatar image URL, and the travel
// preferences that feed the recommendation engine. Email/role/password are
// intentionally not editable here.
app.put(
  "/api/users/profile",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {name, image, preferences} = req.body || {};
      const update: Record<string, any> = {updatedAt: new Date()};

      if (name !== undefined) {
        if (typeof name !== "string" || !name.trim())
          return res.status(400).send({message: "Name can't be empty"});
        update.name = name.trim();
      }

      if (image !== undefined) {
        if (typeof image !== "string")
          return res.status(400).send({message: "Invalid image"});
        update.image = image.trim();
      }

      if (preferences !== undefined) {
        const {budgetLevel, tripTypes, favoriteDestinations} =
          preferences || {};
        if (
          budgetLevel !== undefined &&
          budgetLevel !== null &&
          !["low", "medium", "high"].includes(budgetLevel)
        )
          return res.status(400).send({message: "Invalid budget level"});
        if (tripTypes !== undefined && !Array.isArray(tripTypes))
          return res.status(400).send({message: "Invalid trip types"});
        if (
          favoriteDestinations !== undefined &&
          !Array.isArray(favoriteDestinations)
        )
          return res
            .status(400)
            .send({message: "Invalid favorite destinations"});

        update.preferences = {
          budgetLevel: budgetLevel !== undefined ? budgetLevel : null,
          tripTypes: tripTypes !== undefined ? tripTypes : [],
          favoriteDestinations:
            favoriteDestinations !== undefined ? favoriteDestinations : [],
        };
      }

      await usersCollection.updateOne({_id: req.user!._id}, {$set: update});
      const freshUser = await usersCollection.findOne({_id: req.user!._id});
      res.send(publicUser(freshUser));
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Saved trips power the recommendation engine's history signal (see
// /api/ai/recommendations below) — not in the original endpoint plan,
// added because "trips the user has saved" needs somewhere to live.
app.get(
  "/api/users/saved-trips",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const savedTripIds: string[] = Array.isArray(req.user!.savedTrips)
        ? req.user!.savedTrips
        : [];
      if (savedTripIds.length === 0) return res.send([]);

      const trips = await tripsCollection
        .find({
          _id: {
            $in: savedTripIds
              .filter(isValidObjectId)
              .map((id) => new ObjectId(id)),
          },
        })
        .sort({createdAt: -1})
        .toArray();
      res.send(trips);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

app.post(
  "/api/users/saved-trips/:tripId",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (req.user!.role === "admin")
        return res
          .status(403)
          .send({message: "Admins can't save trips to a personal list."});

      const {tripId} = req.params;
      if (!isValidObjectId(tripId as string))
        return res.status(400).send({message: "Invalid trip id"});

      await usersCollection.updateOne(
        {_id: req.user!._id},
        {$addToSet: {savedTrips: tripId}},
      );
      res.send({success: true});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

app.delete(
  "/api/users/saved-trips/:tripId",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {tripId} = req.params;
      await usersCollection.updateOne({_id: req.user!._id}, {
        $pull: {savedTrips: tripId as string},
      } as any);
      res.send({success: true});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// ===== TRIP ROUTES =====

app.post("/api/trips", verifyToken, async (req: Request, res: Response) => {
  try {
    if (req.user!.role === "admin")
      return res
        .status(403)
        .send({message: "Admins can't create or clone trips."});

    const trip = req.body;

    if (!trip.title || !trip.destination)
      return res
        .status(400)
        .send({message: "title and destination are required"});

    const newTrip = {
      ownerId: req.user!._id.toString(),
      ownerName: req.user!.name,
      title: trip.title,
      destination: trip.destination,
      region: trip.region || "",
      startDate: trip.startDate || null,
      endDate: trip.endDate || null,
      durationDays: Number(trip.durationDays) || 0,
      budgetLevel: trip.budgetLevel || "medium",
      estimatedBudget: trip.estimatedBudget || {
        stay: 0,
        food: 0,
        activities: 0,
        transport: 0,
        total: 0,
      },
      groupSize: Number(trip.groupSize) || 1,
      bestTimeToVisit: trip.bestTimeToVisit || "",
      tripType: Array.isArray(trip.tripType) ? trip.tripType : [],
      shortDescription: trip.shortDescription || "",
      fullDescription: trip.fullDescription || "",
      coverImageUrl: trip.coverImageUrl || "",
      galleryImages: Array.isArray(trip.galleryImages)
        ? trip.galleryImages
        : [],
      itinerary: Array.isArray(trip.itinerary) ? trip.itinerary : [],
      // Trips start private; the client flips this to true on "Publish".
      isPublic: false,
      // Only an admin can flip this, from Manage trips — it controls whether
      // the trip shows up in the homepage's "Featured itineraries" section.
      isFeatured: false,
      avgRating: 0,
      reviewCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await tripsCollection.insertOne(newTrip);
    res.status(201).send({
      success: true,
      trip: {...newTrip, _id: result.insertedId},
    });
  } catch (error: any) {
    res.status(500).send({success: false, message: error.message});
  }
});

app.get("/api/trips", async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.perPage as string) || 8;
    const skip = (page - 1) * perPage;

    const {search, destination, region, budgetLevel, tripType, sort, featured} =
      req.query;
    const andConditions: any[] = [{isPublic: true}];

    // Powers the homepage's "Top rated · Featured itineraries" section —
    // only trips an admin has explicitly marked as featured show up here.
    if (featured === "true") andConditions.push({isFeatured: true});

    if (search) {
      andConditions.push({
        $or: [
          {title: {$regex: search, $options: "i"}},
          {destination: {$regex: search, $options: "i"}},
          {shortDescription: {$regex: search, $options: "i"}},
        ],
      });
    }

    if (destination)
      andConditions.push({destination: {$regex: destination, $options: "i"}});
    if (region && region !== "all") andConditions.push({region});
    if (budgetLevel && budgetLevel !== "all") andConditions.push({budgetLevel});
    if (tripType && tripType !== "all")
      andConditions.push({tripType: tripType});

    const minDuration = parseInt(req.query.minDuration as string);
    const maxDuration = parseInt(req.query.maxDuration as string);
    if (!isNaN(minDuration) || !isNaN(maxDuration)) {
      const durationCond: any = {};
      if (!isNaN(minDuration)) durationCond.$gte = minDuration;
      if (!isNaN(maxDuration)) durationCond.$lte = maxDuration;
      andConditions.push({durationDays: durationCond});
    }

    const query = {$and: andConditions};

    let sortObj: any = {createdAt: -1};
    if (sort === "oldest") sortObj = {createdAt: 1};
    if (sort === "rating") sortObj = {avgRating: -1};
    if (sort === "duration_short") sortObj = {durationDays: 1};
    if (sort === "duration_long") sortObj = {durationDays: -1};

    const total = await tripsCollection.countDocuments(query);
    const trips = await tripsCollection
      .find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(perPage)
      .toArray();

    res.send({
      trips,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (err: any) {
    res.status(500).send({message: err.message});
  }
});

// Must come before /api/trips/:id — otherwise "mine" is captured as :id.
app.get("/api/trips/mine", verifyToken, async (req: Request, res: Response) => {
  try {
    const trips = await tripsCollection
      .find({ownerId: req.user!._id.toString()})
      .sort({createdAt: -1})
      .toArray();
    res.send(trips);
  } catch (err: any) {
    res.status(500).send({message: err.message});
  }
});

// Aggregated numbers for the signed-in user's dashboard (Recharts).
app.get(
  "/api/trips/mine/stats",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const ownerId = req.user!._id.toString();
      const trips = await tripsCollection.find({ownerId}).toArray();

      const budgetCounts: Record<string, number> = {low: 0, medium: 0, high: 0};
      const typeCounts: Record<string, number> = {};
      const monthCounts: Record<string, number> = {};
      let publicCount = 0;
      let totalBudget = 0;
      let totalDays = 0;

      for (const trip of trips) {
        budgetCounts[trip.budgetLevel] =
          (budgetCounts[trip.budgetLevel] || 0) + 1;
        for (const type of trip.tripType || []) {
          typeCounts[type] = (typeCounts[type] || 0) + 1;
        }
        const created = new Date(trip.createdAt);
        const monthKey = created.toLocaleString("en-US", {
          month: "short",
          year: "2-digit",
        });
        monthCounts[monthKey] = (monthCounts[monthKey] || 0) + 1;
        if (trip.isPublic) publicCount += 1;
        totalBudget += trip.estimatedBudget?.total || 0;
        totalDays += trip.durationDays || 0;
      }

      res.send({
        totalTrips: trips.length,
        publicTrips: publicCount,
        privateTrips: trips.length - publicCount,
        avgDurationDays: trips.length
          ? Math.round(totalDays / trips.length)
          : 0,
        avgBudget: trips.length ? Math.round(totalBudget / trips.length) : 0,
        byBudgetLevel: Object.entries(budgetCounts).map(([name, value]) => ({
          name,
          value,
        })),
        byTripType: Object.entries(typeCounts).map(([name, value]) => ({
          name,
          value,
        })),
        byMonth: Object.entries(monthCounts).map(([name, value]) => ({
          name,
          value,
        })),
      });
    } catch (err: any) {
      res.status(500).send({message: err.message});
    }
  },
);

app.get("/api/trips/:id", async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id as string))
      return res.status(400).send({message: "Invalid trip id"});

    const trip = await tripsCollection.findOne({
      _id: new ObjectId(req.params.id as string),
    });
    if (!trip) return res.status(404).send({message: "Trip not found"});

    // Only the owner (or an admin) can view a private trip.
    if (!trip.isPublic) {
      const authHeader = req.headers?.authorization;
      const token = authHeader?.split(" ")[1];
      const session = token ? await sessionCollection.findOne({token}) : null;
      const requesterId = session?.userId?.toString();
      const requester = requesterId
        ? await usersCollection.findOne({_id: session!.userId})
        : null;
      const isOwner = requesterId === trip.ownerId;
      const isAdmin = requester?.role === "admin";
      if (!isOwner && !isAdmin)
        return res.status(404).send({message: "Trip not found"});
    }

    res.send(trip);
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.get("/api/trips/:id/related", async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id as string))
      return res.status(400).send({message: "Invalid trip id"});

    const trip = await tripsCollection.findOne({
      _id: new ObjectId(req.params.id as string),
    });
    if (!trip) return res.status(404).send({message: "Not found"});

    const related = await tripsCollection
      .find({
        _id: {$ne: trip._id},
        isPublic: true,
        $or: [
          {destination: trip.destination},
          {tripType: {$in: trip.tripType || []}},
        ],
      })
      .limit(6)
      .toArray();
    res.send(related);
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.put("/api/trips/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!isValidObjectId(req.params.id as string))
      return res.status(400).send({message: "Invalid trip id"});

    const trip = await tripsCollection.findOne({
      _id: new ObjectId(req.params.id as string),
    });
    if (!trip) return res.status(404).send({message: "Trip not found"});

    const isOwner = trip.ownerId === req.user!._id.toString();
    const isAdmin = req.user!.role === "admin";
    if (!isOwner && !isAdmin)
      return res.status(403).send({message: "forbidden"});

    const updates = {...req.body, updatedAt: new Date()};
    delete updates._id;
    delete updates.ownerId;

    const result = await tripsCollection.updateOne(
      {_id: new ObjectId(req.params.id as string)},
      {$set: updates},
    );
    res.send(result);
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.delete(
  "/api/trips/:id",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string))
        return res.status(400).send({message: "Invalid trip id"});

      const trip = await tripsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      if (!trip) return res.status(404).send({message: "Trip not found"});

      const isOwner = trip.ownerId === req.user!._id.toString();
      const isAdmin = req.user!.role === "admin";
      if (!isOwner && !isAdmin)
        return res.status(403).send({message: "forbidden"});

      const [tripResult] = await Promise.all([
        tripsCollection.deleteOne({_id: new ObjectId(req.params.id as string)}),
        reviewsCollection.deleteMany({tripId: req.params.id as string}),
      ]);
      res.send(tripResult);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// ===== ADMIN ROUTES =====

// Raw counts for the admin overview's stat cards.
app.get(
  "/api/admin/collection-stats",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      const [users, trips, reviews, savedTripsAgg] = await Promise.all([
        usersCollection.countDocuments(),
        tripsCollection.countDocuments(),
        reviewsCollection.countDocuments(),
        usersCollection
          .aggregate([
            {$project: {count: {$size: {$ifNull: ["$savedTrips", []]}}}},
            {$group: {_id: null, total: {$sum: "$count"}}},
          ])
          .toArray(),
      ]);
      const savedTrips = savedTripsAgg[0]?.total || 0;
      res.send({users, trips, reviews, savedTrips});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Aggregated breakdowns for the admin overview's charts.
app.get(
  "/api/admin/stats",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      const trips = await tripsCollection.find({}).toArray();

      const byBudgetLevelCounts: Record<string, number> = {
        low: 0,
        medium: 0,
        high: 0,
      };
      const byRegionCounts: Record<string, number> = {};
      let publicCount = 0;

      for (const trip of trips) {
        byBudgetLevelCounts[trip.budgetLevel] =
          (byBudgetLevelCounts[trip.budgetLevel] || 0) + 1;
        const region = trip.region || "Unspecified";
        byRegionCounts[region] = (byRegionCounts[region] || 0) + 1;
        if (trip.isPublic) publicCount += 1;
      }

      res.send({
        totalTrips: trips.length,
        publicTrips: publicCount,
        privateTrips: trips.length - publicCount,
        byBudgetLevel: Object.entries(byBudgetLevelCounts).map(
          ([name, value]) => ({name, value}),
        ),
        byRegion: Object.entries(byRegionCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([name, value]) => ({name, value})),
      });
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// List every registered account, optionally filtered by role or search term.
app.get(
  "/api/admin/users",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      const {role, search} = req.query;
      const andConditions: any[] = [];

      if (role && role !== "all") andConditions.push({role});
      if (search) {
        andConditions.push({
          $or: [
            {name: {$regex: search, $options: "i"}},
            {email: {$regex: search, $options: "i"}},
          ],
        });
      }

      const query = andConditions.length ? {$and: andConditions} : {};
      const users = await usersCollection
        .find(query)
        .sort({createdAt: -1})
        .toArray();
      res.send(users.map(publicUser));
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Promote/demote an account. An admin can't change their own role, so the
// platform never ends up with zero admins through this endpoint.
app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      if (!isValidObjectId(id as string))
        return res.status(400).send({message: "Invalid user id"});

      const {role} = req.body || {};
      if (!["traveler", "admin"].includes(role))
        return res.status(400).send({message: "Invalid role"});

      if (id === req.user!._id.toString())
        return res
          .status(400)
          .send({message: "You can't change your own role"});

      await usersCollection.updateOne(
        {_id: new ObjectId(id as string)},
        {$set: {role, updatedAt: new Date()}},
      );
      const updated = await usersCollection.findOne({
        _id: new ObjectId(id as string),
      });
      res.send(publicUser(updated));
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Public trips only — private/draft trips are intentionally excluded from
// this list per product decision (drafts aren't ready for admin review).
app.get(
  "/api/admin/trips",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      const trips = await tripsCollection
        .find({isPublic: true})
        .sort({createdAt: -1})
        .toArray();
      res.send(trips);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Feature/unfeature a trip. Featured + public trips are what surfaces in
// the homepage's "Top rated · Featured itineraries" section.
app.patch(
  "/api/admin/trips/:id/feature",
  verifyToken,
  verifyAdmin,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string))
        return res.status(400).send({message: "Invalid trip id"});

      const {isFeatured} = req.body || {};
      if (typeof isFeatured !== "boolean")
        return res.status(400).send({message: "isFeatured must be a boolean"});

      const result = await tripsCollection.updateOne(
        {_id: new ObjectId(req.params.id as string)},
        {$set: {isFeatured, updatedAt: new Date()}},
      );
      if (result.matchedCount === 0)
        return res.status(404).send({message: "Trip not found"});

      const updated = await tripsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      res.send(updated);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// ===== REVIEW ROUTES =====

app.get("/api/trips/:id/reviews", async (req: Request, res: Response) => {
  try {
    const reviews = await reviewsCollection
      .find({tripId: req.params.id})
      .sort({createdAt: -1})
      .toArray();
    res.send(reviews);
  } catch (error: any) {
    res.status(500).send({message: error.message});
  }
});

app.post(
  "/api/trips/:id/reviews",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string))
        return res.status(400).send({message: "Invalid trip id"});

      const {rating, comment} = req.body;
      if (!rating) return res.status(400).send({message: "Rating is required"});

      const trip = await tripsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      if (!trip) return res.status(404).send({message: "Trip not found"});

      const review = {
        tripId: req.params.id as string,
        userId: req.user!._id.toString(),
        userName: req.user!.name,
        userImage: req.user!.image || "",
        rating: Number(rating),
        comment: (comment || "").trim(),
        createdAt: new Date(),
      };
      const result = await reviewsCollection.insertOne(review);

      // recompute the trip's rating average
      const allReviews = await reviewsCollection
        .find({tripId: req.params.id as string})
        .toArray();
      const avgRating =
        allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

      await tripsCollection.updateOne(
        {_id: new ObjectId(req.params.id as string)},
        {$set: {avgRating, reviewCount: allReviews.length}},
      );

      res
        .status(201)
        .send({success: true, review: {...review, _id: result.insertedId}});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// ===== AI ROUTES =====

app.post(
  "/api/ai/generate-itinerary",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {
        destination,
        region,
        startDate,
        endDate,
        durationDays,
        budgetLevel,
        tripType,
        groupSize,
        interests,
      } = req.body;

      const itinerary = await generateItinerary({
        destination,
        region,
        startDate,
        endDate,
        durationDays: Number(durationDays),
        budgetLevel: budgetLevel || "medium",
        tripType: Array.isArray(tripType) ? tripType : [],
        groupSize: groupSize ? Number(groupSize) : undefined,
        interests,
      });

      res.send({success: true, itinerary});
    } catch (error: any) {
      if (error instanceof AiRateLimitError) {
        return res
          .status(429)
          .send({
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          });
      }
      if (error instanceof AiGenerationError) {
        return res.status(422).send({message: error.message});
      }
      res
        .status(502)
        .send({message: "AI itinerary generation failed. Please try again."});
      console.error("generate-itinerary error:", error);
    }
  },
);

// Regenerates a single day. Works whether or not the trip has been saved
// yet: if tripId is provided, ownership is verified and the trip's own
// destination/budgetLevel/tripType are used as context; otherwise the
// caller (mid-creation, before the trip is saved) passes that context
// directly in the request body.
app.post(
  "/api/ai/regenerate-day",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {tripId, day, instructions, currentDay} = req.body;
      let {destination, budgetLevel, tripType} = req.body;

      if (tripId) {
        if (!isValidObjectId(tripId)) {
          return res.status(400).send({message: "Invalid trip id"});
        }
        const trip = await tripsCollection.findOne({_id: new ObjectId(tripId)});
        if (!trip) return res.status(404).send({message: "Trip not found"});

        const isOwner = trip.ownerId === req.user!._id.toString();
        const isAdmin = req.user!.role === "admin";
        if (!isOwner && !isAdmin)
          return res.status(403).send({message: "forbidden"});

        destination = trip.destination;
        budgetLevel = trip.budgetLevel;
        tripType = trip.tripType;
      }

      const regeneratedDay = await regenerateDay({
        destination,
        budgetLevel: budgetLevel || "medium",
        tripType: Array.isArray(tripType) ? tripType : [],
        day: Number(day),
        currentDay,
        instructions,
      });

      res.send({success: true, day: regeneratedDay});
    } catch (error: any) {
      if (error instanceof AiRateLimitError) {
        return res
          .status(429)
          .send({
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          });
      }
      if (error instanceof AiGenerationError) {
        return res.status(422).send({message: error.message});
      }
      res
        .status(502)
        .send({message: "AI regeneration failed. Please try again."});
      console.error("regenerate-day error:", error);
    }
  },
);

// Feature B — AI Smart Recommendation Engine. Builds a candidate pool of
// public trips the user doesn't already own/have saved, then asks Groq
// to rank the best matches against their preferences + history.
app.post(
  "/api/ai/recommendations",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {budgetLevel, region} = req.body;
      const user = req.user!;
      const savedTripIds: string[] = Array.isArray(user.savedTrips)
        ? user.savedTrips
        : [];

      const [ownTrips, savedTrips] = await Promise.all([
        tripsCollection.find({ownerId: user._id.toString()}).toArray(),
        savedTripIds.length
          ? tripsCollection
              .find({
                _id: {
                  $in: savedTripIds
                    .filter(isValidObjectId)
                    .map((id) => new ObjectId(id)),
                },
              })
              .toArray()
          : Promise.resolve([]),
      ]);

      const candidateFilter: any = {
        isPublic: true,
        ownerId: {$ne: user._id.toString()},
        _id: {
          $nin: savedTripIds
            .filter(isValidObjectId)
            .map((id) => new ObjectId(id)),
        },
      };
      if (budgetLevel) candidateFilter.budgetLevel = budgetLevel;
      if (region) candidateFilter.region = {$regex: region, $options: "i"};

      const candidateTrips = await tripsCollection
        .find(candidateFilter)
        .sort({avgRating: -1, createdAt: -1})
        .limit(40)
        .toArray();

      const candidates: RecommendationCandidate[] = candidateTrips.map((t) => ({
        id: t._id.toString(),
        title: t.title,
        destination: t.destination,
        region: t.region,
        tripType: t.tripType || [],
        budgetLevel: t.budgetLevel,
        avgRating: t.avgRating || 0,
        shortDescription: t.shortDescription || "",
      }));

      const recommendations = await recommendTrips({
        preferredBudgetLevel: user.preferences?.budgetLevel ?? null,
        preferredTripTypes: user.preferences?.tripTypes || [],
        favoriteDestinations: user.preferences?.favoriteDestinations || [],
        ownTripDestinations: ownTrips.map((t) => t.destination),
        savedTripTitles: savedTrips.map((t) => t.title),
        candidates,
      });

      const tripsById = new Map(
        candidateTrips.map((t) => [t._id.toString(), t]),
      );
      const resolved = recommendations
        .map((r) => ({trip: tripsById.get(r.tripId), reason: r.reason}))
        .filter((r) => r.trip);

      res.send({success: true, recommendations: resolved});
    } catch (error: any) {
      if (error instanceof AiRateLimitError) {
        return res
          .status(429)
          .send({
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          });
      }
      if (error instanceof AiGenerationError) {
        return res.status(422).send({message: error.message});
      }
      res
        .status(502)
        .send({message: "Recommendations failed. Please try again."});
      console.error("recommendations error:", error);
    }
  },
);

// ===== AI CHAT ASSISTANT ROUTES (Feature C, optional 3rd AI feature) =====

app.post(
  "/api/ai/chat/sessions",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const {tripId} = req.body;
      if (tripId && !isValidObjectId(tripId)) {
        return res.status(400).send({message: "Invalid trip id"});
      }

      const session = {
        userId: req.user!._id.toString(),
        tripId: tripId || null,
        messages: [] as {role: string; content: string; timestamp: Date}[],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await chatSessionsCollection.insertOne(session);
      res.status(201).send({...session, _id: result.insertedId});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

app.get(
  "/api/ai/chat/sessions",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      const sessions = await chatSessionsCollection
        .find({userId: req.user!._id.toString()})
        .sort({updatedAt: -1})
        .toArray();
      res.send(sessions);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

app.get(
  "/api/ai/chat/sessions/:id",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string))
        return res.status(400).send({message: "Invalid session id"});

      const session = await chatSessionsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      if (!session || session.userId !== req.user!._id.toString())
        return res.status(404).send({message: "Session not found"});

      res.send(session);
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

app.delete(
  "/api/ai/chat/sessions/:id",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string))
        return res.status(400).send({message: "Invalid session id"});

      const session = await chatSessionsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      if (!session || session.userId !== req.user!._id.toString())
        return res.status(404).send({message: "Session not found"});

      await chatSessionsCollection.deleteOne({_id: session._id});
      res.send({success: true});
    } catch (error: any) {
      res.status(500).send({message: error.message});
    }
  },
);

// Streams the assistant's reply over Server-Sent Events. Each chunk is sent
// as a `delta` event; a final `done` event carries follow-up suggestions.
app.post(
  "/api/ai/chat/sessions/:id/messages",
  verifyToken,
  async (req: Request, res: Response) => {
    try {
      if (!isValidObjectId(req.params.id as string)) {
        return res.status(400).send({message: "Invalid session id"});
      }

      const {message} = req.body;
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).send({message: "message is required"});
      }

      const session = await chatSessionsCollection.findOne({
        _id: new ObjectId(req.params.id as string),
      });
      if (!session || session.userId !== req.user!._id.toString()) {
        return res.status(404).send({message: "Session not found"});
      }

      let tripContext: ChatTripContext | undefined;
      if (session.tripId) {
        const trip = await tripsCollection.findOne({
          _id: new ObjectId(session.tripId),
        });
        if (trip) {
          tripContext = {
            title: trip.title,
            destination: trip.destination,
            budgetLevel: trip.budgetLevel,
            durationDays: trip.durationDays,
            tripType: trip.tripType || [],
            itinerary: trip.itinerary || [],
          };
        }
      }

      const priorMessages: ChatMessage[] = (session.messages || []).map(
        (m: any) => ({
          role: m.role,
          content: m.content,
        }),
      );
      const history: ChatMessage[] = [
        ...priorMessages,
        {role: "user", content: message},
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      let assistantText = "";
      try {
        assistantText = await streamChatReply(history, tripContext, (delta) => {
          res.write(
            `data: ${JSON.stringify({type: "delta", text: delta})}\n\n`,
          );
        });
      } catch (streamError: any) {
        res.write(
          `data: ${JSON.stringify({type: "error", message: streamError.message || "The assistant hit an error."})}\n\n`,
        );
        return res.end();
      }

      const now = new Date();
      const updatedMessages = [
        ...(session.messages || []),
        {role: "user", content: message, timestamp: now},
        {role: "assistant", content: assistantText, timestamp: now},
      ];
      await chatSessionsCollection.updateOne(
        {_id: session._id},
        {$set: {messages: updatedMessages, updatedAt: now}},
      );

      const suggestions = await generateFollowUps([
        ...history,
        {role: "assistant", content: assistantText},
      ]);

      res.write(`data: ${JSON.stringify({type: "done", suggestions})}\n\n`);
      res.end();
    } catch (error: any) {
      console.error("chat message error:", error);
      try {
        res.write(
          `data: ${JSON.stringify({type: "error", message: "The assistant hit an error."})}\n\n`,
        );
        res.end();
      } catch {
        res.status(500).send({message: error.message});
      }
    }
  },
);

// ===== CONTACT =====

app.post("/api/contact", async (req: Request, res: Response) => {
  try {
    const {name, email, message} = req.body;
    if (!name || !email || !message) {
      return res
        .status(400)
        .send({message: "name, email and message are required"});
    }
    await db.collection("contactMessages").insertOne({
      name,
      email,
      message,
      createdAt: new Date(),
    });
    res.status(201).send({success: true});
  } catch (error: any) {
    res.status(500).send({success: false, message: error.message});
  }
});

// ===== ROOT + STARTUP =====

app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to the AI Travel Planner Server!");
});

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ping: 1});
    console.log(" Connected to MongoDB!");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
  }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(` Server is running on port ${PORT}`);
  console.log(` Visit: http://localhost:${PORT}`);
});
