// Minimal stand-in for Supabase Auth, so the app can run locally without a
// Supabase project (UI smoke tests only):
//   GET    /auth/v1/user                  the user behind the bearer token
//   POST   /auth/v1/logout                sign-out (no-op)
//   POST   /auth/v1/token?grant_type=refresh_token
//   POST   /auth/v1/factors               enroll TOTP
//   DELETE /auth/v1/factors/:id           unenroll
//   POST   /auth/v1/factors/:id/challenge
//   POST   /auth/v1/factors/:id/verify    code 123456 verifies → aal2 session
//
//   DATABASE_URL=… node scripts/dev/fake-supabase-auth.mjs <profile-uuid> <email>
//
// Build/run the app with NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321.
// Tokens are unsigned HS256-shaped JWTs (see ui-smoke.mjs); getClaims()
// trusts them because /user answers. Verified factors are mirrored into
// auth.mfa_factors (the app reads them) when DATABASE_URL is set.
// Never point a real deployment at this.
import http from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const [, , userId, email] = process.argv;
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} }) : null;
const factors = new Map(); // id → { id, factor_type, status, friendly_name }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

function token(sessionId, aal) {
  const now = Math.floor(Date.now() / 1000);
  const amr = [{ method: "otp", timestamp: now - 60 }, ...(aal === "aal2" ? [{ method: "totp", timestamp: now }] : [])];
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub: userId, email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: sessionId, aal, amr }),
    "c2lnbmF0dXJl",
  ].join(".");
}

function user() {
  return {
    id: userId, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {},
    factors: [...factors.values()].map((f) => ({ ...f, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })),
    created_at: new Date().toISOString(),
  };
}

function session(sessionId, aal) {
  return { access_token: token(sessionId, aal), token_type: "bearer", expires_in: 3600, refresh_token: `r:${sessionId}:${aal}`, user: user() };
}

function bearerSession(req) {
  const auth = req.headers.authorization ?? "";
  try {
    return decode(auth.replace(/^Bearer /, "")).session_id ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

http
  .createServer(async (req, res) => {
    const cors = {
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    };
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json", ...cors });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    if (req.method === "OPTIONS") return send(204);
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/auth/v1/user") return send(200, user());
    if (path === "/auth/v1/logout") return send(204);
    if (path === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const [, sid = randomUUID(), aal = "aal1"] = String((await body(req)).refresh_token ?? "").split(":");
      const stillMfa = aal === "aal2" && [...factors.values()].some((f) => f.status === "verified");
      return send(200, session(sid, stillMfa ? "aal2" : "aal1"));
    }
    if (path === "/auth/v1/factors" && req.method === "POST") {
      const b = await body(req);
      const f = { id: randomUUID(), factor_type: "totp", status: "unverified", friendly_name: b.friendly_name ?? "" };
      factors.set(f.id, f);
      return send(200, {
        id: f.id, type: "totp", friendly_name: f.friendly_name,
        totp: {
          qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="white"/><rect x="20" y="20" width="40" height="40" fill="black"/></svg>',
          secret: "JBSWY3DPEHPK3PXP",
          uri: `otpauth://totp/Groundworks:${email}?secret=JBSWY3DPEHPK3PXP`,
        },
      });
    }
    const m = /^\/auth\/v1\/factors\/([^/]+)(?:\/(challenge|verify))?$/.exec(path);
    if (m) {
      const f = factors.get(m[1]);
      if (!f) return send(404, { code: 404, msg: "factor not found" });
      if (req.method === "DELETE") {
        factors.delete(f.id);
        if (sql) await sql`DELETE FROM auth.mfa_factors WHERE id = ${f.id}`;
        return send(200, { id: f.id });
      }
      if (m[2] === "challenge") return send(200, { id: randomUUID(), type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
      if (m[2] === "verify") {
        if ((await body(req)).code !== "123456") return send(422, { code: 422, error_code: "mfa_verification_failed", msg: "Invalid TOTP code entered" });
        f.status = "verified";
        if (sql) await sql`INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status) VALUES (${f.id}, ${userId}, ${f.friendly_name}, 'totp', 'verified') ON CONFLICT (id) DO UPDATE SET status = 'verified'`;
        return send(200, session(bearerSession(req), "aal2"));
      }
    }
    send(404, {});
  })
  .listen(54321, () => console.log("fake auth on 54321"));
