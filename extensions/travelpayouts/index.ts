import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createApiClient } from "./src/api-client.js";
import { createSearchFlightsTool } from "./src/tools/flights.js";
import { createSearchHotelsTool } from "./src/tools/hotels.js";
import { createSearchTrainsTool } from "./src/tools/trains.js";
import { createSearchTransfersTool } from "./src/tools/transfers.js";

const DEFAULT_GATEWAY_BASE_URL = "http://10.0.1.40:8080";

const travelpayoutsPlugin = {
  id: "travelpayouts",
  name: "Travelpayouts",
  description: "Travel search tools: flights, hotels, transfers, trains via Travelpayouts API",

  register(api: OpenClawPluginApi) {
    const gatewayBaseUrl = (api.pluginConfig?.gatewayBaseUrl as string) || DEFAULT_GATEWAY_BASE_URL;

    const client = createApiClient({ gatewayBaseUrl });

    api.registerTool(createSearchFlightsTool(client));
    api.registerTool(createSearchHotelsTool(client));
    api.registerTool(createSearchTransfersTool(client));
    api.registerTool(createSearchTrainsTool(client));

    api.logger.info(`Travelpayouts plugin registered: 4 tools, gateway: ${gatewayBaseUrl}`);
  },
};

export default travelpayoutsPlugin;
