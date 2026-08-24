import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import skillStatePlugin from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const SCHEMA = {
  version: 1,
  skill: "workout-plan",
  shared: ["body"],
  stages: ["basics", "details", "active"],
  fields: {
    goal: {
      type: "enum",
      values: ["lose", "muscle", "endurance"],
      stage: "basics",
      required: true,
      question: "Чего хочется?",
    },
    minutes: {
      type: "int",
      min: 10,
      max: 120,
      stage: "basics",
      required: true,
      question: "Сколько минут?",
    },
    level: {
      type: "enum",
      values: ["beginner", "advanced"],
      stage: "details",
      required: true,
      question: "Занимался раньше?",
    },
    equipment: { type: "string[]", stage: "details", question: "Что есть из инвентаря?" },
  },
  call: {
    action: "generate",
    required: ["goal", "minutes"],
    include: ["goal", "minutes", "level", "equipment"],
  },
};

let root: string;
let skillsDir: string;
let tool: RegisteredTool;

function call(args: Record<string, unknown>) {
  return tool.execute("t", args).then((r) => JSON.parse(r.content[0].text));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "actiq-state-"));
  skillsDir = mkdtempSync(join(tmpdir(), "actiq-skills-"));

  mkdirSync(join(skillsDir, "workout-plan"), { recursive: true });
  writeFileSync(join(skillsDir, "workout-plan", "schema.json"), JSON.stringify(SCHEMA), "utf8");

  const tools: RegisteredTool[] = [];
  skillStatePlugin.register({
    pluginConfig: { stateDir: root, skillsDir },
    registerTool: (t: RegisteredTool) => tools.push(t),
    logger: { info: () => {} },
  } as never);

  const found = tools.find((t) => t.name === "skill_state");
  if (!found) throw new Error("skill_state was not registered");
  tool = found;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsDir, { recursive: true, force: true });
});

describe("stage — the thing the model cannot fake", () => {
  it("hands back one question at a time and advances only on real answers", async () => {
    const empty = await call({ op: "get", skill: "workout-plan" });
    expect(empty.stage).toBe("basics");
    expect(empty.next_question).toBe("Чего хочется?");
    expect(empty.ready).toBe(false);

    const afterGoal = await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose" } });
    expect(afterGoal.stage).toBe("basics");
    expect(afterGoal.next_question).toBe("Сколько минут?");

    const afterMinutes = await call({ op: "patch", skill: "workout-plan", patch: { minutes: 45 } });
    expect(afterMinutes.stage).toBe("details");
    expect(afterMinutes.ready).toBe(true);

    const done = await call({ op: "patch", skill: "workout-plan", patch: { level: "beginner" } });
    expect(done.stage).toBe("active");
    expect(done.next_question).toBe("");
  });

  // Ровно то, ради чего стадия и вычисляется: разговор оборвался, сессия новая,
  // а бот обязан продолжить с того же места, а не начать опрос заново.
  it("survives a restart — the next question comes from disk, not from the conversation", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose" } });

    const tools: RegisteredTool[] = [];
    skillStatePlugin.register({
      pluginConfig: { stateDir: root, skillsDir },
      registerTool: (t: RegisteredTool) => tools.push(t),
      logger: { info: () => {} },
    } as never);

    const fresh = tools.find((t) => t.name === "skill_state")!;
    const state = JSON.parse(
      (await fresh.execute("t", { op: "get", skill: "workout-plan" })).content[0].text,
    );

    expect(state.profile.goal).toBe("lose");
    expect(state.next_question).toBe("Сколько минут?");
  });
});

describe("writing the profile", () => {
  it("refuses values the schema does not allow, naming the field", async () => {
    const result = await call({
      op: "patch",
      skill: "workout-plan",
      patch: { goal: "стать птицей" },
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toMatchObject({ field: "goal", reason: "enum" });
  });

  // Опечатка в имени поля не должна выглядеть как «записал»: человек рассказал
  // о себе, услышал подтверждение, а данные уехали в никуда.
  it("refuses fields the schema does not define", async () => {
    const result = await call({ op: "patch", skill: "workout-plan", patch: { minutess: 45 } });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toMatchObject({ field: "minutess", reason: "unknown" });
  });

  it("keeps a rejected patch out of the file entirely", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose" } });
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "muscle", minutes: 5 } });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.profile.goal).toBe("lose");
    expect(state.profile.minutes).toBeUndefined();
  });

  it("replaces lists whole instead of appending", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { equipment: ["гантели", "коврик"] } });
    await call({ op: "patch", skill: "workout-plan", patch: { equipment: ["турник"] } });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.profile.equipment).toEqual(["турник"]);
  });

  it("stores shared body data where every skill can find it", async () => {
    await call({
      op: "patch",
      skill: "workout-plan",
      patch: {},
      shared: { body: { height_cm: 180 } },
    });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.shared.body.height_cm).toBe(180);

    const onDisk = JSON.parse(readFileSync(join(root, "shared", "body.json"), "utf8"));
    expect(onDisk.height_cm).toBe(180);
  });
});

describe("facts — what is true right now, not forever", () => {
  it("refuses an injury without an end date", async () => {
    const result = await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: { text: "подвернул ногу", kind: "injury" },
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("end date");
  });

  it("records a dated injury and hands it to the gateway with the call", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose", minutes: 45 } });

    const added = await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: {
        text: "подвернул ногу",
        kind: "injury",
        until: "2100-01-01",
        affects: ["бег", "прыжки"],
      },
    });

    expect(added.status).toBe("ok");
    expect(added.facts).toHaveLength(1);
    expect(added.call_payload.params.facts[0].affects).toEqual(["бег", "прыжки"]);
  });

  it("drops an injury once it has healed, without forgetting it happened", async () => {
    await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: { text: "старая травма", kind: "injury", since: "2026-01-01", until: "2026-02-01" },
    });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.facts).toHaveLength(0);

    const stored = JSON.parse(
      readFileSync(join(root, "skills", "workout-plan", "facts.json"), "utf8"),
    );
    expect(stored.archived).toHaveLength(1);
  });

  it("closes a fact early when the user says it is over", async () => {
    const added = await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: { text: "нога", kind: "injury", until: "2100-01-01" },
    });

    const closed = await call({
      op: "fact_close",
      skill: "workout-plan",
      fact_id: added.recorded.id,
    });
    expect(closed.facts).toHaveLength(0);
  });

  // Модель считает «сегодня» по таймзоне человека, инстанс — по UTC. Факт, уехавший
  // из-за этого на день вперёд, не применился бы к сегодняшнему плану.
  it("does not let a timezone gap postpone a fact to tomorrow", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const added = await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: { text: "подвернул ногу", kind: "injury", since: tomorrow, until: "2100-01-01" },
    });

    expect(added.facts).toHaveLength(1);
  });

  it("allows an allergy to be open-ended — it does not expire", async () => {
    const added = await call({
      op: "fact_add",
      skill: "workout-plan",
      fact: { text: "аллергия на орехи", kind: "constraint", since: "2026-01-01" },
    });

    expect(added.status).toBe("ok");
    expect(added.facts).toHaveLength(1);
  });
});

describe("the call to the gateway", () => {
  // Граница приватности: профиль на инстансе может быть сколь угодно подробным,
  // наверх уходит только то, что перечислено в схеме.
  it("sends only the fields the schema includes", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose", minutes: 45 } });
    await call({
      op: "patch",
      skill: "workout-plan",
      patch: {},
      shared: { body: { weight_kg: 90 } },
    });

    const state = await call({ op: "get", skill: "workout-plan" });

    expect(Object.keys(state.call_payload.params.profile).sort()).toEqual(["goal", "minutes"]);
    expect(JSON.stringify(state.call_payload)).not.toContain("weight_kg");
  });

  it("offers no payload until the required fields are collected", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose" } });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.ready).toBe(false);
    expect(state.call_payload).toBeNull();
  });

  it("carries recent history so the next plan reacts to the last one", async () => {
    await call({ op: "patch", skill: "workout-plan", patch: { goal: "lose", minutes: 45 } });
    await call({
      op: "history_append",
      skill: "workout-plan",
      event: { done: true, hard: "еле дожил" },
    });

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.call_payload.params.recent).toHaveLength(1);
    expect(state.call_payload.params.recent[0].hard).toBe("еле дожил");
  });
});

describe("failure modes", () => {
  it("says plainly when a skill keeps no profile", async () => {
    const result = await call({ op: "get", skill: "travelpayouts" });

    expect(result.status).toBe("error");
    expect(result.message).toContain("does not keep a profile");
  });

  // Битый файл — это единственный экземпляр данных пользователя. Перезаписать его
  // пустым значит потерять всё, что человек рассказывал; отложить в сторону — нет.
  it("sets a corrupted profile aside instead of overwriting it", async () => {
    mkdirSync(join(root, "skills", "workout-plan"), { recursive: true });
    writeFileSync(join(root, "skills", "workout-plan", "profile.json"), "{ not json", "utf8");

    const state = await call({ op: "get", skill: "workout-plan" });
    expect(state.status).toBe("ok");
    expect(state.stage).toBe("basics");

    const { readdirSync } = await import("node:fs");
    const saved = readdirSync(join(root, "skills", "workout-plan")).filter((f) =>
      f.includes("corrupt"),
    );
    expect(saved).toHaveLength(1);
  });
});
