import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import skillProxyPlugin from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
};

/**
 * Registers the skill-proxy plugin against a fake plugin API and returns the
 * `call_skill` tool the OpenClaw agent would invoke.
 */
function registerCallSkill(
  gatewayBaseUrl: string,
  extra: Record<string, string> = {},
): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const api = {
    pluginConfig: { gatewayBaseUrl, ...extra },
    // Тул регистрируется фабрикой (ей нужна сессия) — разворачиваем её, как агент.
    // Тул регистрируется фабрикой (ей нужна сессия) — разворачиваем её, как агент;
    // фабрика отдаёт список: общий `call_skill` и типизированные инструменты.
    registerTool: (t: unknown) => {
      const made = typeof t === "function" ? t({ sessionKey: "agent:main:main" }) : t;
      tools.push(...(Array.isArray(made) ? made : [made]));
    },
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
    expect(url).toBe(`${gateway}/v1/skill`);
    expect(init.method).toBe("POST");

    const sent = JSON.parse(init.body as string);
    // Скилл теперь едет в теле, а не в пути — точка входа одна на всю платформу.
    expect(sent.skill).toBe("travelpayouts");
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

  /**
   * `CLT-059`. Подключения: блоб едет к гейтвею вместе с вызовом и токеном
   * инстанса, новый блоб из ответа сохраняется, а модель блобов не видит.
   */
  it("carries sealed connections both ways and hides them from the model", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "skill-proxy-"));
    mkdirSync(join(stateDir, "connections"));
    writeFileSync(join(stateDir, "connections", "yandex-mail.blob"), "nk1.k1.mail");

    const fetchMock = vi.fn(async () => ({
      json: async () => ({
        status: "ok",
        result: { items: [] },
        connections: { "yandex-disk": "nk1.k1.disk", "yandex-mail": "", "../evil": "x" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const callSkill = registerCallSkill("http://gateway.test:8082", {
      instanceToken: "inst-token",
      stateDir,
    });

    const result = await callSkill.execute("call-3", { skill: "yandex-disk", action: "list" });

    // С токеном расширение ещё и спрашивает каталог инструментов — ищем вызов скилла.
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/v1/skill")) as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["X-Instance-Token"]).toBe("inst-token");
    expect(JSON.parse(init.body as string).connections).toEqual({ "yandex-mail": "nk1.k1.mail" });

    // Новый блоб сохранён, стёртый — удалён, имя с выходом из каталога — проигнорировано.
    expect(readFileSync(join(stateDir, "connections", "yandex-disk.blob"), "utf8")).toBe(
      "nk1.k1.disk",
    );
    expect(existsSync(join(stateDir, "connections", "yandex-mail.blob"))).toBe(false);
    expect(existsSync(join(stateDir, "evil.blob"))).toBe(false);

    expect(result.content[0].text).not.toContain("nk1");
    expect(JSON.parse(result.content[0].text).status).toBe("ok");
  });

  it("sends no connections field when there is nothing stored", async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ status: "ok" }) }));
    vi.stubGlobal("fetch", fetchMock);

    const callSkill = registerCallSkill("http://gateway.test:8082", {
      stateDir: mkdtempSync(join(tmpdir(), "skill-proxy-")),
    });

    await callSkill.execute("call-4", { skill: "travelpayouts", action: "x" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).connections).toBeUndefined();
    expect((init.headers as Record<string, string>)["X-Instance-Token"]).toBeUndefined();
  });
});
