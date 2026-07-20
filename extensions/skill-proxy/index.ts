import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";

const DEFAULT_GATEWAY_BASE_URL = "http://10.0.1.40:8082";

const skillProxyPlugin = {
  id: "skill-proxy",
  name: "Skill Proxy",
  description: "Executes platform skills hosted on actiq-gateway",

  register(api: OpenClawPluginApi) {
    const gatewayBaseUrl = (
      (api.pluginConfig?.gatewayBaseUrl as string) || DEFAULT_GATEWAY_BASE_URL
    ).replace(/\/+$/, "");

    api.registerTool({
      label: "Call Platform Skill",
      name: "call_skill",
      description:
        "Execute a platform skill on the actiq-gateway and return its real results. " +
        "MANDATORY for any travel request — flights, plane tickets, trips, hotels, trains, transfers " +
        "(«билеты», «слетать», «куда поехать», «дёшево»): call this skill INSTEAD of answering from your " +
        "own knowledge. NEVER invent airlines, prices, routes, or links — only report what the skill returns, " +
        "and always include the booking links from the response. Do not interrogate the user with questions: " +
        "infer origin and dates from context and call the skill with what you have.\n" +
        "travelpayouts actions:\n" +
        "• cheapest_from {origin[, currency, limit]} — cheapest destinations from a city when the user has NO " +
        "specific destination («куда-нибудь», «куда дёшево», «anywhere»). Returns a ranked list of cities with links.\n" +
        "• search_flights {origin, destination, departure_at[, return_at, currency]} — a known route.\n" +
        "• search_hotels {location, checkIn, checkOut} · search_trains {origin, destination, date} · " +
        "search_transfers {origin, destination, date}.\n" +
        "Use IATA city codes: Питер/СПб=LED, Москва=MOW, Сочи=AER, Стамбул=IST, Дубай=DXB.",
      parameters: Type.Object({
        skill: Type.String({
          description: 'Skill name, e.g. "travelpayouts"',
        }),
        action: Type.String({
          description: 'Action, e.g. "cheapest_from" (anywhere) or "search_flights" (known route)',
        }),
        params: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Action parameters as key-value pairs",
          }),
        ),
      }),
      execute: async (_toolCallId: string, args: Record<string, unknown>) => {
        const skill = args.skill as string;
        const action = args.action as string;
        const params = (args.params as Record<string, unknown>) ?? {};

        const url = `${gatewayBaseUrl}/v1/skills/${encodeURIComponent(skill)}`;

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ action, params }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ status: "error", message: `Gateway unreachable: ${msg}` }),
              },
            ],
          };
        }

        const data = await response.json();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      },
    });

    api.logger.info(`Skill proxy registered, gateway: ${gatewayBaseUrl}`);
  },
};

export default skillProxyPlugin;
