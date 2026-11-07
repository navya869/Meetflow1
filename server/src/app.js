import express from "express";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { authRouter, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { Meeting } from "./models.js";
import { verifySessionToken } from "./security.js";

export const MAX_ROOM_PARTICIPANTS = 100;
const staticDirectory = fileURLToPath(new URL("../../app/static/", import.meta.url));
const meetingPage = fileURLToPath(new URL("../../app/static/index.html", import.meta.url));
const clientBuild = fileURLToPath(new URL("../../client/dist/", import.meta.url));
const clientIndex = fileURLToPath(new URL("../../client/dist/index.html", import.meta.url));

export const app = express();
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").flatMap(item => {
    const separator = item.indexOf("=");
    if (separator < 0) return [];
    const key = item.slice(0, separator).trim();
    try {
      return [[key, decodeURIComponent(item.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
  next();
});

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  app: "Meetflow",
  database: "mongodb",
  max_room_participants: MAX_ROOM_PARTICIPANTS,
  room_capacity_note: "Built for up to 100 participants per room with mesh-style WebRTC signaling."
}));
app.use("/api/auth", authRouter);
app.use("/static", express.static(staticDirectory, { fallthrough: true, maxAge: config.nodeEnv === "production" ? "1d" : 0 }));

app.get("/api/meetings", requireAuth, async (req, res, next) => {
  try {
    const meetings = await Meeting.find({ owner: req.user._id }).sort({ created_at: -1 }).limit(100).lean();
    res.json(meetings.map(meeting => meetingDto(meeting)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/meetings", requireAuth, async (req, res, next) => {
  try {
    const title = req.body?.title === undefined ? "Meetflow meeting" : String(req.body.title).trim();
    const description = String(req.body?.description || "").trim();
    const scheduledAt = req.body?.scheduled_at || null;
    const duration = req.body?.duration_minutes === undefined ? 30 : Number(req.body.duration_minutes);
    if (!title || title.length > 160) return res.status(422).json({ detail: "Meeting title must be between 1 and 160 characters." });
    if (description.length > 4000) return res.status(422).json({ detail: "Meeting description must be no more than 4000 characters." });
    if (!Number.isInteger(duration) || duration < 5 || duration > 720) return res.status(422).json({ detail: "Meeting duration must be between 5 and 720 minutes." });
    if (scheduledAt && (typeof scheduledAt !== "string" || Number.isNaN(Date.parse(scheduledAt)))) {
      return res.status(422).json({ detail: "Meeting date and time must be valid." });
    }

    const meeting = await Meeting.create({
      code: await makeMeetingCode(),
      owner: req.user._id,
      title,
      description,
      scheduled_at: scheduledAt,
      duration_minutes: duration,
      status: scheduledAt ? "scheduled" : "ready"
    });
    res.json(meetingDto(meeting));
  } catch (error) {
    next(error);
  }
});

app.get("/api/meetings/:code", requireAuth, async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ code: req.params.code.toUpperCase() }).lean();
    if (!meeting) return res.status(404).json({ detail: "Meeting not found. Check the meeting code." });
    res.json(meetingDto(meeting));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/meetings/:code/cancel", requireAuth, async (req, res, next) => {
  try {
    const meeting = await Meeting.findOneAndUpdate(
      { code: req.params.code.toUpperCase(), owner: req.user._id },
      { status: "cancelled" },
      { new: true, runValidators: true }
    );
    if (!meeting) return res.status(404).json({ detail: "Meeting not found or you are not its host." });
    res.json(meetingDto(meeting));
  } catch (error) {
    next(error);
  }
});

app.get("/api/meetings/:code/notes", requireAuth, async (req, res, next) => {
  try {
    const meeting = await Meeting.findOne({ code: req.params.code.toUpperCase() }).select("notes").lean();
    if (!meeting) return res.status(404).json({ detail: "Meeting not found." });
    res.json({ content: meeting.notes || "" });
  } catch (error) {
    next(error);
  }
});

app.put("/api/meetings/:code/notes", requireAuth, async (req, res, next) => {
  try {
    const content = String(req.body?.content || "");
    if (content.length > 20000) return res.status(422).json({ detail: "Meeting notes must be no more than 20000 characters." });
    const meeting = await Meeting.findOneAndUpdate(
      { code: req.params.code.toUpperCase() },
      { notes: content },
      { new: true }
    ).select("notes").lean();
    if (!meeting) return res.status(404).json({ detail: "Meeting not found." });
    res.json({ content: meeting.notes, saved: true });
  } catch (error) {
    next(error);
  }
});

app.get("/meetings", (req, res, next) => {
  if (!verifySessionToken(req.cookies?.[config.sessionCookie], config.jwtSecret)) {
    return res.redirect(`/?next=${encodeURIComponent(`${req.path}${req.url.includes("?") ? req.url.slice(req.path.length) : ""}`)}`);
  }
  return requireAuth(req, res, next);
}, (_req, res) => {
  res.sendFile(meetingPage);
});

app.use(express.static(clientBuild, { index: false, fallthrough: true }));
app.get("*splat", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) return next();
  res.sendFile(clientIndex, error => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(422).json({ detail: "The submitted data is invalid." });
  }
  console.error("Request failed:", error);
  res.status(500).json({ detail: "An unexpected server error occurred." });
});

function meetingDto(meeting) {
  return {
    code: meeting.code,
    title: meeting.title,
    description: meeting.description,
    scheduled_at: meeting.scheduled_at,
    duration_minutes: meeting.duration_minutes,
    status: meeting.status,
    created_at: new Date(meeting.created_at).toISOString(),
    url: `/?meeting=${meeting.code}`
  };
}

async function makeMeetingCode() {
  const { randomInt } = await import("node:crypto");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    if (!await Meeting.exists({ code })) return code;
  }
  throw new Error("Could not generate a unique meeting code.");
}
