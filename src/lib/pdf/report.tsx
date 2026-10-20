import type { ReactElement } from "react";
import { format } from "date-fns";
import { cellText, columnKind, type ReportTable } from "@/lib/reports/table";
import type { Pdf, PdfCompany } from "./templates";

/**
 * Any report table as a PDF: company name, title, and range on top, the
 * table with its heading repeated on every page, notes, and page numbers.
 * Wide tables (more than 5 value columns) print landscape. Text columns
 * share the free width with the label column; the rest are fixed.
 */

const INK = "#1c2541";
const MUTED = "#6b7280";
const RULE = "#d9dce3";
const SHADE = "#f3f4f6";

export function reportDocument(P: Pdf, company: PdfCompany, t: ReportTable): ReactElement {
  const landscape = t.columns.length > 5;
  const valueWidth = t.columns.length > 10 ? 50 : t.columns.length > 8 ? 58 : t.columns.length > 5 ? 70 : 90;
  const fontSize = t.columns.length > 8 ? 7 : 8.5;
  const s = P.StyleSheet.create({
    page: { paddingTop: 36, paddingBottom: 54, paddingHorizontal: 36, fontFamily: "Helvetica", fontSize, color: INK },
    head: { textAlign: "center", marginBottom: 14 },
    company: { fontFamily: "Helvetica-Bold", fontSize: 13 },
    title: { fontFamily: "Helvetica-Bold", fontSize: 10, letterSpacing: 1.5, marginTop: 4 },
    subtitle: { fontSize: 8.5, color: MUTED, marginTop: 2 },
    th: { flexDirection: "row", backgroundColor: SHADE, paddingVertical: 4, paddingHorizontal: 4, fontFamily: "Helvetica-Bold", fontSize: 7, color: MUTED },
    tr: { flexDirection: "row", paddingVertical: 2.5, paddingHorizontal: 4 },
    num: { width: valueWidth, textAlign: "right" },
    text: { flex: 1, paddingLeft: 6 },
    footer: { position: "absolute", bottom: 22, left: 36, right: 36, flexDirection: "row", borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 5, fontSize: 7, color: MUTED },
  });
  const labelFlex = t.columns.some((_, j) => columnKind(t, j) === "text") ? 2 : 1;
  const col = (j: number) => (columnKind(t, j) === "text" ? s.text : s.num);
  return (
    <P.Document title={`${t.title} ${t.subtitle}`} author={company.name} creator="Groundworks">
      <P.Page size="LETTER" orientation={landscape ? "landscape" : "portrait"} style={s.page}>
        <P.View style={s.head}>
          <P.Text style={s.company}>{company.name}</P.Text>
          <P.Text style={s.title}>{t.title.toUpperCase()}</P.Text>
          <P.Text style={s.subtitle}>{t.subtitle}</P.Text>
        </P.View>
        <P.View style={s.th} fixed>
          <P.Text style={{ flex: labelFlex }}>{t.labelColumn.toUpperCase()}</P.Text>
          {t.columns.map((c, j) => (
            <P.Text key={c} style={col(j)}>{c.toUpperCase()}</P.Text>
          ))}
        </P.View>
        {t.rows.map((r, i) => {
          const strong = r.kind === "section" || r.kind === "subtotal" || r.kind === "total";
          const line = r.kind === "subtotal" || r.kind === "total";
          return (
            <P.View
              key={i}
              wrap={false}
              style={[
                s.tr,
                line ? { borderTopWidth: r.kind === "total" ? 0.9 : 0.5, borderTopColor: r.kind === "total" ? INK : RULE } : {},
                r.kind === "section" && i > 0 ? { marginTop: 6 } : {},
              ]}
            >
              <P.Text style={{ flex: labelFlex, paddingLeft: (r.depth ?? 0) * 10, fontFamily: strong ? "Helvetica-Bold" : "Helvetica" }}>
                {r.code ? `${r.code}  ` : ""}
                {r.label}
              </P.Text>
              {t.columns.map((_, j) => (
                <P.Text key={j} style={[col(j), strong ? { fontFamily: "Helvetica-Bold" } : {}]}>{cellText(t, j, r.values[j] ?? null)}</P.Text>
              ))}
            </P.View>
          );
        })}
        {(t.notes ?? []).map((n) => (
          <P.Text key={n} style={{ marginTop: 10, fontSize: 7.5, color: MUTED }}>{n}</P.Text>
        ))}
        <P.View style={s.footer} fixed>
          <P.Text style={{ flex: 1 }}>{`${company.name} · ${t.title} · Printed ${format(new Date(), "MMM d, yyyy")}`}</P.Text>
          <P.Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </P.View>
      </P.Page>
    </P.Document>
  );
}
