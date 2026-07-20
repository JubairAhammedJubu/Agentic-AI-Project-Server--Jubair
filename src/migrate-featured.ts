// One-time migration: backfills `isFeatured: false` on any trip documents
// that were created before the "Featured itineraries" admin toggle existed.
// New trips already get this field set in POST /api/trips, so this only
// needs to run once against an existing database.
//
// Usage:
//   npm run migrate:featured

import dotenv from "dotenv";
import {MongoClient, ServerApiVersion} from "mongodb";

dotenv.config({path: ".env"});

const uri = process.env.MONGODB_URI as string;
if (!uri) {
  console.error("MONGODB_URI is not set — check your .env file.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {version: ServerApiVersion.v1, strict: true, deprecationErrors: true},
});

async function run() {
  try {
    await client.connect();
    const db = client.db();
    const trips = db.collection("trips");

    const result = await trips.updateMany(
      {isFeatured: {$exists: false}},
      {$set: {isFeatured: false}},
    );

    console.log(
      `Migration complete: ${result.modifiedCount} trip(s) updated with isFeatured: false.`,
    );
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

run();
