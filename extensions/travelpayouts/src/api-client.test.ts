import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api-client.js";

describe("createApiClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds URL with path and query params", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({ data: [] }) };
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse as Response);

    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080" });
    await client.get({ path: "/travelpayouts/test", params: { foo: "bar", num: 42 } });

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/travelpayouts/test");
    expect(calledUrl).toContain("foo=bar");
    expect(calledUrl).toContain("num=42");
  });

  it("skips undefined params", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse as Response);

    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080" });
    await client.get({ path: "/test", params: { a: "1", b: undefined } });

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("a=1");
    expect(calledUrl).not.toContain("b=");
  });

  it("throws on non-200 response", async () => {
    const mockResponse = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: () => Promise.resolve("upstream error"),
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse as unknown as Response);

    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080" });
    await expect(client.get({ path: "/test", params: {} })).rejects.toThrow(
      "Travelpayouts API error: 502 Bad Gateway",
    );
  });

  it("strips trailing slashes from base URL", async () => {
    const mockResponse = { ok: true, json: () => Promise.resolve({}) };
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse as Response);

    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080///" });
    await client.get({ path: "/test", params: {} });

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(/^http:\/\/gateway:8080\/test/);
  });
});
