# Meetflow

Meetflow is a MERN meeting app with passwordless account registration and sign-in. People verify their email address with an SMTP email code. After verifying, they can create meetings, share an invite, and use the existing browser-based video meeting tools.

## Requirements

- Node.js 20 or newer
- A MongoDB database (local or MongoDB Atlas)
- An SMTP account for email codes

## Configure and run on Windows

1. Install Node.js from https://nodejs.org/.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to your MongoDB connection string.
4. Generate two different random secrets and put them in `JWT_SECRET` and `OTP_SECRET`:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. Add your SMTP host, port, username, password, and verified sender address to the `SMTP_*` variables.
6. Double-click `start.bat`, or run `npm install` and `npm run dev`.
7. Open the local frontend URL printed by Vite (usually http://127.0.0.1:5173 unless that port is already in use).

The development server serves the React sign-in/register page on the Vite port and the Express API on the port defined by `PORT` (default 8000). If a port is already occupied, set `PORT` and `VITE_PORT` in `.env` before starting the app. For a production build, run `npm run build`, then `npm start`; Express serves the built React app and meeting UI on the configured port.

For email, port 465 uses TLS and port 587 uses STARTTLS. OTP sending returns a configuration error when SMTP settings are missing; verification codes are never printed to logs or returned by the API.

## Authentication and account safety

- Registration and sign-in use a one-time 6-digit code; there is no password to store or reset.
- Codes expire after 5 minutes, are stored as keyed hashes, and allow at most 5 verification attempts.
- Requests have resend cooldowns, contact-level send limits, and IP-based rate limits.
- Sessions use a signed, HTTP-only, same-site cookie that expires after 7 days.
- Email addresses are unique and must be verified before an account is created.

## Video meetings

The app retains the browser-based Meetflow meeting experience, including WebRTC audio/video, screen sharing, notes, chat, and browser-side recording. Meeting REST endpoints and WebSocket signaling run in Express; meeting and account data are stored in MongoDB.

WebRTC needs HTTPS or localhost for camera and microphone access. STUN alone cannot traverse every firewall; reliable public calls may require a TURN service. The mesh-style demo is not designed for production rooms with 100 active video streams. Use a Selective Forwarding Unit (SFU), TURN infrastructure, and a persistent Node host for larger deployments. Serverless platforms that do not support long-lived WebSockets cannot run all meeting features.

Invite links can be shared with other registered Meetflow users. Opening an invite asks users to sign in or register before entering the room.

## Tests and checks

```powershell
npm test
npm run build
```

The existing Python test suite for the original FastAPI backend remains available with `python -m pytest`, but the MERN application is started with Node.js. The Python backend is no longer the app entry point.

## Deploying on Vercel

The repository includes a Vercel configuration that builds the Vite client from `client/dist` and routes API, static meeting assets, and `/meetings` requests to the Node.js function. Configure these Vercel environment variables for the Production, Preview, and Development environments as needed:

- `MONGODB_URI`
- `JWT_SECRET` and `OTP_SECRET` (each at least 32 characters and different)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` for email verification

Vercel can host the frontend and HTTP API, but its serverless functions cannot keep the app's WebSocket signaling connections alive. Video-call signaling and other real-time meeting features therefore need a persistent Node.js host; for the complete app, deploy the frontend/API and WebSocket server on a platform that supports long-lived connections.

## Troubleshooting

- **MongoDB connection fails:** verify `MONGODB_URI`, network access, and Atlas database credentials.
- **Email code is not sent:** verify the SMTP server, TLS port, credentials, and sender address.
- **Camera/microphone unavailable:** use a supported browser, allow device permissions, and close other apps using the camera.
- **Remote video cannot connect:** confirm both accounts are using the same invite, check the browser console, and configure TURN if needed.
- **Node cannot find a dependency:** run `npm install`.
