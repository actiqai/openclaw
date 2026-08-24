import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callPayload,
  mergeProfile,
  readyToCall,
  stageOf,
  validateKnownFields,
  type FieldError,
  type Profile,
  type SkillSchema,
} from "./schema.js";
import {
  activeFacts,
  appendHistory,
  ensureRoot,
  loadFacts,
  nextFactId,
  readProfile,
  readShared,
  recentHistory,
  saveFacts,
  todayISO,
  validateFact,
  writeProfile,
  writeShared,
  type Fact,
} from "./store.js";

const DEFAULT_STATE_DIR = "/home/openclaw/.openclaw/actiq";
const DEFAULT_SKILLS_DIR = "/opt/actiq-skills";

/** Сколько последних событий уезжает в гейтвей вместе с вызовом. */
const RECENT_EVENTS = 5;

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

    function snapshot(schema: SkillSchema, skill: string): Record<string, unknown> {
      const today = todayISO();
      const profile = readProfile(stateDir, skill);
      const facts = activeFacts(loadFacts(stateDir, skill, today), today);
      const shared: Record<string, unknown> = {};

      for (const name of schema.shared ?? []) {
        shared[name] = readShared(stateDir, name);
      }

      const { stage, missing, next_question } = stageOf(schema, profile);
      const ready = readyToCall(schema, profile);

      return {
        status: "ok",
        skill,
        stage,
        next_question,
        missing,
        profile,
        shared,
        facts,
        ready,
        // Запрос собирает код, а не модель: иначе «строгая структура» держится
        // на том, что модель ничего не забыла и не дописала лишнего.
        call_payload: ready
          ? {
              action: schema.call.action,
              params: {
                profile: callPayload(schema, profile),
                facts,
                recent: recentHistory(stateDir, skill, RECENT_EVENTS),
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
        shared: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: 'op=patch: shared blocks to store, e.g. {"body": {"height_cm": 180}}',
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

            writeProfile(stateDir, skill, mergeProfile(readProfile(stateDir, skill), patch));

            for (const [name, value] of Object.entries((args.shared as Profile) ?? {})) {
              if (!(schema.shared ?? []).includes(name)) {
                return fail(`this skill does not use the shared block "${name}"`);
              }
              writeShared(stateDir, name, {
                ...readShared(stateDir, name),
                ...(value as Record<string, unknown>),
              });
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

          case "history_append": {
            appendHistory(stateDir, skill, (args.event as Record<string, unknown>) ?? {});

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
