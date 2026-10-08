import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolCatalog, toolSchema, typedTool, type ToolSpec } from "./typed-tools.js";

const disk: ToolSpec = {
  skill: "yandex-disk",
  tool: "yandex_disk",
  description: "Яндекс Диск",
  actions: {
    list: { description: "папка", params: { path: { type: "string", description: "Папка" } } },
    read: {
      description: "файл",
      params: { path: { type: "string", description: "Путь" } },
      required: ["path"],
    },
    search: {
      description: "поиск",
      params: { query: { type: "string", description: "Имя", minLength: 2 } },
      required: ["query"],
    },
  },
};

describe("typed skill tools (CLT-060)", () => {
  it("builds one schema with an action enum and typed params", () => {
    const schema = toolSchema(disk) as {
      properties: Record<
        string,
        { type: string; enum?: string[]; minLength?: number; description: string }
      >;
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.properties.action.enum).toEqual(["list", "read", "search"]);
    expect(schema.properties.query.type).toBe("string");
    expect(schema.properties.query.minLength).toBe(2);
    // Параметр двух действий описан один раз, с пометкой, где обязателен.
    expect(schema.properties.path.description).toContain("обязателен для read");
    expect(schema.required).toEqual(["action"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("calls the gateway with the skill, the action and the rest as params", async () => {
    const call = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "{}" }],
      details: null,
    }));

    await typedTool(disk, call).execute("t1", { action: "search", query: "договор" });

    expect(call).toHaveBeenCalledWith("yandex-disk", "search", { query: "договор" });
  });

  it("loads the catalog from the gateway, keeps a copy and drops unsafe names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-tools-"));
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        digest: "d1",
        tools: [
          disk,
          { ...disk, skill: "evil", tool: "call_skill" },
          { ...disk, skill: "x", tool: "Bad Name" },
        ],
      }),
    })) as unknown as typeof fetch;

    const catalog = createToolCatalog({
      gatewayBaseUrl: "http://gw",
      instanceToken: "tok",
      cacheFile: join(dir, "skill-tools.json"),
      logger: { info: () => {} },
      fetchImpl,
    });

    await catalog.refresh();

    expect(catalog.current().map((t) => t.tool)).toEqual(["yandex_disk"]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://gw/v1/skills/tools");
    expect((init.headers as Record<string, string>)["X-Instance-Token"]).toBe("tok");

    // После перезапуска без сети инструменты берутся из копии.
    expect(JSON.parse(readFileSync(join(dir, "skill-tools.json"), "utf8")).digest).toBe("d1");
    const offline = createToolCatalog({
      gatewayBaseUrl: "http://gw",
      instanceToken: "",
      cacheFile: join(dir, "skill-tools.json"),
      logger: { info: () => {} },
    });
    expect(offline.current().map((t) => t.tool)).toEqual(["yandex_disk"]);
  });
});
