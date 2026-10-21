/**
 * A fake Plaid for the bank feed tests: link tokens, the public token
 * exchange, accounts, transactions/sync (paging, cursors, added / modified /
 * removed, as the real one does), item/remove, and signed webhooks with the
 * verification key, on a local port. It also serves a stand-in for Plaid
 * Link's script: open() signs in to the bank at once and hands back a public
 * token. Knobs make a bank want its sign-in again or change mid-read.
 */
import { createHash, generateKeyPairSync, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_PLAID_CLIENT_ID = "fake-plaid-client";
export const FAKE_PLAID_SECRET = "fake-plaid-secret";
const KID = "fake-key-1";

export type FakeAccount = { account_id: string; name: string; official_name?: string | null; mask: string; type: string; subtype: string };
export type FakeTxn = {
  transaction_id: string;
  account_id: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  original_description?: string | null;
  check_number?: string | null;
  pending: boolean;
};
type Change = { kind: "added" | "modified"; txn: FakeTxn } | { kind: "removed"; txn: { transaction_id: string; account_id: string } };

type Item = {
  itemId: string;
  accessToken: string;
  institution: { name: string; institution_id: string };
  accounts: FakeAccount[];
  log: Change[];
  loginRequired: boolean;
  removed: boolean;
  webhook: string | null;
};

export type FakePlaid = {
  url: string;
  state: {
    items: Map<string, Item>;
    /** What /link/token/create was asked, newest last. */
    linkTokens: Array<{ token: string; body: Record<string, unknown> }>;
    /** Calls made, by path. */
    calls: string[];
    /** Most transactions per sync page (the app asks for 500). */
    pageSize: number;
    /** The next read past the first page fails as if the bank changed meanwhile (Plaid asks for a restart). */
    mutateOnce: boolean;
  };
  /** A person signs in to a bank (as Plaid's window would): returns the public token for it. */
  signIn: (opts?: { institution?: string; accounts?: FakeAccount[] }) => { publicToken: string; itemId: string };
  /** A fresh public token for a bank login that already exists (as when someone signs in to it again). */
  publicTokenFor: (itemId: string) => string;
  add: (itemId: string, ...txns: FakeTxn[]) => void;
  modify: (itemId: string, ...txns: FakeTxn[]) => void;
  remove: (itemId: string, ...txns: Array<{ transaction_id: string; account_id: string }>) => void;
  setLoginRequired: (itemId: string, on: boolean) => void;
  /** A Plaid-Verification header for this body (iat in seconds, default now). */
  signWebhook: (body: string, opts?: { iat?: number; bodyHash?: string }) => string;
  close: () => Promise<void>;
};

export const DEFAULT_ACCOUNTS: FakeAccount[] = [
  { account_id: "acc-checking", name: "Plaid Checking", official_name: "Plaid Gold Standard 0% Interest Checking", mask: "0000", type: "depository", subtype: "checking" },
  { account_id: "acc-savings", name: "Plaid Saving", official_name: "Plaid Silver Standard 0.1% Interest Saving", mask: "1111", type: "depository", subtype: "savings" },
  { account_id: "acc-card", name: "Plaid Credit Card", official_name: "Plaid Diamond 12.5% APR Interest Credit Card", mask: "3333", type: "credit", subtype: "credit card" },
];

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET" };

function send(res: ServerResponse, status: number, json: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(json));
}

const plaidError = (res: ServerResponse, code: string, message: string, type = "INVALID_REQUEST") =>
  send(res, 400, { error_type: type, error_code: code, error_message: message, display_message: null, request_id: randomUUID() });

/** The current transactions of an item: its log played forward. */
function current(item: Item): FakeTxn[] {
  const m = new Map<string, FakeTxn>();
  for (const c of item.log) {
    if (c.kind === "removed") m.delete(c.txn.transaction_id);
    else m.set(c.txn.transaction_id, c.txn);
  }
  return [...m.values()];
}

/** Stand-in for Plaid Link's script: create() returns a handler whose open() signs in at once. */
const linkScript = (base: string) => `(() => {
  window.Plaid = {
    create(opts) {
      let gone = false;
      return {
        open() {
          fetch(${JSON.stringify(base)} + "/fake/link/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link_token: opts.token }) })
            .then((r) => r.json())
            .then((j) => {
              if (gone) return;
              if (j.error_code) opts.onExit({ error_code: j.error_code, error_message: j.error_message, display_message: j.display_message }, {});
              else opts.onSuccess(j.public_token, { institution: j.institution, accounts: j.accounts });
            })
            .catch((e) => opts.onExit({ error_message: String(e) }, {}));
        },
        exit() {},
        destroy() { gone = true; },
      };
    },
  };
})();`;

export async function startFakePlaid(opts: { port?: number } = {}): Promise<FakePlaid> {
  let n = 0;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: KID, alg: "ES256", use: "sig", created_at: 1_700_000_000, expired_at: null };
  const publicTokens = new Map<string, string>();
  const state: FakePlaid["state"] = { items: new Map(), linkTokens: [], calls: [], pageSize: 500, mutateOnce: false };
  const byToken = (accessToken: unknown) => [...state.items.values()].find((i) => i.accessToken === accessToken && !i.removed);

  const signIn: FakePlaid["signIn"] = (o = {}) => {
    const itemId = `item-${++n}-${randomUUID().slice(0, 8)}`;
    state.items.set(itemId, {
      itemId,
      accessToken: `access-sandbox-${randomUUID()}`,
      institution: { name: o.institution ?? "First Platypus Bank", institution_id: "ins_109508" },
      accounts: o.accounts ?? DEFAULT_ACCOUNTS,
      log: [],
      loginRequired: false,
      removed: false,
      webhook: null,
    });
    const publicToken = `public-sandbox-${randomUUID()}`;
    publicTokens.set(publicToken, itemId);
    return { publicToken, itemId };
  };
  const item = (itemId: string) => {
    const i = state.items.get(itemId);
    if (!i) throw new Error(`No fake item ${itemId}`);
    return i;
  };
  const signWebhook: FakePlaid["signWebhook"] = (raw, o = {}) => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const head = enc({ alg: "ES256", kid: KID, typ: "JWT" });
    const claims = enc({ iat: o.iat ?? Math.floor(Date.now() / 1000), request_body_sha256: o.bodyHash ?? createHash("sha256").update(raw).digest("hex") });
    const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${head}.${claims}.${sig}`;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/link-initialize.js") {
      res.writeHead(200, { "content-type": "application/javascript", ...CORS });
      return res.end(linkScript(fake.url));
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const raw = await body(req);
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return plaidError(res, "INVALID_BODY", "Body isn't JSON.");
    }
    state.calls.push(url.pathname);

    // What the Link stand-in calls when its window "finishes": sign in (or sign in again) at once.
    if (url.pathname === "/fake/link/complete") {
      const lt = state.linkTokens.find((t) => t.token === b.link_token);
      if (!lt) return plaidError(res, "INVALID_LINK_TOKEN", "Unknown link token.");
      const existing = lt.body.access_token ? byToken(lt.body.access_token) : null;
      if (existing) {
        existing.loginRequired = false;
        const publicToken = `public-sandbox-${randomUUID()}`;
        return send(res, 200, { public_token: publicToken, institution: { name: existing.institution.name, institution_id: existing.institution.institution_id } });
      }
      const s = signIn();
      const i = item(s.itemId);
      i.webhook = typeof lt.body.webhook === "string" ? lt.body.webhook : null;
      seed(i);
      return send(res, 200, { public_token: s.publicToken, institution: i.institution, accounts: i.accounts });
    }
    // Send a signed webhook for an item (default: the newest signed in through Link) to the app, for trying it in the browser.
    if (url.pathname === "/fake/webhook") {
      const i = b.item_id ? state.items.get(String(b.item_id)) : [...state.items.values()].filter((x) => x.webhook).at(-1);
      if (!i?.webhook) return send(res, 404, { error: "no webhook for that item" });
      const payload = JSON.stringify({ webhook_type: b.webhook_type ?? "TRANSACTIONS", webhook_code: b.webhook_code ?? "SYNC_UPDATES_AVAILABLE", item_id: i.itemId, environment: "sandbox" });
      const r = await fetch(i.webhook, { method: "POST", headers: { "content-type": "application/json", "plaid-verification": signWebhook(payload) }, body: payload });
      return send(res, 200, { status: r.status });
    }

    if (b.client_id !== FAKE_PLAID_CLIENT_ID || b.secret !== FAKE_PLAID_SECRET) {
      return plaidError(res, "INVALID_API_KEYS", "invalid client_id or secret provided", "INVALID_INPUT");
    }

    switch (url.pathname) {
      case "/link/token/create": {
        if (b.access_token && !byToken(b.access_token)) return plaidError(res, "INVALID_ACCESS_TOKEN", "Unknown access token.");
        const token = `link-sandbox-${randomUUID()}`;
        state.linkTokens.push({ token, body: b });
        if (b.access_token) {
          const i = byToken(b.access_token)!;
          if (typeof b.webhook === "string") i.webhook = b.webhook;
        }
        return send(res, 200, { link_token: token, expiration: new Date(Date.now() + 4 * 3600_000).toISOString(), request_id: randomUUID() });
      }
      case "/item/public_token/exchange": {
        const itemId = publicTokens.get(String(b.public_token));
        if (!itemId) return plaidError(res, "INVALID_PUBLIC_TOKEN", "Unknown public token.");
        publicTokens.delete(String(b.public_token));
        const i = item(itemId);
        return send(res, 200, { access_token: i.accessToken, item_id: i.itemId, request_id: randomUUID() });
      }
      case "/accounts/get": {
        const i = byToken(b.access_token);
        if (!i) return plaidError(res, "INVALID_ACCESS_TOKEN", "Unknown access token.");
        if (i.loginRequired) return plaidError(res, "ITEM_LOGIN_REQUIRED", "the login details of this item have changed", "ITEM_ERROR");
        return send(res, 200, { accounts: i.accounts, item: { item_id: i.itemId, institution_id: i.institution.institution_id }, request_id: randomUUID() });
      }
      case "/transactions/sync": {
        const i = byToken(b.access_token);
        if (!i) return plaidError(res, "INVALID_ACCESS_TOKEN", "Unknown access token.");
        if (i.loginRequired) return plaidError(res, "ITEM_LOGIN_REQUIRED", "the login details of this item have changed", "ITEM_ERROR");
        const size = Math.min(Number(b.count ?? 100), state.pageSize);
        const cursor = typeof b.cursor === "string" && b.cursor ? b.cursor : null;
        // A first read pages through what the bank has now ("i<log length>:<offset>"); later reads replay the log from "c<position>".
        let changes: Change[];
        let at: number;
        let next: (taken: number, more: boolean) => string;
        const ci = cursor?.match(/^i(\d+):(\d+)$/);
        const cc = cursor?.match(/^c(\d+)$/);
        if (!cursor || ci) {
          const snap = ci ? Number(ci[1]) : i.log.length;
          at = ci ? Number(ci[2]) : 0;
          if (at > 0 && state.mutateOnce) {
            state.mutateOnce = false;
            return plaidError(res, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "Underlying transaction data changed since last page was fetched.", "TRANSACTIONS_ERROR");
          }
          changes = current({ ...i, log: i.log.slice(0, snap) }).map((txn) => ({ kind: "added" as const, txn }));
          next = (taken, more) => (more ? `i${snap}:${at + taken}` : `c${snap}`);
        } else if (cc) {
          at = Number(cc[1]);
          changes = i.log;
          next = (taken) => `c${at + taken}`;
        } else return plaidError(res, "INVALID_CURSOR", "Bad cursor.");
        const page = changes.slice(at, at + size);
        const more = at + size < changes.length;
        return send(res, 200, {
          added: page.filter((c) => c.kind === "added").map((c) => c.txn),
          modified: page.filter((c) => c.kind === "modified").map((c) => c.txn),
          removed: page.filter((c) => c.kind === "removed").map((c) => ({ transaction_id: c.txn.transaction_id, account_id: c.txn.account_id })),
          next_cursor: next(page.length, more),
          has_more: more,
          request_id: randomUUID(),
        });
      }
      case "/item/remove": {
        const i = byToken(b.access_token);
        if (!i) return plaidError(res, "INVALID_ACCESS_TOKEN", "Unknown access token.");
        i.removed = true;
        return send(res, 200, { request_id: randomUUID() });
      }
      case "/webhook_verification_key/get":
        if (b.key_id !== KID) return plaidError(res, "INVALID_WEBHOOK_VERIFICATION_KEY_ID", "Unknown key id.");
        return send(res, 200, { key: jwk, request_id: randomUUID() });
      default:
        return send(res, 404, { error: "not found" });
    }
  });

  /** A few weeks of ordinary activity for a bank signed in through the Link stand-in. */
  function seed(i: Item) {
    const d = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const t = (id: string, account: string, amount: number, daysAgo: number, name: string, pending = false): FakeTxn => ({
      transaction_id: `${i.itemId}-${id}`,
      account_id: account,
      amount,
      date: d(daysAgo),
      name,
      merchant_name: name.split(" ")[0],
      pending,
    });
    i.log.push(
      ...[
        t("t1", "acc-checking", -2500, 20, "Customer deposit ACH"),
        t("t2", "acc-checking", 89.4, 14, "Office Depot #1234"),
        t("t3", "acc-checking", 1200, 10, "Rent payment CHECK 1042"),
        t("t4", "acc-card", 42.15, 6, "Shell Oil 5678"),
        t("t5", "acc-card", 18.99, 3, "Adobe Creative Cloud"),
        t("t6", "acc-checking", 64.0, 1, "Comcast Business", true),
      ].map((txn) => ({ kind: "added" as const, txn }))
    );
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const fake: FakePlaid = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    signIn,
    publicTokenFor: (itemId) => {
      item(itemId);
      const publicToken = `public-sandbox-${randomUUID()}`;
      publicTokens.set(publicToken, itemId);
      return publicToken;
    },
    add: (itemId, ...txns) => item(itemId).log.push(...txns.map((txn) => ({ kind: "added" as const, txn }))),
    modify: (itemId, ...txns) => item(itemId).log.push(...txns.map((txn) => ({ kind: "modified" as const, txn }))),
    remove: (itemId, ...txns) => item(itemId).log.push(...txns.map((txn) => ({ kind: "removed" as const, txn }))),
    setLoginRequired: (itemId, on) => {
      item(itemId).loginRequired = on;
    },
    signWebhook,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
