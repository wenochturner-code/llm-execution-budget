<img src="banner.png" width="100%" />
# LLM Execution Guard

Minimal control-plane primitive for limiting worst-case LLM execution costs.

## Install
```bash
npm install llm-execution-guard
```

## API
```typescript
import { createBudget, guardedResponse, isBudgetError } from "llm-execution-guard";
```

### createBudget(limits, now?)

Creates a budget tracker.
```typescript
const budget = createBudget({
  executionId: "task-123",          // optional, included in errors
  maxSteps: 10,                     // max LLM calls (attempts count)
  maxToolCalls: 50,                 // max tool invocations
  timeoutMs: 30_000,                // wall clock limit
  maxOutputTokens: 4096,            // per-call output cap
  maxTokens: 100_000,               // total tokens; enforced between calls (may overshoot by one call)
  tokenAccountingMode: "fail-open", // or "fail-closed"
});
```

### guardedResponse(budget, params, fn)

Wraps one LLM call. Enforces limits, clamps output tokens, tracks usage.

`fn` must be a function that accepts `params` and returns your provider response.

Works with both OpenAI APIs:
```typescript
// Chat Completions API
const response = await guardedResponse(
  budget,
  { model: "<your-model>", messages: [...], max_tokens: 1000 },
  (p) => openai.chat.completions.create(p)
);

// Responses API
const response = await guardedResponse(
  budget,
  { model: "<your-model>", input: [...], max_output_tokens: 1000 },
  (p) => openai.responses.create(p)
);
```

The SDK auto-detects which API you're using:
- If `messages` is present → clamps `max_tokens` (Chat Completions)
- Otherwise → clamps `max_output_tokens` (Responses API)

### budget.recordToolCall()

Manually record a tool invocation (call each time your agent executes a tool).
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

## Provider Compatibility

This SDK is **provider-agnostic**. It works with any LLM provider as long as:

1. You can wrap calls with `guardedResponse(budget, params, fn)`
2. The response includes token usage (or you use `fail-open` mode)

Built-in support for OpenAI's Chat Completions and Responses APIs. For other providers (Anthropic, local LLMs, etc.), pass any `fn` that returns a response — the SDK only requires `usage.total_tokens` or `prompt_tokens + completion_tokens` for token tracking.

## Limits

| Limit | Enforced | Behavior |
|-------|----------|----------|
| `maxSteps` | Before call | Throws `STEP_LIMIT` if exceeded |
| `maxToolCalls` | Before `recordToolCall()` | Throws `TOOL_LIMIT` if exceeded |
| `timeoutMs` | Before call/`recordToolCall()` | Throws `TIMEOUT` if elapsed ≥ timeout |
| `maxOutputTokens` | Per call | Clamps `max_tokens` or `max_output_tokens` depending on API |
| `maxTokens` | Between calls | If exceeded after a call, budget becomes terminated; next boundary throws `TOKEN_LIMIT` |

Precedence when multiple limits apply: TIMEOUT → STEP_LIMIT → TOOL_LIMIT → TOKEN_LIMIT

Timeout takes precedence to guarantee a hard wall-clock bound.

## Token Accounting

The SDK normalizes usage across Chat Completions and Responses APIs. It reads token usage from the provider response (`usage.total_tokens`, or `prompt_tokens + completion_tokens`). Usage may be absent depending on provider or config.

**If usage data is missing:**

| Mode | Behavior |
|------|----------|
| `"fail-open"` (default) | Sets `tokenAccountingReliable = false` and **disables `maxTokens` enforcement**. Other limits still apply. |
| `"fail-closed"` | Throws `USAGE_UNAVAILABLE` immediately. |

⚠️ In `fail-open`, a provider that omits usage data can bypass your token budget. Use `fail-closed` if token limits are critical.

`snapshot.tokenAccountingReliable` tells you whether token enforcement was active.

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
import { createBudget, guardedResponse, isBudgetError } from "llm-execution-guard";
import OpenAI from "openai";

const openai = new OpenAI();

const budget = createBudget({
  maxSteps: 5,
  maxToolCalls: 20,
  timeoutMs: 60_000,
  maxOutputTokens: 2048,
  maxTokens: 50_000,
  tokenAccountingMode: "fail-closed",
});

async function agentLoop() {
  let done = false;
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "user", content: "Hello" }
  ];

  while (!done) {
    try {
      const response = await guardedResponse(
        budget,
        { model: "<your-model>", messages },
        (p) => openai.chat.completions.create(p)
      );

      const message = response.choices[0]?.message;
      if (message) messages.push(message);

      for (const toolCall of message?.tool_calls ?? []) {
        budget.recordToolCall();
        // execute tool...
      }

      done = !message?.tool_calls?.length;
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

## Behavior Details

### Step Counting
- Steps are counted as **attempts**, not successes
- If `fn` throws (network error, 429, etc.), the step is still consumed
- This prevents retry loops from bypassing limits

### Token Limit Semantics
- Enforced **between calls**, not during
- The call that crosses `maxTokens` is allowed to complete
- The next boundary throws `TOKEN_LIMIT` and includes `overshoot` in the snapshot

### What `recordToolCall()` Checks
- Timeout
- Tool limit
- Terminated state (including token limit)
- Does **not** check `maxSteps` (that's only for LLM calls)

## Publishing

This package publishes compiled JavaScript in `dist/` along with TypeScript type definitions.

## Test
```bash
npm test
```

## License

MIT
