import type { Budget } from "./types.js";
import { BudgetError } from "./errors.js";
import { getInternals, createSnapshot } from "./budget.js";

export interface ResponseParams {
  max_output_tokens?: number;
  [key: string]: unknown;
}

export interface ResponseUsage {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface Response {
  usage?: ResponseUsage;
  [key: string]: unknown;
}

export async function guardedResponse<P extends ResponseParams, R extends Response>(
  budget: Budget,
  params: P,
  fn: (params: P) => Promise<R>
): Promise<R> {
  const internals = getInternals(budget);
  const { limits, state, now } = internals;
  const elapsed = now() - state.startTime;

  // Boundary checks in precedence order: TIMEOUT > STEP_LIMIT > TOKEN_LIMIT

  // 1. Check timeout
  if (elapsed >= limits.timeoutMs) {
    throw new BudgetError(
      "TIMEOUT",
      createSnapshot(internals),
      limits.executionId
    );
  }

  // 2. Check step limit
  if (state.stepsUsed + 1 > limits.maxSteps) {
    throw new BudgetError(
      "STEP_LIMIT",
      createSnapshot(internals),
      limits.executionId
    );
  }

  // 3. Check terminatedReason (TOKEN_LIMIT from between-calls)
  if (state.terminatedReason) {
    throw new BudgetError(
      state.terminatedReason,
      state.terminatedSnapshot!,
      limits.executionId
    );
  }

  // All checks passed, increment step count before calling fn
  state.stepsUsed++;

  // Clamp max_output_tokens
  const modifiedParams = {
    ...params,
    max_output_tokens: Math.min(
      params.max_output_tokens ?? Infinity,
      limits.maxOutputTokens
    ),
  } as P;

  // Call fn (if it throws, step is still consumed)
  const response = await fn(modifiedParams);

  // Extract token usage
  let deltaTokens = 0;
  const usage = response.usage;

  let usageMissing = false;

  if (usage) {
    if (typeof usage.total_tokens === "number") {
      deltaTokens = usage.total_tokens;
    } else if (
      typeof usage.prompt_tokens === "number" &&
      typeof usage.completion_tokens === "number"
    ) {
      deltaTokens = usage.prompt_tokens + usage.completion_tokens;
    } else {
      usageMissing = true;
    }
  } else {
    usageMissing = true;
  }

  if (usageMissing) {
    const mode = limits.tokenAccountingMode ?? "fail-open";
    if (mode === "fail-closed") {
      throw new BudgetError(
        "USAGE_UNAVAILABLE",
        createSnapshot(internals),
        limits.executionId
      );
    }
    state.tokenAccountingReliable = false;
  }

  // Update tokensUsed
  state.tokensUsed += deltaTokens;

  // Apply between-calls termination rule for maxTokens (only if reliable)
  if (state.tokenAccountingReliable && state.tokensUsed > limits.maxTokens) {
    const overshoot = state.tokensUsed - limits.maxTokens;
    state.terminatedReason = "TOKEN_LIMIT";
    state.terminatedSnapshot = createSnapshot(internals, overshoot);
  }

  return response;
}