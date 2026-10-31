import { LegalFrame } from "@/components/legal-frame";

export const metadata = {
  title: "Privacy Policy · Groundworks",
  description: "How Groundworks collects, uses, stores, and shares your information.",
};

export default function PrivacyPage() {
  return (
    <LegalFrame title="Privacy Policy" effectiveDate="October 31, 2026">
      <p>
        This Privacy Policy explains how Floor Daddy, LLC, an Arizona limited liability company
        doing business as Groundworks (<strong>&ldquo;Groundworks,&rdquo;</strong> <strong>&ldquo;we,&rdquo;</strong>{" "}
        <strong>&ldquo;us,&rdquo;</strong> or <strong>&ldquo;our&rdquo;</strong>), collects, uses, stores,
        discloses, and protects information about you when you access or use the Groundworks web
        application, API, and related services (collectively, the <strong>&ldquo;Service&rdquo;</strong>).
        By creating an account or otherwise using the Service, you agree to this Privacy Policy.
      </p>

      <h2>1. Who this policy covers</h2>
      <p>
        This Privacy Policy applies to the owners, administrators, bookkeepers, accountants, and
        other authorized users of a Groundworks workspace or company (each, a <strong>&ldquo;User&rdquo;</strong>),
        to visitors of our marketing pages, and to prospective customers who inquire about the
        Service. If you access Groundworks on behalf of an organization, &ldquo;you&rdquo; includes
        that organization. This policy does not apply to third-party sites, services, or
        integrations that are not operated by us, including Intuit QuickBooks Online, even when
        reached from within the Service.
      </p>

      <h2>2. Information we collect</h2>

      <h3>2.1 Information you provide directly</h3>
      <ul>
        <li>Account information: your name, email address, and password (stored as a salted hash).</li>
        <li>Workspace and company information: workspace name, legal entity name, fiscal year, base currency, chart of accounts, and other configuration you enter.</li>
        <li>Financial records: invoices, bills, payments, journal entries, bank transactions, customers, vendors, items, inventory, attachments, and related documentation that you create, upload, or import.</li>
        <li>Communications you send to us, including support requests and feedback.</li>
      </ul>

      <h3>2.2 Information collected from connected services</h3>
      <p>
        When you connect a third-party service to the Service, we receive data from that service as
        authorized by you. The categories we may collect include:
      </p>
      <ul>
        <li>QuickBooks Online: your company file metadata, chart of accounts, lists (customers, vendors, items, employees), transactions (invoices, bills, payments, journals), tax codes, attachments, and the OAuth 2.0 tokens needed to call the Intuit API on your behalf.</li>
        <li>Bank feeds through Plaid: posted account transactions, account and institution metadata, and the Plaid access token for your institution connection.</li>
        <li>Email delivery through Resend: delivery and engagement events for messages you send through the Service.</li>
      </ul>

      <h3>2.3 Information collected automatically</h3>
      <ul>
        <li>Device and connection data: IP address, browser type and version, operating system, language, and the pages you request.</li>
        <li>Usage data: timestamps of actions you take, features you use, and API calls you make.</li>
        <li>Audit log entries: who performed each change, from what channel (web, API, MCP, agent), at what time, from what IP address, and with what user agent. These records are retained to support security, compliance, and your own review.</li>
        <li>Cookies and similar technologies used for authentication (session cookies for your sign in, active workspace, and active company) and for security (CSRF protection).</li>
      </ul>

      <h2>3. How we use your information</h2>
      <p>We use the information described above to:</p>
      <ul>
        <li>Provide, operate, maintain, and improve the Service.</li>
        <li>Import your QuickBooks Online company, reconcile banking activity, generate reports, and perform the accounting workflows you request.</li>
        <li>Authenticate you, enforce access controls, protect against fraud and abuse, and investigate security incidents.</li>
        <li>Respond to your support requests and send service-related communications.</li>
        <li>Comply with applicable law and respond to lawful requests from governmental authorities.</li>
        <li>With your opt-in, where required by law, send marketing or promotional messages. You can opt out at any time.</li>
      </ul>
      <p>
        We do not sell your personal information. We do not use the content of your financial
        records to train or improve any generalized machine learning model, and we do not share
        your financial records with third parties for their own marketing purposes.
      </p>

      <h2>4. How we share your information</h2>

      <h3>4.1 Within your workspace</h3>
      <p>
        Information you enter is shared with the other authorized Users of the same workspace or
        company, consistent with the roles and permissions assigned by your workspace owner or
        administrator.
      </p>

      <h3>4.2 Service providers (subprocessors)</h3>
      <p>
        We engage a limited set of vendors who process information on our behalf under written
        agreements that restrict their use of the data to providing services to us. Our current
        subprocessors include:
      </p>
      <ul>
        <li>Vercel Inc. (application hosting and content delivery).</li>
        <li>Supabase, Inc. (managed Postgres database, authentication, and object storage).</li>
        <li>Resend, Inc. (transactional and document email delivery).</li>
        <li>Plaid Inc. (bank account linking and transaction retrieval).</li>
        <li>Intuit Inc. (QuickBooks Online integration).</li>
        <li>Anthropic PBC (AI reading of receipts and other attachments you upload; the content is sent only to process the item you submitted and is not used by Anthropic to train its models).</li>
      </ul>
      <p>
        We may update this list from time to time. Material changes will be reflected in a revised
        version of this policy posted at this URL.
      </p>

      <h3>4.3 Legal and safety disclosures</h3>
      <p>
        We may disclose information when we believe in good faith that disclosure is necessary to
        comply with applicable law, a lawful subpoena, court order, or similar legal process; to
        enforce our Terms of Service; to protect the rights, property, or safety of Groundworks,
        our Users, or others; or in connection with a merger, acquisition, financing, or sale of
        all or part of our business.
      </p>

      <h3>4.4 With your direction</h3>
      <p>
        We share information with third parties when you direct us to, for example by connecting a
        new integration, sending a document to a customer or vendor, or exporting data from the
        Service.
      </p>

      <h2>5. QuickBooks Online data</h2>
      <p>
        If you connect the Service to a QuickBooks Online company, you authorize Groundworks to
        read your QuickBooks Online data through the Intuit API in order to perform the import,
        tie-out, and ongoing synchronization features you request. We handle that data as follows:
      </p>
      <ul>
        <li>We store Intuit OAuth 2.0 access and refresh tokens encrypted at rest using an application encryption key held outside the database.</li>
        <li>We store the data we import so that your Groundworks books remain usable even if you later disconnect QuickBooks Online.</li>
        <li>We do not write to your QuickBooks Online company, except as expressly described in the Service.</li>
        <li>You may disconnect the integration at any time from the QuickBooks settings page inside Groundworks, or from the Apps screen inside QuickBooks Online. On disconnection we revoke the Intuit tokens and stop calling the Intuit API for that company. The books already imported remain in your workspace.</li>
        <li>You may request deletion of imported QuickBooks data by contacting us at <a href="mailto:privacy@floordaddy.com">privacy@floordaddy.com</a>.</li>
      </ul>

      <h2>6. Security</h2>
      <p>We maintain administrative, technical, and physical safeguards designed to protect your information, including:</p>
      <ul>
        <li>Transport encryption of all traffic to and from the Service using TLS.</li>
        <li>At-rest encryption of secrets (API keys, OAuth tokens, bank access tokens) using an application-held encryption key.</li>
        <li>Row-level security on all tenant tables and tenant-guard database triggers that reject references to another company&apos;s records.</li>
        <li>Append-only audit logging of mutations across the Service.</li>
        <li>Two-step verification for workspace sign-in, available to all Users and required for workspace members when their workspace policy requires it.</li>
        <li>Routine review of security advisories and dependency updates.</li>
      </ul>
      <p>
        No security program is impenetrable. You are responsible for keeping your password and API
        keys confidential, for enabling two-step verification, and for promptly revoking access
        when a User leaves your workspace.
      </p>

      <h2>7. Data retention</h2>
      <p>
        We retain your information for as long as your account is active and for a reasonable
        period thereafter to meet our legal obligations, resolve disputes, and enforce our
        agreements. Audit log entries are retained for the longer of (i) seven years and
        (ii) the period required by applicable law. On your written request, we will delete or
        return your account data within sixty (60) days, subject to legal holds and to the
        continued retention of records we are required to keep.
      </p>

      <h2>8. Your rights and choices</h2>
      <p>Depending on where you reside, you may have the right to:</p>
      <ul>
        <li>Access the personal information we hold about you.</li>
        <li>Request correction of inaccurate personal information.</li>
        <li>Request deletion of personal information, subject to our record-keeping obligations.</li>
        <li>Object to or restrict certain processing of your personal information.</li>
        <li>Opt out of marketing communications at any time.</li>
      </ul>
      <p>
        To exercise these rights, email <a href="mailto:privacy@floordaddy.com">privacy@floordaddy.com</a>.
        We will respond consistent with applicable law. If we deny your request, we will explain
        why and tell you how to appeal.
      </p>

      <h2>9. Children</h2>
      <p>
        The Service is not directed to, and not intended for, individuals under 18 years of age.
        We do not knowingly collect personal information from children. If you believe a child has
        provided us with personal information, contact us and we will delete it.
      </p>

      <h2>10. International Users</h2>
      <p>
        The Service is operated from the United States and the information you submit is stored
        and processed in the United States. If you access the Service from outside the United
        States, you consent to the transfer of your information to the United States and to its
        processing under United States law, which may provide a different level of protection than
        the laws of your jurisdiction.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. The updated version will be posted at
        this URL with a new &ldquo;Effective&rdquo; date. If a change is material, we will provide
        reasonable notice before the change takes effect, including by email to the account owner
        or by a notice inside the Service. Your continued use of the Service after the effective
        date of the updated policy constitutes acceptance of it.
      </p>

      <h2>12. Contact us</h2>
      <p>Questions, requests, or complaints about this Privacy Policy may be sent to:</p>
      <p>
        Floor Daddy, LLC
        <br />
        Attn: Privacy
        <br />
        [Street Address]
        <br />
        [City], Arizona [ZIP]
        <br />
        Email: <a href="mailto:privacy@floordaddy.com">privacy@floordaddy.com</a>
      </p>
    </LegalFrame>
  );
}
