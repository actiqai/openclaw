/**
 * Подстановка из профиля перед вызовом скилла (actiq CLT-075, гейтвей — GTW-080).
 *
 * Контракт `tool.json`:
 *  - у параметра `from` — где на инстансе лежит его значение (`person.city`,
 *    `profile.team`). Модель его не передала — код подставит из стора;
 *  - у действия `state: true` — к вызову прикладывается состояние скилла: профиль,
 *    факты, оценки, недавнее. Раньше модель переносила это из `call_payload`;
 *  - на пустое обязательное поле гейтвей отвечает `errors[].question` и `from`.
 *    Модель задаёт вопрос, человек отвечает, модель зовёт снова с ответом — и
 *    ответ записывается в `from`: второй раз вопрос не прозвучит.
 *
 * Записывается только ответ на заданный вопрос. Человек, сказавший «найди кафе
 * в Казани» без всякого вопроса, мог быть там проездом — делать Казань его домом
 * нельзя.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSpec } from "./typed-tools.js";
import { loadSchema, readSource, stateParams, writeSource } from "../skill-state/call-state.js";
import { writeJsonAtomic } from "../skill-state/store.js";

/** Сколько живёт заданный вопрос: ответ на него приходит в том же разговоре. */
const ASK_TTL_MS = 24 * 60 * 60_000;

export type FillPaths = { stateDir: string; skillsDir: string; workspaceDir: string };

type Ask = { skill: string; field: string; from: string; at: number };

function asksFile(paths: FillPaths): string {
  return join(paths.stateDir, "skill-asks.json");
}

function loadAsks(paths: FillPaths, now: number): Ask[] {
  const file = asksFile(paths);
  if (!existsSync(file)) return [];

  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));

    return Array.isArray(raw)
      ? (raw as Ask[]).filter((a) => a && typeof a.at === "number" && now - a.at < ASK_TTL_MS)
      : [];
  } catch {
    return [];
  }
}

function empty(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

/**
 * Готовит параметры вызова: подставляет `from`, прикладывает состояние, записывает
 * ответ на заданный ранее вопрос. Возвращает новые параметры — исходные не трогает.
 */
export function prepareParams(
  paths: FillPaths,
  spec: ToolSpec | undefined,
  skill: string,
  action: string,
  params: Record<string, unknown>,
  now: Date = new Date(),
): Record<string, unknown> {
  const declared = spec?.actions?.[action];
  if (!declared) return params;

  const out: Record<string, unknown> = { ...params };
  const asks = loadAsks(paths, now.getTime());
  let answered = false;

  for (const [name, param] of Object.entries(declared.params ?? {})) {
    if (!param.from) continue;

    if (empty(out[name])) {
      const value = readSource(paths.stateDir, skill, param.from);
      if (!empty(value)) out[name] = value;

      continue;
    }

    // Значение пришло от модели — если это ответ на наш вопрос, запомним.
    const ask = asks.find((a) => a.skill === skill && a.field === name && a.from === param.from);
    if (ask && writeSource(paths.stateDir, paths.workspaceDir, skill, param.from, out[name])) {
      asks.splice(asks.indexOf(ask), 1);
      answered = true;
    }
  }

  if (answered) writeJsonAtomic(asksFile(paths), asks);

  if (declared.state) {
    const schema = loadSchema(paths.skillsDir, skill);
    // Состояние собирает код, а не модель: что бы она ни прислала под этими
    // именами, правда — в сторе.
    if (schema) Object.assign(out, stateParams(paths.stateDir, schema, skill, now));
  }

  return out;
}

/**
 * Запоминает вопросы, которые гейтвей велел задать, — по полям с источником.
 * Ответ на них `prepareParams` запишет в профиль.
 */
export function rememberAsks(
  paths: FillPaths,
  skill: string,
  response: unknown,
  now: Date = new Date(),
): void {
  if (!response || typeof response !== "object") return;

  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return;

  const fresh = errors
    .filter(
      (e): e is { field: string; from: string } =>
        !!e &&
        typeof e === "object" &&
        (e as { reason?: unknown }).reason === "required" &&
        typeof (e as { field?: unknown }).field === "string" &&
        typeof (e as { from?: unknown }).from === "string" &&
        (e as { from: string }).from !== "",
    )
    .map((e) => ({ skill, field: e.field, from: e.from, at: now.getTime() }));

  if (fresh.length === 0) return;

  const kept = loadAsks(paths, now.getTime()).filter(
    (a) => !fresh.some((f) => f.skill === a.skill && f.field === a.field),
  );

  writeJsonAtomic(asksFile(paths), [...kept, ...fresh]);
}
