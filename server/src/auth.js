import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { config } from "./config.js";
import { OtpChallenge, User } from "./models.js";
import { createOtp, createSessionToken, hashOtp, normalizeEmail, safeEqualHex, verifySessionToken } from "./security.js";
import { DeliveryConfigurationError, sendOtp } from "./delivery.js";

const OTP_LIFETIME_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_WINDOW_MS = 60 * 60 * 1000;
const MAX_OTP_SENDS_PER_WINDOW = 5;
const MAX_OTP_ATTEMPTS = 5;

function safeUser(user) {
  return { id: String(user._id), displayName: user.displayName, email: user.email };
}

function setSessionCookie(res, userId) {
  res.cookie(config.sessionCookie, createSessionToken(userId, config.jwtSecret), {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[config.sessionCookie];
  const claims = verifySessionToken(token, config.jwtSecret);
  if (!claims) return res.status(401).json({ detail: "Please sign in with a verification code." });
  try {
    const user = await User.findById(claims.sub);
    if (!user) return res.status(401).json({ detail: "Your session is no longer valid. Please sign in again." });
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function createAuthRouter({ UserModel = User, OtpModel = OtpChallenge, deliverOtp = sendOtp } = {}) {
const router = Router();
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { detail: "Too many verification attempts. Please wait 15 minutes and try again." }
});

router.post("/request-otp", authRateLimit, async (req, res, next) => {
  try {
    const { intent, displayName } = req.body || {};
    if (!["login", "register"].includes(intent)) return res.status(400).json({ detail: "Choose login or register." });
    if (req.body?.channel !== undefined && req.body.channel !== "email") return res.status(400).json({ detail: "Only email verification is supported." });
    const identity = normalizeEmail(req.body?.identifier);
    const name = String(displayName || "").trim();
    if (intent === "register" && (!name || name.length > 60)) {
      return res.status(400).json({ detail: "Enter a name between 1 and 60 characters." });
    }

    const user = await UserModel.findOne({ email: identity });
    if (intent === "register" && user) return res.status(409).json({ detail: "An account already uses this contact. Sign in instead." });
    if (intent === "login" && !user) return res.status(404).json({ detail: "No account uses this contact. Register first." });

    const now = new Date();
    const existing = await OtpModel.findOne({ identity, intent });
    if (existing && now.getTime() - existing.sentAt.getTime() < RESEND_COOLDOWN_MS) {
      const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - existing.sentAt.getTime())) / 1000);
      return res.status(429).json({ detail: `Wait ${retryAfter} seconds before requesting another code.`, retryAfter });
    }
    const withinWindow = existing?.windowStarted && now.getTime() - existing.windowStarted.getTime() < OTP_WINDOW_MS;
    const windowStarted = withinWindow ? existing.windowStarted : now;
    const sendCount = withinWindow ? existing.sendCount || 0 : 0;
    if (sendCount >= MAX_OTP_SENDS_PER_WINDOW) {
      const retryAfter = Math.ceil((OTP_WINDOW_MS - (now.getTime() - windowStarted.getTime())) / 1000);
      return res.status(429).json({ detail: "Too many codes have been requested for this contact. Please try again later.", retryAfter });
    }

    const { code, codeHash } = createOtp(config.otpSecret);
    await OtpModel.findOneAndUpdate(
      { identity, intent },
      { $set: { codeHash, displayName: name, attempts: 0, sendCount: sendCount + 1, windowStarted, sentAt: now, expiresAt: new Date(now.getTime() + OTP_WINDOW_MS) } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    try {
      await deliverOtp({ identity, code });
    } catch (error) {
      await OtpModel.deleteOne({ identity, intent, codeHash });
      if (error instanceof DeliveryConfigurationError) return res.status(503).json({ detail: error.message });
      console.error("OTP delivery failed:", error?.code || error?.name || "provider error");
      return res.status(502).json({ detail: "Could not send the verification code. Check your provider settings and try again." });
    }
    return res.json({ message: "A verification code was sent to your email.", expiresInSeconds: OTP_LIFETIME_MS / 1000, retryAfter: RESEND_COOLDOWN_MS / 1000 });
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Enter ") || error.message.startsWith("Choose "))) {
      return res.status(400).json({ detail: error.message });
    }
    return next(error);
  }
});

router.post("/verify-otp", authRateLimit, async (req, res, next) => {
  try {
    const { intent } = req.body || {};
    if (!["login", "register"].includes(intent)) return res.status(400).json({ detail: "Choose login or register." });
    if (req.body?.channel !== undefined && req.body.channel !== "email") return res.status(400).json({ detail: "Only email verification is supported." });
    const identity = normalizeEmail(req.body?.identifier);
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ detail: "Enter the 6-digit verification code." });

    const now = new Date();
    const challenge = await OtpModel.findOneAndUpdate(
      { identity, intent, sentAt: { $gt: new Date(now.getTime() - OTP_LIFETIME_MS) }, attempts: { $lt: MAX_OTP_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true }
    );
    if (!challenge) return res.status(400).json({ detail: "The code expired or is no longer valid. Request a new one." });
    if (!safeEqualHex(challenge.codeHash, hashOtp(config.otpSecret, code))) {
      const remaining = Math.max(0, MAX_OTP_ATTEMPTS - challenge.attempts);
      return res.status(400).json({ detail: remaining ? `That code is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.` : "Too many incorrect codes. Request a new one." });
    }

    const consumed = await OtpModel.findOneAndDelete({ _id: challenge._id, codeHash: challenge.codeHash, attempts: challenge.attempts });
    if (!consumed) return res.status(400).json({ detail: "This code has already been used. Request a new one." });

    const contact = { email: identity };
    let user;
    if (intent === "register") {
      user = await UserModel.create({ ...contact, displayName: challenge.displayName, verifiedAt: now });
    } else {
      user = await UserModel.findOne(contact);
      if (!user) return res.status(404).json({ detail: "This account no longer exists. Please register." });
    }
    setSessionCookie(res, user._id);
    return res.json({ user: safeUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ detail: "An account already uses this contact. Sign in instead." });
    if (error instanceof Error && (error.message.startsWith("Enter ") || error.message.startsWith("Choose "))) {
      return res.status(400).json({ detail: error.message });
    }
    return next(error);
  }
});

router.get("/me", requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));
router.post("/logout", (_req, res) => {
  res.clearCookie(config.sessionCookie, { httpOnly: true, secure: config.nodeEnv === "production", sameSite: "lax", path: "/" });
  res.json({ ok: true });
});
return router;
}

export const authRouter = createAuthRouter();
