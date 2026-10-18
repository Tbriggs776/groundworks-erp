// Minimal stand-in for Supabase Auth's GET /auth/v1/user, so the app can
// run locally without a Supabase project (UI smoke tests only).
//
//   node scripts/dev/fake-supabase-auth.mjs <profile-uuid> <email>
//
// Build/run the app with NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321.
// Never point a real deployment at this.
import http from "node:http";
const [, , userId, email] = process.argv;
http
  .createServer((req, res) => {
    if (req.url.startsWith("/auth/v1/user")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: userId, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  })
  .listen(54321, () => console.log("fake auth on 54321"));
