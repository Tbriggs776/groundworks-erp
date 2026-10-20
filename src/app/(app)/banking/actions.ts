"use server";

import { revalidatePath } from "next/cache";
import { serviceAction, type ActionResult } from "@/lib/action";
import * as reconcile from "@/lib/banking/reconcile";
import * as review from "@/lib/banking/review";
import * as rules from "@/lib/banking/rules";
import * as txns from "@/lib/banking/transactions";

/**
 * Banking server actions: thin wrappers over src/lib/banking/*, which owns
 * validation, posting, matching, reconciliation, and the audit trail for
 * the web UI, REST API, and MCP server alike.
 */

function revalidate() {
  revalidatePath("/banking", "layout");
  revalidatePath("/gl");
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

type Notice = { review?: { required: true; reason: string } };

// ------------------------------------------------------------ Transactions

export async function createExpense(input: txns.CreateExpenseInput): Promise<ActionResult<{ id: string } & Notice>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const t = await txns.createExpense(ctx, input);
    return { id: t.id, review: t.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function createDeposit(input: txns.CreateDepositInput): Promise<ActionResult<{ id: string } & Notice>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const t = await txns.createDeposit(ctx, input);
    return { id: t.id, review: t.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function createTransfer(input: txns.CreateTransferInput): Promise<ActionResult<{ id: string } & Notice>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const t = await txns.createTransfer(ctx, input);
    return { id: t.id, review: t.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function postBankTransaction(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await txns.postBankTransaction(ctx, { id })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function voidBankTransaction(id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({ id: (await txns.voidBankTransaction(ctx, { id, reason })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteBankTransaction(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", (ctx) => txns.deleteDraftBankTransaction(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

// ------------------------------------------------------------ For review

export async function importStatement(
  input: review.ImportStatementInput
): Promise<ActionResult<{ id: string; result: review.ImportResult }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const result = await review.importStatement(ctx, input);
    return { id: result.importId, result };
  });
  if (r.ok) revalidate();
  return r;
}

export async function matchLine(id: string, glLineIds: string[]): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await review.matchStatementLine(ctx, { id, glLineIds })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function addLine(input: review.AddStatementLineInput): Promise<ActionResult<{ id: string } & Notice>> {
  const r = await serviceAction("bookkeeper", async (ctx) => {
    const added = await review.addStatementLine(ctx, input);
    return { id: added.line.id, review: added.review };
  });
  if (r.ok) revalidate();
  return r;
}

export async function excludeLine(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await review.excludeStatementLine(ctx, { id })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function undoLine(id: string): Promise<ActionResult> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({ id: (await review.undoStatementLine(ctx, { id })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function findMatches(id: string): Promise<ActionResult<{ id: string; candidates: review.MatchCandidate[] }>> {
  return serviceAction("viewer", async (ctx) => ({ id, candidates: await review.findMatchCandidates(ctx, { id }) }));
}

// ------------------------------------------------------------ Rules

export async function createRule(input: rules.CreateBankRuleInput): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rules.createBankRule(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function updateRule(input: rules.UpdateBankRuleInput): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await rules.updateBankRule(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function deleteRule(id: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", (ctx) => rules.deleteBankRule(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

export async function applyRules(accountId?: string): Promise<ActionResult<{ id: string; result: review.RuleRunResult }>> {
  const r = await serviceAction("bookkeeper", async (ctx) => ({
    id: accountId ?? "all",
    result: await review.applyBankRules(ctx, { accountId }),
  }));
  if (r.ok) revalidate();
  return r;
}

// ------------------------------------------------------------ Reconcile

export async function startReconciliation(input: {
  accountId: string;
  statementEndDate: string;
  statementEndingBalance: string;
}): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await reconcile.startReconciliation(ctx, input)).id }));
  if (r.ok) revalidate();
  return r;
}

export async function setCleared(id: string, glLineIds: string[], cleared: boolean): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await reconcile.setCleared(ctx, { id, glLineIds, cleared })).id }));
  if (r.ok) revalidatePath(`/banking/reconcile/${id}`);
  return r;
}

export async function updateStatementBalance(id: string, statementEndingBalance: string, statementEndDate: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({
    id: (await reconcile.updateReconciliation(ctx, { id, statementEndingBalance, statementEndDate })).id,
  }));
  if (r.ok) revalidatePath(`/banking/reconcile/${id}`);
  return r;
}

export async function completeReconciliation(id: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", async (ctx) => ({ id: (await reconcile.completeReconciliation(ctx, { id })).id }));
  if (r.ok) revalidate();
  return r;
}

export async function cancelReconciliation(id: string): Promise<ActionResult> {
  const r = await serviceAction("accountant", (ctx) => reconcile.cancelReconciliation(ctx, { id }));
  if (r.ok) revalidate();
  return r;
}

export async function undoReconciliation(id: string, reason: string): Promise<ActionResult> {
  const r = await serviceAction("admin", async (ctx) => ({ id: (await reconcile.undoReconciliation(ctx, { id, reason })).id }));
  if (r.ok) revalidate();
  return r;
}
