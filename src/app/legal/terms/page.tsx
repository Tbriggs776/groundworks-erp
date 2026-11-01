import { LegalFrame } from "@/components/legal-frame";

export const metadata = {
  title: "Terms of Service · Groundworks",
  description: "The agreement that governs your use of Groundworks.",
};

export default function TermsPage() {
  return (
    <LegalFrame title="Terms of Service" effectiveDate="October 31, 2026">
      <p>
        These Terms of Service (<strong>&ldquo;Terms&rdquo;</strong>) are a binding agreement between
        Floor Daddy, LLC, an Arizona limited liability company doing business as Groundworks
        (<strong>&ldquo;Groundworks,&rdquo;</strong> <strong>&ldquo;we,&rdquo;</strong> <strong>&ldquo;us,&rdquo;</strong>
        or <strong>&ldquo;our&rdquo;</strong>), and the individual or entity that accepts them
        (<strong>&ldquo;Customer,&rdquo;</strong> <strong>&ldquo;you,&rdquo;</strong> or <strong>&ldquo;your&rdquo;</strong>).
        By creating an account, clicking a button indicating acceptance, or otherwise using the
        Groundworks web application, API, Model Context Protocol server, or related services
        (collectively, the <strong>&ldquo;Service&rdquo;</strong>), you agree to these Terms. If you
        are accepting these Terms on behalf of an organization, you represent that you have
        authority to bind that organization and &ldquo;Customer&rdquo; refers to that organization.
        If you do not accept these Terms, you may not use the Service.
      </p>

      <h2>1. The Service</h2>
      <p>
        Groundworks is a multi-tenant cloud accounting application that allows a workspace to keep
        books for one or more companies. The Service includes the web application, the REST API,
        the Model Context Protocol server, documentation, and support, as well as any updates and
        new features we make generally available to accounts of your type.
      </p>

      <h2>2. Accounts and access</h2>

      <h3>2.1 Registration</h3>
      <p>
        To use the Service you must register for a Groundworks account and provide accurate,
        complete, and current information. You must be at least 18 years old.
      </p>

      <h3>2.2 Workspace roles</h3>
      <p>
        Workspace owners and administrators are responsible for inviting and removing Users,
        granting company-level access, configuring the security policy, and reviewing audit logs.
        You are responsible for the acts and omissions of your Users and for ensuring they comply
        with these Terms.
      </p>

      <h3>2.3 Authentication and credentials</h3>
      <p>
        You are responsible for safeguarding account credentials, API keys, and the devices used
        to access the Service, and for enabling two-step verification where appropriate. You must
        notify us promptly at <a href="mailto:tyler@tylermbriggs.com">tyler@tylermbriggs.com</a>
        if you suspect unauthorized access.
      </p>

      <h3>2.4 Agents and automated access</h3>
      <p>
        You may authorize software agents to act on your behalf through API keys issued inside the
        Service. Each agent acts under its own identity, with scopes and posting limits set by
        your administrators. You are solely responsible for actions taken by agents you authorize.
      </p>

      <h2>3. Fees and payment</h2>
      <p>
        Fees for the Service, if any, will be as described on our pricing page or in an order form
        you accept. Unless stated otherwise, fees are quoted in United States dollars, exclusive
        of taxes, and are non-refundable. You authorize us to charge the payment method you
        provide for all fees as they come due. We may suspend or terminate your access for
        non-payment after reasonable notice.
      </p>

      <h2>4. Customer Data</h2>

      <h3>4.1 Ownership</h3>
      <p>
        As between the parties, you own all data, files, records, and other content that you or
        your Users submit to the Service, or that we import on your behalf from a service you
        connect, including from Intuit QuickBooks Online (<strong>&ldquo;Customer Data&rdquo;</strong>).
      </p>

      <h3>4.2 License to us</h3>
      <p>
        You grant us a non-exclusive, worldwide, royalty-free license to host, copy, transmit,
        process, display, and otherwise use Customer Data solely as necessary to provide, secure,
        improve, and support the Service, to comply with law, and to enforce these Terms. We will
        not sell Customer Data and will not use the content of Customer Data to train or improve
        any generalized machine learning model.
      </p>

      <h3>4.3 Your responsibilities for Customer Data</h3>
      <p>
        You represent that you have the right to submit Customer Data to the Service and that the
        Service&apos;s use of Customer Data under these Terms will not violate any law or infringe
        any third party&apos;s rights. You are responsible for the accuracy and legality of
        Customer Data, for maintaining your own backup copies, and for determining whether the
        Service meets your record-keeping, tax, and audit requirements.
      </p>

      <h3>4.4 Deletion</h3>
      <p>
        You may delete Customer Data from your workspace at any time, subject to retention of
        audit log entries and other records we are required to keep. On termination of your
        account, we will delete or return your Customer Data within sixty (60) days, except for
        records we must keep by law or that are retained in routine, encrypted backups until those
        backups cycle out.
      </p>

      <h2>5. Third-party services</h2>
      <p>
        The Service integrates with third-party services, including Intuit QuickBooks Online,
        Plaid, and Resend. Your use of a third-party service is governed by that service&apos;s
        own terms and privacy policy, not these Terms, and we are not responsible for a
        third-party service&apos;s acts, omissions, availability, or data handling. By connecting
        a third-party service to the Service, you authorize us to access, retrieve, and store
        data from that service as described in our Privacy Policy.
      </p>

      <h2>6. Acceptable use</h2>
      <p>You will not, and will not permit any User or agent to:</p>
      <ul>
        <li>Use the Service in violation of any applicable law, including laws governing data protection, financial reporting, tax, or consumer protection.</li>
        <li>Upload or transmit any content that is unlawful, infringing, defamatory, obscene, or that contains viruses, worms, or other malicious code.</li>
        <li>Attempt to gain unauthorized access to the Service, to another customer&apos;s workspace, or to any system or network connected to the Service.</li>
        <li>Reverse engineer, decompile, or otherwise attempt to derive the source code of the Service, except to the extent this restriction is unenforceable under applicable law.</li>
        <li>Interfere with or disrupt the integrity or performance of the Service, including by rate-limit evasion, scraping, or excessive automated queries.</li>
        <li>Resell, sublicense, lease, or otherwise commercially exploit the Service, except as expressly permitted by a separate written agreement.</li>
        <li>Use the Service to send unsolicited commercial communications in violation of applicable anti-spam laws.</li>
      </ul>
      <p>
        We may suspend accounts that we reasonably believe are violating this Section 6, including
        without prior notice if a violation threatens the security or integrity of the Service.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        We and our licensors own all right, title, and interest in and to the Service, including
        all software, documentation, trademarks, service marks, and other materials, and all
        intellectual property rights therein. Subject to these Terms and to timely payment of
        applicable fees, we grant you a limited, non-exclusive, non-transferable,
        non-sublicensable right to access and use the Service during the term solely for your
        internal business purposes. All rights not expressly granted are reserved.
      </p>

      <h2>8. Feedback</h2>
      <p>
        If you provide suggestions, enhancements, or feedback regarding the Service, you grant us
        a perpetual, irrevocable, worldwide, royalty-free license to use that feedback for any
        purpose, without obligation to you.
      </p>

      <h2>9. Warranty disclaimer</h2>
      <p className="uppercase tracking-wide">
        The Service, including all content and output, is provided &ldquo;as is&rdquo; and &ldquo;as
        available,&rdquo; without warranty of any kind, whether express, implied, or statutory. To
        the maximum extent permitted by law, we disclaim all warranties, including the implied
        warranties of merchantability, fitness for a particular purpose, non-infringement, title,
        and any warranties arising from course of dealing or usage of trade. We do not warrant
        that the Service will be uninterrupted, error-free, secure, or that it will meet your
        requirements. The Service does not provide legal, tax, accounting, or financial advice.
        You are solely responsible for determining whether the Service&apos;s output is accurate
        and suitable for your use.
      </p>

      <h2>10. Limitation of liability</h2>
      <p className="uppercase tracking-wide">
        To the maximum extent permitted by law, in no event will Groundworks or its affiliates,
        officers, directors, employees, agents, or licensors be liable for any indirect,
        incidental, special, consequential, exemplary, or punitive damages, or for any lost
        profits, lost revenue, lost data, business interruption, or loss of goodwill, arising out
        of or related to these Terms or the Service, whether in contract, tort, strict liability,
        or any other legal theory, even if we have been advised of the possibility of such
        damages.
      </p>
      <p className="uppercase tracking-wide">
        Our aggregate liability arising out of or related to these Terms or the Service will not
        exceed the greater of (a) the fees you paid us for the Service in the twelve (12) months
        preceding the event giving rise to the claim, or (b) one hundred United States dollars
        ($100).
      </p>
      <p>
        Some jurisdictions do not allow the exclusion or limitation of certain damages. In those
        jurisdictions, the above limitations apply to the fullest extent permitted by law.
      </p>

      <h2>11. Indemnification</h2>
      <p>
        You will defend, indemnify, and hold harmless Groundworks and its affiliates, officers,
        directors, employees, and agents from and against any claim, demand, liability, loss, or
        expense (including reasonable attorneys&apos; fees) arising out of or related to (a) your
        or any User&apos;s or agent&apos;s use of the Service in violation of these Terms, (b)
        your Customer Data or any claim that it infringes or violates the rights of any third
        party, or (c) your violation of any law or regulation. We will promptly notify you of any
        claim subject to this Section 11 and cooperate reasonably with your defense, provided
        that we may participate in the defense with counsel of our own choosing at our expense.
      </p>

      <h2>12. Term and termination</h2>
      <p>
        These Terms begin when you first accept them and continue until terminated. You may
        terminate at any time by closing your account. We may suspend or terminate your access,
        with or without notice, if (a) you materially breach these Terms, (b) your account is
        delinquent on fees, or (c) continuing to provide the Service to you would, in our good
        faith judgment, expose us to legal, security, or regulatory risk. Sections 4.1, 4.2, 7,
        8, 9, 10, 11, 13, and 14 survive any termination.
      </p>

      <h2>13. Governing law; dispute resolution</h2>
      <p>
        These Terms are governed by the laws of the State of Arizona, without regard to its
        conflict-of-laws principles. The United Nations Convention on Contracts for the
        International Sale of Goods does not apply.
      </p>
      <p>
        The parties will try in good faith to resolve any dispute arising out of or related to
        these Terms through informal negotiation. If the dispute is not resolved within thirty
        (30) days, the parties consent to the exclusive jurisdiction of the state and federal
        courts located in Maricopa County, Arizona, and waive any objection to venue in those
        courts. Each party irrevocably waives any right to a trial by jury. Any claim must be
        brought within one (1) year after the cause of action arises or it is permanently barred.
      </p>

      <h2>14. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. The updated version will be posted at this
        URL with a new &ldquo;Effective&rdquo; date. If a change is material, we will provide
        reasonable notice before it takes effect, including by email to the account owner or by a
        notice inside the Service. Your continued use of the Service after the effective date of
        the updated Terms constitutes acceptance of them. If you do not agree, you must stop
        using the Service.
      </p>

      <h2>15. General</h2>
      <p>
        These Terms, together with the Privacy Policy and any order form you accept, are the
        entire agreement between the parties regarding the Service and supersede all prior or
        contemporaneous understandings. If any provision of these Terms is held unenforceable,
        the remaining provisions remain in effect. Our failure to enforce any right or provision
        is not a waiver. You may not assign these Terms without our prior written consent; we may
        assign them to an affiliate or in connection with a merger, acquisition, financing, or
        sale of our business. Notices to you may be sent to the email address on your account.
        Notices to us must be sent to <a href="mailto:tyler@tylermbriggs.com">tyler@tylermbriggs.com</a>
        with a copy to the address below.
      </p>

      <h2>16. Contact us</h2>
      <p>
        Floor Daddy, LLC
        <br />
        Attn: Legal
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
