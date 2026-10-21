/**
 * The fake Plaid (scripts/lib/fake-plaid.ts) as a standalone server, for
 * trying bank feeds in the browser or in the UI smoke test. Start the app
 * with:
 *
 *   PLAID_CLIENT_ID=fake-plaid-client PLAID_SECRET=fake-plaid-secret
 *   APP_ENCRYPTION_KEY=<openssl rand -base64 32>
 *   PLAID_API_BASE=http://127.0.0.1:<port>
 *   PLAID_LINK_SCRIPT_URL=http://127.0.0.1:<port>/link-initialize.js
 *
 *   npx tsx scripts/dev/fake-plaid-server.ts [port]     (default 54331)
 *
 * "Connect a bank" then signs in to First Platypus Bank at once, with a few
 * weeks of activity. POST {} to <fake>/fake/webhook to have it send the app
 * a signed "new transactions" webhook for that bank.
 */
import { startFakePlaid } from "../lib/fake-plaid";

const port = Number(process.argv[2] ?? 54331);
void startFakePlaid({ port }).then((fake) => console.log(`fake Plaid on ${fake.url}`));
