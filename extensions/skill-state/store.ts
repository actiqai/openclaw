/**
 * Хранилище того, что бот знает о человеке.
 *
 * Лежит внутри `~/.openclaw` — единственного каталога, который уезжает в бэкап
 * (том `openclaw-state`). Смонтированный `workspace` пуст на всех инстансах, и
 * данные, положенные туда, умирают при первом самообновлении молча.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = "1";

/** Сколько истории храним. Бот читает её, чтобы собрать контекст; без предела
 * сборка контекста со временем начнёт раздуваться и тормозить. */
const HISTORY_MAX_FILES = 200;
const HISTORY_MAX_DAYS = 90;

export type Fact = {
  id: string;
  text: string;
  kind: "injury" | "preference" | "constraint" | "life_event";
  since: string;
  until?: string | null;
  affects?: string[];
  source?: string;
};

export type FactStore = { facts: Fact[]; archived: Fact[] };

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function skillDir(root: string, skill: string): string {
  return join(root, "skills", skill);
}

/**
 * Атомарная запись: временный файл рядом и переименование.
 *
 * Оборванная запись оставила бы невалидный JSON, и при следующем запуске бот решил
 * бы, что профиля нет вообще. Для человека потеря данных выглядит как «бот меня
 * забыл» — худший из возможных отказов для ассистента с памятью.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Чтение JSON. Битый файл не затирается, а откладывается в сторону: это
 * единственный экземпляр данных пользователя, и переписать его пустым значит
 * потерять всё, что человек рассказывал.
 */
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    try {
      renameSync(path, `${path}.corrupt.${Date.now()}`);
    } catch {
      // Не смогли отложить — тем более не будем перезаписывать.
    }
    return fallback;
  }
}

export function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true });

  const marker = join(root, ".schema-version");
  if (!existsSync(marker)) {
    writeFileSync(marker, `${SCHEMA_VERSION}\n`, "utf8");
  }
}

export function readProfile(root: string, skill: string): Record<string, unknown> {
  return readJson(join(skillDir(root, skill), "profile.json"), {} as Record<string, unknown>);
}

export function writeProfile(root: string, skill: string, profile: Record<string, unknown>): void {
  writeJsonAtomic(join(skillDir(root, skill), "profile.json"), profile);
}

/**
 * Общие сведения о теле — рост, вес, возраст. Нужны и питанию, и тренировкам.
 *
 * Отдельный файл, а не «прочитай профиль соседнего скилла»: скилл может быть
 * не заведён вовсе, и тогда инструкция читать его файл — это молчаливая поломка.
 */
export function readShared(root: string, name: string): Record<string, unknown> {
  return readJson(join(root, "shared", `${name}.json`), {} as Record<string, unknown>);
}

export function writeShared(root: string, name: string, value: Record<string, unknown>): void {
  writeJsonAtomic(join(root, "shared", `${name}.json`), value);
}

/** Факты, у которых обязан быть срок: они временны по своей природе. */
const DATED_KINDS = new Set(["injury", "life_event"]);

export function validateFact(fact: Partial<Fact>): string | null {
  if (!fact.text || fact.text.trim() === "") return "a fact without text says nothing";

  if (!fact.kind || !["injury", "preference", "constraint", "life_event"].includes(fact.kind)) {
    return "kind must be one of: injury, preference, constraint, life_event";
  }

  if (!fact.since || !/^\d{4}-\d{2}-\d{2}$/.test(fact.since)) return "since must be YYYY-MM-DD";

  if (!fact.until) {
    if (DATED_KINDS.has(fact.kind)) {
      return `a ${fact.kind} needs an end date — ask how long it lasts instead of making it permanent`;
    }
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.until)) return "until must be YYYY-MM-DD";
  if (fact.until < fact.since) return "it ends before it starts";

  return null;
}

/**
 * Читает факты и убирает просроченные из активных.
 *
 * Просроченное не удаляется, а уезжает в `archived`: «нога зажила?» — осмысленный
 * вопрос, а удалённый факт задать его не позволяет.
 */
export function loadFacts(root: string, skill: string, today: string): FactStore {
  const path = join(skillDir(root, skill), "facts.json");
  const store = readJson<FactStore>(path, { facts: [], archived: [] });

  store.facts ??= [];
  store.archived ??= [];

  const expired = store.facts.filter((f) => f.until && f.until < today);
  if (expired.length === 0) return store;

  const fresh: FactStore = {
    facts: store.facts.filter((f) => !(f.until && f.until < today)),
    archived: [...store.archived, ...expired],
  };

  writeJsonAtomic(path, fresh);

  return fresh;
}

export function saveFacts(root: string, skill: string, store: FactStore): void {
  writeJsonAtomic(join(skillDir(root, skill), "facts.json"), store);
}

/** Активные на сегодня: будущие ещё не начались, просроченные уже отфильтрованы. */
export function activeFacts(store: FactStore, today: string): Fact[] {
  return store.facts
    .filter((f) => !f.since || f.since <= today)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function nextFactId(store: FactStore): string {
  const used = [...store.facts, ...store.archived]
    .map((f) => Number.parseInt(String(f.id).replace(/^f/, ""), 10))
    .filter((n) => Number.isFinite(n));

  return `f${(used.length === 0 ? 0 : Math.max(...used)) + 1}`;
}

/**
 * История — файл на событие, а не один растущий JSON.
 *
 * Крон и живой диалог пишут одновременно; read-modify-write общего файла теряет
 * записи, причём незаметно — пропадает ровно то, что человек только что рассказал.
 */
export function appendHistory(
  root: string,
  skill: string,
  event: unknown,
  now: Date = new Date(),
): string {
  const dir = join(skillDir(root, skill), "history");
  mkdirSync(dir, { recursive: true });

  // Имя с точностью до миллисекунды всё равно совпадает, когда события пишутся
  // подряд — например, когда три просроченных ожидания разом закрываются пропусками.
  // Совпадение имени означает молча потерянную запись, поэтому занятое имя
  // разводится суффиксом, а не перезаписывается.
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let path = join(dir, `${stamp}.json`);
  for (let n = 1; existsSync(path); n += 1) {
    path = join(dir, `${stamp}-${n}.json`);
  }

  writeJsonAtomic(path, { at: now.toISOString(), ...(event as Record<string, unknown>) });
  pruneHistory(dir, now);

  return path;
}

function pruneHistory(dir: string, now: Date): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const cutoff = new Date(now.getTime() - HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[:.]/g, "-");

  const tooOld = files.filter((f) => f < `${cutoff}.json`);
  const overflow = files.length - HISTORY_MAX_FILES;
  const doomed = new Set([...tooOld, ...(overflow > 0 ? files.slice(0, overflow) : [])]);

  for (const file of doomed) {
    try {
      rmSync(join(dir, file));
    } catch {
      // Ретенция — уборка, а не операция, ради которой стоит ронять запись.
    }
  }
}

export function recentHistory(root: string, skill: string, limit: number): unknown[] {
  const dir = join(skillDir(root, skill), "history");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map((f) => readJson<unknown>(join(dir, f), null))
    .filter((e) => e !== null);
}

/**
 * Ожидание отчёта: бот прислал тренировку и ждёт, что человек скажет, как прошло.
 *
 * Ожидание живёт на диске, а не в памяти диалога: между отправкой плана и вопросом
 * «как прошло» проходят часы, за которые контейнер успевает перезапуститься, а
 * сессия — закончиться. Обещание спросить, живущее только в контексте модели, — это
 * обещание, которое не будет выполнено.
 */
export type Pending = {
  id: string;
  kind: string;
  about?: string;
  due: string;
  created: string;
};

export function loadPending(root: string, skill: string): Pending[] {
  return readJson<Pending[]>(join(skillDir(root, skill), "pending.json"), []);
}

export function savePending(root: string, skill: string, items: Pending[]): void {
  writeJsonAtomic(join(skillDir(root, skill), "pending.json"), items);
}

/**
 * Насколько давно ожидание просрочено, в днях.
 *
 * Отдельная функция, потому что «просрочено» решает, спрашивать ли, а «просрочено
 * давно» — считать ли это пропуском.
 */
export function overdueDays(item: Pending, now: Date): number {
  return (now.getTime() - Date.parse(item.due)) / 86_400_000;
}

/**
 * Сколько отчётов подряд человек не сдал.
 *
 * Считается по истории, а не хранится счётчиком: счётчик, который забыли обнулить,
 * заставит бота приставать к человеку, который на самом деле занимается.
 */
export function missedStreak(events: Array<Record<string, unknown>>): number {
  let streak = 0;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const missed = event.missed === true || event.done === false;
    if (!missed) break;
    streak += 1;
  }

  return streak;
}

/**
 * Пишет вес в общий блок и ведёт его историю.
 *
 * Одно число «текущий вес» отвечает на вопрос «сколько сейчас», но не на вопрос
 * «идёт ли дело» — а именно второй заставляет человека остаться. Лог дописывается,
 * а не перезаписывается: динамика есть только у последовательности.
 */
export function logWeight(
  body: Record<string, unknown>,
  kg: number,
  today: string,
): Record<string, unknown> {
  const log = Array.isArray(body.weight_log)
    ? [...(body.weight_log as Array<Record<string, unknown>>)]
    : [];
  const last = log[log.length - 1];

  // Два взвешивания за день — это правка, а не динамика.
  if (last && last.date === today) {
    log[log.length - 1] = { date: today, kg };
  } else {
    log.push({ date: today, kg });
  }

  return { ...body, weight_kg: kg, weight_log: log };
}
