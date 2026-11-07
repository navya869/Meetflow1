import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import mongoose from "mongoose";
import { app } from "./app.js";
import { config } from "./config.js";
import { connectToDatabase } from "./database.js";
import { verifySessionToken } from "./security.js";

const server = createServer(app);
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const rooms = new Map();
const allowedMessageTypes = new Set(["offer", "answer", "ice", "chat", "state", "reaction", "raise-hand", "leave"]);

function rejectUpgrade(socket, status = 401, message = "Unauthorized") {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function isAllowedOrigin(origin, request) {
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.origin === config.clientOrigin) return true;
    const forwardedProtocol = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
    const requestProtocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
    return originUrl.origin === `${requestProtocol}://${request.headers.host}`;
  } catch {
    return false;
  }
}

async function authorizeUpgrade(request) {
  const url = new URL(request.url, "http://localhost");
  const match = url.pathname.match(/^\/ws\/([A-Z0-9]{8})\/([A-Za-z0-9_-]{1,80})$/i);
  if (!match || !isAllowedOrigin(request.headers.origin, request)) return null;
  const claims = verifySessionToken(cookieValue(request.headers.cookie, config.sessionCookie), config.jwtSecret);
  if (!claims) return null;
  const [user, meeting] = await Promise.all([
    User.findById(claims.sub).select("_id").lean(),
    Meeting.findOne({ code: match[1].toUpperCase(), status: { $ne: "cancelled" } }).select("code").lean()
  ]);
  if (!user || !meeting) return null;
  return { room: meeting.code, participantId: match[2] };
}

server.on("upgrade", async (request, socket, head) => {
  try {
    const authorization = await authorizeUpgrade(request);
    if (!authorization) return rejectUpgrade(socket);
    webSocketServer.handleUpgrade(request, socket, head, client => {
      webSocketServer.emit("connection", client, authorization);
    });
  } catch (error) {
    console.error("WebSocket authorization failed:", error);
    rejectUpgrade(socket, 503, "Service Unavailable");
  }
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room, message, excludedId) {
  for (const [participantId, socket] of rooms.get(room) || []) {
    if (participantId !== excludedId) send(socket, message);
  }
}

webSocketServer.on("connection", (socket, { room, participantId }) => {
  const peers = rooms.get(room) || new Map();
  if (peers.has(participantId)) {
    socket.close(1008, "Participant is already connected.");
    return;
  }
  if (peers.size >= 100) {
    send(socket, { type: "error", message: "This room has reached the supported limit of 100 participants." });
    socket.close(1013, "Room is full.");
    return;
  }

  const existing = [...peers.keys()];
  peers.set(participantId, socket);
  rooms.set(room, peers);
  send(socket, { type: "existing-peers", peers: existing });
  broadcast(room, { type: "peer-joined", peerId: participantId }, participantId);

  socket.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || !allowedMessageTypes.has(message.type)) return;
    message.from = participantId;

    if (message.target) {
      const target = peers.get(String(message.target));
      if (target) send(target, message);
      return;
    }
    if (message.type === "chat") {
      if (typeof message.message !== "string") return;
      message.message = message.message.trim().slice(0, 1000);
      if (!message.message) return;
    }
    if (["chat", "state", "reaction", "raise-hand", "leave"].includes(message.type)) {
      broadcast(room, message, participantId);
    }
  });

  socket.on("close", () => {
    if (peers.get(participantId) !== socket) return;
    peers.delete(participantId);
    if (peers.size === 0) rooms.delete(room);
    broadcast(room, { type: "peer-left", peerId: participantId }, participantId);
  });
});

async function start() {
  await connectToDatabase();
  server.listen(config.port, () => {
    console.log(`Meetflow MERN server listening on http://127.0.0.1:${config.port}`);
  });
}

start().catch(error => {
  console.error("Meetflow could not connect to MongoDB:", error);
  process.exitCode = 1;
});

function shutdown() {
  webSocketServer.close();
  server.close(() => {
    void mongoose.disconnect().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
