import { describe, expect, it } from "vitest";
import { buildFlightLink, buildHotelLink, formatPrice, truncateResults } from "./format.js";

describe("formatPrice", () => {
  it("formats RUB with symbol", () => {
    expect(formatPrice(15000, "RUB")).toContain("15");
    expect(formatPrice(15000, "RUB")).toContain("\u20BD");
  });

  it("formats USD with dollar sign", () => {
    expect(formatPrice(250, "USD")).toContain("$");
  });

  it("uses currency code as fallback", () => {
    expect(formatPrice(100, "TRY")).toContain("TRY");
  });
});

describe("buildFlightLink", () => {
  it("builds Aviasales deep link", () => {
    const link = buildFlightLink("abc123");
    expect(link).toBe("https://www.aviasales.ru/search/abc123");
  });
});

describe("buildHotelLink", () => {
  it("builds Hotellook link with dates", () => {
    const link = buildHotelLink(12345, "2026-06-01", "2026-06-05");
    expect(link).toContain("hotelId=12345");
    expect(link).toContain("checkIn=2026-06-01");
    expect(link).toContain("checkOut=2026-06-05");
  });
});

describe("truncateResults", () => {
  it("truncates to limit", () => {
    expect(truncateResults([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });

  it("returns at least 1 result", () => {
    expect(truncateResults([1, 2], 0)).toEqual([1]);
  });

  it("returns all if under limit", () => {
    expect(truncateResults([1, 2], 5)).toEqual([1, 2]);
  });
});
