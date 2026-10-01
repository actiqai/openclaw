import { describe, expect, it } from "vitest";
import {
  REENTRY_GAP_MS,
  isReentry,
  pickStep,
  stepForCall,
  type SkillCall,
  type TurnMemory,
} from "./steps.js";

const ok = (payload: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ status: "ok", ...payload }) }],
});

/** Ответ `skill_state`, задающий вопрос про поле `field`. */
const asks = (field: string, extra: Record<string, unknown> = {}) =>
  ok({ next_question: `вопрос про ${field}`, missing: [field], ready: false, ...extra });

const state = (skill: string, params: Record<string, unknown>, result: unknown): SkillCall => ({
  tool: "skill_state",
  params: { skill, ...params },
  result,
});

const gw = (
  skill: string,
  action: string,
  params: Record<string, unknown> = {},
  result: unknown = { content: [{ type: "text", text: '{"status":"ok"}' }] },
): SkillCall => ({ tool: "call_skill", params: { skill, action, params }, result });

/**
 * Каждая строка справочника, которую можно определить по вызову, — и вызов,
 * который её даёт. Не покрытые по вызову шаги перечислены отдельно ниже: если
 * в справочнике появится шаг, его придётся положить либо сюда, либо туда.
 */
const COVERED: Array<[string, SkillCall, boolean?]> = [
  ["meal.1.1", state("meal-plan", { op: "get" }, asks("sex"))],
  ["meal.1.2", state("meal-plan", { op: "patch", patch: { sex: "male" } }, asks("age"))],
  ["meal.1.3", state("meal-plan", { op: "get" }, asks("height_cm"))],
  ["meal.1.4", state("meal-plan", { op: "get" }, asks("weight_kg"))],
  ["meal.1.5", state("meal-plan", { op: "get" }, asks("activity"))],
  ["meal.1.6", state("meal-plan", { op: "get" }, asks("goal"))],
  ["meal.1.7", state("meal-plan", { op: "get" }, asks("allergies"))],
  ["meal.2.1", state("meal-plan", { op: "get" }, asks("diet"))],
  ["meal.2.2", state("meal-plan", { op: "get" }, asks("budget"))],
  ["meal.2.3", state("meal-plan", { op: "get" }, asks("cuisines"))],
  ["meal.2.4", state("meal-plan", { op: "get" }, asks("target_weight_kg"))],
  ["meal.3.1", gw("meal-plan", "generate", { horizon: "day" })],
  ["meal.3.2", gw("meal-plan", "generate", { horizon: "week" })],
  ["meal.4.1", gw("meal-plan", "generate", { horizon: "meal" })],
  ["meal.5.1", state("meal-plan", { op: "rate", item: "шакшука", score: 2 }, ok())],
  ["meal.6.1", state("meal-plan", { op: "due_check" }, ok({ ask: true, missed_streak: 0 }))],
  ["meal.6.2", state("meal-plan", { op: "history_append", event: { followed: "почти" } }, ok())],
  ["meal.6.3", state("meal-plan", { op: "history_append", event: { off_plan: ["бургер"] } }, ok())],
  ["meal.6.4", state("meal-plan", { op: "due_check" }, ok({ ask: true, missed_streak: 3 }))],
  [
    "meal.7.1",
    state("meal-plan", { op: "patch", patch: { weight_kg: 88.5 } }, ok({ ready: true })),
  ],
  ["meal.7.2", state("meal-plan", { op: "fact_add", fact: { text: "гастрит" } }, ok())],
  ["meal.7.3", state("meal-plan", { op: "fact_close", fact_id: "f1" }, ok())],
  [
    "meal.8.1",
    state("meal-plan", { op: "patch", patch: { blocked_reason: "800 ккал" } }, asks("age")),
  ],

  ["workout.1.1", state("workout-plan", { op: "get" }, asks("goal"))],
  ["workout.1.2", state("workout-plan", { op: "get" }, asks("place"))],
  ["workout.1.3", state("workout-plan", { op: "get" }, asks("minutes"))],
  ["workout.1.4", state("workout-plan", { op: "get" }, asks("days"))],
  ["workout.2.1", state("workout-plan", { op: "get" }, asks("level"))],
  ["workout.2.2", state("workout-plan", { op: "get" }, asks("city"))],
  ["workout.2.3", state("workout-plan", { op: "get" }, asks("equipment"))],
  ["workout.2.4", state("workout-plan", { op: "get" }, asks("time"))],
  ["workout.2.5", state("workout-plan", { op: "get" }, asks("remind"))],
  ["workout.2.6", state("workout-plan", { op: "get" }, asks("weight_kg"))],
  ["workout.3.1", gw("workout-plan", "generate"), true],
  ["workout.3.2", gw("workout-plan", "generate")],
  ["workout.4.1", state("workout-plan", { op: "due_check" }, ok({ ask: true }))],
  ["workout.4.2", state("workout-plan", { op: "history_append", event: { done: true } }, ok())],
  ["workout.4.3", state("workout-plan", { op: "rate", item: "планка", score: -2 }, ok())],
  ["workout.4.4", state("workout-plan", { op: "due_check" }, ok({ ask: true, missed_streak: 3 }))],
  [
    "workout.5.1",
    state("workout-plan", { op: "reschedule", date: "2026-10-07", moved_to: "2026-10-08" }, ok()),
  ],
  ["workout.5.2", state("workout-plan", { op: "reschedule", date: "2026-10-07" }, ok())],
  [
    "workout.5.3",
    state("workout-plan", { op: "patch", patch: { days: ["thu"] } }, ok({ ready: true })),
  ],
  ["workout.6.1", state("workout-plan", { op: "fact_add", fact: { text: "нога" } }, ok())],
  ["workout.6.2", state("workout-plan", { op: "fact_close", fact_id: "f1" }, ok())],
  [
    "workout.7.1",
    gw("workout-plan", "generate", {}, ok({ status: "blocked", message: "к врачу" })),
  ],
  ["workout.8.1", state("workout-plan", { op: "expect_cancel" }, ok())],

  ["booking.1.1", state("booking", { op: "get" }, asks("city"))],
  ["booking.1.2", state("booking", { op: "get" }, asks("area"))],
  ["booking.1.3", state("booking", { op: "get" }, asks("sex"))],
  ["booking.2.1", state("booking", { op: "get" }, asks("hair_type"))],
  ["booking.2.2", state("booking", { op: "get" }, asks("beard"))],
  ["booking.2.3", state("booking", { op: "get" }, asks("budget"))],
  ["booking.2.4", state("booking", { op: "get" }, asks("phone"))],
  ["booking.3.1", gw("booking", "find_places", { service: "барбершоп" })],
  ["booking.4.1", state("booking", { op: "cadence_set", item: "стрижка", every_days: 28 }, ok())],
  ["booking.4.2", state("booking", { op: "expect", due: "2026-10-02T17:00:00Z" }, ok())],
  ["booking.4.3", state("booking", { op: "due_check" }, ok({ ask: true }))],
  ["booking.5.1", state("booking", { op: "history_append", event: { items: ["стрижка"] } }, ok())],
  ["booking.5.2", state("booking", { op: "rate", item: "Антон", score: 2 }, ok())],
  ["booking.6.1", state("booking", { op: "fact_add", fact: { text: "блонд" } }, ok())],

  ["travel.1.1", state("travelpayouts", { op: "get" }, asks("city"))],
  ["travel.1.2", state("travelpayouts", { op: "get" }, asks("citizenship"))],
  ["travel.1.3", state("travelpayouts", { op: "get" }, asks("currency"))],
  ["travel.2.1", state("travelpayouts", { op: "get" }, asks("country"))],
  ["travel.2.2", state("travelpayouts", { op: "get" }, asks("children"))],
  ["travel.2.3", state("travelpayouts", { op: "get" }, asks("stops"))],
  ["travel.2.4", state("travelpayouts", { op: "get" }, asks("usual_purpose"))],
  ["travel.3.1", gw("travelpayouts", "search_flights", { destination: "IST" })],
  ["travel.3.2", gw("travelpayouts", "cheapest_from")],
  ["travel.3.3", gw("travelpayouts", "search_hotels")],
  [
    "travel.3.4",
    gw("travelpayouts", "search_flights", {}, ok({ document_warnings: ["паспорт истекает"] })),
  ],
  [
    "travel.4.1",
    state("travelpayouts", { op: "fact_add", fact: { kind: "document", text: "загран" } }, ok()),
  ],
  ["travel.5.1", state("travelpayouts", { op: "history_append", event: { kind: "trip" } }, ok())],
];

/** Шаги справочника, которые по одному вызову не определяются. */
const NOT_FROM_A_CALL = [
  // Отказ от блюда второй раз — только вместе с заменой в том же ходу (pickStep).
  "meal.4.2",
  // Фраза для звонка — ответ без вызова тула.
  "booking.3.2",
];

describe("step codes (CLT-056)", () => {
  it.each(COVERED)("%s", (code, call, firstCall) => {
    expect(stepForCall(call, firstCall ?? false)?.code).toBe(code);
  });

  it("covers the whole catalogue: 75 steps, each either from a call or listed as not", () => {
    const all = new Set([...COVERED.map(([code]) => code), ...NOT_FROM_A_CALL]);
    expect(all.size).toBe(75);
  });

  it("an error answer is not a step", () => {
    const failed = state(
      "meal-plan",
      { op: "rate", item: "x" },
      { content: [{ type: "text", text: '{"status":"error","message":"rate needs score"}' }] },
    );
    expect(stepForCall(failed)).toBeNull();
  });

  it("an unknown skill or a silent cron check is not a step", () => {
    expect(stepForCall(gw("weather", "now"))).toBeNull();
    expect(stepForCall(state("meal-plan", { op: "due_check" }, ok({ ask: false })))).toBeNull();
  });

  it("recording the dishes of a menu just sent is bookkeeping, not a step", () => {
    const dishes = state("meal-plan", { op: "history_append", event: { items: ["гречка"] } }, ok());
    expect(stepForCall(dishes)).toBeNull();
  });

  it("weight said during the questionnaire answers the question, it is not meal.7.1", () => {
    const answer = state("meal-plan", { op: "patch", patch: { weight_kg: 90 } }, asks("activity"));
    expect(stepForCall(answer)?.code).toBe("meal.1.5");
  });
});

describe("visible step of a turn", () => {
  const pick = (calls: SkillCall[]) =>
    pickStep(
      calls.map((c) => stepForCall(c)).filter((s) => s !== null),
      calls,
    )?.code;

  it("the menu beats the questionnaire question that `get` returns alongside it", () => {
    expect(
      pick([
        state("meal-plan", { op: "get" }, asks("diet", { ready: true })),
        gw("meal-plan", "generate", { horizon: "day" }),
        state("meal-plan", { op: "history_append", event: { items: ["гречка"] } }, ok()),
      ]),
    ).toBe("meal.3.1");
  });

  it("a report beats the next question", () => {
    expect(
      pick([
        state("workout-plan", { op: "history_append", event: { done: true } }, ok()),
        state("workout-plan", { op: "get" }, asks("equipment")),
      ]),
    ).toBe("workout.4.2");
  });

  it("a replaced dish with a negative rating is a taste, meal.4.2", () => {
    expect(
      pick([
        gw("meal-plan", "generate", { horizon: "meal" }),
        state("meal-plan", { op: "rate", item: "рыба", score: -2 }, ok()),
      ]),
    ).toBe("meal.4.2");
  });

  it("a red flag beats everything", () => {
    expect(
      pick([
        gw("meal-plan", "generate", { horizon: "day" }),
        state("meal-plan", { op: "patch", patch: { blocked_reason: "диабет" } }, ok()),
      ]),
    ).toBe("meal.8.1");
  });

  it("nothing visible — no step", () => {
    expect(pick([])).toBeUndefined();
  });
});

describe("reentry", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const memory = (m: Partial<TurnMemory>): TurnMemory => ({
    last: null,
    skills: {},
    called: {},
    ...m,
  });

  it("the very first turn of a skill is an entry, not a return", () => {
    expect(isReentry(memory({}), "workout-plan", now)).toBe(false);
  });

  it("the previous turn was about another skill — a return", () => {
    const m = memory({
      last: { skill: "travelpayouts", at: now - 60_000 },
      skills: { "workout-plan": now - 30 * 60_000, travelpayouts: now - 60_000 },
    });
    expect(isReentry(m, "workout-plan", now)).toBe(true);
  });

  it("the previous turn was outside skills — a return", () => {
    const m = memory({
      last: { skill: null, at: now - 60_000 },
      skills: { "workout-plan": now - 10 * 60_000 },
    });
    expect(isReentry(m, "workout-plan", now)).toBe(true);
  });

  it("the same skill a minute ago — a continuation", () => {
    const m = memory({
      last: { skill: "workout-plan", at: now - 60_000 },
      skills: { "workout-plan": now - 60_000 },
    });
    expect(isReentry(m, "workout-plan", now)).toBe(false);
  });

  it("the same skill, but more than an hour ago — a return", () => {
    const m = memory({
      last: { skill: "workout-plan", at: now - REENTRY_GAP_MS - 1 },
      skills: { "workout-plan": now - REENTRY_GAP_MS - 1 },
    });
    expect(isReentry(m, "workout-plan", now)).toBe(true);
  });
});
