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
        "Execute a platform skill on the gateway. Use this for travel search (travelpayouts) and other platform capabilities.",
      parameters: Type.Object({
        skill: Type.String({
          description: 'Skill name, e.g. "travelpayouts"',
        }),
        action: Type.String({
          description: 'Action to perform, e.g. "search_flights"',
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
