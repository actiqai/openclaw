import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `USER.md` — представление профиля, а не второй профиль.
 *
 * До этого на инстансе было два места, где живёт человек, и оба пустые. `USER.md` —
 * вольный markdown, который openclaw читает в bootstrap на каждом прогоне
 * (`DEFAULT_USER_FILENAME` в списке распознаваемых файлов). Строгий стор — схема,
 * валидация, вычисленная стадия, — но в контекст он сам не попадает: только когда
 * скилл позовёт тул. Человек, описанный в одном, другому не виден, и синхронизировать
 * их было нечем.
 *
 * Поэтому правда одна — `shared/` в сторе, — а этот файл её печатает. Ассистент видит
 * человека в каждом запросе, не вызывая тула и не тратя токенов сверх тех, что bootstrap
 * тратит и так.
 */

/** Шапка обязана быть: файл машинный, и правки в нём затрутся. */
const HEADER = [
  "# USER.md — про человека",
  "",
  "<!-- Сгенерировано из профиля на этом инстансе. Правки здесь затрутся при",
  "     следующей записи — меняйте профиль через бота. -->",
];

type Row = { key: string; label: string };

/**
 * Порядок и подписи. Список явный, а не обход ключей: файл читает модель, и порядок
 * «имя, город, потом телосложение» для неё осмысленнее алфавитного. Незнакомые ключи
 * намеренно не печатаются — схема скилла может завести общее поле, для которого здесь
 * нет подписи, и «citizenship: RU» в русском тексте выглядит как утечка внутренностей.
 */
const PERSON_ROWS: Row[] = [
  { key: "name", label: "Имя" },
  { key: "city", label: "Город" },
  { key: "country", label: "Страна" },
  { key: "tz", label: "Часовой пояс" },
  { key: "citizenship", label: "Гражданство" },
  { key: "currency", label: "Валюта" },
];

const BODY_ROWS: Row[] = [
  { key: "sex", label: "Пол" },
  { key: "age", label: "Возраст" },
  { key: "height_cm", label: "Рост, см" },
  { key: "weight_kg", label: "Вес, кг" },
  { key: "activity", label: "Активность" },
];

/** Блоки, которые этот файл печатает. Запись в остальные его не касается. */
export const RENDERED_BLOCKS = ["person", "body"] as const;

function format(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    const items = value.map((v) => String(v).trim()).filter(Boolean);

    return items.length > 0 ? items.join(", ") : null;
  }

  if (typeof value === "boolean") return value ? "да" : "нет";

  const text = String(value).trim();

  return text === "" ? null : text;
}

function section(title: string, rows: Row[], data: Record<string, unknown>): string[] {
  const lines: string[] = [];

  for (const { key, label } of rows) {
    const value = format(data[key]);
    if (value !== null) lines.push(`- **${label}:** ${value}`);
  }

  // Пустой раздел не печатается вовсе. Заголовок над пустотой читается как
  // «спрашивали и не ответили», а половина шаблона с пустыми `**Имя:**` — это
  // ровно то состояние, из которого мы уходим.
  return lines.length > 0 ? ["", `## ${title}`, "", ...lines] : [];
}

/** Собирает содержимое `USER.md` из общих блоков стора. */
export function renderUserMd(blocks: {
  person?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): string {
  const body = [
    ...section("Человек", PERSON_ROWS, blocks.person ?? {}),
    ...section("Телосложение", BODY_ROWS, blocks.body ?? {}),
  ];

  // Нечего печатать — так и говорим. Пустой файл выглядел бы как поломка генератора,
  // а не как «профиль ещё не заполнен».
  if (body.length === 0) {
    return [...HEADER, "", "_Профиль пока пуст: бот ещё не спрашивал._", ""].join("\n");
  }

  return [...HEADER, ...body, ""].join("\n");
}

/**
 * Перезаписывает `USER.md` в рабочей области.
 *
 * Тихо ничего не делает при ошибке записи: `USER.md` — удобство, а не данные.
 * Уронить `skill_state` из-за того, что не удалось напечатать представление уже
 * записанного профиля, значило бы потерять ответ человека ради красоты файла.
 */
export function writeUserMd(
  workspaceDir: string,
  blocks: { person?: Record<string, unknown>; body?: Record<string, unknown> },
): boolean {
  const path = join(workspaceDir, "USER.md");

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderUserMd(blocks), "utf8");

    return true;
  } catch {
    return false;
  }
}
