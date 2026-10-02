/**
 * Код шага скилла по вызовам тулов за ход (`CLT-056`).
 *
 * Справочник — документ «Скиллы Ники: сценарии и шаги»: `<скилл>.<сценарий>.<шаг>`,
 * `meal.1.2` — онбординг питания, вопрос про возраст. Код считается по тому, что
 * модель сделала, а не по тексту: вызов уже несёт скилл и операцию, и возврат к
 * скиллу посреди чужой темы виден так же, как обычный шаг.
 *
 * Коды не переиспользуются и не перенумеровываются: по ним роутер пишет историю,
 * а к ним привяжутся гифки.
 */

export type SkillCall = {
  tool: string;
  params: Record<string, unknown>;
  result: unknown;
};

export type Step = {
  code: string;
  skill: string;
  rank: number;
};

/**
 * Приоритет — что человек увидит в ответе.
 *
 * Меню важнее записи оценки, запись важнее очередного вопроса анкеты: вопрос
 * онбординга `get` возвращает почти всегда, и если бы он побеждал, любой ход с
 * меню помечался бы вопросом, которого бот не задавал.
 */
const RANK = {
  question: 10,
  write: 20,
  cron: 25,
  call: 30,
  callDetail: 31,
  blocked: 40,
} as const;

/** Короткое имя скилла в коде шага. */
export const SKILL_CODES: Record<string, string> = {
  "meal-plan": "meal",
  "workout-plan": "workout",
  booking: "booking",
  travelpayouts: "travel",
};

/** Вопрос анкеты → шаг онбординга: по полю, про которое `next_question`. */
const QUESTION_STEPS: Record<string, Record<string, string>> = {
  meal: {
    sex: "1.1",
    age: "1.2",
    height_cm: "1.3",
    weight_kg: "1.4",
    activity: "1.5",
    goal: "1.6",
    allergies: "1.7",
    diet: "2.1",
    dislikes: "2.1",
    cook_effort: "2.2",
    budget: "2.2",
    meals_per_day: "2.2",
    eats_out: "2.3",
    cuisines: "2.3",
    target_weight_kg: "2.4",
  },
  workout: {
    goal: "1.1",
    place: "1.2",
    minutes: "1.3",
    days: "1.4",
    level: "2.1",
    city: "2.2",
    equipment: "2.3",
    time: "2.4",
    remind: "2.5",
    weight_kg: "2.6",
    sex: "2.6",
    age: "2.6",
  },
  booking: {
    city: "1.1",
    area: "1.2",
    sex: "1.3",
    hair_length: "2.1",
    hair_type: "2.1",
    hair_colored: "2.1",
    hair_concerns: "2.1",
    beard: "2.2",
    nails: "2.2",
    budget: "2.3",
    phone: "2.4",
    name: "2.4",
  },
  travel: {
    city: "1.1",
    citizenship: "1.2",
    currency: "1.3",
    country: "2.1",
    adults: "2.2",
    children: "2.2",
    companions: "2.2",
    cabin: "2.3",
    baggage: "2.3",
    stops: "2.3",
    usual_purpose: "2.4",
  },
};

/** Ответ тула — `{content: [{text: JSON}]}`; достаём JSON. */
export function parseToolResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: Array<{ text?: unknown }> }).content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text === "string") {
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
  }
  return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

function step(code: string, skill: string, rank: number): Step {
  return { code, skill, rank };
}

/** Шаг вопроса анкеты, если ответ `skill_state` его задаёт. */
function questionStep(short: string, skill: string, res: Record<string, unknown>): Step | null {
  if (typeof res.next_question !== "string" || !res.next_question) return null;
  const missing = Array.isArray(res.missing) ? (res.missing as unknown[]) : [];
  const field = typeof missing[0] === "string" ? missing[0] : "";
  const num = QUESTION_STEPS[short]?.[field];
  return num ? step(`${short}.${num}`, skill, RANK.question) : null;
}

function skillStateStep(
  short: string,
  skill: string,
  params: Record<string, unknown>,
  res: Record<string, unknown>,
): Step | null {
  if (res.status === "error") return null;

  const write = (num: string) => step(`${short}.${num}`, skill, RANK.write);

  switch (params.op) {
    case "get":
      return questionStep(short, skill, res);

    case "patch": {
      const patch = (params.patch as Record<string, unknown>) ?? {};
      // Красный флаг — в любой момент, даже посреди анкеты.
      if (nonEmpty(patch.blocked_reason)) {
        if (short === "meal") return step("meal.8.1", skill, RANK.blocked);
        if (short === "workout") return step("workout.7.1", skill, RANK.blocked);
      }
      // Пока анкета не собрана, записанный вес или дни — это ответ на вопрос,
      // а следующий шаг — следующий вопрос. Вес — шаг только питания: в
      // тренировках он просто поле профиля, и метка `meal.7.1` увела бы ответ
      // про тренировки к гифке питания (`CLT-057`).
      if (res.ready === true) {
        if (short === "meal" && typeof patch.weight_kg === "number") return write("7.1");
        if (short === "workout" && Array.isArray(patch.days)) return write("5.3");
      }
      return questionStep(short, skill, res);
    }

    case "fact_add":
      if (short === "meal") return write("7.2");
      if (short === "workout") return write("6.1");
      if (short === "booking") return write("6.1");
      if (short === "travel") return write("4.1");
      return null;

    case "fact_close":
      if (short === "meal") return write("7.3");
      if (short === "workout") return write("6.2");
      if (short === "booking") return write("6.1");
      return null;

    case "history_append": {
      const event = (params.event as Record<string, unknown>) ?? {};
      if (short === "meal") {
        if (nonEmpty(event.off_plan)) return write("6.3");
        if (nonEmpty(event.followed) || typeof event.weight_kg === "number") return write("6.2");
        // Запись блюд из только что отправленного меню — служебная, не шаг.
        return null;
      }
      if (short === "workout") return write("4.2");
      if (short === "booking") return write("5.1");
      if (short === "travel") return write("5.1");
      return null;
    }

    case "rate":
      if (short === "meal") {
        // Отказ от блюда второй-третий раз — это уже вкус (meal.4.2); различить
        // по одному вызову можно только по знаку, поэтому отрицательная оценка
        // рядом с заменой блюда превращается в 4.2 при выборе (см. pickStep).
        return write("5.1");
      }
      if (short === "workout") return write("4.3");
      if (short === "booking") return write("5.2");
      if (short === "travel") return write("5.1");
      return null;

    case "reschedule":
      if (short === "workout") return write(nonEmpty(params.moved_to) ? "5.1" : "5.2");
      return null;

    case "cadence_set":
      return short === "booking" ? write("4.1") : null;

    case "expect":
      // Ожидание отчёта ставится вместе с меню или тренировкой и своим шагом не
      // является; у записи это напоминание перед визитом.
      return short === "booking" ? write("4.2") : null;

    case "expect_cancel":
      return short === "workout" ? write("8.1") : null;

    case "due_check": {
      if (res.ask !== true) return null;
      const streak = typeof res.missed_streak === "number" ? res.missed_streak : 0;
      if (streak >= 3) {
        if (short === "meal") return step("meal.6.4", skill, RANK.cron);
        if (short === "workout") return step("workout.4.4", skill, RANK.cron);
      }
      if (short === "meal") return step("meal.6.1", skill, RANK.cron);
      if (short === "workout") return step("workout.4.1", skill, RANK.cron);
      if (short === "booking") return step("booking.4.3", skill, RANK.cron);
      return null;
    }

    default:
      return null;
  }
}

function callSkillStep(
  short: string,
  skill: string,
  params: Record<string, unknown>,
  res: Record<string, unknown>,
  firstCall: boolean,
): Step | null {
  if (res.status === "error") return null;

  const action = params.action;
  const callParams = (params.params as Record<string, unknown>) ?? {};

  if (res.status === "blocked") {
    if (short === "meal") return step("meal.8.1", skill, RANK.blocked);
    if (short === "workout") return step("workout.7.1", skill, RANK.blocked);
  }

  const call = (num: string, rank: number = RANK.call) => step(`${short}.${num}`, skill, rank);

  switch (short) {
    case "meal":
      if (action !== "generate") return null;
      if (callParams.horizon === "meal") return call("4.1");
      if (callParams.horizon === "week") return call("3.2");
      return call("3.1");
    case "workout":
      if (action !== "generate") return null;
      return call(firstCall ? "3.1" : "3.2");
    case "booking":
      return action === "find_places" ? call("3.1") : null;
    case "travel": {
      const warnings = res.document_warnings;
      if (Array.isArray(warnings) && warnings.length > 0) return call("3.4", RANK.callDetail);
      if (action === "search_flights") return call("3.1");
      if (action === "cheapest_from") return call("3.2");
      if (action === "search_hotels" || action === "search_trains" || action === "search_transfers")
        return call("3.3");
      return null;
    }
    default:
      return null;
  }
}

/**
 * Шаг одного вызова; `null` — вызов шага не даёт.
 *
 * `firstCall` — у скилла ещё не было ни одного вызова гейтвея (первая тренировка
 * сразу после анкеты — свой шаг, `workout.3.1`).
 */
export function stepForCall(call: SkillCall, firstCall = false): Step | null {
  const skill = typeof call.params.skill === "string" ? call.params.skill : "";
  const short = SKILL_CODES[skill];
  if (!short) return null;

  const res = parseToolResult(call.result);

  if (call.tool === "skill_state") return skillStateStep(short, skill, call.params, res);
  if (call.tool === "call_skill") return callSkillStep(short, skill, call.params, res, firstCall);
  return null;
}

/**
 * Видимый шаг хода: старший по приоритету, при равенстве — последний.
 *
 * Особый случай — `meal.4.2`: отрицательная оценка блюда в том же ходу, где его
 * заменили, — это уже «не люблю», а не «не сегодня».
 */
export function pickStep(steps: Step[], calls: SkillCall[]): Step | null {
  let best: Step | null = null;
  for (const s of steps) {
    if (!best || s.rank >= best.rank) best = s;
  }
  if (best?.code === "meal.4.1") {
    const dislike = calls.some(
      (c) =>
        c.tool === "skill_state" &&
        c.params.op === "rate" &&
        c.params.skill === "meal-plan" &&
        typeof c.params.score === "number" &&
        c.params.score < 0,
    );
    if (dislike) return { ...best, code: "meal.4.2" };
  }
  return best;
}

/** Последний ход и когда скиллы трогали в последний раз — для `reentry`. */
export type TurnMemory = {
  last: { skill: string | null; at: number } | null;
  skills: Record<string, number>;
  called: Record<string, boolean>;
};

/** Сколько можно молчать о скилле, чтобы следующий разговор о нём не считался возвратом. */
export const REENTRY_GAP_MS = 60 * 60_000;

/**
 * Вернулся ли человек к скиллу.
 *
 * Да — если прошлый ход был про другой скилл или вне скиллов, либо к этому
 * скиллу не обращались больше часа. Первый в жизни ход скилла — тоже вход,
 * а не возврат: возвращаться было не к чему.
 */
export function isReentry(memory: TurnMemory, skill: string, now: number): boolean {
  const lastAt = memory.skills[skill];
  if (lastAt === undefined) return false;
  if (now - lastAt > REENTRY_GAP_MS) return true;
  return memory.last !== null && memory.last.skill !== skill;
}
