import { Type } from "@sinclair/typebox";
import type { ApiClient } from "../api-client.js";
import { formatPrice } from "../format.js";

const SearchTrainsSchema = Type.Object({
  origin: Type.String({
    description: "Departure city or station code (e.g. 'Moscow', 'MOW')",
  }),
  destination: Type.String({
    description: "Arrival city or station code (e.g. 'Saint Petersburg', 'LED')",
  }),
  date: Type.String({
    description: "Travel date: YYYY-MM-DD",
  }),
  currency: Type.Optional(Type.String({ description: "Currency code (default: RUB)" })),
});

type TrainApiResponse = {
  success: boolean;
  data: Array<{
    train_number: string;
    departure: string;
    arrival: string;
    duration_minutes: number;
    price: number;
    currency: string;
    link: string;
  }>;
};

export function createSearchTrainsTool(client: ApiClient) {
  return {
    label: "Search Trains",
    name: "search_trains",
    description:
      "Search for railway tickets. Returns train numbers, schedules, prices, and booking links.",
    parameters: SearchTrainsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const origin = (args.origin as string).trim();
      const destination = (args.destination as string).trim();
      const date = args.date as string;
      const currency = ((args.currency as string) ?? "RUB").toUpperCase();

      const data = await client.get<TrainApiResponse>({
        path: "/travelpayouts/trains/v1/search",
        params: { origin, destination, date, currency },
      });

      if (!data.success || !data.data?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "no_results",
                message: `No trains found from ${origin} to ${destination} on ${date}`,
              }),
            },
          ],
        };
      }

      const hours = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;

      const results = data.data.map((t) => ({
        trainNumber: t.train_number,
        departure: t.departure,
        arrival: t.arrival,
        duration: hours(t.duration_minutes),
        price: formatPrice(t.price, t.currency || currency),
        priceRaw: t.price,
        link: t.link,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "ok", count: results.length, results }, null, 2),
          },
        ],
        details: { results },
      };
    },
  };
}
