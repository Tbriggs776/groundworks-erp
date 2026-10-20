import { AppShell } from "@/components/app-shell/shell";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { companyLogoDataUrl, getCompanyProfile, LOGO_MAX_BYTES } from "@/lib/company/profile";
import { CompanyProfileForm } from "./profile-form";

export default async function CompanyProfilePage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [p, logo] = await runAs(actor, async (ctx) => [await getCompanyProfile(ctx), await companyLogoDataUrl(ctx)] as const);
  return (
    <AppShell title="Company Profile" crumb={`${organization.name} · Settings`} userEmail={user?.email}>
      <div className="max-w-3xl space-y-4">
        <p className="text-xs text-muted-foreground">
          What customers see at the top and bottom of invoices, estimates, sales receipts, credit memos, and statements.
        </p>
        <CompanyProfileForm
          canEdit={hasRole(role, "admin")}
          companyName={p.companyName}
          logo={logo}
          maxLogoKb={LOGO_MAX_BYTES / 1024}
          initial={{
            legalName: p.legalName ?? "",
            street1: p.address.street1 ?? "",
            street2: p.address.street2 ?? "",
            city: p.address.city ?? "",
            state: p.address.state ?? "",
            zip: p.address.zip ?? "",
            country: p.address.country ?? "",
            phone: p.phone ?? "",
            email: p.email ?? "",
            website: p.website ?? "",
            taxId: p.taxId ?? "",
            documentFooter: p.documentFooter ?? "",
            checkOffsetX: Number(p.checkOffsetX).toFixed(2),
            checkOffsetY: Number(p.checkOffsetY).toFixed(2),
          }}
        />
      </div>
    </AppShell>
  );
}
