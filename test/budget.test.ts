import { test, describe } from "node:test";
import assert from "node:assert";
import { createBudget, guardedResponse, isBudgetError, BudgetError } from "../src/index.js";

describe("Budget SDK", () => {
  // Test 1: step limit stops
  test("step limit stops after maxSteps calls", async () => {
    const budget = createBudget({
      maxSteps: 2,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    const mockFn = async () => ({ usage: { total_tokens: 100 } });

    await guardedResponse(budget, {}, mockFn);
    await guardedResponse(budget, {}, mockFn);

    try {
      await guardedResponse(budget, {}, mockFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT");
      assert.strictEqual(e.snapshot.stepsUsed, 2);
      assert.strictEqual(e.snapshot.maxSteps, 2);
    }
  });

  // Test 2: tool limit stops
  test("tool limit stops after maxToolCalls", () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 2,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    budget.recordToolCall();
    budget.recordToolCall();

    try {
      budget.recordToolCall();
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOOL_LIMIT");
      assert.strictEqual(e.snapshot.toolCallsUsed, 2);
      assert.strictEqual(e.snapshot.maxToolCalls, 2);
    }
  });

  // Test 3: timeout stops (fake clock)
  test("timeout stops using fake clock", async () => {
    let currentTime = 0;
    const now = () => currentTime;

    const budget = createBudget(
      {
        maxSteps: 10,
        maxToolCalls: 10,
        timeoutMs: 1000,
        maxOutputTokens: 1000,
        maxTokens: 10000,
      },
      now
    );

    const mockFn = async () => ({ usage: { total_tokens: 100 } });

    // First call at time 0 - should work
    await guardedResponse(budget, {}, mockFn);

    // Advance time past timeout
    currentTime = 1000;

    try {
      await guardedResponse(budget, {}, mockFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TIMEOUT");
      assert.strictEqual(e.snapshot.elapsedMs, 1000);
      assert.strictEqual(e.snapshot.timeoutMs, 1000);
    }
  });

  // Test 4: token limit marks terminated after call, throws on next call
  test("token limit marks terminated after call, throws on next with overshoot", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 500,
    });

    const mockFn = async () => ({ usage: { total_tokens: 600 } });

    // First call succeeds but marks as terminated
    const response = await guardedResponse(budget, {}, mockFn);
    assert.deepStrictEqual(response.usage, { total_tokens: 600 });

    // Second call throws
    try {
      await guardedResponse(budget, {}, mockFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOKEN_LIMIT");
      assert.strictEqual(e.snapshot.tokensUsed, 600);
      assert.strictEqual(e.snapshot.maxTokens, 500);
      assert.strictEqual(e.snapshot.overshoot, 100);
      assert.strictEqual(e.snapshot.tokenAccountingReliable, true);
    }
  });

  // Test 5: once terminated, recordToolCall throws too
  test("once terminated, recordToolCall throws", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 500,
    });

    const mockFn = async () => ({ usage: { total_tokens: 600 } });

    // First call triggers token limit termination
    await guardedResponse(budget, {}, mockFn);

    // recordToolCall should throw with TOKEN_LIMIT
    try {
      budget.recordToolCall();
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOKEN_LIMIT");
    }
  });

  // Test 6: output cap is applied to params
  test("output cap is applied to params", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 500,
      maxTokens: 10000,
    });

    let capturedParams: { max_output_tokens?: number };
    const mockFn = async (params: { max_output_tokens?: number }) => {
      capturedParams = params;
      return { usage: { total_tokens: 100 } };
    };

    // Without user-specified max_output_tokens
    await guardedResponse(budget, {}, mockFn);
    assert.strictEqual(capturedParams!.max_output_tokens, 500);

    // With user-specified higher max_output_tokens (should clamp)
    await guardedResponse(budget, { max_output_tokens: 1000 }, mockFn);
    assert.strictEqual(capturedParams!.max_output_tokens, 500);

    // With user-specified lower max_output_tokens (should use lower)
    await guardedResponse(budget, { max_output_tokens: 200 }, mockFn);
    assert.strictEqual(capturedParams!.max_output_tokens, 200);
  });

  // Test 7: isBudgetError works
  test("isBudgetError type guard works", async () => {
    const budget = createBudget({
      maxSteps: 0,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    let caught: unknown;
    try {
      await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 0 } }));
    } catch (e) {
      caught = e;
    }

    assert(caught !== undefined);
    assert(isBudgetError(caught));
    assert.strictEqual((caught as BudgetError).reason, "STEP_LIMIT");

    // Negative cases
    assert.strictEqual(isBudgetError(new Error("regular error")), false);
    assert.strictEqual(isBudgetError(null), false);
    assert.strictEqual(isBudgetError(undefined), false);
    assert.strictEqual(isBudgetError({ reason: "STEP_LIMIT" }), false);
  });

  // Test 8: missing usage disables token limit enforcement
  test("missing usage disables token limit enforcement but step/tool/timeout still work", async () => {
    const budget = createBudget({
      maxSteps: 5,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 100, // Very low limit
    });

    // Response with no usage
    const mockFnNoUsage = async () => ({});

    // First call - no usage, should set tokenAccountingReliable = false
    await guardedResponse(budget, {}, mockFnNoUsage);

    // Response with high tokens - should NOT trigger token limit (accounting unreliable)
    const mockFnHighTokens = async () => ({ usage: { total_tokens: 5000 } });
    await guardedResponse(budget, {}, mockFnHighTokens);
    await guardedResponse(budget, {}, mockFnHighTokens);
    await guardedResponse(budget, {}, mockFnHighTokens);
    await guardedResponse(budget, {}, mockFnHighTokens);

    // 6th call should fail with STEP_LIMIT (not TOKEN_LIMIT)
    try {
      await guardedResponse(budget, {}, mockFnHighTokens);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT");
      assert.strictEqual(e.snapshot.tokenAccountingReliable, false);
      // Tokens were still tracked even though not enforced
      assert(e.snapshot.tokensUsed > 0);
    }
  });

  // Additional: tool limit still enforced when token accounting unreliable
  test("tool limit still enforced when token accounting unreliable", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 2,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 100,
    });

    // Make token accounting unreliable
    await guardedResponse(budget, {}, async () => ({}));

    // Tool calls should still be limited
    budget.recordToolCall();
    budget.recordToolCall();

    try {
      budget.recordToolCall();
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOOL_LIMIT");
      assert.strictEqual(e.snapshot.tokenAccountingReliable, false);
    }
  });

  // Additional: timeout still enforced when token accounting unreliable
  test("timeout still enforced when token accounting unreliable", async () => {
    let currentTime = 0;
    const now = () => currentTime;

    const budget = createBudget(
      {
        maxSteps: 10,
        maxToolCalls: 10,
        timeoutMs: 1000,
        maxOutputTokens: 1000,
        maxTokens: 100,
      },
      now
    );

    // Make token accounting unreliable
    await guardedResponse(budget, {}, async () => ({}));

    // Advance time past timeout
    currentTime = 1000;

    try {
      await guardedResponse(budget, {}, async () => ({}));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TIMEOUT");
      assert.strictEqual(e.snapshot.tokenAccountingReliable, false);
    }
  });

  // Verify prompt_tokens + completion_tokens fallback works
  test("uses prompt_tokens + completion_tokens when total_tokens missing", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 500,
    });

    const mockFn = async () => ({
      usage: { prompt_tokens: 300, completion_tokens: 350 },
    });

    await guardedResponse(budget, {}, mockFn);

    // Should trigger token limit (650 > 500)
    try {
      await guardedResponse(budget, {}, mockFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOKEN_LIMIT");
      assert.strictEqual(e.snapshot.tokensUsed, 650);
      assert.strictEqual(e.snapshot.overshoot, 150);
      assert.strictEqual(e.snapshot.tokenAccountingReliable, true);
    }
  });

  // Verify executionId is passed through
  test("executionId is included in BudgetError", async () => {
    const budget = createBudget({
      executionId: "exec-123",
      maxSteps: 0,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    try {
      await guardedResponse(budget, {}, async () => ({}));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.executionId, "exec-123");
    }
  });

  // Test fail-closed mode throws USAGE_UNAVAILABLE when usage missing
  test("fail-closed mode throws USAGE_UNAVAILABLE when usage missing", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
      tokenAccountingMode: "fail-closed",
    });

    try {
      await guardedResponse(budget, {}, async () => ({}));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "USAGE_UNAVAILABLE");
    }
  });

  // Test fail-closed mode works normally when usage present
  test("fail-closed mode works normally when usage present", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
      tokenAccountingMode: "fail-closed",
    });

    const response = await guardedResponse(
      budget,
      {},
      async () => ({ usage: { total_tokens: 100 } })
    );

    assert.deepStrictEqual(response.usage, { total_tokens: 100 });
  });

  // Test fail-closed with partial usage (only prompt_tokens, no completion)
  test("fail-closed throws when usage is partial", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
      tokenAccountingMode: "fail-closed",
    });

    try {
      await guardedResponse(
        budget,
        {},
        async () => ({ usage: { prompt_tokens: 100 } }) // missing completion_tokens
      );
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "USAGE_UNAVAILABLE");
    }
  });

  // ===========================================
  // EDGE CASE TESTS
  // ===========================================

  // Precedence: TIMEOUT wins over STEP_LIMIT
  test("precedence: TIMEOUT beats STEP_LIMIT when both exceeded", async () => {
    let currentTime = 0;
    const now = () => currentTime;

    const budget = createBudget(
      {
        maxSteps: 1,
        maxToolCalls: 10,
        timeoutMs: 100,
        maxOutputTokens: 1000,
        maxTokens: 10000,
      },
      now
    );

    // Use up the step limit
    await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 10 } }));

    // Now both step limit (1 used, max 1) AND timeout are exceeded
    currentTime = 100;

    try {
      await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 10 } }));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TIMEOUT"); // TIMEOUT wins
    }
  });

  // Precedence: STEP_LIMIT wins over TOKEN_LIMIT (stored termination)
  test("precedence: STEP_LIMIT beats stored TOKEN_LIMIT", async () => {
    const budget = createBudget({
      maxSteps: 1,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 50, // Will exceed on first call
    });

    // First call exceeds token limit but succeeds (between-calls rule)
    await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 100 } }));

    // Now both STEP_LIMIT and TOKEN_LIMIT (stored) apply
    try {
      await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 10 } }));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT"); // STEP_LIMIT wins over stored TOKEN_LIMIT
    }
  });

  // Precedence: TIMEOUT beats TOOL_LIMIT in recordToolCall
  test("precedence: TIMEOUT beats TOOL_LIMIT in recordToolCall", () => {
    let currentTime = 0;
    const now = () => currentTime;

    const budget = createBudget(
      {
        maxSteps: 10,
        maxToolCalls: 1,
        timeoutMs: 100,
        maxOutputTokens: 1000,
        maxTokens: 10000,
      },
      now
    );

    // Use up tool limit
    budget.recordToolCall();

    // Both tool limit AND timeout exceeded
    currentTime = 100;

    try {
      budget.recordToolCall();
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TIMEOUT"); // TIMEOUT wins
    }
  });

  // fn throws: step is still consumed, error is rethrown
  test("when fn throws, step is consumed and error is rethrown", async () => {
    const budget = createBudget({
      maxSteps: 2,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    const networkError = new Error("Network failure");

    try {
      await guardedResponse(budget, {}, async () => {
        throw networkError;
      });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.strictEqual(e, networkError); // Original error rethrown
      assert(!isBudgetError(e)); // Not wrapped
    }

    // Step was consumed even though fn threw
    // Only 1 step left now
    await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 10 } }));

    // Third call should fail with STEP_LIMIT (2 steps consumed)
    try {
      await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 10 } }));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT");
      assert.strictEqual(e.snapshot.stepsUsed, 2);
    }
  });

  // fn is NOT invoked after budget is terminated
  test("fn is not invoked after budget termination", async () => {
    const budget = createBudget({
      maxSteps: 1,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 10000,
    });

    let fnCallCount = 0;
    const countingFn = async () => {
      fnCallCount++;
      return { usage: { total_tokens: 10 } };
    };

    // First call succeeds
    await guardedResponse(budget, {}, countingFn);
    assert.strictEqual(fnCallCount, 1);

    // Second call should throw STEP_LIMIT without invoking fn
    try {
      await guardedResponse(budget, {}, countingFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT");
    }

    // fn was NOT called again
    assert.strictEqual(fnCallCount, 1);
  });

  // fn is NOT invoked after TOKEN_LIMIT termination
  test("fn is not invoked after TOKEN_LIMIT termination", async () => {
    const budget = createBudget({
      maxSteps: 10,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 50,
    });

    let fnCallCount = 0;
    const countingFn = async () => {
      fnCallCount++;
      return { usage: { total_tokens: 100 } }; // Exceeds maxTokens
    };

    // First call succeeds but marks terminated
    await guardedResponse(budget, {}, countingFn);
    assert.strictEqual(fnCallCount, 1);

    // Second call should throw TOKEN_LIMIT without invoking fn
    try {
      await guardedResponse(budget, {}, countingFn);
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "TOKEN_LIMIT");
    }

    // fn was NOT called again
    assert.strictEqual(fnCallCount, 1);
  });

  // Token accounting continues even when unreliable (policy: we track but don't enforce)
  test("tokens are still tracked when tokenAccountingReliable is false", async () => {
    const budget = createBudget({
      maxSteps: 3,
      maxToolCalls: 10,
      timeoutMs: 10000,
      maxOutputTokens: 1000,
      maxTokens: 100,
    });

    // First call: no usage -> unreliable
    await guardedResponse(budget, {}, async () => ({}));

    // Second call: has usage -> still tracked (500 tokens)
    await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 500 } }));

    // Third call: has usage -> still tracked (100 tokens)
    await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 100 } }));

    // Fourth call: should fail with STEP_LIMIT
    try {
      await guardedResponse(budget, {}, async () => ({ usage: { total_tokens: 100 } }));
      assert.fail("Should have thrown");
    } catch (e) {
      assert(isBudgetError(e));
      assert.strictEqual(e.reason, "STEP_LIMIT");
      assert.strictEqual(e.snapshot.tokenAccountingReliable, false);
      // Tokens were tracked: 0 + 500 + 100 = 600
      assert.strictEqual(e.snapshot.tokensUsed, 600);
    }
  });
});