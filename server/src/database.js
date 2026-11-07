import mongoose from "mongoose";
import { config } from "./config.js";
import { Meeting, User } from "./models.js";

let connectionPromise;
let databaseReady = false;

export async function connectToDatabase() {
  if (databaseReady && mongoose.connection.readyState === 1) return;

  if (!connectionPromise) {
    connectionPromise = (async () => {
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(config.mongoUri);
      }
      await Promise.all([User.init(), Meeting.init()]);
      databaseReady = true;
    })();
  }

  const pendingConnection = connectionPromise;
  try {
    await pendingConnection;
  } finally {
    if (connectionPromise === pendingConnection) connectionPromise = undefined;
  }
}
