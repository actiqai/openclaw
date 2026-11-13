import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolSpec } from "./typed-tools.js";
import { prepareParams, rememberAsks, type FillPaths } from "./fill.js";

function paths(): FillPaths {
  const root = mkdtempSync(join(tmpdir(), "fill-"));

  return {
    stateDir: join(root, "actiq"),
    skillsDir: join(root, "skills"),
    workspaceDir: join(root, "workspace"),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const dgis: ToolSpec = {
  skill: "dgis",
  tool: "dgis",
  description: "d",
  actions: {
    search: {
      description: "d",
      params: {
        query: { type: "string", description: "d", ask: "Что поищем?" },
        city: { type: "string", description: "d", from: "person.city", ask: "Где живёшь?" },
      },
      required: ["query", "city"],
    },
  },
};

const sports: ToolSpec = {
  skill: "sportsru",
  tool: "sports",
  description: "d",
  actions: {
    team: {
      description: "d",
      state: true,
      params: { name: { type: "string", description: "d", from: "profile.team", ask: "За кого?" } },
      required: ["name"],
    },
  },
};

describe("prepareParams", () => {
  it("подставляет город из общего блока, если модель его не передала", () => {
    const p = paths();
    writeJson(join(p.stateDir, "shared", "person.json"), { city: "Москва" });

    const out = prepareParams(p, dgis, "dgis", "search", { query: "кофейня" });

    expect(out).toEqual({ query: "кофейня", city: "Москва" });
  });

  it("названное человеком сильнее профиля и профиль не переписывает", () => {
    const p = paths();
    writeJson(join(p.stateDir, "shared", "person.json"), { city: "Москва" });

    const out = prepareParams(p, dgis, "dgis", "search", { query: "кофейня", city: "Казань" });

    expect(out.city).toBe("Казань");
    expect(JSON.parse(readFileSync(join(p.stateDir, "shared", "person.json"), "utf8")).city).toBe(
      "Москва",
    );
  });

  it("пустой профиль — параметр не выдумывается, отказ спросит гейтвей", () => {
    const out = prepareParams(paths(), dgis, "dgis", "search", { query: "кофейня" });

    expect(out).toEqual({ query: "кофейня" });
  });

  it("ответ на заданный вопрос записывается в профиль и в USER.md", () => {
    const p = paths();
    const now = new Date("2026-11-13T10:00:00Z");

    rememberAsks(
      p,
      "dgis",
      {
        status: "error",
        errors: [
          { field: "city", reason: "required", from: "person.city", question: "Где живёшь?" },
        ],
      },
      now,
    );

    prepareParams(p, dgis, "dgis", "search", { query: "кофейня", city: "Казань" }, now);

    expect(JSON.parse(readFileSync(join(p.stateDir, "shared", "person.json"), "utf8"))).toEqual({
      city: "Казань",
    });
    expect(readFileSync(join(p.workspaceDir, "USER.md"), "utf8")).toContain("Казань");

    // Вопрос закрыт: следующий город, названный без вопроса, домом не становится.
    prepareParams(p, dgis, "dgis", "search", { query: "кофейня", city: "Сочи" }, now);
    expect(JSON.parse(readFileSync(join(p.stateDir, "shared", "person.json"), "utf8")).city).toBe(
      "Казань",
    );
  });

  it("старый вопрос не превращает сегодняшний город в дом", () => {
    const p = paths();

    rememberAsks(
      p,
      "dgis",
      { errors: [{ field: "city", reason: "required", from: "person.city" }] },
      new Date("2026-11-10T10:00:00Z"),
    );

    prepareParams(
      p,
      dgis,
      "dgis",
      "search",
      { query: "кофейня", city: "Сочи" },
      new Date("2026-11-13T10:00:00Z"),
    );

    expect(existsSync(join(p.stateDir, "shared", "person.json"))).toBe(false);
  });

  it("вопрос без источника не запоминается", () => {
    const p = paths();

    rememberAsks(p, "dgis", { errors: [{ field: "query", reason: "required", question: "Что?" }] });

    expect(existsSync(join(p.stateDir, "skill-asks.json"))).toBe(false);
  });

  it("собственное поле скилла и состояние прикладываются вместо присланного моделью", () => {
    const p = paths();
    writeJson(join(p.skillsDir, "sportsru", "schema.json"), {
      version: 1,
      skill: "sportsru",
      stages: ["basics"],
      fields: { team: { type: "string", stage: "basics", question: "За кого?" } },
      call: { action: "team", required: [], include: ["team"] },
    });
    writeJson(join(p.stateDir, "skills", "sportsru", "profile.json"), { team: "Зенит" });

    const out = prepareParams(p, sports, "sportsru", "team", { profile: { team: "выдумка" } });

    expect(out.name).toBe("Зенит");
    expect(out.profile).toEqual({ team: "Зенит" });
    expect(out).toHaveProperty("facts");
    expect(out).toHaveProperty("liked");
  });

  it("скилл без описания вызывается как есть", () => {
    const params = { anything: 1 };

    expect(prepareParams(paths(), undefined, "x", "y", params)).toBe(params);
  });
});
