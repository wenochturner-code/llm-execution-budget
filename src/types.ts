export type BudgetReason = "TIMEOUT" | "STEP_LIMIT" | "TOOL_LIMIT" | "TOKEN_LIMIT" | "USAGE_UNAVAILABLE";

export interface BudgetLimits {
  executionId?: string;
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxTokens: number;
  tokenAccountingMode?: "fail-open" | "fail-closed";
}

export interface BudgetSnapshot {
  stepsUsed: number;
  maxSteps: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  tokensUsed: number;
  maxTokens: number;
  overshoot?: number;
  elapsedMs: number;
  timeoutMs: number;
  tokenAccountingReliable: boolean;
}

export interface Budget {
  recordToolCall(): void;
}