import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api-client.js";
import { createSearchFlightsTool } from "./flights.js";

describe("search_flights tool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeTool() {
    const client = createApiClient({ gatewayBaseUrl: "http://gateway:8080" });
    return createSearchFlightsTool(client);
  }

  const mockFlightData = {
    success: true,
    data: [
      {
        origin: "MOW",
        destination: "AER",
        price: 4500,
        airline: "S7",
        flight_number: "S7 1234",
        departure_at: "2026-06-15",
        return_at: "2026-06-20",
        transfers: 0,
        link: "abc123token",
      },
      {
        origin: "MOW",
        destination: "AER",
        price: 5200,
        airline: "SU",
        flight_number: "SU 567",
        departure_at: "2026-06-15",
        return_at: "2026-06-20",
        transfers: 1,
        link: "def456token",
      },
    ],
  };

  it("returns formatted flight results", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockFlightData),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-1", {
      origin: "MOW",
      destination: "AER",
      departure_at: "2026-06",
    });

    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("ok");
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].airline).toBe("S7");
    expect(parsed.results[0].link).toContain("aviasales.ru");
  });

  it("returns no_results when API returns empty data", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-2", {
      origin: "MOW",
      destination: "XXX",
      departure_at: "2026-06",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("no_results");
  });

  it("respects limit parameter", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockFlightData),
    } as Response);

    const tool = makeTool();
    const result = await tool.execute("call-3", {
      origin: "MOW",
      destination: "AER",
      departure_at: "2026-06",
      limit: 1,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
  });

  it("uppercases origin and destination", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    } as Response);

    const tool = makeTool();
    await tool.execute("call-4", {
      origin: "mow",
      destination: "aer",
      departure_at: "2026-06",
    });

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("origin=MOW");
    expect(calledUrl).toContain("destination=AER");
  });
});
