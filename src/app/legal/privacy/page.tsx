import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Groundworks",
  description:
    "How Groundworks collects, uses, and protects your information.",
};

const UPDATED = "October 31, 2026";

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-heading text-base tracking-[0.14em] uppercase text-[var(--gw-navy)] mt-10 mb-3">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-[15px] leading-relaxed">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return <ul className="mb-4 ml-5 list-disc space-y-1.5 text-[15px] leading-relaxed">{children}</ul>;
}

export default function PrivacyPage() {
  return (
    <>
      <header className="mb-8">
        <div className="text-[10px] font-medium uppercase tracking-[0.28em] text-[var(--gw-gold-deep)]">
          Legal
        </div>
        <h1 className="font-heading text-3xl tracking-[0.08em] uppercase text-[var(--gw-navy)] mt-2">
          Privacy Policy
        </h1>
        <p className="mt-3 text-xs text-muted-foreground">Last updated {UPDATED}</p>
      </header>

      <P>
        Groundworks (&ldquo;Groundworks,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;)
        provides small-business accounting software with a first-class REST API and MCP server. This
        Privacy Policy explains what information we collect, how we use it, and the choices you have.
        It applies to the Groundworks web application, API, MCP server, and marketing site (together,
        the &ldquo;Service&rdquo;).
      </P>

      <H2>1. Information we collect</H2>
      <P>We collect only what we need to run the Service for you.</P>
      <UL>
        <li>
          <strong>Account information.</strong> Your name, email address, password hash, and
          multi-factor authentication settings. Workspace and company names, roles, and seat
          assignments.
        </li>
        <li>
          <strong>Customer data.</strong> Accounting records you create or import, including the
          chart of accounts, journals, invoices, bills, bank transactions, inventory items,
          attachments, and reports.
        </li>
        <li>
          <strong>Connected services.</strong> Access tokens and account identifiers for third-party
          services you choose to connect, such as Intuit QuickBooks Online, Plaid bank feeds, and
          email delivery through Resend. Tokens are encrypted at rest.
        </li>
        <li>
          <strong>Agent and API activity.</strong> API keys (SHA-256 hashed), scopes, autonomy
          limits, and the operations performed by human users and AI agents in your workspace.
        </li>
        <li>
          <strong>Usage and device data.</strong> IP address, user agent, pages visited, and events
          generated as you use the Service. We use this to secure the Service and to improve it.
        </li>
        <li>
          <strong>Communications.</strong> Messages you send to our support team.
        </li>
      </UL>

      <H2>2. How we use information</H2>
      <UL>
        <li>Provide, operate, maintain, and improve the Service.</li>
        <li>Authenticate you, enforce session and MFA policies, and prevent fraud and abuse.</li>
        <li>Keep an append-only audit log of every change for your records and for SOC 2 compliance.</li>
        <li>Exchange data with the third-party services you connect, at your direction.</li>
        <li>Send transactional email (receipts, invitations, reminders, password resets).</li>
        <li>Respond to your questions and support requests.</li>
        <li>Comply with legal obligations and enforce our agreements.</li>
      </UL>
      <P>
        We do not sell your personal information, and we do not use your Customer Data to train
        third-party AI models.
      </P>

      <H2>3. Legal bases (EEA / UK)</H2>
      <P>
        If you are in the European Economic Area or the United Kingdom, we rely on the following
        bases to process your information: performance of our contract with you, our legitimate
        interests (securing and improving the Service), compliance with legal obligations, and your
        consent where applicable.
      </P>

      <H2>4. Sharing</H2>
      <P>We share information only as described below.</P>
      <UL>
        <li>
          <strong>Service providers.</strong> We use trusted vendors to host and run the Service,
          including Supabase (database and authentication), Vercel (application hosting), Resend
          (email delivery), Plaid (bank feeds), Anthropic (receipt reading and agent calls), and
          Intuit (QuickBooks import). Each is bound by a data-processing agreement.
        </li>
        <li>
          <strong>Workspace members.</strong> People and agents in your workspace see the data their
          role and scopes permit.
        </li>
        <li>
          <strong>At your direction.</strong> Data you send to connected third-party services (for
          example, posting to QuickBooks, or sending an invoice to a customer).
        </li>
        <li>
          <strong>Legal and safety.</strong> When required by law, legal process, or to protect the
          rights, safety, and property of Groundworks, our users, or the public.
        </li>
        <li>
          <strong>Business transfers.</strong> In connection with a merger, acquisition, or sale of
          assets, subject to the acquirer honoring this Policy.
        </li>
      </UL>

      <H2>5. QuickBooks and Intuit data</H2>
      <P>
        When you connect a QuickBooks Online company to Groundworks, we read your company data
        (customers, vendors, items, chart of accounts, transactions, and reports) to create a
        matching Groundworks company. We store Intuit OAuth tokens encrypted at rest and refresh
        them as needed. We use QuickBooks data only to run the import you initiated and to support
        you if you ask. We do not sell or share QuickBooks data with third parties for their own
        purposes.
      </P>

      <H2>6. Security</H2>
      <UL>
        <li>Encryption in transit (TLS) and at rest for the database and for sensitive tokens.</li>
        <li>Row-level security on every tenant table, with database triggers that reject cross-company references.</li>
        <li>Per-session policy enforcement (idle and absolute timeouts, revocation, and MFA where enabled).</li>
        <li>An append-only audit log of every mutation.</li>
        <li>SOC 2 control program; see our compliance documentation for details.</li>
      </UL>
      <P>
        No system is completely secure. If we learn of a breach that affects you, we will notify you
        as required by law.
      </P>

      <H2>7. Data retention</H2>
      <P>
        We keep your Customer Data for as long as your account is active. After you cancel, we make
        your data available for export for 30 days and then delete or de-identify it, except where
        we are required by law to keep it longer (for example, for tax or audit purposes). Audit log
        rows are retained as long as the underlying records.
      </P>

      <H2>8. Your rights</H2>
      <P>
        Depending on where you live, you may have the right to access, correct, delete, port, or
        restrict processing of your personal information, and to object to certain uses. You can
        exercise most of these rights directly in the application, or by writing to{" "}
        <a href="mailto:privacy@groundworks.app" className="underline underline-offset-2">
          privacy@groundworks.app
        </a>
        . We will respond within the time required by applicable law.
      </P>

      <H2>9. International transfers</H2>
      <P>
        Groundworks is operated from the United States, and we store and process data in the United
        States. Where required, we rely on standard contractual clauses or other lawful transfer
        mechanisms to move personal information across borders.
      </P>

      <H2>10. Children</H2>
      <P>
        The Service is not directed to children under 16, and we do not knowingly collect personal
        information from them. If you believe a child has given us personal information, contact us
        and we will delete it.
      </P>

      <H2>11. Cookies</H2>
      <P>
        We use strictly necessary cookies to keep you signed in, remember your active workspace and
        company, and secure the Service. We do not use advertising cookies or third-party trackers
        on the application.
      </P>

      <H2>12. Changes</H2>
      <P>
        We may update this Policy from time to time. If a change is material, we will notify you in
        the application or by email before it takes effect. The &ldquo;Last updated&rdquo; date at
        the top shows when it was most recently revised.
      </P>

      <H2>13. Contact</H2>
      <P>
        Questions about this Policy or our privacy practices can be sent to{" "}
        <a href="mailto:privacy@groundworks.app" className="underline underline-offset-2">
          privacy@groundworks.app
        </a>
        .
      </P>
    </>
  );
}
