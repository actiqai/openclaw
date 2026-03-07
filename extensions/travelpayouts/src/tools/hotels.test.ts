import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api-client.js";
import { createSearchHotelsTool } from "./hotels.js";

describe("search_hotels tool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeTool() {
    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080" });
    return createSearchHotelsTool(client);
  }

  const mockHotelData = [
    {
      hotelName: "Grand Hotel",
      stars: 4,
      priceFrom: 3500,
      priceAvg: 5000,
      hotelId: 101,
      location: { lat: 55.75, lon: 37.61 },
    },
    {
      hotelName: "Budget Inn",
      stars: 2,
      priceFrom: 1200,
      priceAvg: 1800,
      hotelId: 202,
      location: { lat: 55.76, lon: 37.62 },
    },
  ];

  it("returns formatted hotel results", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockHotelData),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-1", {
      location: "Moscow",
      checkIn: "2026-06-01",
      checkOut: "2026-06-05",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].hotelName).toBe("Grand Hotel");
    expect(parsed.results[0].link).toContain("hotellook.com");
    expect(parsed.results[0].link).toContain("hotelId=101");
  });

  it("returns no_results for empty array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-2", {
      location: "Nowhere",
      checkIn: "2026-06-01",
      checkOut: "2026-06-05",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("no_results");
  });

  it("respects limit parameter", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockHotelData),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-3", {
      location: "Moscow",
      checkIn: "2026-06-01",
      checkOut: "2026-06-05",
      limit: 1,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
  });
});
