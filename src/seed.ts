import dotenv from "dotenv";
import {MongoClient, ServerApiVersion} from "mongodb";
import bcrypt from "bcrypt";

dotenv.config({path: ".env"});

const uri = process.env.MONGODB_URI as string;
if (!uri) {
  console.error("MONGODB_URI is not set — check your .env file.");
  process.exit(1);
}

export const DEMO_EMAIL = "demo@travelplanner.app";
export const DEMO_PASSWORD = "demo1234";

const client = new MongoClient(uri, {
  serverApi: {version: ServerApiVersion.v1, strict: true, deprecationErrors: true},
});

const SAMPLE_TRIPS = [
  {
    title: "Temples, Tea, and Neon in Kyoto",
    destination: "Kyoto, Japan",
    region: "East Asia",
    durationDays: 3,
    budgetLevel: "medium" as const,
    estimatedBudget: {stay: 450, food: 300, activities: 180, transport: 120, total: 1050},
    groupSize: 2,
    bestTimeToVisit: "Late March to April, for cherry blossoms",
    tripType: ["culture", "foodie"],
    shortDescription: "Temple hopping by day, izakaya crawling by night.",
    fullDescription:
      "A slower-paced few days built around Kyoto's temples, tea houses, and street food markets, with one day set aside for Arashiyama's bamboo grove and riverside walks.",
    coverImageUrl: "https://picsum.photos/seed/kyoto-cover/900/600",
    galleryImages: [
      "https://picsum.photos/seed/kyoto-1/900/600",
      "https://picsum.photos/seed/kyoto-2/900/600",
    ],
    itinerary: [
      {
        day: 1,
        title: "Temples & Tea",
        activities: [
          {time: "9:00 AM", name: "Fushimi Inari Shrine", description: "Walk as far up the torii gate trails as your legs allow.", location: "Fushimi-ku"},
          {time: "1:00 PM", name: "Nishiki Market food crawl", description: "Skewers, pickles, and fresh tofu snacks.", location: "Nishiki Market"},
          {time: "4:00 PM", name: "Traditional tea ceremony", description: "A quiet hour in Gion before dinner.", location: "Gion district"},
        ],
      },
      {
        day: 2,
        title: "Arashiyama",
        activities: [
          {time: "8:00 AM", name: "Bamboo Grove", description: "Go early to beat the tour groups.", location: "Arashiyama"},
          {time: "11:00 AM", name: "Riverside lunch", description: "Grilled fish overlooking the Katsura River.", location: "Arashiyama"},
          {time: "3:00 PM", name: "Monkey Park Iwatayama", description: "Short hike, big views over the city.", location: "Arashiyama"},
        ],
      },
      {
        day: 3,
        title: "Higashiyama & Departure",
        activities: [
          {time: "9:00 AM", name: "Kiyomizu-dera", description: "Wooden stage views over the hillside.", location: "Higashiyama"},
          {time: "12:00 PM", name: "Pontocho alley lunch", description: "Narrow lantern-lit alley, small kitchens.", location: "Pontocho"},
        ],
      },
    ],
  },
  {
    title: "Long Weekend in Lisbon",
    destination: "Lisbon, Portugal",
    region: "Southern Europe",
    durationDays: 4,
    budgetLevel: "low" as const,
    estimatedBudget: {stay: 280, food: 200, activities: 90, transport: 60, total: 630},
    groupSize: 1,
    bestTimeToVisit: "September to October",
    tripType: ["solo", "relaxation"],
    shortDescription: "Pastel de nata, tram rides, and a lot of hills.",
    fullDescription:
      "A relaxed solo weekend leaning into Lisbon's neighborhoods on foot — Alfama's alleys, Belém's pastries, and a sunset over the Tagus.",
    coverImageUrl: "https://picsum.photos/seed/lisbon-cover/900/600",
    galleryImages: ["https://picsum.photos/seed/lisbon-1/900/600"],
    itinerary: [
      {
        day: 1,
        title: "Alfama on foot",
        activities: [
          {time: "10:00 AM", name: "Tram 28 ride", description: "The classic route through the old town.", location: "Alfama"},
          {time: "1:00 PM", name: "Lunch at a tasca", description: "Grilled sardines, house wine.", location: "Alfama"},
          {time: "6:00 PM", name: "Miradouro sunset", description: "Viewpoint over the rooftops.", location: "Miradouro das Portas do Sol"},
        ],
      },
      {
        day: 2,
        title: "Belém",
        activities: [
          {time: "9:00 AM", name: "Pastéis de Belém", description: "Get there before the queue does.", location: "Belém"},
          {time: "11:00 AM", name: "Jerónimos Monastery", description: "Manueline architecture, quiet cloisters.", location: "Belém"},
        ],
      },
    ],
  },
  {
    title: "Iceland Ring Road, Shortened",
    destination: "Reykjavik, Iceland",
    region: "Northern Europe",
    durationDays: 5,
    budgetLevel: "high" as const,
    estimatedBudget: {stay: 900, food: 500, activities: 600, transport: 400, total: 2400},
    groupSize: 2,
    bestTimeToVisit: "June to August, for long daylight",
    tripType: ["adventure", "nature"],
    shortDescription: "Waterfalls, glaciers, and a rental car with heated seats.",
    fullDescription:
      "A shortened south-coast version of the ring road — glacier lagoons, black sand beaches, and waterfalls you can walk behind.",
    coverImageUrl: "https://picsum.photos/seed/iceland-cover/900/600",
    galleryImages: ["https://picsum.photos/seed/iceland-1/900/600"],
    itinerary: [
      {
        day: 1,
        title: "Golden Circle",
        activities: [
          {time: "9:00 AM", name: "Þingvellir National Park", description: "Walk between two tectonic plates.", location: "Þingvellir"},
          {time: "1:00 PM", name: "Geysir geothermal area", description: "Watch Strokkur erupt every few minutes.", location: "Geysir"},
          {time: "4:00 PM", name: "Gullfoss waterfall", description: "Two-tiered falls, bring a rain jacket.", location: "Gullfoss"},
        ],
      },
      {
        day: 2,
        title: "South Coast",
        activities: [
          {time: "8:00 AM", name: "Seljalandsfoss", description: "Walk behind the falls if it's not too icy.", location: "Seljalandsfoss"},
          {time: "11:00 AM", name: "Reynisfjara black sand beach", description: "Basalt columns, watch the sneaker waves.", location: "Vik"},
        ],
      },
    ],
  },
  {
    title: "Bangkok Street Food Deep Dive",
    destination: "Bangkok, Thailand",
    region: "Southeast Asia",
    durationDays: 3,
    budgetLevel: "low" as const,
    estimatedBudget: {stay: 150, food: 180, activities: 70, transport: 50, total: 450},
    groupSize: 4,
    bestTimeToVisit: "November to February, dry season",
    tripType: ["foodie", "family"],
    shortDescription: "Markets, river ferries, and more mango sticky rice than is reasonable.",
    fullDescription:
      "A food-first three days: morning markets, a river ferry instead of taxis where possible, and an evening street food crawl through Chinatown.",
    coverImageUrl: "https://picsum.photos/seed/bangkok-cover/900/600",
    galleryImages: ["https://picsum.photos/seed/bangkok-1/900/600"],
    itinerary: [
      {
        day: 1,
        title: "Chinatown & river",
        activities: [
          {time: "8:00 AM", name: "Chatuchak-style morning market", description: "Fresh fruit, coffee, quiet before the crowds.", location: "Chinatown"},
          {time: "1:00 PM", name: "Chao Phraya river ferry", description: "Cheap, scenic, beats sitting in traffic.", location: "Chao Phraya River"},
          {time: "7:00 PM", name: "Yaowarat Road food crawl", description: "Grilled skewers, oyster omelets, mango sticky rice.", location: "Yaowarat Road"},
        ],
      },
    ],
  },
];

const SAMPLE_REVIEWS = [
  {rating: 5, comment: "Followed this almost exactly and it worked great."},
  {rating: 4, comment: "Solid plan, swapped one afternoon for a museum instead."},
];

async function run() {
  await client.connect();
  const db = client.db("ai-travel-planner");
  const usersCollection = db.collection("users");
  const tripsCollection = db.collection("trips");
  const reviewsCollection = db.collection("reviews");

  // 1. Demo user (idempotent — safe to run the seed script more than once)
  let demoUser = await usersCollection.findOne({email: DEMO_EMAIL});
  if (!demoUser) {
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const result = await usersCollection.insertOne({
      name: "Demo Traveler",
      email: DEMO_EMAIL,
      passwordHash,
      image: "",
      role: "traveler",
      preferences: {
        budgetLevel: "medium",
        tripTypes: ["culture", "foodie"],
        favoriteDestinations: ["Kyoto, Japan", "Lisbon, Portugal"],
      },
      savedTrips: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    demoUser = await usersCollection.findOne({_id: result.insertedId});
    console.log(`Created demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } else {
    console.log(`Demo user already exists: ${DEMO_EMAIL}`);
  }

  // 2. Sample published trips (skip any that already exist by title, so
  // re-running the seed script doesn't create duplicates)
  for (const sample of SAMPLE_TRIPS) {
    const existing = await tripsCollection.findOne({title: sample.title});
    if (existing) {
      console.log(`Trip already seeded: ${sample.title}`);
      continue;
    }

    const tripResult = await tripsCollection.insertOne({
      ownerId: demoUser!._id.toString(),
      ownerName: demoUser!.name,
      ...sample,
      startDate: null,
      endDate: null,
      isPublic: true,
      isFeatured: SAMPLE_TRIPS.indexOf(sample) < 3,
      avgRating: 0,
      reviewCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const reviews = SAMPLE_REVIEWS.map((r, i) => ({
      tripId: tripResult.insertedId.toString(),
      userId: `seed-reviewer-${i}`,
      userName: i === 0 ? "Jordan" : "Sam",
      userImage: "",
      rating: r.rating,
      comment: r.comment,
      createdAt: new Date(),
    }));
    await reviewsCollection.insertMany(reviews);

    const avgRating = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
    await tripsCollection.updateOne(
      {_id: tripResult.insertedId},
      {$set: {avgRating, reviewCount: reviews.length}},
    );

    console.log(`Seeded trip: ${sample.title}`);
  }

  console.log("\nSeed complete.");
  console.log(`Demo login — email: ${DEMO_EMAIL}  password: ${DEMO_PASSWORD}`);
}

run()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
