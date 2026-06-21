import { SELF } from "cloudflare:test";

const DO_INVALIDATION = "invalidating this Durable Object";

export async function fetchWithDoRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await SELF.fetch(input, init);
      if (res.status !== 500) return res;
      const text = await res.clone().text();
      if (!text.includes(DO_INVALIDATION)) return res;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(DO_INVALIDATION)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return SELF.fetch(input, init);
}
