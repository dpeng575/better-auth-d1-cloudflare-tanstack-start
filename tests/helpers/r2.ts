/** In-memory R2BucketLike for tests. */
export function makeR2Like() {
  const objects = new Map<string, { body: string; contentType?: string }>();
  const r2 = {
    objects,
    async put(
      key: string,
      value: string | ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof value === "string"
          ? value
          : new TextDecoder().decode(value as Uint8Array);
      objects.set(key, {
        body,
        contentType: options?.httpMetadata?.contentType,
      });
    },
  };
  return r2;
}
