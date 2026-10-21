/**
 * The fake QuickBooks (scripts/lib/fake-qbo.ts) as a standalone server, for
 * trying the import in the browser or in the UI smoke test. Start the app
 * with:
 *
 *   QBO_CLIENT_ID=fake-client QBO_CLIENT_SECRET=fake-secret
 *   APP_ENCRYPTION_KEY=<openssl rand -base64 32>
 *   QBO_AUTH_URL=http://127.0.0.1:<port>/connect/oauth2
 *   QBO_TOKEN_URL=http://127.0.0.1:<port>/oauth2/v1/tokens/bearer
 *   QBO_REVOKE_URL=http://127.0.0.1:<port>/revoke
 *   QBO_API_BASE=http://127.0.0.1:<port>
 *
 *   npx tsx scripts/dev/fake-qbo-server.ts [port]     (default 54330)
 */
import { startFakeQbo } from "../lib/fake-qbo";

const port = Number(process.argv[2] ?? 54330);
void startFakeQbo({ realmId: "9130354", companyName: "Craig's Design and Landscaping", port }).then((fake) => console.log(`fake QuickBooks on ${fake.url}`));
