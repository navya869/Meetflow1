import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

async function requestApi(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Something went wrong. Please try again.");
  return data;
}

function meetingDestination() {
  const query = new URLSearchParams(location.search);
  const next = query.get("next");
  if (next?.startsWith("/") && !next.startsWith("//")) return next;
  const code = query.get("meeting");
  return code ? `/meetings?meeting=${encodeURIComponent(code)}` : "/meetings";
}

function Brand() {
  return <a className="brand" href="/" aria-label="Meetflow home">
    <img src="/static/assets/logo.svg" alt="" />
    <span>Meetflow</span>
  </a>;
}

function AuthApp() {
  const [intent, setIntent] = useState("register");
  const [displayName, setDisplayName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState("contact");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryIn, setRetryIn] = useState(0);

  useEffect(() => {
    requestApi("/api/auth/me")
      .then(() => location.replace(meetingDestination()))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!retryIn) return undefined;
    const timer = window.setTimeout(() => setRetryIn(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [retryIn]);

  function switchIntent(value) {
    setIntent(value);
    setPhase("contact");
    setCode("");
    setError("");
    setNotice("");
  }

  async function sendCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestApi("/api/auth/request-otp", {
        intent, identifier: identifier.trim(), displayName: displayName.trim()
      });
      setPhase("verify");
      setRetryIn(result.retryAfter || 30);
      setNotice(result.message || "Your verification code has been sent.");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestApi("/api/auth/verify-otp", {
        intent, identifier: identifier.trim(), code: code.trim()
      });
      location.replace(meetingDestination());
    } catch (reason) {
      setError(reason.message);
      setBusy(false);
    }
  }

  async function resendCode() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestApi("/api/auth/request-otp", {
        intent, identifier: identifier.trim(), displayName: displayName.trim()
      });
      setRetryIn(result.retryAfter || 30);
      setNotice("A new verification code has been sent.");
      setCode("");
    } catch (reason) {
      setError(reason.message);
      setRetryIn(reason.message.match(/Wait (\d+) seconds/)?.[1] || 0);
    } finally {
      setBusy(false);
    }
  }

  return <div className="auth-page">
    <header className="auth-header">
      <Brand />
      <span className="secure-label"><span aria-hidden="true">●</span> Secure sign in</span>
    </header>
    <main className="auth-layout">
      <section className="welcome-panel">
        <span className="eyebrow"><span className="pulse-dot" /> YOUR SPACE TO CONNECT</span>
        <h1>Better meetings.<br /><span>Bigger ideas.</span></h1>
        <p>Sign in to bring your people together with clear conversations and room-ready collaboration.</p>
        <div className="welcome-benefits">
          <div><span className="benefit-icon">↗</span><span><b>Meet in seconds</b><small>One shared link gets your team together.</small></span></div>
          <div><span className="benefit-icon">◉</span><span><b>Keep your space</b><small>Your meetings and notes stay in one place.</small></span></div>
          <div><span className="benefit-icon">✦</span><span><b>No password to forget</b><small>Verify with a one-time email code.</small></span></div>
        </div>
      </section>

      <section className="auth-card" aria-labelledby="authTitle">
        <Brand />
        <div className="auth-tabs" role="tablist" aria-label="Account action">
          <button type="button" role="tab" aria-selected={intent === "register"} className={intent === "register" ? "selected" : ""} onClick={() => switchIntent("register")}>Create account</button>
          <button type="button" role="tab" aria-selected={intent === "login"} className={intent === "login" ? "selected" : ""} onClick={() => switchIntent("login")}>Sign in</button>
        </div>
        <h2 id="authTitle">{phase === "verify" ? "Check your messages" : intent === "register" ? "Create your account" : "Welcome back"}</h2>
        <p className="card-description">{phase === "verify"
          ? <>Enter the 6-digit code we sent to <b>{identifier}</b>.</>
          : intent === "register"
            ? "Get started with a verified email address."
            : "Enter your registered email address to sign in."}</p>

        {phase === "contact" ? <form onSubmit={sendCode}>
          {intent === "register" && <label className="field">
            <span>Your name</span>
            <input autoComplete="name" maxLength="60" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="e.g. Alex Morgan" required />
          </label>}
          <label className="field">
            <span>Email address</span>
            <input
              autoComplete="email"
              inputMode="email"
              type="email"
              value={identifier}
              onChange={event => setIdentifier(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          {error && <p className="form-message error" role="alert">{error}</p>}
          <button className="submit-button" type="submit" disabled={busy}>
            {busy ? "Sending code…" : "Continue with a code"} <span aria-hidden="true">→</span>
          </button>
        </form> : <form onSubmit={verifyCode}>
          <label className="field">
            <span>6-digit verification code</span>
            <input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" required />
          </label>
          {notice && <p className="form-message success" role="status">{notice}</p>}
          {error && <p className="form-message error" role="alert">{error}</p>}
          <button className="submit-button" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Verifying…" : "Verify and continue"} <span aria-hidden="true">→</span>
          </button>
          <div className="code-actions">
            <button type="button" onClick={resendCode} disabled={busy || retryIn > 0}>{retryIn ? `Resend code in ${retryIn}s` : "Resend code"}</button>
            <button type="button" onClick={() => { setPhase("contact"); setCode(""); setError(""); setNotice(""); }}>Change email</button>
          </div>
        </form>}
        <div className="privacy-note"><span aria-hidden="true">♢</span> Your code is private. Never share it with anyone.</div>
      </section>
    </main>
    <footer className="auth-footer"><span>© Meetflow · Built for better conversations</span><span>Secure, passwordless access</span></footer>
  </div>;
}

createRoot(document.getElementById("root")).render(<AuthApp />);
