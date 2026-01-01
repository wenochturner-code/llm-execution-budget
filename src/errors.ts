import type { BudgetReason, BudgetSnapshot } from "./types.js";

export class BudgetError extends Error {
  readonly reason: BudgetReason;
  readonly executionId?: string;
  readonly snapshot: BudgetSnapshot;

  constructor(reason: BudgetReason, snapshot: BudgetSnapshot, executionId?: string) {
    super(`Budget exceeded: ${reason}`);
    this.name = "BudgetError";
    this.reason = reason;
    this.snapshot = snapshot;
    this.executionId = executionId;
  }
}

export function isBudgetError(e: unknown): e is BudgetError {
  return e instanceof BudgetError;
}
