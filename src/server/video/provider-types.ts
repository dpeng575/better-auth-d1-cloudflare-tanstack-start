/**
 * Pluggable video-generation provider interface.
 *
 * Design rules (from the SaaS redesign audit):
 * - Never assume external APIs share the same params, callback or cancel
 *   semantics. Each provider adapts its own wire format; the rest of the app
 *   only sees the normalized types below.
 * - Webhooks, when a provider supports them, are an accelerator only: they
 *   may trigger an early poll but the authoritative state always comes from
 *   `poll()`.
 * - Provider API keys NEVER travel through these types' return values; they
 *   are injected via ProviderConfig assembled server-side from env secrets.
 */

/** Normalized request built by the app; providers map it to their own API. */
export interface VideoSubmitRequest {
  /** Provider-specific model code (e.g. "mock-fast"). */
  model: string;
  prompt: string;
  /** Normalized, optional generation params. Providers may ignore any of
   *  them and must not fail when absent. */
  params: {
    durationSec?: number;
    resolution?: string;
    aspectRatio?: string;
  };
}

export interface VideoResult {
  /** R2 object key of the finished video, when the provider (or an earlier
   *  drive) has already stored it. */
  r2Key?: string;
  /** Remote URL of the finished video — the driver fetches it into R2. */
  sourceUrl?: string;
  /** Self-contained content (mock provider); stored to R2 as-is. */
  inlineContent?: { body: string; contentType: string };
  /** Free-form provider result metadata (duration, resolution, URLs...). */
  meta: Record<string, unknown>;
}

/** Outcome of submitting a task. No assumption of a uniform upstream shape. */
export type SubmitOutcome =
  /** Common case: upstream returns a task id to poll later. */
  | { kind: "async"; providerTaskId: string }
  /** Some APIs return the finished result synchronously. */
  | { kind: "completed"; result: VideoResult }
  /** Rare: upstream accepts the job but exposes no id — poll-by-list only. */
  | { kind: "accepted_no_id" };

/**
 * Normalized poll result. Providers must map their own state machines onto
 * these five states and never leak raw upstream states upward.
 */
export type PollResult =
  | { state: "processing" }
  | { state: "succeeded"; result: VideoResult }
  | { state: "failed"; errorCode: string; retryable: boolean }
  /** Upstream no longer knows the task (expired, cleaned up...). */
  | { state: "not_found" }
  /** Poll budget exhausted for this tick; try again later. */
  | { state: "poll_exhausted" };

export type CancelResult = "canceled" | "unsupported";

/** Non-secret runtime config for a provider (secrets resolved separately). */
export type ProviderConfig = Record<string, unknown>;

export interface VideoProvider {
  readonly code: string;
  submit(req: VideoSubmitRequest, cfg: ProviderConfig): Promise<SubmitOutcome>;
  /** `nowMs` injected for testability. */
  poll(
    providerTaskId: string,
    cfg: ProviderConfig,
    nowMs?: number,
  ): Promise<PollResult>;
  /** Optional: providers that cannot cancel return "unsupported". */
  cancel?(
    providerTaskId: string,
    cfg: ProviderConfig,
  ): Promise<CancelResult>;
}
