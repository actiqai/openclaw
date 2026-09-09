import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

// web-fetch.ts reads tools.web.fetch.firecrawl and tools.web.fetch.readability, and
// types.tools.ts declares both — but the zod schema is `.strict()` and never listed
// them. So configuring the one documented way to make web_fetch go through something
// other than a direct request was rejected, and the whole config with it.

describe("config: tools.web.fetch", () => {
  it("accepts the firecrawl settings the tool actually reads", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              enabled: true,
              apiKey: "not-a-credential",
              baseUrl: "http://10.0.1.40:8082/firecrawl",
              onlyMainContent: true,
              maxAgeMs: 0,
              timeoutSeconds: 30,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts readability, which the tool also reads", () => {
    const res = validateConfigObject({
      tools: { web: { fetch: { readability: false } } },
    });

    expect(res.ok).toBe(true);
  });

  // Strictness stays where it belongs: a typo inside firecrawl is still an error, and
  // it should name the field rather than the whole config.
  it("still rejects an unknown firecrawl key", () => {
    const res = validateConfigObject({
      tools: { web: { fetch: { firecrawl: { baseUrll: "typo" } } } },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.startsWith("tools.web.fetch.firecrawl"))).toBe(true);
    }
  });
});
