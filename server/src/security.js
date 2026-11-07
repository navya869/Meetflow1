import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

export function createOtp(secret) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, codeHash: hashOtp(secret, code) };
}

export function hashOtp(secret, code) {
  return createHmac("sha256", secret).update(String(code)).digest("hex");
}

export function safeEqualHex(left, right) {
  if (!/^[\da-f]{64}$/i.test(left || "") || !/^[\da-f]{64}$/i.test(right || "")) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createSessionToken(userId, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(userId),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 60 * 60 * 24 * 7
  })).toString("base64url");
  const input = `mfs1.${payload}`;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [version, payload, signature, extra] = token.split(".");
  if (version !== "mfs1" || !payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(`${version}.${payload}`).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims.sub !== "string" || !claims.sub || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(now / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
