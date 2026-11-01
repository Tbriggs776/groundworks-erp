import { LegalFrame } from "@/components/legal-frame";

export const metadata = {
  title: "Data Retention and Disposal Policy · Groundworks",
  description:
    "How long Groundworks keeps your data, and how we dispose of it when the retention period ends.",
};

export default function RetentionPage() {
  return (
    <LegalFrame
      title="Data Retention and Disposal Policy"
      effectiveDate="November 1, 2026"
    >
      <p>
        This Data Retention and Disposal Policy (<strong>&ldquo;Policy&rdquo;</strong>) explains how long
        Floor Daddy, LLC, an Arizona limited liability company doing business as Groundworks
        (<strong>&ldquo;Groundworks,&rdquo;</strong> <strong>&ldquo;we,&rdquo;</strong>{" "}
        <strong>&ldquo;us,&rdquo;</strong> or <strong>&ldquo;our&rdquo;</strong>), keeps the
        information you entrust to the Groundworks web application, API, and related services
        (collectively, the <strong>&ldquo;Service&rdquo;</strong>), and the methods we use to
        dispose of that information at the end of the retention period. This Policy is a public
        companion to Section 12 of our Information Security Policy; the governing text for
        operations is maintained in our repository.
      </p>

      <h2>1. Scope</h2>
      <p>
        This Policy covers every category of information Groundworks processes, including the
        records you or your Users enter directly, data imported from services you connect
        (QuickBooks Online, Plaid, Resend), attachments you upload, operational records
        (application logs, audit log entries, database backups), and account and authentication
        records.
      </p>

      <h2>2. How we set retention periods</h2>
      <p>
        Each retention period in this Policy is set to be the longer of (a) the period required by
        law or by Plaid, Intuit, or another contractual partner, (b) the period needed to allow
        you to meet your own tax and accounting obligations, and (c) the period needed to
        investigate security incidents and resolve disputes. For books of account, that period is
        typically seven years, based on Internal Revenue Code §6001 and the Arizona statute of
        limitations on business records.
      </p>

      <h2>3. Retention schedule</h2>
      <p>
        The table below sets our authoritative retention periods. &ldquo;End of retention&rdquo;
        means the point at which the record becomes eligible for disposal through the methods in
        Section 5.
      </p>
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-semibold">Category</th>
            <th className="py-2 pr-3 font-semibold">Retention period</th>
            <th className="py-2 font-semibold">Trigger</th>
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-border/60 [&_td]:py-2 [&_td]:pr-3 [&_td]:align-top">
          <tr>
            <td>Account identity (name, email, password hash)</td>
            <td>Life of account + 90 days</td>
            <td>Account closure</td>
          </tr>
          <tr>
            <td>Workspace and company configuration</td>
            <td>Life of workspace + 60 days</td>
            <td>Workspace or company deletion request</td>
          </tr>
          <tr>
            <td>Workspace and company membership records</td>
            <td>Life of workspace + 7 years</td>
            <td>Workspace deletion</td>
          </tr>
          <tr>
            <td>
              Financial records (ledger journals, invoices, bills, payments, estimates, purchase
              orders, change orders, bank activity, reconciliations)
            </td>
            <td>Life of company + 7 years</td>
            <td>Company deletion request</td>
          </tr>
          <tr>
            <td>Attachments and uploaded documents</td>
            <td>Life of company + 7 years</td>
            <td>Company deletion request</td>
          </tr>
          <tr>
            <td>Audit log entries (append-only)</td>
            <td>Longer of 7 years and the period required by law</td>
            <td>Workspace deletion</td>
          </tr>
          <tr>
            <td>QuickBooks Online OAuth tokens</td>
            <td>Until you disconnect the integration</td>
            <td>Disconnection or account closure</td>
          </tr>
          <tr>
            <td>Plaid access tokens</td>
            <td>Until you disconnect the bank, or 24 months rolling, whichever is shorter</td>
            <td>Disconnection or token age</td>
          </tr>
          <tr>
            <td>Plaid-returned bank transactions</td>
            <td>Life of company + 7 years, same as financial records</td>
            <td>Company deletion request</td>
          </tr>
          <tr>
            <td>Email delivery and engagement events (Resend)</td>
            <td>30 days inside Resend; metadata written to the audit log follows that schedule</td>
            <td>Age</td>
          </tr>
          <tr>
            <td>Session records</td>
            <td>90 days after revocation or last activity, whichever is later</td>
            <td>Age</td>
          </tr>
          <tr>
            <td>API keys (SHA-256 digest only)</td>
            <td>Until revoked; metadata retained in the audit log per that schedule</td>
            <td>Revocation</td>
          </tr>
          <tr>
            <td>Application runtime logs (Vercel)</td>
            <td>30 days in Vercel; longer in a drained log store if configured</td>
            <td>Age</td>
          </tr>
          <tr>
            <td>Database backups (Supabase)</td>
            <td>
              Managed by Supabase per the active plan; typically 7–35 days of point-in-time
              recovery plus daily snapshots
            </td>
            <td>Age</td>
          </tr>
          <tr>
            <td>Support communications</td>
            <td>7 years</td>
            <td>Age</td>
          </tr>
          <tr>
            <td>Marketing contacts</td>
            <td>Until opt-out, plus 30 days to process the opt-out</td>
            <td>Opt-out request</td>
          </tr>
        </tbody>
      </table>

      <h2>4. Deletion and portability requests</h2>
      <p>
        A workspace owner may request deletion of the workspace or of any of its companies. An
        individual User may request deletion of their personal account. Submit requests by email
        to <a href="mailto:tyler@tylermbriggs.com">tyler@tylermbriggs.com</a>. We acknowledge
        within three business days and complete verified requests within sixty (60) days. We will
        provide a machine-readable export of the account&apos;s data before deletion if you ask
        for one.
      </p>
      <p>
        We may continue to retain, in restricted-access form, information we are required to
        retain to meet a legal records-retention obligation, to comply with a legal hold described
        in Section 6, to resolve an open dispute, to complete a billing cycle, or to allow routine
        encrypted database backups to age out of the backup cycle. We will state the applicable
        exception when we rely on it.
      </p>
      <p>
        We honor the data-subject rights of residents of California (CCPA/CPRA), Virginia (VCDPA),
        Colorado (CPA), Connecticut (CTDPA), Utah (UCPA), and other U.S. states to the extent
        those laws apply to us, and the data-subject rights under the EU and UK General Data
        Protection Regulations where applicable.
      </p>

      <h2>5. Disposal methods</h2>
      <p>Disposal is matched to the medium:</p>
      <ul>
        <li>
          <strong>Database rows.</strong> Hard-deleted inside a database transaction. Soft-deleted
          rows (<code>deleted_at IS NOT NULL</code>) are hard-deleted after a 90-day grace window.
          The managed-database provider reclaims the underlying storage on its standard schedule.
        </li>
        <li>
          <strong>Audit log entries.</strong> Not deleted. The schema is append-only; entries
          become eligible to be archived to cold storage after their retention period but are
          never updated or removed.
        </li>
        <li>
          <strong>Authentication records.</strong> Removed through the Supabase Admin API, which
          clears the authentication row, enrolled MFA factors, and session records.
        </li>
        <li>
          <strong>Uploaded files.</strong> Removed through the storage provider&apos;s API, with
          deletion confirmed by the API response. The file&apos;s SHA-256 digest remains in the
          audit log.
        </li>
        <li>
          <strong>Secrets.</strong> Revoked at the issuing provider (Intuit, Plaid, Supabase)
          and then removed from our encrypted token store.
        </li>
        <li>
          <strong>Backups.</strong> Expire naturally on the managed-database provider&apos;s
          backup schedule; we do not reach into backups to selectively redact.
        </li>
        <li>
          <strong>Runtime logs.</strong> Expire naturally at 30 days inside Vercel.
        </li>
        <li>
          <strong>Printed records.</strong> Shredded to a cross-cut standard. We do not routinely
          print customer records; this provision applies to any ad hoc printout.
        </li>
      </ul>

      <h2>6. Legal hold</h2>
      <p>
        A legal hold suspends the deletion requirements of Sections 3 and 4 for specified data
        when preservation is required by litigation, a subpoena or court order, a regulatory
        inquiry, or a cooperative agreement with law enforcement. Legal holds are documented,
        applied with the narrowest scope that satisfies the obligation, reviewed at least
        quarterly, and lifted promptly when no longer required.
      </p>

      <h2>7. Backup restoration</h2>
      <p>
        Information restored from backup may re-materialize records that were previously deleted.
        After any restore from backup, we re-apply outstanding deletion requests against the
        restored environment within seven days and record the re-application in the audit log.
      </p>

      <h2>8. Changes to this Policy</h2>
      <p>
        We may update this Policy from time to time. The updated version will be posted at this
        URL with a new &ldquo;Effective&rdquo; date. If a change is material, we will provide
        reasonable notice before the change takes effect, including by email to the account owner
        or by a notice inside the Service.
      </p>

      <h2>9. Contact</h2>
      <p>Questions about this Policy may be sent to:</p>
      <p>
        Floor Daddy, LLC
        <br />
        Attn: Privacy
        <br />
        22495 E Russet Rd
        <br />
        Queen Creek, Arizona 85142
        <br />
        Email: <a href="mailto:tyler@tylermbriggs.com">tyler@tylermbriggs.com</a>
      </p>
    </LegalFrame>
  );
}
