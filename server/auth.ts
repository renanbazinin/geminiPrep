import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";

// A single shared password protects the whole app (pages, API, docs). Signing in sets a signed,
// HttpOnly cookie; the signing key is derived from the password, so changing APP_PASSWORD signs
// everyone out.

const COOKIE = "gp_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// The icons and the web app manifest are public too: the login page shows the icon, and a browser
// fetches the manifest and its icons without cookies.
const PUBLIC_PATHS = new Set([
  "/login", "/api/health",
  "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/site.webmanifest",
]);
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameText(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    // Our cookie value is digits, "." and base64url, so it never needs decoding.
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Only same-site paths, so the login form can't be used as an open redirect. */
function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function sendLoginPage(res: Response, status: number, next: string, error?: string): void {
  res.status(status).set({
    "Cache-Control": "no-store",
    // The password form must never be framed by another site.
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
  }).type("html").send(loginPage(next, error));
}

/** The app's one-line description, as in index.html and public/site.webmanifest. */
const DESCRIPTION = "A Gemini chat and learning lab: chat on Vertex AI and the Gemini API, with large files, Jira assistants and documented experiments.";

function loginPage(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0b0d10" />
<meta name="robots" content="noindex" />
<meta name="description" content="${DESCRIPTION}" />
<title>Sign in · Gemini Prep</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/site.webmanifest" />
<!-- A link to the app shows this page to a signed-out preview, so it carries the app's card. -->
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Gemini Prep" />
<meta property="og:title" content="Gemini Prep" />
<meta property="og:description" content="${DESCRIPTION}" />
<meta name="twitter:card" content="summary" />
<style>
  :root { color-scheme: dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: #0b0d10; color: #eef0f4; }
  form { width: min(100%, 360px); display: grid; gap: 14px; padding: 28px; background: #15191f; border: 1px solid #2b323d; border-radius: 16px; }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
  p { margin: 0; color: #969eab; font-size: 14px; }
  label { display: grid; gap: 6px; font-size: 13px; color: #969eab; }
  input { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid #2b323d; background: #0b0d10; color: inherit; }
  input:focus { outline: 2px solid #9d8cff; outline-offset: 1px; }
  button { font: inherit; font-weight: 600; padding: 10px 12px; border: 0; border-radius: 10px; background: #9d8cff; color: #0b0d10; cursor: pointer; }
  button:hover { background: #b8adff; }
  .error { color: #f08d95; }
  .logo { display: block; width: 44px; height: 44px; border-radius: 11px; box-shadow: 0 0 32px rgba(157, 140, 255, 0.16); }
</style>
</head>
<body>
<form method="post" action="/login">
  <img class="logo" src="/favicon.svg" alt="" width="44" height="44" />
  <h1>Gemini Prep</h1>
  <p>Enter the password to continue.</p>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <label>Password
    <input type="password" name="password" autocomplete="current-password" required autofocus />
  </label>
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

export function createPasswordGate(password: string, options: { now?: () => number } = {}): {
  routes: Router;
  guard: RequestHandler;
} {
  const now = options.now ?? (() => Date.now());
  const key = createHmac("sha256", "gemini-prep-session").update(password).digest();
  const sign = (expires: number) => createHmac("sha256", key).update(String(expires)).digest("base64url");
  const failures = new Map<string, { count: number; since: number }>();

  const isSignedIn = (req: Request) => {
    const [expires, signature] = (readCookie(req, COOKIE) ?? "").split(".");
    const expiresAt = Number(expires);
    return Boolean(signature) && Number.isFinite(expiresAt) && expiresAt > now() && sameText(signature!, sign(expiresAt));
  };

  const routes = express.Router();
  routes.get("/login", (req, res) => {
    const next = safeNext(req.query.next);
    if (isSignedIn(req)) {
      res.redirect(303, next);
      return;
    }
    sendLoginPage(res, 200, next);
  });

  routes.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const next = safeNext(req.body?.next);
    const client = req.ip ?? "unknown";
    const record = failures.get(client);
    if (record && now() - record.since > FAILURE_WINDOW_MS) failures.delete(client);
    if ((failures.get(client)?.count ?? 0) >= MAX_FAILURES) {
      sendLoginPage(res, 429, next, "Too many attempts. Try again in a few minutes.");
      return;
    }
    const attempt = typeof req.body?.password === "string" ? req.body.password : "";
    if (!sameText(attempt, password)) {
      if (failures.size > 10_000) failures.clear();
      const current = failures.get(client) ?? { count: 0, since: now() };
      failures.set(client, { count: current.count + 1, since: current.since });
      sendLoginPage(res, 401, next, "Wrong password.");
      return;
    }
    failures.delete(client);
    const expires = now() + SESSION_MS;
    res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: SESSION_MS,
      path: "/",
    });
    res.redirect(303, next);
  });

  const guard: RequestHandler = (req, res, next) => {
    if (PUBLIC_PATHS.has(req.path) || isSignedIn(req)) {
      next();
      return;
    }
    const wantsPage = req.method === "GET" && !req.path.startsWith("/api/") && Boolean(req.accepts("html"));
    if (wantsPage) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.status(401).json({ error: "Sign in required. Reload the page to enter the password." });
  };

  return { routes, guard };
}
