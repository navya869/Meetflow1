import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET ||= "test-session-secret-012345678901234567890123";
process.env.OTP_SECRET ||= "test-otp-secret-01234567890123456789012345";
process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/meetflow-test";

const [{ createAuthRouter }, security] = await Promise.all([
  import("../src/auth.js"),
  import("../src/security.js")
]);

function makeModels() {
  const users = [];
  const challenges = new Map();
  let nextId = 0;
  const UserModel = {
    async findOne(query) {
      return users.find(user => Object.entries(query).every(([key, value]) => user[key] === value)) || null;
    },
    async create(data) {
      const user = { _id: `user-${users.length + 1}`, ...data };
      users.push(user);
      return user;
    }
  };
  const OtpModel = {
    async findOne(query) {
      return challenges.get(`${query.identity}:${query.intent}`) || null;
    },
    async findOneAndUpdate(query, update) {
      const key = `${query.identity}:${query.intent}`;
      const previous = challenges.get(key);
      if (query.sentAt?.$gt && previous?.sentAt <= query.sentAt.$gt) return null;
      if (query.attempts?.$lt !== undefined && (previous?.attempts || 0) >= query.attempts.$lt) return null;
      const challenge = {
        ...previous,
        _id: previous?._id || `challenge-${++nextId}`,
        identity: query.identity,
        intent: query.intent,
        ...update.$set
      };
      if (update.$inc) {
        for (const [field, amount] of Object.entries(update.$inc)) {
          challenge[field] = (previous?.[field] || 0) + amount;
        }
      }
      challenges.set(key, challenge);
      return challenge;
    },
    async findOneAndDelete(query) {
      for (const [key, challenge] of challenges) {
        if (challenge._id === query._id && challenge.codeHash === query.codeHash && challenge.attempts === query.attempts) {
          challenges.delete(key);
          return challenge;
        }
      }
      return null;
    },
    async deleteOne(query) {
      const key = `${query.identity}:${query.intent}`;
      const challenge = challenges.get(key);
      if (challenge?.codeHash === query.codeHash) challenges.delete(key);
    }
  };
  return { UserModel, OtpModel, users, challenges };
}

async function openHarness(deliverOtp) {
  const { createServer } = await import("node:http");
  const express = (await import("express")).default;
  const models = makeModels();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").flatMap(part => {
      const separator = part.indexOf("=");
      return separator < 0 ? [] : [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    }));
    next();
  });
  app.use(createAuthRouter({ ...models, deliverOtp }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { ...models, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeHarness(harness) {
  await new Promise((resolve, reject) => harness.server.close(error => error ? reject(error) : resolve()));
}

async function post(baseUrl, route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("normalizes email addresses", () => {
  assert.equal(security.normalizeEmail("  NAVYA@Example.com "), "navya@example.com");
  assert.throws(() => security.normalizeEmail("not-an-email"), /valid email address/);
});

test("session tokens reject invalid signatures and expire", () => {
  const now = 1_800_000_000_000;
  const token = security.createSessionToken("user-1", process.env.JWT_SECRET, now);
  assert.equal(security.verifySessionToken(token, process.env.JWT_SECRET, now)?.sub, "user-1");
  assert.equal(security.verifySessionToken(token, "a-different-secret-which-is-long-enough", now), null);
  assert.equal(security.verifySessionToken(token, process.env.JWT_SECRET, now + 8 * 24 * 60 * 60 * 1000), null);
});

test("registration sends an OTP without exposing it and verifies before creating an account", async t => {
  let sent;
  const harness = await openHarness(async details => { sent = details; });
  t.after(() => closeHarness(harness));

  const request = await post(harness.baseUrl, "/request-otp", {
    intent: "register", identifier: "Alex@Example.com", displayName: "Alex"
  });
  assert.equal(request.status, 200);
  const requestBody = await request.json();
  assert.equal("code" in requestBody, false);
  assert.equal(sent.identity, "alex@example.com");
  assert.equal(harness.users.length, 0);

  const wrongCode = sent.code === "000000" ? "000001" : "000000";
  const incorrect = await post(harness.baseUrl, "/verify-otp", {
    intent: "register", identifier: "alex@example.com", code: wrongCode
  });
  assert.equal(incorrect.status, 400);
  assert.match((await incorrect.json()).detail, /incorrect/);
  assert.equal(harness.users.length, 0);

  const verified = await post(harness.baseUrl, "/verify-otp", {
    intent: "register", identifier: "alex@example.com", code: sent.code
  });
  assert.equal(verified.status, 200);
  assert.match(verified.headers.get("set-cookie"), /HttpOnly/i);
  assert.equal((await verified.json()).user.displayName, "Alex");
  assert.equal(harness.users.length, 1);
  assert.equal(harness.users[0].email, "alex@example.com");
});

test("OTP attempts are capped and provider failures are explicit", async t => {
  let sent;
  const harness = await openHarness(async details => { sent = details; });
  t.after(() => closeHarness(harness));
  await harness.UserModel.create({ _id: "existing", displayName: "Sam", email: "sam@example.com", verifiedAt: new Date() });

  const requested = await post(harness.baseUrl, "/request-otp", {
    intent: "login", identifier: "sam@example.com"
  });
  assert.equal(requested.status, 200);
  const wrongCode = sent.code === "111111" ? "222222" : "111111";
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await post(harness.baseUrl, "/verify-otp", {
      intent: "login", identifier: "sam@example.com", code: wrongCode
    });
    assert.equal(response.status, 400);
  }
  const locked = await post(harness.baseUrl, "/verify-otp", {
    intent: "login", identifier: "sam@example.com", code: sent.code
  });
  assert.match((await locked.json()).detail, /expired|no longer valid/);

  const unavailable = await openHarness(async () => { throw new Error("SMTP server details must not be sent to the browser."); });
  t.after(() => closeHarness(unavailable));
  const failedDelivery = await post(unavailable.baseUrl, "/request-otp", {
    intent: "register", identifier: "sam@example.com", displayName: "Sam"
  });
  assert.equal(failedDelivery.status, 502);
  const failureBody = await failedDelivery.json();
  assert.match(failureBody.detail, /provider settings/);
  assert.doesNotMatch(failureBody.detail, /SMTP server details/);
  assert.equal(unavailable.challenges.size, 0);
});

test("email OTPs can be used to register and sign in", async t => {
  let sent;
  const harness = await openHarness(async details => { sent = details; });
  t.after(() => closeHarness(harness));

  const registration = await post(harness.baseUrl, "/request-otp", {
    intent: "register", identifier: "Jordan@Example.com", displayName: "Jordan"
  });
  assert.equal(registration.status, 200);
  const registered = await post(harness.baseUrl, "/verify-otp", {
    intent: "register", identifier: "jordan@example.com", code: sent.code
  });
  assert.equal(registered.status, 200);
  assert.equal((await registered.json()).user.email, "jordan@example.com");

  const login = await post(harness.baseUrl, "/request-otp", {
    intent: "login", identifier: "jordan@example.com"
  });
  assert.equal(login.status, 200);
  for (let attempt = 0; attempt < 4; attempt++) {
    harness.challenges.get("jordan@example.com:login").sentAt = new Date(Date.now() - 31_000);
    const resend = await post(harness.baseUrl, "/request-otp", {
      intent: "login", identifier: "jordan@example.com"
    });
    assert.equal(resend.status, 200);
  }
  harness.challenges.get("jordan@example.com:login").sentAt = new Date(Date.now() - 31_000);
  const rateLimited = await post(harness.baseUrl, "/request-otp", {
    intent: "login", identifier: "jordan@example.com"
  });
  assert.equal(rateLimited.status, 429);

  const authenticated = await post(harness.baseUrl, "/verify-otp", {
    intent: "login", identifier: "jordan@example.com", code: sent.code
  });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).user.displayName, "Jordan");
});

test("SMS verification requests are rejected", async t => {
  let deliveryCalled = false;
  const harness = await openHarness(async () => { deliveryCalled = true; });
  t.after(() => closeHarness(harness));

  const request = await post(harness.baseUrl, "/request-otp", {
    intent: "register", channel: "sms", identifier: "+14155552671", displayName: "Jordan"
  });
  assert.equal(request.status, 400);
  assert.match((await request.json()).detail, /Only email verification/);
  assert.equal(deliveryCalled, false);
  assert.equal(harness.challenges.size, 0);

  const verification = await post(harness.baseUrl, "/verify-otp", {
    intent: "login", channel: "sms", identifier: "+14155552671", code: "123456"
  });
  assert.equal(verification.status, 400);
  assert.match((await verification.json()).detail, /Only email verification/);
});
