import { Type } from "@sinclair/typebox";
import type { ApiClient } from "../api-client.js";
import { formatPrice } from "../format.js";

const SearchTransfersSchema = Type.Object({
  origin: Type.String({
    description: "Pickup location: airport IATA code or city name (e.g. 'SVO', 'Sheremetyevo')",
  }),
  destination: Type.String({
    description: "Drop-off location: address, hotel name, or city name",
  }),
  date: Type.String({
    description: "Transfer date: YYYY-MM-DD",
  }),
  passengers: Type.Optional(
    Type.Number({
      description: "Number of passengers (default: 2)",
      minimum: 1,
      maximum: 8,
    }),
  ),
  currency: Type.Optional(Type.String({ description: "Currency code (default: RUB)" })),
});

type TransferApiResponse = {
  success: boolean;
  data: Array<{
    provider: string;
    vehicle_type: string;
    price: number;
    currency: string;
    duration_minutes: number;
    link: string;
  }>;
};

export function createSearchTransfersTool(client: ApiClient) {
  return {
    label: "Search Transfers",
    name: "search_transfers",
    description:
      "Search for airport transfers and car services. Returns vehicle types, prices, and booking links.",
    parameters: SearchTransfersSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const origin = (args.origin as string).trim();
      const destination = (args.destination as string).trim();
      const date = args.date as string;
      const passengers = (args.passengers as number) ?? 2;
      const currency = ((args.currency as string) ?? "RUB").toUpperCase();

      const data = await client.get<TransferApiResponse>({
        path: "/travelpayouts/transfers/v1/search",
        params: { origin, destination, date, passengers, currency },
      });

      if (!data.success || !data.data?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "no_results",
                message: `No transfers found from ${origin} to ${destination} on ${date}`,
              }),
            },
          ],
        };
      }

      const results = data.data.map((t) => ({
        provider: t.provider,
        vehicleType: t.vehicle_type,
        price: formatPrice(t.price, t.currency || currency),
        priceRaw: t.price,
        duration: `${t.duration_minutes} min`,
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
