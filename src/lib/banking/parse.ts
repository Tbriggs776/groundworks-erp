import { createHash } from "node:crypto";
import { isValid, parse } from "date-fns";
import { money, toDbMoney } from "@/lib/money";

/**
 * Bank statement parsers. Pure functions (no database), so they're easy to
 * test. Output amounts follow the banking sign convention: + money in,
 * − money out (for a card: + payment / refund, − charge).
 */

export type ParsedLine = {
  postedDate: string; // YYYY-MM-DD
  amount: string; // 4-decimal, signed
  description: string;
  payee: string | null;
  reference: string | null;
  fitId: string;
};

export type ParsedStatement = {
  format: "csv" | "ofx";
  lines: ParsedLine[];
  ledgerBalance: string | null;
  ledgerBalanceDate: string | null;
  /** Rows that couldn't be read (CSV only), with why. */
  skipped: Array<{ row: number; reason: string }>;
};

export type CsvOptions = {
  /** Order of day / month / year in the file's dates. Default: guessed, US first. */
  dateFormat?: "MDY" | "DMY" | "YMD";
  /** The file shows charges / withdrawals as positive numbers (common for credit cards). */
  flipSigns?: boolean;
};

export function detectFormat(content: string): "csv" | "ofx" {
  return /<OFX>|OFXHEADER/i.test(content.slice(0, 5000)) ? "ofx" : "csv";
}

export function parseStatement(content: string, opts: CsvOptions = {}): ParsedStatement {
  return detectFormat(content) === "ofx" ? parseOfx(content, opts) : parseCsv(content, opts);
}

/** Same date, amount, and text → same id; the nth identical line in a file gets #n. */
function withFitIds(lines: Array<Omit<ParsedLine, "fitId"> & { fitId?: string | null }>): ParsedLine[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    if (l.fitId) return { ...l, fitId: l.fitId };
    const key = `${l.postedDate}|${l.amount}|${l.description.toLowerCase()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...l, fitId: `h:${createHash("sha256").update(`${key}|${n}`).digest("hex").slice(0, 32)}` };
  });
}

// ---------------------------------------------------------------------------
// OFX / QFX (SGML 1.x and XML 2.x)
// ---------------------------------------------------------------------------

function ofxField(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(block);
  const v = m?.[1]?.trim();
  return v ? decodeEntities(v) : null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function ofxDate(v: string | null): string | null {
  const m = v ? /^(\d{4})(\d{2})(\d{2})/.exec(v) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function parseOfx(content: string, opts: CsvOptions): ParsedStatement {
  const blocks = content.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) ?? [];
  const skipped: ParsedStatement["skipped"] = [];
  const raw = blocks.flatMap((b, i) => {
    const postedDate = ofxDate(ofxField(b, "DTPOSTED"));
    const amt = ofxField(b, "TRNAMT");
    if (!postedDate || !amt || !/^[+-]?\d*\.?\d+$/.test(amt.replace(",", "."))) {
      skipped.push({ row: i + 1, reason: "missing date or amount" });
      return [];
    }
    const name = ofxField(b, "NAME");
    const memo = ofxField(b, "MEMO");
    const signed = money(amt.replace(",", "."));
    return [
      {
        postedDate,
        amount: toDbMoney(opts.flipSigns ? signed.neg() : signed),
        description: [name, memo].filter(Boolean).join(" · ") || ofxField(b, "TRNTYPE") || "Transaction",
        payee: name,
        reference: ofxField(b, "CHECKNUM") ?? ofxField(b, "REFNUM"),
        fitId: ofxField(b, "FITID"),
      },
    ];
  });
  const ledger = /<LEDGERBAL>[\s\S]*?(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(content)?.[0] ?? "";
  const balAmt = ofxField(ledger, "BALAMT");
  return {
    format: "ofx",
    lines: withFitIds(raw),
    ledgerBalance: balAmt && /^[+-]?\d*\.?\d+$/.test(balAmt) ? toDbMoney(balAmt) : null,
    ledgerBalanceDate: ofxDate(ofxField(ledger, "DTASOF")),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180-ish: quoted fields, doubled quotes, commas / newlines inside quotes. */
export function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = content.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

type Columns = {
  date: number;
  description: number[];
  amount: number | null;
  debit: number | null;
  credit: number | null;
  reference: number | null;
  payee: number | null;
};

function findColumns(header: string[]): Columns | null {
  const h = header.map((x) => x.toLowerCase().replace(/[^a-z ]/g, "").trim());
  const find = (re: RegExp, not?: RegExp) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const date = find(/date/, /value date/) >= 0 ? find(/date/, /value date/) : find(/^posted$|^when$/);
  const amount = find(/^amount$|^transaction amount$|^amount usd$/) >= 0 ? find(/^amount$|^transaction amount$|^amount usd$/) : find(/amount/, /balance/);
  const debit = find(/debit|withdrawal|money out|paid out|charge/, /credit/);
  const credit = find(/credit|deposit|money in|paid in|payment/, /debit|card/);
  const payee = find(/^payee$|^name$|^merchant/);
  const description = [find(/description|details|narrative|transaction$/), payee, find(/memo|note/)].filter(
    (i, n, all) => i >= 0 && all.indexOf(i) === n
  );
  const reference = find(/check|cheque|reference|^ref/);
  if (date < 0 || description.length === 0 || (amount < 0 && debit < 0 && credit < 0)) return null;
  return {
    date,
    description,
    amount: amount >= 0 ? amount : null,
    debit: amount < 0 && debit >= 0 ? debit : null,
    credit: amount < 0 && credit >= 0 ? credit : null,
    reference: reference >= 0 ? reference : null,
    payee: payee >= 0 ? payee : null,
  };
}

/** "$1,234.50", "(12.00)", "12.00 CR", "-5" → signed decimal string, or null. */
export function parseAmount(raw: string): string | null {
  let s = raw.replace(/[$£€\s]/g, "").replace(/,/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/cr$/i.test(s)) s = s.slice(0, -2);
  else if (/dr$/i.test(s)) {
    sign = -sign;
    s = s.slice(0, -2);
  }
  if (!/^[+-]?\d*\.?\d+$/.test(s)) return null;
  return toDbMoney(money(s).times(sign));
}

const FORMATS: Record<"MDY" | "DMY" | "YMD", string[]> = {
  YMD: ["yyyy-MM-dd", "yyyy/MM/dd", "yyyyMMdd"],
  MDY: ["MM/dd/yyyy", "M/d/yyyy", "MM/dd/yy", "M/d/yy", "MM-dd-yyyy", "M-d-yyyy"],
  DMY: ["dd/MM/yyyy", "d/M/yyyy", "dd/MM/yy", "d/M/yy", "dd-MM-yyyy", "dd.MM.yyyy"],
};

export function parseDate(raw: string, order: "MDY" | "DMY" | "YMD"): string | null {
  const s = raw.trim().split(/[ T]/)[0];
  for (const f of [...FORMATS.YMD, ...FORMATS[order]]) {
    const d = parse(s, f, new Date(2000, 0, 1));
    if (isValid(d) && d.getFullYear() > 1900 && d.getFullYear() < 2200) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  }
  return null;
}

/** US order unless a first component over 12 shows it's day-first. */
function guessOrder(dates: string[]): "MDY" | "DMY" {
  return dates.some((d) => Number(/^(\d{1,2})[/.-]/.exec(d)?.[1] ?? 0) > 12) ? "DMY" : "MDY";
}

function parseCsv(content: string, opts: CsvOptions): ParsedStatement {
  const rows = csvRows(content);
  const headerAt = rows.slice(0, 15).findIndex((r) => findColumns(r));
  if (headerAt < 0) {
    throw new Error(
      "Couldn't find the columns. The file needs a header row with a date, a description, and either an amount or debit / credit columns."
    );
  }
  const cols = findColumns(rows[headerAt])!;
  const body = rows.slice(headerAt + 1);
  const order = opts.dateFormat ?? guessOrder(body.map((r) => r[cols.date] ?? ""));
  const skipped: ParsedStatement["skipped"] = [];
  const raw = body.flatMap((r, i) => {
    const rowNo = headerAt + i + 2;
    const postedDate = parseDate(r[cols.date] ?? "", order);
    let amount: string | null;
    if (cols.amount !== null) amount = parseAmount(r[cols.amount] ?? "");
    else {
      const out = parseAmount(r[cols.debit ?? -1] ?? "") ?? "0";
      const inn = parseAmount(r[cols.credit ?? -1] ?? "") ?? "0";
      amount = money(out).isZero() && money(inn).isZero() ? null : toDbMoney(money(inn).abs().minus(money(out).abs()));
    }
    if (!postedDate || amount === null) {
      skipped.push({ row: rowNo, reason: !postedDate ? "unreadable date" : "unreadable amount" });
      return [];
    }
    const description = cols.description.map((c) => r[c]).filter(Boolean).join(" · ") || "Transaction";
    return [
      {
        postedDate,
        amount: opts.flipSigns ? toDbMoney(money(amount).neg()) : amount,
        description,
        payee: cols.payee !== null ? r[cols.payee] || null : null,
        reference: cols.reference !== null ? r[cols.reference] || null : null,
      },
    ];
  });
  return { format: "csv", lines: withFitIds(raw), ledgerBalance: null, ledgerBalanceDate: null, skipped };
}
