/**
 * Разбор и применение схемы скилла.
 *
 * Схема приезжает с гейтвея вместе со SKILL.md (`/opt/actiq-skills/<name>/schema.json`)
 * и является единственным описанием профиля: тот же файл проверяет вход на гейтвее.
 * Вторая копия правил, написанная здесь «по памяти», однажды разойдётся с первой,
 * и заметит это пользователь, у которого бот спрашивает уже отвеченное.
 */

export type FieldType = "string" | "int" | "number" | "bool" | "enum" | "string[]" | "date";

export type Field = {
  type: FieldType;
  /**
   * Общий блок, в котором поле живёт на диске («body» — рост, вес, возраст).
   * Пометка стоит на поле, а не отдельным списком: иначе общие данные — второй
   * сорт, их не проверяет схема и не видит вычисление стадии, и каждый скилл
   * спрашивает их заново.
   */
  shared?: string;
  values?: string[];
  min?: number;
  max?: number;
  stage: string;
  required?: boolean;
  question?: string;
};

export type SkillSchema = {
  version: number;
  skill: string;
  shared?: string[];
  stages: string[];
  fields: Record<string, Field>;
  call: { action: string; required: string[]; include: string[] };
};

export type FieldError = { field: string; reason: string; message: string };

export type Profile = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Пустая строка и пустой список — это «не ответили», а не ответ. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function validateField(name: string, field: Field, value: unknown): FieldError | null {
  const fail = (reason: string, message: string): FieldError => ({ field: name, reason, message });

  switch (field.type) {
    case "string":
      if (typeof value !== "string") return fail("type", "expected a string");
      break;

    case "enum": {
      if (typeof value !== "string") return fail("type", "expected a string");
      if (!(field.values ?? []).includes(value)) {
        return fail("enum", `expected one of: ${(field.values ?? []).join(", ")}`);
      }
      break;
    }

    case "int":
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value))
        return fail("type", "expected a number");
      if (field.type === "int" && !Number.isInteger(value)) {
        return fail("type", "expected a whole number");
      }
      if (field.min !== undefined && value < field.min) {
        return fail("range", `must be at least ${field.min}`);
      }
      if (field.max !== undefined && value > field.max) {
        return fail("range", `must be at most ${field.max}`);
      }
      break;
    }

    case "bool":
      if (typeof value !== "boolean") return fail("type", "expected true or false");
      break;

    case "string[]": {
      if (!Array.isArray(value)) return fail("type", "expected a list of strings");
      if (value.some((item) => typeof item !== "string")) {
        return fail("type", "expected a list of strings");
      }
      break;
    }

    case "date":
      if (typeof value !== "string" || !DATE.test(value))
        return fail("format", "expected YYYY-MM-DD");
      break;
  }

  return null;
}

/**
 * Проверяет типы и допустимые значения, но не требует полноты: во время онбординга
 * профиль неполон по определению, и отказ означал бы, что первый же ответ некуда
 * положить.
 */
export function validateKnownFields(schema: SkillSchema, profile: Profile): FieldError[] {
  const errors: FieldError[] = [];

  for (const name of Object.keys(profile).sort()) {
    const field = schema.fields[name];
    if (!field) {
      errors.push({
        field: name,
        reason: "unknown",
        message: "the schema does not define this field",
      });
      continue;
    }
    if (profile[name] === null || profile[name] === undefined) continue;

    const error = validateField(name, field, profile[name]);
    if (error) errors.push(error);
  }

  return errors;
}

/**
 * Где сейчас разговор: первая стадия с незаполненными обязательными полями.
 *
 * Стадия вычисляется, а не хранится. Записанную строку модель может переписать и
 * объявить онбординг законченным, не спросив половину; из заполненности полей
 * соврать не получается.
 */
export function stageOf(
  schema: SkillSchema,
  profile: Profile,
): { stage: string; missing: string[]; next_question: string } {
  for (const stage of schema.stages) {
    const missing = Object.entries(schema.fields)
      .filter(([, f]) => f.stage === stage && f.required)
      .map(([name]) => name)
      .filter((name) => isEmpty(profile[name]))
      .sort();

    if (missing.length > 0) {
      return { stage, missing, next_question: schema.fields[missing[0]].question ?? "" };
    }
  }

  return { stage: schema.stages[schema.stages.length - 1], missing: [], next_question: "" };
}

/**
 * Собирает то, что уедет в гейтвей.
 *
 * `call.include` — граница приватности: профиль на инстансе может быть сколь угодно
 * подробным, наверх уходит только перечисленное в схеме. Payload собирает код, а не
 * модель, — иначе «строгая структура» держится на том, что модель ничего не забыла.
 */
export function callPayload(schema: SkillSchema, profile: Profile): Profile {
  const payload: Profile = {};

  for (const name of schema.call.include) {
    if (!isEmpty(profile[name])) payload[name] = profile[name];
  }

  return payload;
}

/** Готов ли скилл к вызову: все обязательные для вызова поля собраны. */
export function readyToCall(schema: SkillSchema, profile: Profile): boolean {
  return schema.call.required.every((name) => !isEmpty(profile[name]));
}

/**
 * Слияние патча в профиль.
 *
 * Массивы заменяются целиком, а не дополняются: модель обязана прислать список
 * целиком. Операции add/remove пришлось бы описывать в промпте, и на них она бы
 * ошибалась — а replace не имеет двусмысленных случаев.
 */
export function mergeProfile(profile: Profile, patch: Profile): Profile {
  const merged: Profile = { ...profile };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

/** Поля, которые живут в общем блоке, а не в профиле скилла. */
export function sharedFields(schema: SkillSchema): Record<string, string> {
  const map: Record<string, string> = {};

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.shared) map[name] = field.shared;
  }

  return map;
}

/**
 * Полный вид профиля: собственные поля скилла плюс общие.
 *
 * Стадия и вызов считаются по нему, поэтому рост, рассказанный скиллу питания,
 * автоматически считается известным и тренировкам — переспрашивать нечего.
 */
export function withShared(
  schema: SkillSchema,
  profile: Profile,
  blocks: Record<string, Record<string, unknown>>,
): Profile {
  const merged: Profile = { ...profile };

  for (const [name, block] of Object.entries(sharedFields(schema))) {
    const value = blocks[block]?.[name];
    if (value !== undefined) merged[name] = value;
  }

  return merged;
}

/** Делит патч на собственные поля скилла и общие, по блокам. */
export function splitPatch(
  schema: SkillSchema,
  patch: Profile,
): { own: Profile; shared: Record<string, Profile> } {
  const map = sharedFields(schema);
  const own: Profile = {};
  const shared: Record<string, Profile> = {};

  for (const [name, value] of Object.entries(patch)) {
    const block = map[name];
    if (!block) {
      own[name] = value;
      continue;
    }
    shared[block] ??= {};
    shared[block][name] = value;
  }

  return { own, shared };
}
