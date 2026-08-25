import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callPayload,
  mergeProfile,
  readyToCall,
  splitPatch,
  stageOf,
  validateKnownFields,
  withShared,
  type FieldError,
  type Profile,
  type SkillSchema,
} from "./schema.js";
import {
  activeFacts,
  appendHistory,
  ensureRoot,
  loadFacts,
  loadOverrides,
  loadPending,
  loadRatings,
  logWeight,
  missedStreak,
  nextFactId,
  overdueDays,
  preferences,
  rateItem,
  recentItems,
  readProfile,
  readShared,
  recentHistory,
  localDate,
  saveFacts,
  saveOverrides,
  saveRatings,
  savePending,
  todayISO,
  validateFact,
  writeProfile,
  writeShared,
  weekAhead,
  type Fact,
  type Override,
  type Pending,
} from "./store.js";

const DEFAULT_STATE_DIR = "/home/openclaw/.openclaw/actiq";
const DEFAULT_SKILLS_DIR = "/opt/actiq-skills";

/** Сколько последних событий уезжает в гейтвей вместе с вызовом. */
const RECENT_EVENTS = 5;

/**
 * Через сколько дней просрочки ожидание считается несданным отчётом.
 *
 * Не ноль: человек может ответить утром следующего дня, и записывать это пропуском
 * значит врать статистике, по которой бот потом предлагает снизить нагрузку.
 */
const MISS_AFTER_DAYS = 2;

/**
 * Сколько дней предложенное считается свежим.
 *
 * Неделя: человек может любить блюдо и всё равно устать от него на четвёртый день,
 * а «надоело одно и то же» — главная причина, по которой перестают пользоваться
 * планом питания.
 */
const RECENT_DAYS = 7;

/** Сколько событий читается, чтобы собрать недавно предложенное. */
const HISTORY_WINDOW = 40;

// details — часть контракта тула в pi-agent-core: агент кладёт туда структурный
// результат рядом с текстом. Нам нечего добавить к JSON, но поле обязательно.
type Reply = { content: Array<{ type: "text"; text: string }>; details: null };

/** Расстояние между двумя датами YYYY-MM-DD в днях. */
function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function reply(payload: unknown): Reply {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: null,
  };
}

function fail(message: string, errors?: FieldError[]): Reply {
  return reply({ status: "error", message, ...(errors ? { errors } : {}) });
}

const skillStatePlugin = {
  id: "skill-state",
  name: "Skill State",
  description: "Keeps each skill's profile, facts and progress on the user's own instance",

  register(api: OpenClawPluginApi) {
    const stateDir = (api.pluginConfig?.stateDir as string) || DEFAULT_STATE_DIR;
    const skillsDir = (api.pluginConfig?.skillsDir as string) || DEFAULT_SKILLS_DIR;

    /** Схема приезжает с гейтвея рядом со SKILL.md — тот же файл проверяет вызов там. */
    function loadSchema(skill: string): SkillSchema | null {
      const path = join(skillsDir, skill, "schema.json");
      if (!existsSync(path)) return null;

      try {
        return JSON.parse(readFileSync(path, "utf8")) as SkillSchema;
      } catch {
        return null;
      }
    }

    /** Общие блоки, объявленные схемой. */
    function sharedBlocks(schema: SkillSchema): Record<string, Record<string, unknown>> {
      const blocks: Record<string, Record<string, unknown>> = {};

      for (const name of schema.shared ?? []) {
        blocks[name] = readShared(stateDir, name);
      }

      return blocks;
    }

    function snapshot(schema: SkillSchema, skill: string): Record<string, unknown> {
      const today = todayISO();
      const facts = activeFacts(loadFacts(stateDir, skill, today), today);
      const blocks = sharedBlocks(schema);

      // Общие поля подмешиваются в профиль: рост, рассказанный скиллу питания,
      // обязан считаться известным и тренировкам, иначе человек рассказывает
      // о себе дважды и делает вывод, что его не слушают.
      const profile = withShared(schema, readProfile(stateDir, skill), blocks);

      const { stage, missing, next_question } = stageOf(schema, profile);
      const ready = readyToCall(schema, profile);

      const now = new Date();

      // Расписание на неделю вперёд с учётом переносов. Считает код: модель
      // ошибается в датах, и «перенеси на четверг» превращается в прошлый четверг —
      // человек получает напоминание не в тот день или не получает вовсе.
      const localToday = localDate(now, profile.tz as string | undefined);
      const week = Array.isArray(profile.days)
        ? weekAhead(
            profile.days as string[],
            profile.time as string | null,
            loadOverrides(stateDir, skill, localToday),
            localToday,
          )
        : [];

      const ratings = loadRatings(stateDir, skill);
      const { liked, disliked } = preferences(ratings);
      const window = recentHistory(stateDir, skill, HISTORY_WINDOW) as Array<
        Record<string, unknown>
      >;

      const pending = loadPending(stateDir, skill)
        .map((item) => ({ ...item, overdue: overdueDays(item, now) >= 0 }))
        .sort((a, b) => (a.due < b.due ? -1 : 1));
      const events = recentHistory(stateDir, skill, RECENT_EVENTS) as Array<
        Record<string, unknown>
      >;

      return {
        status: "ok",
        skill,
        stage,
        next_question,
        missing,
        profile,
        shared: blocks,
        facts,
        // Что бот обещал спросить и не спросил. Первое, на что смотреть при любом
        // пробуждении: человек прислал «привет», а за ним висит несданный отчёт
        // за среду — спрашивать надо про среду.
        pending,
        liked,
        disliked,
        // Предложенное на этой неделе — чтобы не приходило четвёртый раз подряд.
        recent_items: recentItems(window, RECENT_DAYS, localToday),
        today: localToday,
        week,
        missed_streak: missedStreak(events),
        ready,
        // Запрос собирает код, а не модель: иначе «строгая структура» держится
        // на том, что модель ничего не забыла и не дописала лишнего.
        call_payload: ready
          ? {
              action: schema.call.action,
              params: {
                profile: callPayload(schema, profile),
                facts,
                recent: events,
                liked,
                avoid: disliked,
                recent_items: recentItems(window, RECENT_DAYS, localToday),
              },
            }
          : null,
      };
    }

    api.registerTool({
      label: "Skill State",
      name: "skill_state",
      description:
        "Reads and updates what this assistant knows about the user for one skill. " +
        'ALWAYS call op="get" before answering anything about a skill with a profile ' +
        "(workout-plan, meal-plan…): it returns the current stage of the conversation, " +
        "the single next question to ask, and everything already known — never ask again " +
        'for something the profile already holds. Record answers with op="patch" as you ' +
        "get them, one at a time. Temporary things (an injury, a trip, a busy month) go in " +
        'with op="fact_add" and MUST carry an end date: ask how long it lasts. ' +
        'When "ready" is true, pass "call_payload" straight to call_skill.',
      parameters: Type.Object({
        op: Type.Union(
          [
            Type.Literal("get"),
            Type.Literal("patch"),
            Type.Literal("fact_add"),
            Type.Literal("fact_close"),
            Type.Literal("history_append"),
            Type.Literal("expect"),
            Type.Literal("reschedule"),
            Type.Literal("rate"),
            Type.Literal("due_check"),
            Type.Literal("expect_cancel"),
          ],
          { description: "What to do with the skill's stored state" },
        ),
        skill: Type.String({ description: 'Skill name, e.g. "workout-plan"' }),
        patch: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "op=patch: profile fields to store. Lists are replaced whole, not appended",
          }),
        ),
        fact: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "op=fact_add: {text, kind: injury|preference|constraint|life_event, since, until, affects[]}. " +
              "An injury or life event needs `until` — ask the user how long before recording it",
          }),
        ),
        fact_id: Type.Optional(
          Type.String({ description: "op=fact_close: which fact ended early" }),
        ),
        date: Type.Optional(
          Type.String({ description: "op=reschedule: the day being moved or skipped, YYYY-MM-DD" }),
        ),
        moved_to: Type.Optional(
          Type.String({
            description:
              "op=reschedule: the new day, YYYY-MM-DD. Omit to skip that day entirely. " +
              "This affects that one day only — the usual schedule stays as it is",
          }),
        ),
        time: Type.Optional(
          Type.String({ description: "op=reschedule: new time for the moved day, HH:MM" }),
        ),
        reason: Type.Optional(
          Type.String({ description: "op=reschedule: why, in the user's own words" }),
        ),
        item: Type.Optional(
          Type.String({ description: 'op=rate: what is being rated, e.g. "овсянка с бананом"' }),
        ),
        score: Type.Optional(
          Type.Number({
            description:
              "op=rate: -2 never again, -1 did not like it, 1 liked it, 2 asks for more. " +
              "Ratings average over time, so one bad day does not ban a favourite",
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: 'op=rate: what it was about, e.g. ["рыба", "долго готовить"]',
          }),
        ),
        due: Type.Optional(
          Type.String({
            description: "op=expect: ISO timestamp by which the user is expected to answer",
          }),
        ),
        kind: Type.Optional(
          Type.String({ description: 'op=expect: what is expected, default "report"' }),
        ),
        about: Type.Optional(
          Type.String({
            description:
              "op=expect: the date of the session this report is about, YYYY-MM-DD. " +
              "Take it from `week` — never «среда», always the concrete date",
          }),
        ),
        closes: Type.Optional(
          Type.String({ description: "op=history_append: which pending item this answers" }),
        ),
        pending_id: Type.Optional(
          Type.String({
            description: "op=expect_cancel: which expectation to drop; omit to drop all",
          }),
        ),
        event: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              'op=history_append: what happened, e.g. {done: true, hard: "ok", skipped: []}',
          }),
        ),
      }),

      execute: async (_toolCallId: string, args: Record<string, unknown>): Promise<Reply> => {
        const op = args.op as string;
        const skill = args.skill as string;

        const schema = loadSchema(skill);
        if (!schema) {
          return fail(
            `Skill "${skill}" does not keep a profile. Answer from the conversation, or call it directly.`,
          );
        }

        ensureRoot(stateDir);
        const today = todayISO();

        switch (op) {
          case "get":
            return reply(snapshot(schema, skill));

          case "patch": {
            const patch = (args.patch as Profile) ?? {};
            const errors = validateKnownFields(schema, patch);
            if (errors.length > 0) {
              // Отказ с именем поля и причиной: модель должна уметь исправиться сама,
              // а «плохой запрос» не даёт ей для этого ничего.
              return fail("some fields do not match the skill schema", errors);
            }

            // Поле само знает, где живёт: рост уезжает в общий блок, цель —
            // в профиль скилла. Модели про это различие знать не нужно, а значит
            // и ошибиться в нём она не может.
            const { own, shared } = splitPatch(schema, patch);

            if (Object.keys(own).length > 0) {
              writeProfile(stateDir, skill, mergeProfile(readProfile(stateDir, skill), own));
            }

            for (const [name, value] of Object.entries(shared)) {
              writeShared(stateDir, name, { ...readShared(stateDir, name), ...value });
            }

            return reply(snapshot(schema, skill));
          }

          case "fact_add": {
            const incoming = {
              since: today,
              source: "user",
              ...((args.fact as Partial<Fact>) ?? {}),
            };

            // Модель считает «сегодня» по своей таймзоне, инстанс — по UTC, и вечером
            // в Москве это разные дни. Факт, начинающийся «завтра» из-за этого сдвига,
            // молча не применился бы к сегодняшнему плану — а человек только что
            // рассказал про травму.
            if (incoming.since && incoming.since > today && daysApart(incoming.since, today) <= 1) {
              incoming.since = today;
            }

            const problem = validateFact(incoming);
            if (problem) return fail(problem);

            const store = loadFacts(stateDir, skill, today);
            const fact = { ...incoming, id: incoming.id ?? nextFactId(store) } as Fact;

            store.facts.push(fact);
            saveFacts(stateDir, skill, store);

            return reply({ ...snapshot(schema, skill), recorded: fact });
          }

          case "fact_close": {
            const id = args.fact_id as string;
            const store = loadFacts(stateDir, skill, today);
            const fact = store.facts.find((f) => f.id === id);

            if (!fact) return fail(`no active fact with id "${id}"`);

            store.facts = store.facts.filter((f) => f.id !== id);
            store.archived.push({ ...fact, until: today });
            saveFacts(stateDir, skill, store);

            return reply({ ...snapshot(schema, skill), closed: id });
          }

          case "expect": {
            const due = (args.due as string) ?? "";
            if (!due || Number.isNaN(Date.parse(due))) {
              return fail("expect needs `due` as an ISO timestamp — when the answer is expected");
            }

            const kind = (args.kind as string) || "report";

            const about = (args.about as string) || "";
            if (kind === "report" && !/^\d{4}-\d{2}-\d{2}$/.test(about)) {
              // Ожидание без даты занятия делает отчёт неприкреплённым: «как прошло»
              // без «что именно» некуда записать и нечем потом объяснить.
              return fail("expect needs `about` as the session date, YYYY-MM-DD");
            }

            const items = loadPending(stateDir, skill);

            // Просроченное ожидание того же рода, на которое так и не ответили,
            // закрывается пропуском. Иначе висящие обещания копятся, и бот будет
            // спрашивать про тренировку двухнедельной давности вместо вчерашней.
            const now = new Date();
            const stale = items.filter(
              (i) => i.kind === kind && overdueDays(i, now) >= MISS_AFTER_DAYS,
            );
            for (const item of stale) {
              appendHistory(stateDir, skill, {
                missed: true,
                about: item.about,
                expected: item.due,
              });
            }

            const kept = items.filter((i) => !stale.includes(i));
            const item: Pending = {
              id: `p${Date.now()}`,
              kind,
              about: about || undefined,
              due,
              created: now.toISOString(),
            };

            savePending(stateDir, skill, [...kept, item]);

            return reply({ ...snapshot(schema, skill), expecting: item });
          }

          case "history_append": {
            const event = (args.event as Record<string, unknown>) ?? {};

            const items = loadPending(stateDir, skill);
            const closing = args.closes
              ? items.find((i) => i.id === args.closes)
              : items.find((i) => i.kind === "report");

            // Событие помечается днём занятия, а не моментом сообщения. Человек
            // отвечает утром следующего дня — и отчёт лёг бы к несуществующей
            // тренировке, а вчерашняя осталась бы пропущенной.
            const forDate =
              (event.for_date as string) ??
              (closing?.about && /^\d{4}-\d{2}-\d{2}$/.test(closing.about) ? closing.about : today);

            appendHistory(stateDir, skill, { ...event, for_date: forDate });

            // Отчёт закрывает ожидание: без этого бот, которому только что всё
            // рассказали, через час спросит то же самое ещё раз.
            const closeId = closing?.id;
            if (closeId) {
              savePending(
                stateDir,
                skill,
                items.filter((i) => i.id !== closeId),
              );
            }

            // Вес из отчёта — это общий факт о теле, а не запись в дневнике
            // тренировок: питание считает по нему калории.
            if (typeof event.weight_kg === "number") {
              writeShared(
                stateDir,
                "body",
                logWeight(readShared(stateDir, "body"), event.weight_kg, today),
              );
            }

            return reply({ ...snapshot(schema, skill), closed: closeId ?? null });
          }

          case "reschedule": {
            const date = args.date as string;
            if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              return fail("reschedule needs `date` as YYYY-MM-DD — which day is moving");
            }

            const movedTo = (args.moved_to as string) ?? null;
            if (movedTo && !/^\d{4}-\d{2}-\d{2}$/.test(movedTo)) {
              return fail("`moved_to` must be YYYY-MM-DD, or omit it to skip the day entirely");
            }

            const profile = withShared(schema, readProfile(stateDir, skill), sharedBlocks(schema));
            const localToday = localDate(new Date(), profile.tz as string | undefined);

            if ((movedTo ?? date) < localToday) {
              // Перенос в прошлое — почти всегда промах модели в арифметике дат,
              // а не намерение человека. Молча приняв его, мы получим расписание,
              // которое ничего не меняет, и необъяснимое отсутствие напоминания.
              return fail(`${movedTo ?? date} is in the past — today is ${localToday}`);
            }

            const items = loadOverrides(stateDir, skill, localToday).filter((o) => o.date !== date);
            const item: Override = {
              date,
              moved_to: movedTo,
              time: (args.time as string) ?? null,
              reason: (args.reason as string) || undefined,
            };

            saveOverrides(stateDir, skill, [...items, item]);

            return reply({ ...snapshot(schema, skill), rescheduled: item });
          }

          case "rate": {
            const item = (args.item as string) ?? "";
            if (!item.trim()) {
              return fail("rate needs `item` — what exactly is being rated");
            }

            const score = args.score;
            if (typeof score !== "number") {
              return fail("rate needs `score` from -2 (never again) to 2 (more of this)");
            }

            saveRatings(
              stateDir,
              skill,
              rateItem(
                loadRatings(stateDir, skill),
                item,
                score,
                today,
                args.tags as string[] | undefined,
              ),
            );

            return reply(snapshot(schema, skill));
          }

          case "due_check": {
            // Отдельная операция, а не «посмотри в pending и реши сам»: этот вызов
            // приходит из молчаливой крон-задачи, и цена ошибки несимметрична.
            // Промолчать, когда стоило спросить, — упущенный отчёт; написать, когда
            // человек уже всё рассказал, — бот, который не слушает. Второе люди
            // прощают гораздо хуже, поэтому решение принимает код, а не модель.
            const now = new Date();
            const due = loadPending(stateDir, skill)
              .filter((item) => overdueDays(item, now) >= 0)
              .sort((a, b) => (a.due < b.due ? -1 : 1));

            if (due.length === 0) {
              return reply({
                status: "ok",
                skill,
                ask: false,
                reason: "nothing is owed right now",
              });
            }

            const events = recentHistory(stateDir, skill, RECENT_EVENTS) as Array<
              Record<string, unknown>
            >;

            return reply({
              status: "ok",
              skill,
              ask: true,
              pending: due[0],
              // Три пропуска подряд — это разговор не про сегодняшнюю тренировку,
              // а про то, что план не подошёл. Спрашивать «как прошло?» четвёртый
              // раз бессмысленно и назойливо.
              missed_streak: missedStreak(events),
            });
          }

          case "expect_cancel": {
            const items = loadPending(stateDir, skill);
            const id = args.pending_id as string;

            savePending(stateDir, skill, id ? items.filter((i) => i.id !== id) : []);

            return reply(snapshot(schema, skill));
          }

          default:
            return fail(`unknown op "${op}"`);
        }
      },
    });

    api.logger.info(`Skill state registered, store: ${stateDir}`);
  },
};

export default skillStatePlugin;
