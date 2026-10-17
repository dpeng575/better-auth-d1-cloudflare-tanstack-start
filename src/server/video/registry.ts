/**
 * Provider registry. Real providers (Waffo-era: Replicate, Runway...) get a
 * module here and one line below. Nothing else in the app hardcodes
 * provider behavior.
 */
import type { VideoProvider } from "./provider-types";
import { mockProvider } from "./providers/mock";

const providers = new Map<string, VideoProvider>([
  [mockProvider.code, mockProvider],
]);

export function getProvider(code: string): VideoProvider | undefined {
  return providers.get(code);
}
