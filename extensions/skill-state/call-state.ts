/**
 * Состояние скилла, которое уезжает с вызовом, и источники параметров
 * (actiq CLT-075, гейтвей — GTW-080).
 *
 * Раньше модель брала `call_payload` из `skill_state get` и переносила его в
 * `call_skill` руками: забыла — гейтвей получал вызов без профиля, дописала
 * лишнего — отказ. Теперь состояние к вызову прикладывает код (`skill-proxy`),
 * а модель передаёт только то, что сказал человек.
 *
 * Здесь же — чтение и запись полей по пути из `tool.json`: `person.city` — общий
 * блок, `profile.team` — профиль самого скилла. Модуль общий для `skill-state` и
 * `skill-proxy`: правило «куда пишется общий блок и что за ним следует» должно
 * жить в одном месте, иначе `USER.md` однажды отстанет от стора.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RENDERED_BLOCKS, writeUserMd } from "./profile-view.js";
import { callPayload, coerceToSchema, withShared, type SkillSchema } from "./schema.js";
import {
  activeFacts,
  expiredFacts,
  loadFacts,
  loadRatings,
  localDate,
  preferences,
  readProfile,
  readShared,
  recentHistory,
  recentItems,
  todayISO,
  writeProfile,
  writeShared,
} from "./store.js";

export const DEFAULT_STATE_DIR = "/home/openclaw/.openclaw/actiq";
export const DEFAULT_SKILLS_DIR = "/opt/actiq-skills";

/** Сколько последних событий уезжает в гейтвей вместе с вызовом. */
export const RECENT_EVENTS = 5;

/**
 * Сколько дней предложенное считается свежим.
 *
 * Неделя: человек может любить блюдо и всё равно устать от него на четвёртый день,
 * а «надоело одно и то же» — главная причина, по которой перестают пользоваться
 * планом питания.
 */
export const RECENT_DAYS = 7;

/** Сколько событий читается, чтобы собрать недавно предложенное. */
export const HISTORY_WINDOW = 40;

/** Схема приезжает с гейтвея рядом со SKILL.md — тот же файл проверяет вызов там. */
export function loadSchema(skillsDir: string, skill: string): SkillSchema | null {
  const path = join(skillsDir, skill, "schema.json");
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as SkillSchema;
  } catch {
    return null;
  }
}

/** Общие блоки, объявленные схемой. */
export function sharedBlocks(
  stateDir: string,
  schema: SkillSchema,
): Record<string, Record<string, unknown>> {
  const blocks: Record<string, Record<string, unknown>> = {};

  for (const name of schema.shared ?? []) {
    blocks[name] = readShared(stateDir, name);
  }

  return blocks;
}

/** Профиль скилла с общими полями, приведённый к схеме. */
export function fullProfile(
  stateDir: string,
  schema: SkillSchema,
  skill: string,
): Record<string, unknown> {
  return coerceToSchema(
    schema,
    withShared(schema, readProfile(stateDir, skill), sharedBlocks(stateDir, schema)),
  );
}

/**
 * Что прикладывается к вызову действия со `state: true` — ровно то, что раньше
 * было `call_payload.params`. Ключи совпадают с `StateKeys` гейтвея.
 */
export function stateParams(
  stateDir: string,
  schema: SkillSchema,
  skill: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const today = todayISO(now);
  const factStore = loadFacts(stateDir, skill, today);
  const profile = fullProfile(stateDir, schema, skill);
  const localToday = localDate(now, profile.tz as string | undefined);
  const { liked, disliked } = preferences(loadRatings(stateDir, skill));
  const window = recentHistory(stateDir, skill, HISTORY_WINDOW) as Array<Record<string, unknown>>;

  return {
    profile: callPayload(schema, profile),
    facts: activeFacts(factStore, today),
    // Наверх едут и истёкшие документы: паспорт, истёкший вчера, — худший
    // случай, и гейтвей должен о нём знать.
    expired: expiredFacts(factStore, today).filter((f) => f.kind === "document"),
    recent: recentHistory(stateDir, skill, RECENT_EVENTS),
    liked,
    avoid: disliked,
    recent_items: recentItems(window, RECENT_DAYS, localToday),
  };
}

/** Путь `person.city` → блок и поле; чужой формат — null. */
export function parseSource(from: string): { block: string; field: string } | null {
  const match = /^(person|body|profile)\.([a-z][a-z0-9_]{0,40})$/.exec(from);

  return match ? { block: match[1], field: match[2] } : null;
}

/** Значение по пути из `tool.json`: общий блок или профиль самого скилла. */
export function readSource(stateDir: string, skill: string, from: string): unknown {
  const source = parseSource(from);
  if (!source) return undefined;

  const store =
    source.block === "profile" ? readProfile(stateDir, skill) : readShared(stateDir, source.block);

  return store[source.field];
}

/**
 * Единственная точка записи общего блока: `USER.md` обязан следовать за стором при
 * каждой записи, а два места записи означают, что однажды добавится третье и
 * представление тихо отстанет от правды.
 */
export function saveSharedBlock(
  stateDir: string,
  workspaceDir: string,
  name: string,
  value: Record<string, unknown>,
): void {
  writeShared(stateDir, name, value);

  if (!RENDERED_BLOCKS.includes(name as (typeof RENDERED_BLOCKS)[number])) return;

  writeUserMd(workspaceDir, {
    person: readShared(stateDir, "person"),
    body: readShared(stateDir, "body"),
  });
}

/** Записывает значение по пути из `tool.json`. */
export function writeSource(
  stateDir: string,
  workspaceDir: string,
  skill: string,
  from: string,
  value: unknown,
): boolean {
  const source = parseSource(from);
  if (!source || value === undefined || value === null || value === "") return false;

  if (source.block === "profile") {
    writeProfile(stateDir, skill, { ...readProfile(stateDir, skill), [source.field]: value });

    return true;
  }

  saveSharedBlock(stateDir, workspaceDir, source.block, {
    ...readShared(stateDir, source.block),
    [source.field]: value,
  });

  return true;
}
