import type { TravelpayoutsConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

export type ApiRequestOptions = {
  path: string;
  params: Record<string, string | number | undefined>;
};

/**
 * Lightweight HTTP client for the actiq-gateway Travelpayouts proxy.
 * All requests go through the gateway which injects the API token.
 */
export function createApiClient(config: TravelpayoutsConfig) {
  const baseUrl = config.gatewayBaseUrl.replace(/\/+$/, "");

  return {
    async get<T>(options: ApiRequestOptions): Promise<T> {
      const url = buildUrl(baseUrl, options.path, options.params);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Travelpayouts API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Travelpayouts API timeout after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function buildUrl(
  base: string,
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export type ApiClient = ReturnType<typeof createApiClient>;
