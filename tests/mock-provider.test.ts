/**
 * Mock provider state machine tests (P2).
 * Poll is a pure function of (providerTaskId, now) — easy to test exactly.
 */
import { describe, expect, it } from "vitest";
import { mockProvider } from "../src/server/video/providers/mock";
import { getProvider } from "../src/server/video/registry";

describe("mock provider", () => {
  it("is registered in the provider registry", () => {
    expect(getProvider("mock")).toBe(mockProvider);
    expect(getProvider("nope")).toBeUndefined();
  });

  it("submit returns an async task id; poll is processing until ready", async () => {

    const outcome = await mockProvider.submit(
      { model: "mock-fast", prompt: "a cat", params: {} },
      {},
    );
    expect(outcome.kind).toBe("async");
    if (outcome.kind !== "async") return;

    const before = await mockProvider.poll(outcome.providerTaskId, {}, Date.now() + 1000);
    expect(before.state).toBe("processing");
  });

  it("mock-fast succeeds after its delay", async () => {

    const outcome = await mockProvider.submit(
      { model: "mock-fast", prompt: "a cat", params: {} },
      {},
    );
    if (outcome.kind !== "async") throw new Error("expected async");

    const after = await mockProvider.poll(
      outcome.providerTaskId,
      {},
      Date.now() + 60_000,
    );
    expect(after.state).toBe("succeeded");
    if (after.state === "succeeded") {
      expect(after.result.meta).toMatchObject({ mock: true });
    }
  });

  it("mock-pro fails when the prompt contains 'fail'", async () => {

    const outcome = await mockProvider.submit(
      { model: "mock-pro", prompt: "make it fail please", params: {} },
      {},
    );
    if (outcome.kind !== "async") throw new Error("expected async");

    const after = await mockProvider.poll(
      outcome.providerTaskId,
      {},
      Date.now() + 60_000,
    );
    expect(after.state).toBe("failed");
    if (after.state === "failed") {
      expect(after.errorCode).toBe("mock_generation_failed");
      expect(after.retryable).toBe(false);
    }
  });

  it("garbage task ids map to not_found", async () => {
    const poll = await mockProvider.poll("mock:garbage!!", {}, Date.now());
    expect(poll.state).toBe("not_found");
    const poll2 = await mockProvider.poll("totally-other-provider:1", {}, Date.now());
    expect(poll2.state).toBe("not_found");
  });
});
