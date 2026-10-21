// Minimal stand-in for Supabase Auth, so the app can run locally without a
// Supabase project (UI smoke tests only):
//   GET    /auth/v1/user                  the user behind the bearer token
//   PUT    /auth/v1/user                  set a new password
//   POST   /auth/v1/signup                email + password; signed in at once
//                                         (like "Confirm email" off)
//   POST   /auth/v1/token?grant_type=password
//   POST   /auth/v1/token?grant_type=refresh_token
//   POST   /auth/v1/recover               reset email (no-op)
//   POST   /auth/v1/logout                sign-out (no-op)
//   POST   /auth/v1/factors               enroll TOTP
//   DELETE /auth/v1/factors/:id           unenroll
//   POST   /auth/v1/factors/:id/challenge
//   POST   /auth/v1/factors/:id/verify    code 123456 verifies → aal2 session
//   POST   /storage/v1/object/<bucket>/<path>   Storage, for attachments: upload,
//   GET    /storage/v1/object/<bucket>/<path>   download, and delete
//   DELETE /storage/v1/object/<bucket>          ({prefixes}); service role only
//                                               (SUPABASE_SERVICE_ROLE_KEY=service-test)
//
//   DATABASE_URL=… node scripts/dev/fake-supabase-auth.mjs <profile-uuid> <email>
//
// The person named on the command line exists from the start, with no
// password until one is set. Sign-ups are added to auth.users (so the
// signup trigger makes their profile) when DATABASE_URL is set.
//
// Build/run the app with NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321.
// Tokens are unsigned HS256-shaped JWTs (see ui-smoke.mjs); getClaims()
// trusts them because /user answers. Verified factors are mirrored into
// auth.mfa_factors (the app reads them) when DATABASE_URL is set.
// Never point a real deployment at this.
import http from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const [, , firstUserId, firstEmail] = process.argv;
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} }) : null;
const users = new Map([[firstUserId, { id: firstUserId, email: firstEmail, password: null, metadata: {} }]]);
const factors = new Map(); // id → { id, userId, factor_type, status, friendly_name }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const byEmail = (email) => [...users.values()].find((u) => u.email.toLowerCase() === String(email ?? "").trim().toLowerCase());
const hasVerifiedFactor = (u) => [...factors.values()].some((f) => f.userId === u.id && f.status === "verified");

function token(u, sessionId, aal) {
  const now = Math.floor(Date.now() / 1000);
  const amr = [{ method: "password", timestamp: now - 60 }, ...(aal === "aal2" ? [{ method: "totp", timestamp: now }] : [])];
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: sessionId, aal, amr }),
    "c2lnbmF0dXJl",
  ].join(".");
}

function userJson(u) {
  const now = new Date().toISOString();
  return {
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: {}, user_metadata: u.metadata,
    identities: [{ id: u.id, provider: "email" }],
    factors: [...factors.values()]
      .filter((f) => f.userId === u.id)
      .map((f) => ({ id: f.id, factor_type: f.factor_type, status: f.status, friendly_name: f.friendly_name, created_at: now, updated_at: now })),
    created_at: now,
  };
}

function session(u, sessionId, aal) {
  return {
    access_token: token(u, sessionId, aal), token_type: "bearer", expires_in: 3600,
    refresh_token: `r:${u.id}:${sessionId}:${aal}`, user: userJson(u),
  };
}

/** The user and session id behind the request's bearer token. */
function bearer(req) {
  try {
    const claims = decode((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return { user: users.get(claims.sub), sessionId: claims.session_id ?? randomUUID() };
  } catch {
    return { user: undefined, sessionId: randomUUID() };
  }
}

const SERVICE_KEY = process.env.FAKE_SERVICE_KEY ?? "service-test";
const objects = new Map();

async function bytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
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
    const fail = (status, code, msg) => send(status, { code: status, error_code: code, msg });
    if (req.method === "OPTIONS") return send(204);
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const grant = url.searchParams.get("grant_type");

    if (path.startsWith("/storage/v1/object/")) {
      if (req.headers.authorization !== `Bearer ${SERVICE_KEY}`) return send(403, { statusCode: "403", error: "Unauthorized", message: "service role only" });
      const key = decodeURIComponent(path.slice("/storage/v1/object/".length));
      if (req.method === "POST" && key.includes("/")) {
        if (objects.has(key)) return send(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
        objects.set(key, { bytes: await bytes(req), contentType: req.headers["content-type"] ?? "application/octet-stream" });
        return send(200, { Key: key, Id: randomUUID() });
      }
      if (req.method === "GET") {
        const o = objects.get(key);
        if (!o) return send(404, { statusCode: "404", error: "not_found", message: "Object not found" });
        res.writeHead(200, { "content-type": o.contentType, ...cors });
        return res.end(o.bytes);
      }
      if (req.method === "DELETE") {
        const { prefixes = [] } = await body(req);
        const gone = prefixes.filter((p) => objects.delete(`${key}/${p}`));
        return send(200, gone.map((name) => ({ name })));
      }
      return send(400, { statusCode: "400", error: "bad_request", message: "unsupported" });
    }

    if (path === "/auth/v1/user") {
      const { user } = bearer(req);
      if (!user) return fail(401, "bad_jwt", "invalid JWT");
      if (req.method === "PUT") {
        const { password } = await body(req);
        if (typeof password === "string") {
          if (password === user.password) return fail(422, "same_password", "New password should be different from the old password.");
          user.password = password;
        }
      }
      return send(200, userJson(user));
    }
    if (path === "/auth/v1/signup" && req.method === "POST") {
      const b = await body(req);
      if (byEmail(b.email)) return fail(422, "user_already_exists", "User already registered");
      if (String(b.password ?? "").length < 6) return fail(422, "weak_password", "Password should be at least 6 characters.");
      const u = { id: randomUUID(), email: String(b.email).trim().toLowerCase(), password: b.password, metadata: b.data ?? {} };
      users.set(u.id, u);
      if (sql) await sql`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (${u.id}, ${u.email}, ${sql.json(u.metadata)})`;
      return send(200, session(u, randomUUID(), "aal1"));
    }
    if (path === "/auth/v1/token" && grant === "password") {
      const b = await body(req);
      const u = byEmail(b.email);
      if (!u || !u.password || u.password !== b.password) return fail(400, "invalid_credentials", "Invalid login credentials");
      return send(200, session(u, randomUUID(), "aal1"));
    }
    if (path === "/auth/v1/token" && grant === "refresh_token") {
      const [, uid, sid = randomUUID(), aal = "aal1"] = String((await body(req)).refresh_token ?? "").split(":");
      const u = users.get(uid) ?? users.get(firstUserId);
      return send(200, session(u, sid, aal === "aal2" && hasVerifiedFactor(u) ? "aal2" : "aal1"));
    }
    if (path === "/auth/v1/recover") return send(200, {});
    if (path === "/auth/v1/logout") return send(204);
    if (path === "/auth/v1/factors" && req.method === "POST") {
      const { user } = bearer(req);
      if (!user) return fail(401, "bad_jwt", "invalid JWT");
      const b = await body(req);
      const f = { id: randomUUID(), userId: user.id, factor_type: "totp", status: "unverified", friendly_name: b.friendly_name ?? "" };
      factors.set(f.id, f);
      return send(200, {
        id: f.id, type: "totp", friendly_name: f.friendly_name,
        totp: {
          qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="white"/><rect x="20" y="20" width="40" height="40" fill="black"/></svg>',
          secret: "JBSWY3DPEHPK3PXP",
          uri: `otpauth://totp/Groundworks:${user.email}?secret=JBSWY3DPEHPK3PXP`,
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
        if ((await body(req)).code !== "123456") return fail(422, "mfa_verification_failed", "Invalid TOTP code entered");
        f.status = "verified";
        if (sql) await sql`INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status) VALUES (${f.id}, ${f.userId}, ${f.friendly_name}, 'totp', 'verified') ON CONFLICT (id) DO UPDATE SET status = 'verified'`;
        const { sessionId } = bearer(req);
        return send(200, session(users.get(f.userId), sessionId, "aal2"));
      }
    }
    send(404, {});
  })
  .listen(54321, () => console.log("fake auth on 54321"));
