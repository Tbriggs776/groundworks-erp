import { ZodError } from "zod";
import { toAppError } from "@/lib/errors";

/** State for forms driven by useActionState. */
export type FormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[] | undefined> };

/** Turn a thrown error into form state: field errors for zod, a message otherwise. */
export function formError(err: unknown): FormState {
  if (err instanceof ZodError) {
    return { status: "error", message: "Please fix the errors below.", fieldErrors: err.flatten().fieldErrors };
  }
  return { status: "error", message: toAppError(err).message };
}

/** Read the CompanyForm fields (src/components/company-form.tsx) out of FormData. */
export function companyFields(data: FormData) {
  return {
    name: String(data.get("name") ?? ""),
    workspaceName: String(data.get("workspaceName") ?? "") || undefined,
    fiscalYearStartMonth: Number(data.get("fiscalYearStartMonth") ?? 1),
    baseCurrency: String(data.get("baseCurrency") ?? "USD"),
    seedDefaultCoa: data.get("seedDefaultCoa") === "on",
  };
}
