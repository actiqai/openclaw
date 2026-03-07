import { Type } from "@sinclair/typebox";
import type { ApiClient } from "../api-client.js";
import type { HotelApiResponse } from "../types.js";
import { buildHotelLink, formatPrice, truncateResults } from "../format.js";

const SearchHotelsSchema = Type.Object({
  location: Type.String({
    description: "City name or IATA code (e.g. 'Moscow', 'MOW', 'Dubai')",
  }),
  checkIn: Type.String({
    description: "Check-in date: YYYY-MM-DD",
  }),
  checkOut: Type.String({
    description: "Check-out date: YYYY-MM-DD",
  }),
  adults: Type.Optional(
    Type.Number({
      description: "Number of adults (default: 2)",
      minimum: 1,
      maximum: 4,
    }),
  ),
  currency: Type.Optional(
    Type.String({
      description: "Currency code (default: RUB)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Number of results (1-20, default: 5)",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

export function createSearchHotelsTool(client: ApiClient) {
  return {
    label: "Search Hotels",
    name: "search_hotels",
    description:
      "Search for hotels by city. Returns hotel names, star ratings, prices, and booking links.",
    parameters: SearchHotelsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const location = (args.location as string).trim();
      const checkIn = args.checkIn as string;
      const checkOut = args.checkOut as string;
      const adults = (args.adults as number) ?? 2;
      const currency = ((args.currency as string) ?? "RUB").toUpperCase();
      const limit = (args.limit as number) ?? 5;

      const data = await client.get<HotelApiResponse>({
        path: "/travelpayouts/hotellook/v2/cache.json",
        params: {
          location,
          checkIn,
          checkOut,
          adults,
          currency,
          limit,
        },
      });

      if (!Array.isArray(data) || data.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "no_results",
                message: `No hotels found in ${location} for ${checkIn} — ${checkOut}`,
              }),
            },
          ],
        };
      }

      const results = truncateResults(data, limit).map((hotel) => ({
        hotelName: hotel.hotelName,
        stars: hotel.stars,
        priceFrom: formatPrice(hotel.priceFrom, currency),
        priceFromRaw: hotel.priceFrom,
        priceAvg: formatPrice(hotel.priceAvg, currency),
        location: hotel.location,
        link: buildHotelLink(hotel.hotelId, checkIn, checkOut),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "ok",
                count: results.length,
                currency,
                results,
              },
              null,
              2,
            ),
          },
        ],
        details: { results },
      };
    },
  };
}
