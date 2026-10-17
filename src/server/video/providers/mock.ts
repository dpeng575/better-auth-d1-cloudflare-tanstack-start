/**
 * Mock provider — deterministic, stateless simulation of an async video API.
 *
 * The provider task id encodes everything poll() needs (outcome + ready
 * time), so no server-side mock state is required:
 *
 *   mock:<base64url(JSON {ok, readyAt})>
 *
 * Behavior:
 * - "mock-fast": ready after MOCK_FAST_DELAY_MS, always succeeds.
 * - "mock-pro": ready after MOCK_PRO_DELAY_MS; fails when the prompt
 *   contains "fail" (lets the UI/tests exercise the failure path).
 */
import type {
  ProviderConfig,
  PollResult,
  SubmitOutcome,
  VideoProvider,
  VideoSubmitRequest,
} from "../provider-types";

export const MOCK_FAST_DELAY_MS = 15_000;
export const MOCK_PRO_DELAY_MS = 10_000;

interface MockPayload {
  ok: boolean;
  readyAt: number;
}

function encode(payload: MockPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(providerTaskId: string): MockPayload | null {
  if (!providerTaskId.startsWith("mock:")) return null;
  try {
    const raw = providerTaskId.slice("mock:".length);
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed.ok !== "boolean" || typeof parsed.readyAt !== "number") {
      return null;
    }
    return parsed as MockPayload;
  } catch {
    return null;
  }
}

export const mockProvider: VideoProvider = {
  code: "mock",

  async submit(req: VideoSubmitRequest, _cfg: ProviderConfig): Promise<SubmitOutcome> {
    const willFail =
      req.model === "mock-pro" && req.prompt.toLowerCase().includes("fail");
    const delay =
      req.model === "mock-pro" ? MOCK_PRO_DELAY_MS : MOCK_FAST_DELAY_MS;
    const payload: MockPayload = {
      ok: !willFail,
      readyAt: Date.now() + delay,
    };
    return { kind: "async", providerTaskId: `mock:${encode(payload)}` };
  },

  async poll(
    providerTaskId: string,
    _cfg: ProviderConfig,
    nowMs: number = Date.now(),
  ): Promise<PollResult> {
    const payload = decode(providerTaskId);
    if (!payload) return { state: "not_found" };
    if (nowMs < payload.readyAt) return { state: "processing" };
    if (payload.ok) {
      return {
        state: "succeeded",
        result: {
          // Real providers return sourceUrl; the mock ships self-contained
          // content so the R2 storage path is exercisable end to end.
          inlineContent: {
            body: `Mock video generated at ${new Date(payload.readyAt).toISOString()}`,
            contentType: "text/plain",
          },
          meta: { mock: true, generatedAt: payload.readyAt },
        },
      };
    }
    return {
      state: "failed",
      errorCode: "mock_generation_failed",
      retryable: false,
    };
  },
};
