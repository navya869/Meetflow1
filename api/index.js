import { app } from "../server/src/app.js";
import { connectToDatabase } from "../server/src/database.js";

export default async function handler(request, response) {
  try {
    await connectToDatabase();
  } catch (error) {
    console.error("Vercel function could not connect to MongoDB:", error);
    return response.status(503).json({ detail: "Database is unavailable." });
  }

  return app(request, response);
}
