/**
 * Result storage — persists provider results into R2 before a task is marked
 * succeeded, so a succeeded task ALWAYS has its bytes downloadable.
 *
 * Failure semantics: if R2 is not configured or the fetch fails, this
 * returns r2Key = null and the caller leaves the task in `processing` to
 * retry on the next tick (never mark succeeded without stored bytes).
 */
export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const VIDEO_R2_PREFIX = "videos";

function extensionFor(contentType: string): string {
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  return "bin";
}

export async function storeVideoResult(
  r2: R2BucketLike | undefined,
  taskId: string,
  result: { r2Key?: string; sourceUrl?: string; inlineContent?: { body: string; contentType: string } },
): Promise<{ r2Key: string | null; error?: string }> {
  // Already stored (e.g. webhook drove the task first).
  if (result.r2Key) return { r2Key: result.r2Key };

  if (!r2) return { r2Key: null, error: "r2_not_configured" };

  try {
    if (result.inlineContent) {
      const key = `${VIDEO_R2_PREFIX}/${taskId}.txt`;
      await r2.put(key, result.inlineContent.body, {
        httpMetadata: { contentType: result.inlineContent.contentType },
      });
      return { r2Key: key };
    }

    if (result.sourceUrl) {
      const res = await fetch(result.sourceUrl);
      if (!res.ok) return { r2Key: null, error: `source_fetch_${res.status}` };
      const contentType = res.headers.get("content-type") ?? "video/mp4";
      const buf = await res.arrayBuffer();
      const key = `${VIDEO_R2_PREFIX}/${taskId}.${extensionFor(contentType)}`;
      await r2.put(key, buf, { httpMetadata: { contentType } });
      return { r2Key: key };
    }
  } catch (error) {
    return {
      r2Key: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { r2Key: null };
}
