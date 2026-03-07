import { Type } from "@sinclair/typebox";
import type { ApiClient } from "../api-client.js";
import type { FlightApiResponse } from "../types.js";
import { buildFlightLink, formatPrice, truncateResults } from "../format.js";

const SearchFlightsSchema = Type.Object({
  origin: Type.String({
    description:
      "IATA city code of departure (e.g. MOW=Moscow, LED=St.Petersburg, AER=Sochi, IST=Istanbul, DXB=Dubai)",
  }),
  destination: Type.String({
    description: "IATA city code of destination",
  }),
  departure_at: Type.String({
    description: "Departure date: YYYY-MM-DD or YYYY-MM (for cheapest in month)",
  }),
  return_at: Type.Optional(
    Type.String({
      description: "Return date for round-trip: YYYY-MM-DD (omit for one-way)",
    }),
  ),
  currency: Type.Optional(
    Type.String({
      description: "Currency code (default: RUB). Supported: RUB, USD, EUR",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-30, default: 5)",
      minimum: 1,
      maximum: 30,
    }),
  ),
});

export function createSearchFlightsTool(client: ApiClient) {
  return {
    label: "Search Flights",
    name: "search_flights",
    description:
      "Search for cheap airline tickets. Returns prices, airlines, and booking links. Use IATA city codes (MOW, LED, AER, KZN, SVX, IST, DXB, etc).",
    parameters: SearchFlightsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const origin = (args.origin as string).toUpperCase().trim();
      const destination = (args.destination as string).toUpperCase().trim();
      const departureAt = args.departure_at as string;
      const returnAt = args.return_at as string | undefined;
      const currency = ((args.currency as string) ?? "RUB").toUpperCase();
      const limit = (args.limit as number) ?? 5;

      const data = await client.get<FlightApiResponse>({
        path: "/travelpayouts/aviasales/v3/prices_for_dates",
        params: {
          origin,
          destination,
          departure_at: departureAt,
          return_at: returnAt,
          currency,
          limit,
          sorting: "price",
        },
      });

      if (!data.success || !data.data?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "no_results",
                message: `No flights found from ${origin} to ${destination} on ${departureAt}`,
              }),
            },
          ],
        };
      }

      const results = truncateResults(data.data, limit).map((flight) => ({
        origin: flight.origin,
        destination: flight.destination,
        price: formatPrice(flight.price, currency),
        priceRaw: flight.price,
        airline: flight.airline,
        flightNumber: flight.flight_number,
        departureAt: flight.departure_at,
        returnAt: flight.return_at,
        transfers: flight.transfers,
        link: buildFlightLink(flight.link),
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
