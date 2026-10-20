import type { ReactElement } from "react";
import { formatMoney, money } from "@/lib/money";
import { addressLines, pdfDate, type Pdf, type PdfCompany } from "./templates";

/**
 * Voucher checks on standard pre-printed stock (Letter): the check in the
 * top third, two matching stubs below. The stock carries the bank details
 * and MICR line; this prints only what changes per check, at the usual
 * positions. `offset` (inches) nudges everything to fit a printer.
 */

export type CheckPdf = {
  checkNumber: string | null;
  date: string;
  payee: string;
  payeeAddress: string[];
  amount: string;
  amountWords: string;
  currency: string;
  memo: string | null;
  bankAccountName: string;
  stub: Array<{ ref: string; date: string | null; description: string; amount: string; discount: string | null }>;
};

const IN = 72;
const INK = "#111111";
const MUTED = "#555555";

function at(x: number, y: number, offset: { x: number; y: number }) {
  return { position: "absolute" as const, left: (x + offset.x) * IN, top: (y + offset.y) * IN };
}

function Stub({ P, c, top, offset, company }: { P: Pdf; c: CheckPdf; top: number; offset: { x: number; y: number }; company: PdfCompany }) {
  const fmt = (v: string) => formatMoney(v, { currency: c.currency });
  const rows = c.stub.slice(0, 12);
  return (
    <P.View style={{ ...at(0.5, top + 0.35, offset), width: 7.5 * IN }}>
      <P.View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <P.Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10 }}>{c.payee}</P.Text>
        <P.Text style={{ fontSize: 9 }}>
          {pdfDate(c.date)}
          {c.checkNumber ? `   Check ${c.checkNumber}` : ""}
        </P.Text>
      </P.View>
      <P.View style={{ flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: MUTED, paddingBottom: 2, marginBottom: 2 }}>
        <P.Text style={{ width: 1.6 * IN, fontSize: 7.5, color: MUTED }}>REFERENCE</P.Text>
        <P.Text style={{ width: 1 * IN, fontSize: 7.5, color: MUTED }}>DATE</P.Text>
        <P.Text style={{ flex: 1, fontSize: 7.5, color: MUTED }}>DESCRIPTION</P.Text>
        <P.Text style={{ width: 0.9 * IN, fontSize: 7.5, color: MUTED, textAlign: "right" }}>DISCOUNT</P.Text>
        <P.Text style={{ width: 1.1 * IN, fontSize: 7.5, color: MUTED, textAlign: "right" }}>AMOUNT</P.Text>
      </P.View>
      {rows.map((r, i) => (
        <P.View key={i} style={{ flexDirection: "row", paddingVertical: 1.5 }}>
          <P.Text style={{ width: 1.6 * IN, fontSize: 8.5 }}>{r.ref}</P.Text>
          <P.Text style={{ width: 1 * IN, fontSize: 8.5 }}>{r.date ? pdfDate(r.date) : ""}</P.Text>
          <P.Text style={{ flex: 1, fontSize: 8.5 }}>{r.description}</P.Text>
          <P.Text style={{ width: 0.9 * IN, fontSize: 8.5, textAlign: "right" }}>{r.discount ? fmt(r.discount) : ""}</P.Text>
          <P.Text style={{ width: 1.1 * IN, fontSize: 8.5, textAlign: "right" }}>{fmt(r.amount)}</P.Text>
        </P.View>
      ))}
      {c.stub.length > rows.length ? (
        <P.Text style={{ fontSize: 8, color: MUTED, marginTop: 2 }}>and {c.stub.length - rows.length} more</P.Text>
      ) : null}
      <P.View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6, borderTopWidth: 0.5, borderTopColor: MUTED, paddingTop: 3 }}>
        <P.Text style={{ fontSize: 8.5, color: MUTED }}>
          {company.name} · {c.bankAccountName}
          {c.memo ? ` · ${c.memo}` : ""}
        </P.Text>
        <P.Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10 }}>{fmt(c.amount)}</P.Text>
      </P.View>
    </P.View>
  );
}

function checkPage(P: Pdf, company: PdfCompany, c: CheckPdf, offset: { x: number; y: number }, key: string) {
  const amount = money(c.amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (
    <P.Page key={key} size="LETTER" style={{ fontFamily: "Helvetica", color: INK }}>
      {/* Check */}
      <P.View style={{ ...at(0.5, 0.3, offset), width: 3.5 * IN }}>
        <P.Text style={{ fontFamily: "Helvetica-Bold", fontSize: 10 }}>{company.name}</P.Text>
        {addressLines(company.address).map((l) => (
          <P.Text key={l} style={{ fontSize: 8 }}>{l}</P.Text>
        ))}
      </P.View>
      <P.Text style={{ ...at(6.55, 0.78, offset), fontSize: 10 }}>{pdfDate(c.date)}</P.Text>
      <P.Text style={{ ...at(1.0, 1.32, offset), fontSize: 11, width: 5.2 * IN }}>{c.payee}</P.Text>
      <P.Text style={{ ...at(6.6, 1.32, offset), fontSize: 11, fontFamily: "Helvetica-Bold" }}>**{amount}</P.Text>
      <P.Text style={{ ...at(0.5, 1.68, offset), fontSize: 10, width: 6.4 * IN }}>
        {`${c.amountWords} ${"*".repeat(Math.max(0, 70 - c.amountWords.length))}`}
      </P.Text>
      <P.View style={{ ...at(1.0, 2.02, offset), width: 3.5 * IN }}>
        <P.Text style={{ fontSize: 10 }}>{c.payee}</P.Text>
        {c.payeeAddress.map((l) => (
          <P.Text key={l} style={{ fontSize: 10 }}>{l}</P.Text>
        ))}
      </P.View>
      {c.memo ? <P.Text style={{ ...at(0.6, 2.85, offset), fontSize: 9, width: 3.6 * IN }}>{c.memo}</P.Text> : null}

      {/* Two stubs: one for the payee, one for the records */}
      <Stub P={P} c={c} top={3.5} offset={offset} company={company} />
      <Stub P={P} c={c} top={7.0} offset={offset} company={company} />
    </P.Page>
  );
}

export function checks(P: Pdf, company: PdfCompany, list: CheckPdf[], offset: { x: number; y: number }): ReactElement {
  return (
    <P.Document title="Checks" author={company.name} creator="Groundworks">
      {list.map((c, i) => checkPage(P, company, c, offset, String(i)))}
    </P.Document>
  );
}
