const AVIASALES_DEEPLINK_BASE = "https://www.aviasales.ru";

/**
 * Format price with currency symbol.
 */
export function formatPrice(amount: number, currency = "RUB"): string {
  const symbols: Record<string, string> = {
    RUB: "\u20BD",
    USD: "$",
    EUR: "\u20AC",
    GBP: "\u00A3",
  };
  const symbol = symbols[currency] ?? currency;
  return `${amount.toLocaleString("ru-RU")} ${symbol}`;
}

/**
 * Build Aviasales deep link for a flight.
 */
export function buildFlightLink(token: string): string {
  return `${AVIASALES_DEEPLINK_BASE}/search/${token}`;
}

/**
 * Build Hotellook hotel link.
 */
export function buildHotelLink(hotelId: number, checkIn: string, checkOut: string): string {
  return `https://search.hotellook.com/hotels?hotelId=${hotelId}&checkIn=${checkIn}&checkOut=${checkOut}`;
}

/**
 * Truncate results array to limit.
 */
export function truncateResults<T>(results: T[], limit: number): T[] {
  return results.slice(0, Math.max(1, limit));
}
