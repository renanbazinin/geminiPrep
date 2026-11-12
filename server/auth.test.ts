import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const PASSWORD = "correct horse battery staple";

function signIn(app: ReturnType<typeof createApp>, password = PASSWORD, next = "/") {
  return supertest(app).post("/login").type("form").send({ password, next });
}

describe("password gate", () => {
  it("keeps the icons and the web app manifest public, and puts them on the login page", async () => {
    const app = createApp({ password: PASSWORD });
    for (const asset of ["/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/site.webmanifest"]) {
      const response = await supertest(app).get(asset).set("Accept", "image/*,text/html");
      // Past the gate. The production server serves these files from dist/; createApp alone has none.
      expect(response.status, asset).toBe(404);
    }
    const login = await supertest(app).get("/login");
    expect(login.text).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(login.text).toContain('<link rel="manifest" href="/site.webmanifest" />');
    expect(login.text).toContain('<meta property="og:title" content="Gemini Prep" />');
    expect(login.text).toContain("<title>Sign in · Gemini Prep</title>");
  });

  it("leaves the app open when no password is configured", async () => {
    const response = await supertest(createApp({ password: "" })).get("/api/session");
    expect(response.status).toBe(200);
  });

  it("blocks the API and sends page loads to the login form", async () => {
    const app = createApp({ password: PASSWORD });
    const api = await supertest(app).get("/api/config");
    expect(api.status).toBe(401);
    expect(api.body.error).toMatch(/sign in/i);

    const post = await supertest(app).post("/api/chat/stream").send({});
    expect(post.status).toBe(401);

    const page = await supertest(app).get("/settings?tab=1").set("Accept", "text/html");
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/login?next=%2Fsettings%3Ftab%3D1");

    const docs = await supertest(app).get("/docs/guides/interactions.en.md").set("Accept", "text/html");
    expect(docs.status).toBe(302);
  });

  it("keeps the login page and health check public", async () => {
    const app = createApp({ password: PASSWORD });
    const login = await supertest(app).get("/login");
    expect(login.status).toBe(200);
    expect(login.text).toContain('type="password"');
    expect(login.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect((await supertest(app).get("/api/health")).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const response = await signIn(createApp({ password: PASSWORD }), "nope");
    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.text).toContain("Wrong password.");
  });

  it("signs in with the right password and lets the cookie through", async () => {
    const app = createApp({ password: PASSWORD });
    const response = await signIn(app, PASSWORD, "/jira");
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/jira");
    const cookie = response.headers["set-cookie"] as unknown as string[];
    expect(cookie[0]).toMatch(/^gp_session=.+HttpOnly/);

    const session = await supertest(app).get("/api/session").set("Cookie", cookie);
    expect(session.status).toBe(200);
  });

  it("does not redirect off-site after sign-in", async () => {
    const response = await signIn(createApp({ password: PASSWORD }), PASSWORD, "//evil.example");
    expect(response.headers.location).toBe("/");
  });

  it("rejects forged and other-password cookies", async () => {
    const app = createApp({ password: PASSWORD });
    const forged = `gp_session=${Date.now() + 60_000}.AAAA`;
    expect((await supertest(app).get("/api/session").set("Cookie", forged)).status).toBe(401);

    const other = await signIn(createApp({ password: "another password" }), "another password");
    const cookie = other.headers["set-cookie"] as unknown as string[];
    expect((await supertest(app).get("/api/session").set("Cookie", cookie)).status).toBe(401);
  });

  it("treats a malformed cookie as signed out", async () => {
    const app = createApp({ password: PASSWORD });
    const response = await supertest(app).get("/api/session").set("Cookie", "gp_session=%E0%A4%A");
    expect(response.status).toBe(401);
  });

  it("locks out repeated failures", async () => {
    const app = createApp({ password: PASSWORD });
    for (let attempt = 0; attempt < 10; attempt += 1) await signIn(app, "wrong");
    const response = await signIn(app, PASSWORD);
    expect(response.status).toBe(429);
  });
});
