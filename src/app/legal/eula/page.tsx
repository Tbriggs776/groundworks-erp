import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "End-User License Agreement — Groundworks",
  description:
    "The agreement that governs your use of Groundworks accounting software.",
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

export default function EulaPage() {
  return (
    <>
      <header className="mb-8">
        <div className="text-[10px] font-medium uppercase tracking-[0.28em] text-[var(--gw-gold-deep)]">
          Legal
        </div>
        <h1 className="font-heading text-3xl tracking-[0.08em] uppercase text-[var(--gw-navy)] mt-2">
          End-User License Agreement
        </h1>
        <p className="mt-3 text-xs text-muted-foreground">Last updated {UPDATED}</p>
      </header>

      <P>
        This End-User License Agreement (the &ldquo;Agreement&rdquo;) is a legal contract between you
        (&ldquo;you,&rdquo; &ldquo;your,&rdquo; or &ldquo;Customer&rdquo;) and Groundworks
        (&ldquo;Groundworks,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) that governs
        your access to and use of the Groundworks accounting software, including the web application,
        REST API, MCP server, and any related services (together, the &ldquo;Service&rdquo;). By creating
        an account, signing in, or using the Service, you agree to be bound by this Agreement. If you do
        not agree, do not use the Service.
      </P>

      <H2>1. License grant</H2>
      <P>
        Subject to your continued compliance with this Agreement, Groundworks grants you a limited,
        non-exclusive, non-transferable, non-sublicensable, revocable license to access and use the
        Service for your internal business purposes during the term of your subscription.
      </P>

      <H2>2. Accounts and eligibility</H2>
      <P>
        You must be at least 18 years old and able to form a binding contract to use the Service. You
        are responsible for the accuracy of the information you provide, for maintaining the
        confidentiality of your credentials and API keys, and for all activity that occurs under your
        workspace. Notify us promptly of any unauthorized use.
      </P>

      <H2>3. Workspaces, companies, and roles</H2>
      <P>
        The Service is organized around a workspace that holds one or more companies. If you invite
        other people or AI agents to your workspace, you are responsible for their actions and for
        assigning appropriate roles, scopes, and autonomy limits. The workspace owner may remove
        access at any time.
      </P>

      <H2>4. Acceptable use</H2>
      <P>You agree not to:</P>
      <UL>
        <li>Reverse engineer, decompile, or attempt to derive the source code of the Service, except where this restriction is prohibited by law.</li>
        <li>Resell, sublicense, or otherwise make the Service available to any third party outside your workspace.</li>
        <li>Use the Service to transmit malicious code, infringe intellectual property, violate privacy or export laws, or evade security controls.</li>
        <li>Interfere with or disrupt the integrity, performance, or security of the Service.</li>
        <li>Use the Service to generate false, misleading, or fraudulent financial records.</li>
      </UL>

      <H2>5. Your data</H2>
      <P>
        You retain all rights in the data you submit to the Service (&ldquo;Customer Data&rdquo;). You
        grant Groundworks a worldwide, non-exclusive license to host, process, and transmit Customer
        Data solely to provide, maintain, and improve the Service and to comply with law. We may use
        aggregated and de-identified data to improve the Service.
      </P>

      <H2>6. Third-party services</H2>
      <P>
        The Service integrates with third-party services, including Intuit QuickBooks Online, Plaid,
        Supabase, Resend, Anthropic, and others. Your use of those services is governed by their own
        terms, and Groundworks is not responsible for their availability, accuracy, or practices.
        When you connect a third-party account, you authorize Groundworks to exchange data with that
        service as described in the application.
      </P>

      <H2>7. Fees</H2>
      <P>
        If your plan is paid, fees are billed in advance on a recurring basis and are non-refundable
        except as required by law. We may change prices on at least 30 days&rsquo; notice; changes take
        effect at the start of the next billing period.
      </P>

      <H2>8. Confidentiality</H2>
      <P>
        Each party will protect the other&rsquo;s non-public business information with the same degree
        of care it uses for its own confidential information, and no less than reasonable care. This
        obligation does not apply to information that is or becomes public without breach,
        independently developed, or lawfully obtained from a third party.
      </P>

      <H2>9. Intellectual property</H2>
      <P>
        Groundworks and its licensors own all right, title, and interest in and to the Service,
        including all software, documentation, trademarks, and improvements. This Agreement does not
        transfer any ownership rights, and all rights not expressly granted are reserved.
      </P>

      <H2>10. Term and termination</H2>
      <P>
        This Agreement remains in effect while you have an active account. Either party may terminate
        for the other&rsquo;s material breach that remains uncured after 30 days&rsquo; notice. On
        termination, your license ends and you must stop using the Service. We will make Customer
        Data available for export for 30 days after termination, after which we may delete it.
      </P>

      <H2>11. Warranty disclaimer</H2>
      <P>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranties
        of any kind, whether express, implied, or statutory, including implied warranties of
        merchantability, fitness for a particular purpose, non-infringement, and any warranty arising
        from course of dealing or usage of trade. Groundworks does not warrant that the Service will
        be uninterrupted, error-free, or that it will meet your requirements. Groundworks is not a
        certified public accountant and does not provide tax, legal, or accounting advice.
      </P>

      <H2>12. Limitation of liability</H2>
      <P>
        To the maximum extent permitted by law, in no event will Groundworks be liable for any
        indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss
        of profits, revenue, data, or goodwill, arising out of or related to the Service, even if
        advised of the possibility of such damages. Groundworks&rsquo; total aggregate liability for
        all claims arising out of or related to this Agreement will not exceed the greater of (a) the
        amount you paid for the Service in the 12 months preceding the claim or (b) US$100.
      </P>

      <H2>13. Indemnification</H2>
      <P>
        You agree to defend, indemnify, and hold harmless Groundworks and its affiliates from and
        against any claims, damages, liabilities, costs, and expenses (including reasonable
        attorneys&rsquo; fees) arising from your use of the Service, your Customer Data, or your
        breach of this Agreement.
      </P>

      <H2>14. Governing law and disputes</H2>
      <P>
        This Agreement is governed by the laws of the State of Delaware, without regard to its
        conflict-of-laws rules. The exclusive venue for any dispute will be the state or federal
        courts located in Delaware, and the parties consent to personal jurisdiction there.
      </P>

      <H2>15. Changes</H2>
      <P>
        We may update this Agreement from time to time. If a change is material, we will give notice
        in the application or by email at least 30 days before it takes effect. Your continued use of
        the Service after the effective date constitutes acceptance.
      </P>

      <H2>16. Contact</H2>
      <P>
        Questions about this Agreement can be sent to{" "}
        <a href="mailto:legal@groundworks.app" className="underline underline-offset-2">
          legal@groundworks.app
        </a>
        .
      </P>
    </>
  );
}
