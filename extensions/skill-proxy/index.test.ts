import { afterEach, describe, expect, it, vi } from "vitest";

import skillProxyPlugin from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

/**
 * Registers the skill-proxy plugin against a fake plugin API and returns the
 * `call_skill` tool the OpenClaw agent would invoke.
 */
function registerCallSkill(gatewayBaseUrl: string): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const api = {
    pluginConfig: { gatewayBaseUrl },
    registerTool: (t: RegisteredTool) => tools.push(t),
    logger: { info: () => {} },
  };

  skillProxyPlugin.register(api as never);

  const tool = tools.find((t) => t.name === "call_skill");
  if (!tool) throw new Error("call_skill tool was not registered");
  return tool;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skill-proxy — client layer of the webhook→reply flow", () => {
  // The LLM inside OpenClaw resolved «Хочу билеты какие-нибудь из Питера на выходные»
  // into a concrete call_skill invocation. This test asserts the plumbing from that
  // decision to the gateway: correct URL, {action, params} body, and relayed result.
  it("POSTs the resolved skill call to the gateway and relays the result", async () => {
    const gateway = "http://gateway.test:8082";

    const gatewayResult = {
      status: "ok",
      result: {
        count: 1,
        currency: "RUB",
        results: [
          {
            origin: "LED",
            destination: "AER",
            price: "5400 ₽",
            airline: "DP",
            link: "https://www.aviasales.ru/search/LED2507AER1?marker=MRK12345",
          },
        ],
      },
    };

    const fetchMock = vi.fn(async () => ({
      json: async () => gatewayResult,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const callSkill = registerCallSkill(gateway);

    const result = await callSkill.execute("call-1", {
      skill: "travelpayouts",
      action: "search_flights",
      params: { origin: "LED", destination: "AER", departure_at: "2026-07-25", currency: "RUB" },
    });

    // --- Request went to the gateway skills endpoint with the right body ---
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${gateway}/v1/skills/travelpayouts`);
    expect(init.method).toBe("POST");

    const sent = JSON.parse(init.body as string);
    expect(sent.action).toBe("search_flights");
    expect(sent.params).toMatchObject({ origin: "LED", destination: "AER" });

    // --- Gateway result is relayed back to the agent as tool output ---
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("ok");
    expect(payload.result.results[0].link).toContain("marker=MRK12345");
  });

  it("returns an error payload when the gateway is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const callSkill = registerCallSkill("http://gateway.test:8082");

    const result = await callSkill.execute("call-2", {
      skill: "travelpayouts",
      action: "search_flights",
      params: { origin: "LED", destination: "AER", departure_at: "2026-07-25" },
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("error");
    expect(payload.message).toContain("Gateway unreachable");
  });
});
