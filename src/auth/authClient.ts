import { cloudflareClient } from "better-auth-cloudflare/client";
import { anonymousClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const client = (baseURL: string) =>
  createAuthClient({
    baseURL,
    plugins: [cloudflareClient(), anonymousClient(), emailOTPClient()],
  });

export default client;
