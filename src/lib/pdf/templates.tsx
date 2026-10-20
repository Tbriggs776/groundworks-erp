import type { ReactElement } from "react";
import { format, parseISO } from "date-fns";
import type { CompanyAddress } from "@/lib/db/schema";
import { formatMoney, money } from "@/lib/money";

/**
 * PDF layouts for customer-facing documents: one letterhead, one sales
 * document layout (invoice, estimate, sales receipt, credit memo), and the
 * balance forward statement. Letter size, Helvetica.
 *
 * @react-pdf/renderer is ESM only and loaded on demand (render.ts), so its
 * primitives come in as `P` rather than as imports.
 */

export type Pdf = typeof import("@react-pdf/renderer");

export type PdfCompany = {
  name: string;
  address: CompanyAddress;
  phone: string | null;
  email: string | null;
  website: string | null;
  taxId: string | null;
  footer: string | null;
  logo: { data: Buffer; format: "png" | "jpg" } | null;
};

export type PdfParty = { name: string; addressLines: string[]; email: string | null };
export type PdfRow = { label: string; value: string; strong?: boolean };

export type SalesDocPdf = {
  title: string;
  /** DRAFT or VOID, printed beside the title. */
  stamp: string | null;
  partyLabel: string;
  party: PdfParty | null;
  meta: PdfRow[];
  currency: string;
  lines: Array<{ item: string | null; description: string | null; quantity: string; unitPrice: string; amount: string }>;
  totals: PdfRow[];
  message: string | null;
  /** Estimates waiting on the customer get signature lines. */
  signature: boolean;
};

export type StatementPdf = {
  party: PdfParty;
  currency: string;
  meta: PdfRow[];
  openingDate: string;
  openingBalance: string;
  lines: Array<{ date: string; description: string; amount: string; balance: string }>;
  closingBalance: string;
  /** Empty when the aging doesn't add up to the closing balance. */
  aging: Array<{ label: string; value: string }>;
};

const INK = "#1c2541";
const MUTED = "#6b7280";
const RULE = "#d9dce3";
const SHADE = "#f3f4f6";

export function pdfDate(iso: string): string {
  return format(parseISO(iso), "MMM d, yyyy");
}

export function addressLines(a: Partial<CompanyAddress> | null | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.street1, a.street2, cityLine, a.country].filter((l): l is string => Boolean(l && l.trim()));
}

function styles(P: Pdf) {
  return P.StyleSheet.create({
    page: { paddingTop: 40, paddingBottom: 64, paddingHorizontal: 44, fontFamily: "Helvetica", fontSize: 9, color: INK },
    row: { flexDirection: "row" },
    companyName: { fontFamily: "Helvetica-Bold", fontSize: 13, marginBottom: 3 },
    small: { fontSize: 8.5, color: MUTED, lineHeight: 1.35 },
    logo: { maxWidth: 170, maxHeight: 72, objectFit: "contain" },
    title: { fontFamily: "Helvetica-Bold", fontSize: 20, letterSpacing: 2, marginTop: 22 },
    stamp: { fontFamily: "Helvetica-Bold", fontSize: 11, color: "#b42318", marginLeft: 10, marginTop: 30, letterSpacing: 1.5 },
    label: { fontFamily: "Helvetica-Bold", fontSize: 7.5, color: MUTED, letterSpacing: 1, marginBottom: 3 },
    partyName: { fontFamily: "Helvetica-Bold", fontSize: 10, marginBottom: 2 },
    metaRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 2 },
    metaLabel: { width: 90, textAlign: "right", color: MUTED, marginRight: 8 },
    metaValue: { width: 100, textAlign: "right" },
    th: { flexDirection: "row", backgroundColor: SHADE, paddingVertical: 5, paddingHorizontal: 6, fontFamily: "Helvetica-Bold", fontSize: 7.5, color: MUTED, letterSpacing: 0.8 },
    tr: { flexDirection: "row", paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: RULE },
    num: { textAlign: "right" },
    itemName: { fontFamily: "Helvetica-Bold" },
    desc: { color: MUTED, marginTop: 1 },
    totalRow: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 2.5 },
    totalLabel: { width: 140, textAlign: "right", color: MUTED, marginRight: 10 },
    totalValue: { width: 90, textAlign: "right" },
    strong: { fontFamily: "Helvetica-Bold", color: INK, fontSize: 10.5 },
    footer: { position: "absolute", bottom: 26, left: 44, right: 44, flexDirection: "row", borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 6 },
    footerText: { flex: 1, fontSize: 7.5, color: MUTED },
    pageNo: { width: 70, textAlign: "right", fontSize: 7.5, color: MUTED },
  });
}

function Letterhead({ P, s, company }: { P: Pdf; s: ReturnType<typeof styles>; company: PdfCompany }) {
  const contact = [company.phone, company.email, company.website].filter(Boolean).join("  ·  ");
  return (
    <P.View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
      <P.View style={{ maxWidth: 300 }}>
        <P.Text style={s.companyName}>{company.name}</P.Text>
        {addressLines(company.address).map((l) => (
          <P.Text key={l} style={s.small}>{l}</P.Text>
        ))}
        {contact ? <P.Text style={s.small}>{contact}</P.Text> : null}
        {company.taxId ? <P.Text style={s.small}>Tax ID {company.taxId}</P.Text> : null}
      </P.View>
      {company.logo ? <P.Image style={s.logo} src={company.logo} /> : null}
    </P.View>
  );
}

function Footer({ P, s, company }: { P: Pdf; s: ReturnType<typeof styles>; company: PdfCompany }) {
  return (
    <P.View style={s.footer} fixed>
      <P.Text style={s.footerText}>{company.footer ?? ""}</P.Text>
      <P.Text style={s.pageNo} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </P.View>
  );
}

function PartyBlock({ P, s, label, party }: { P: Pdf; s: ReturnType<typeof styles>; label: string; party: PdfParty | null }) {
  return (
    <P.View style={{ flex: 1 }}>
      <P.Text style={s.label}>{label}</P.Text>
      {party ? (
        <>
          <P.Text style={s.partyName}>{party.name}</P.Text>
          {party.addressLines.map((l) => (
            <P.Text key={l} style={s.small}>{l}</P.Text>
          ))}
          {party.email ? <P.Text style={s.small}>{party.email}</P.Text> : null}
        </>
      ) : (
        <P.Text style={s.small}>Walk-in customer</P.Text>
      )}
    </P.View>
  );
}

function Meta({ P, s, rows }: { P: Pdf; s: ReturnType<typeof styles>; rows: PdfRow[] }) {
  return (
    <P.View>
      {rows.map((r) => (
        <P.View key={r.label} style={s.metaRow}>
          <P.Text style={s.metaLabel}>{r.label}</P.Text>
          <P.Text style={[s.metaValue, r.strong ? s.strong : {}]}>{r.value}</P.Text>
        </P.View>
      ))}
    </P.View>
  );
}

/** Invoice, estimate, sales receipt, or credit memo. */
export function salesDocument(P: Pdf, company: PdfCompany, d: SalesDocPdf): ReactElement {
  const s = styles(P);
  const fmt = (v: string) => formatMoney(v, { currency: d.currency });
  return (
    <P.Document title={`${d.title} ${d.meta[0]?.value ?? ""}`.trim()} author={company.name} creator="Groundworks">
      <P.Page size="LETTER" style={s.page}>
        <Letterhead P={P} s={s} company={company} />
        <P.View style={s.row}>
          <P.Text style={s.title}>{d.title.toUpperCase()}</P.Text>
          {d.stamp ? <P.Text style={s.stamp}>{d.stamp}</P.Text> : null}
        </P.View>
        <P.View style={[s.row, { marginTop: 14, marginBottom: 18 }]}>
          <PartyBlock P={P} s={s} label={d.partyLabel} party={d.party} />
          <Meta P={P} s={s} rows={d.meta} />
        </P.View>

        <P.View style={s.th} fixed>
          <P.Text style={{ flex: 1 }}>PRODUCT / SERVICE</P.Text>
          <P.Text style={[s.num, { width: 50 }]}>QTY</P.Text>
          <P.Text style={[s.num, { width: 80 }]}>RATE</P.Text>
          <P.Text style={[s.num, { width: 90 }]}>AMOUNT</P.Text>
        </P.View>
        {d.lines.map((l, i) => (
          <P.View key={i} style={s.tr} wrap={false}>
            <P.View style={{ flex: 1, paddingRight: 8 }}>
              {l.item ? <P.Text style={s.itemName}>{l.item}</P.Text> : null}
              {l.description && l.description !== l.item ? <P.Text style={l.item ? s.desc : {}}>{l.description}</P.Text> : null}
            </P.View>
            <P.Text style={[s.num, { width: 50 }]}>{money(l.quantity).toString()}</P.Text>
            <P.Text style={[s.num, { width: 80 }]}>{fmt(l.unitPrice)}</P.Text>
            <P.Text style={[s.num, { width: 90 }]}>{fmt(l.amount)}</P.Text>
          </P.View>
        ))}

        <P.View style={{ marginTop: 10 }} wrap={false}>
          {d.totals.map((t) => (
            <P.View key={t.label} style={s.totalRow}>
              <P.Text style={[s.totalLabel, t.strong ? s.strong : {}]}>{t.label}</P.Text>
              <P.Text style={[s.totalValue, t.strong ? s.strong : {}]}>{t.value}</P.Text>
            </P.View>
          ))}
        </P.View>

        {d.message ? (
          <P.View style={{ marginTop: 22 }} wrap={false}>
            <P.Text style={s.label}>MESSAGE</P.Text>
            <P.Text style={{ lineHeight: 1.4 }}>{d.message}</P.Text>
          </P.View>
        ) : null}

        {d.signature ? (
          <P.View style={[s.row, { marginTop: 40 }]} wrap={false}>
            <P.View style={{ flex: 2, marginRight: 24, borderTopWidth: 0.75, borderTopColor: INK, paddingTop: 4 }}>
              <P.Text style={s.small}>Accepted by</P.Text>
            </P.View>
            <P.View style={{ flex: 1, borderTopWidth: 0.75, borderTopColor: INK, paddingTop: 4 }}>
              <P.Text style={s.small}>Date</P.Text>
            </P.View>
          </P.View>
        ) : null}

        <Footer P={P} s={s} company={company} />
      </P.Page>
    </P.Document>
  );
}

function statementPage(P: Pdf, s: ReturnType<typeof styles>, company: PdfCompany, d: StatementPdf, key: string) {
  const fmt = (v: string) => formatMoney(v, { currency: d.currency });
  return (
    <P.Page key={key} size="LETTER" style={s.page}>
      <Letterhead P={P} s={s} company={company} />
      <P.Text style={s.title}>STATEMENT</P.Text>
      <P.View style={[s.row, { marginTop: 14, marginBottom: 18 }]}>
        <PartyBlock P={P} s={s} label="TO" party={d.party} />
        <Meta P={P} s={s} rows={d.meta} />
      </P.View>

      <P.View style={s.th} fixed>
        <P.Text style={{ width: 80 }}>DATE</P.Text>
        <P.Text style={{ flex: 1 }}>ACTIVITY</P.Text>
        <P.Text style={[s.num, { width: 90 }]}>AMOUNT</P.Text>
        <P.Text style={[s.num, { width: 90 }]}>BALANCE</P.Text>
      </P.View>
      <P.View style={s.tr}>
        <P.Text style={{ width: 80 }}>{pdfDate(d.openingDate)}</P.Text>
        <P.Text style={[{ flex: 1 }, s.itemName]}>Balance forward</P.Text>
        <P.Text style={[s.num, { width: 90 }]}></P.Text>
        <P.Text style={[s.num, { width: 90 }]}>{fmt(d.openingBalance)}</P.Text>
      </P.View>
      {d.lines.map((l, i) => (
        <P.View key={i} style={s.tr} wrap={false}>
          <P.Text style={{ width: 80 }}>{pdfDate(l.date)}</P.Text>
          <P.Text style={{ flex: 1, paddingRight: 8 }}>{l.description}</P.Text>
          <P.Text style={[s.num, { width: 90 }]}>{fmt(l.amount)}</P.Text>
          <P.Text style={[s.num, { width: 90 }]}>{fmt(l.balance)}</P.Text>
        </P.View>
      ))}
      <P.View style={[s.totalRow, { marginTop: 8 }]}>
        <P.Text style={[s.totalLabel, s.strong]}>{money(d.closingBalance).lt(0) ? "Credit balance" : "Amount due"}</P.Text>
        <P.Text style={[s.totalValue, s.strong]}>{fmt(money(d.closingBalance).abs().toString())}</P.Text>
      </P.View>

      {d.aging.length > 0 ? (
        <P.View style={[s.row, { marginTop: 24, borderWidth: 0.5, borderColor: RULE }]} wrap={false}>
          {d.aging.map((a, i) => (
            <P.View key={a.label} style={{ flex: 1, padding: 6, borderLeftWidth: i === 0 ? 0 : 0.5, borderLeftColor: RULE }}>
              <P.Text style={s.label}>{a.label.toUpperCase()}</P.Text>
              <P.Text style={i === d.aging.length - 1 ? s.itemName : {}}>{fmt(a.value)}</P.Text>
            </P.View>
          ))}
        </P.View>
      ) : null}

      <Footer P={P} s={s} company={company} />
    </P.Page>
  );
}

/** One customer's statement, or a batch (one statement after another). */
export function statements(P: Pdf, company: PdfCompany, list: StatementPdf[]): ReactElement {
  const s = styles(P);
  return (
    <P.Document title="Statements" author={company.name} creator="Groundworks">
      {list.map((d, i) => statementPage(P, s, company, d, String(i)))}
    </P.Document>
  );
}
