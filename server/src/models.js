import mongoose from "mongoose";

const { Schema, model } = mongoose;

const userSchema = new Schema({
  displayName: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, default: undefined, unique: true, sparse: true, index: true },
  verifiedAt: { type: Date, required: true }
}, { timestamps: true });

const otpSchema = new Schema({
  identity: { type: String, required: true },
  intent: { type: String, enum: ["login", "register"], required: true },
  codeHash: { type: String, required: true },
  displayName: { type: String, default: "" },
  attempts: { type: Number, default: 0 },
  sendCount: { type: Number, default: 0 },
  windowStarted: { type: Date, required: true },
  sentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});
otpSchema.index({ identity: 1, intent: 1 }, { unique: true });

const meetingSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  owner: { type: Schema.Types.ObjectId, ref: "MeetflowUser", required: true, index: true },
  title: { type: String, required: true, maxlength: 160 },
  description: { type: String, default: "", maxlength: 4000 },
  scheduled_at: { type: String, default: null },
  duration_minutes: { type: Number, min: 5, max: 720, default: 30 },
  status: { type: String, enum: ["scheduled", "ready", "cancelled"], default: "ready" },
  notes: { type: String, default: "", maxlength: 20000 },
  created_at: { type: Date, default: Date.now }
});

export const User = model("MeetflowUser", userSchema);
export const OtpChallenge = model("MeetflowOtpChallenge", otpSchema);
export const Meeting = model("MeetflowMeeting", meetingSchema);
