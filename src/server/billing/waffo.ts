/**
 * Waffo payment client + webhook signature verification.
 *
 * Everything is fetch-injectable so unit tests run without network or
 * sandbox keys. Before production:
 *   - confirm the order-creation endpoint & request shape against the Waffo
 *     sandbox docs (docs.waffo.ai) — paths below are configurable and
 *     currently follow the documented checkout integration flow;
 *   - set secrets: WAFFO_API_KEY, WAFFO_PUBLIC_KEY (Merchant Portal →
 *     Integration), optionally WAFFO_API_URL (defaults to production).
 *
 * Webhook verification per docs: header `X-SIGNATURE`, SHA256WithRSA over
 * the RAW request body, verified with Waffo's RSA public key. Implemented
 * with WebCrypto only — no Node SDK needed in Workers.
 */

const DEFAULT_API_URL = "https://api.waffo.ai";
/** X-API-VERSION header value per Waffo changelog (HTTP 1.0.0). */
const API_VERSION = "1.0.0";

export interface WaffoClientConfig {
  apiKey: string;
  apiUrl?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CheckoutInput {
  orderNo: string;
  amountCents: number;
  currency: string;
  /** Required by Waffo order creation. */
  userEmail: string;
  notifyUrl: string;
  successRedirectUrl: string;
  failedRedirectUrl: string;
  cancelRedirectUrl: string;
}

export type CheckoutResult =
  | { ok: true; webUrl: string; paymentRef?: string }
  | { ok: false; error: string };

/** Create a hosted-checkout order. Returns the cashier webUrl to redirect to. */
export async function createWaffoCheckout(
  cfg: WaffoClientConfig,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.apiUrl ?? DEFAULT_API_URL;
  let res: Response;
  try {
    res = await doFetch(`${base}/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-VERSION": API_VERSION,
        "X-API-KEY": cfg.apiKey,
      },
      body: JSON.stringify({
        outTradeNo: input.orderNo,
        totalAmount: input.amountCents,
        currency: input.currency.toUpperCase(),
        userEmail: input.userEmail,
        notifyUrl: input.notifyUrl,
        successRedirectUrl: input.successRedirectUrl,
        failedRedirectUrl: input.failedRedirectUrl,
        cancelRedirectUrl: input.cancelRedirectUrl,
      }),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (!res.ok) {
    return { ok: false, error: `waffo_http_${res.status}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "waffo_invalid_response" };
  }

  // orderAction is a JSON string per docs; parse it and pick the web URL.
  let action: any = data?.data?.orderAction ?? data?.orderAction;
  if (typeof action === "string") {
    try {
      action = JSON.parse(action);
    } catch {
      action = null;
    }
  }
  const webUrl = action?.webUrl;
  if (!webUrl) return { ok: false, error: "waffo_no_checkout_url" };

  return {
    ok: true,
    webUrl,
    paymentRef: data?.data?.tradeNo ?? data?.tradeNo ?? undefined,
  };
}

export type PaymentQueryResult =
  | { ok: true; paid: boolean; status: string }
  | { ok: false; error: string };

/** Active query used by the reconciliation cron for stale pending orders. */
export async function queryWaffoPayment(
  cfg: WaffoClientConfig,
  orderNo: string,
): Promise<PaymentQueryResult> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.apiUrl ?? DEFAULT_API_URL;
  try {
    const res = await doFetch(
      `${base}/v1/payments?outTradeNo=${encodeURIComponent(orderNo)}`,
      { headers: { "X-API-VERSION": API_VERSION, "X-API-KEY": cfg.apiKey } },
    );
    if (!res.ok) return { ok: false, error: `waffo_http_${res.status}` };
    const data: any = await res.json();
    const status: string = String(
      data?.data?.status ?? data?.status ?? "unknown",
    );
    return { ok: true, paid: /success|paid|completed/i.test(status), status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---- webhook signature (SHA256WithRSA via WebCrypto) -----------------------

function pemToSpkiBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Verify the X-SIGNATURE header against the raw webhook body.
 *  Returns false on any malformed input — callers must treat the webhook
 *  as unverified. */
export async function verifyWaffoSignature(
  rawBody: string,
  signatureBase64: string,
  publicKeyPem: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToSpkiBytes(publicKeyPem) as unknown as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64ToBytes(signatureBase64) as unknown as ArrayBuffer,
      new TextEncoder().encode(rawBody) as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}
