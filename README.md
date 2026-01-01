# LLM Execution Budget SDK

Minimal control-plane primitive for limiting LLM execution costs.

## Install
```bash
npm install llm-budget-sdk
```

## API
```typescript
import { createBudget, guardedResponse, isBudgetError } from "llm-budget-sdk";
```

### createBudget(limits, now?)

Creates a budget tracker.
```typescript
const budget = createBudget({
  executionId: "task-123",       // optional, included in errors
  maxSteps: 10,                  // max LLM calls (attempts count)
  maxToolCalls: 50,              // max tool invocations
  timeoutMs: 30_000,             // wall clock limit
  maxOutputTokens: 4096,         // per-call output cap
  maxTokens: 100_000,            // total tokens; checked between calls; may overshoot by one call
  tokenAccountingMode: "fail-open", // or "fail-closed"
});
```

### guardedResponse(budget, params, fn)

Wraps one LLM call. Enforces limits, clamps output tokens, tracks usage.
```typescript
const response = await guardedResponse(
  budget,
  { model: "gpt-4", messages: [...] },
  (p) => openai.responses.create(p)
);
```

### budget.recordToolCall()

Manually record a tool invocation. Call this each time your agent executes a tool.
```typescript
budget.recordToolCall();
```

### isBudgetError(e)

Type guard for budget errors.
```typescript
try {
  await guardedResponse(budget, params, fn);
} catch (e) {
  if (isBudgetError(e)) {
    console.log(e.reason);   // "TIMEOUT" | "STEP_LIMIT" | "TOOL_LIMIT" | "TOKEN_LIMIT" | "USAGE_UNAVAILABLE"
    console.log(e.snapshot); // full state at time of error
  }
}
```

## Limits

| Limit | Enforced | Behavior |
|-------|----------|----------|
| `maxSteps` | Before call | Throws `STEP_LIMIT` if exceeded |
| `maxToolCalls` | Before recordToolCall | Throws `TOOL_LIMIT` if exceeded |
| `timeoutMs` | Before call/recordToolCall | Throws `TIMEOUT` if elapsed ≥ timeout |
| `maxOutputTokens` | Per call | Clamps `params.max_output_tokens` |
| `maxTokens` | Between calls | Marks terminated after call, throws `TOKEN_LIMIT` on next boundary |

Precedence when multiple limits apply: TIMEOUT → STEP_LIMIT → TOOL_LIMIT → TOKEN_LIMIT

## Token Accounting

The SDK reads `usage.total_tokens` (or `prompt_tokens + completion_tokens`) from responses.

**If usage data is missing:**

| Mode | Behavior |
|------|----------|
| `"fail-open"` (default) | Sets `tokenAccountingReliable = false`, **disables `maxTokens` enforcement**. Other limits still apply. |
| `"fail-closed"` | Throws `USAGE_UNAVAILABLE` immediately. |

⚠️ **Warning:** In `fail-open` mode, a provider that omits usage data will bypass your token budget entirely. Use `fail-closed` if token limits are critical.

The `snapshot.tokenAccountingReliable` field tells you whether token enforcement was active.

## Error Shape
```typescript
class BudgetError extends Error {
  reason: "TIMEOUT" | "STEP_LIMIT" | "TOOL_LIMIT" | "TOKEN_LIMIT" | "USAGE_UNAVAILABLE";
  executionId?: string;
  snapshot: {
    stepsUsed: number;
    maxSteps: number;
    toolCallsUsed: number;
    maxToolCalls: number;
    tokensUsed: number;
    maxTokens: number;
    overshoot?: number;          // only for TOKEN_LIMIT
    elapsedMs: number;
    timeoutMs: number;
    tokenAccountingReliable: boolean;
  };
}
```

## Example
```typescript
import { createBudget, guardedResponse, isBudgetError } from "llm-budget-sdk";
import OpenAI from "openai";

const openai = new OpenAI();

const budget = createBudget({
  maxSteps: 5,
  maxToolCalls: 20,
  timeoutMs: 60_000,
  maxOutputTokens: 2048,
  maxTokens: 50_000,
  tokenAccountingMode: "fail-closed", // strict mode
});

async function agentLoop() {
  while (true) {
    try {
      const response = await guardedResponse(
        budget,
        { model: "gpt-4", messages: [...] },
        (p) => openai.responses.create(p)
      );

      for (const toolCall of response.tool_calls ?? []) {
        budget.recordToolCall();
        // execute tool...
      }

      if (response.done) break;
    } catch (e) {
      if (isBudgetError(e)) {
        console.log(`Budget exceeded: ${e.reason}`, e.snapshot);
        break;
      }
      throw e;
    }
  }
}
```

## Test
```bash
npm test
```

## License

MIT