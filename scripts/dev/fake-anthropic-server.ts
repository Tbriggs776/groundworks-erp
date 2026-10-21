/**
 * The fake Claude (scripts/lib/fake-anthropic.ts) as a standalone server,
 * for trying receipts in the browser or in the UI smoke test. Every receipt
 * reads as the same card purchase at Shell (42.15, six days ago, card
 * ••3333), which matches the card line the fake Plaid's bank brings in.
 * Start the app with:
 *
 *   ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
 *
 *   npx tsx scripts/dev/fake-anthropic-server.ts [port]     (default 54332)
 */
import { startFakeAnthropic } from "../lib/fake-anthropic";

const port = Number(process.argv[2] ?? 54332);
const date = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
void startFakeAnthropic({ port }).then((fake) => {
  fake.state.fallback = {
    documentType: "receipt",
    vendorName: "Shell",
    date,
    total: "42.15",
    tax: "3.12",
    currency: "USD",
    paymentMethod: "card",
    cardLast4: "3333",
    description: "Fuel",
  };
  console.log(`fake Claude on ${fake.url}`);
});
