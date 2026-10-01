/**
 * Метки исходящих сообщений: к какому шагу скилла относится ответ (`CLT-056`).
 *
 * Роутер логирует тип каждого ответа и кладёт его в историю переписки, а увидеть
 * тип может только инстанс: вызовы тулов видны здесь, а наверх уходит лишь
 * `sendMessage`. Метка едет заголовками на сам вызов Telegram API:
 *
 *   X-NikaAI-Step: workout.4.2
 *   X-NikaAI-Reentry: 1
 *
 * Связь «ход → сообщение» держится не на асинхронном контексте, а на ключах.
 * Между вызовом тула и отправкой стоят очередь сессии и троттлер grammY, и
 * контекст, начатый в обработчике апдейта, до `fetch` доезжает не всегда — а
 * ошибка здесь тихая: ответ уходит с чужой меткой. Поэтому так:
 *
 * - скилл пишет метку на сессию (`setSessionOutboundTags`);
 * - канал, отправляя ответ сессии, связывает чат с этой сессией (`bindOutboundChat`);
 * - `fetch` Telegram достаёт `chat_id` из тела и по нему находит метку.
 *
 * Состояние живёт на `globalThis`: расширения грузятся своим загрузчиком, и
 * модуль-синглтон мог бы оказаться в двух экземплярах — скилл писал бы в один,
 * а канал читал из другого.
 */

export type OutboundTags = {
  step: string;
  reentry: boolean;
};

export type SkillToolCall = {
  tool: string;
  params: Record<string, unknown>;
  result: unknown;
};

type SkillToolCallListener = (sessionKey: string, call: SkillToolCall) => void;

type State = {
  bySession: Map<string, OutboundTags & { at: number }>;
  chatSession: Map<string, string>;
  listeners: Set<SkillToolCallListener>;
};

const STATE_KEY = Symbol.for("nikaai.outbound-tags");

/** Формат кода шага — тот же, что проверяет роутер. */
export const STEP_PATTERN = /^[a-z]+(\.[0-9]+){2}$/;

/**
 * Сколько метка сессии годится для чата, который ни с какой сессией не связан.
 *
 * Такое бывает у отправок мимо канала: `message`-тул, крон без явного адресата.
 * Инстанс принадлежит одному человеку, и свежая метка почти наверняка про этот
 * ответ; несвежая — уже нет, и лучше не пометить, чем пометить чужим.
 */
const UNBOUND_FRESH_MS = 2 * 60_000;

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { bySession: new Map(), chatSession: new Map(), listeners: new Set() };
    g[STATE_KEY] = s;
  }
  return s;
}

/** Метка ответа сессии; `null` снимает её (ход без скилла). */
export function setSessionOutboundTags(sessionKey: string, tags: OutboundTags | null): void {
  if (!sessionKey) {
    return;
  }
  if (!tags || !STEP_PATTERN.test(tags.step) || tags.step.length > 32) {
    state().bySession.delete(sessionKey);
    return;
  }
  state().bySession.set(sessionKey, { ...tags, at: Date.now() });
}

export function getSessionOutboundTags(sessionKey: string): OutboundTags | undefined {
  const tags = state().bySession.get(sessionKey);
  return tags ? { step: tags.step, reentry: tags.reentry } : undefined;
}

/** Канал отправляет ответ сессии `sessionKey` в чат `chatId`. */
export function bindOutboundChat(chatId: string | number, sessionKey: string | undefined): void {
  const chat = normalizeChatId(chatId);
  if (!chat || !sessionKey) {
    return;
  }
  state().chatSession.set(chat, sessionKey);
}

/**
 * `telegram:123`, `tg:-100…`, `123` → `123` / `-100…`.
 *
 * Адресат крона приходит строкой с префиксом канала, а в теле вызова Telegram —
 * голым числом; без нормализации связь бы не находилась.
 */
export function normalizeChatId(chatId: string | number | undefined | null): string {
  if (chatId === undefined || chatId === null) {
    return "";
  }
  const match = String(chatId)
    .trim()
    .match(/(-?\d+)$/);
  return match ? match[1] : "";
}

export function resolveOutboundTagsForChat(chatId: string | number): OutboundTags | undefined {
  const s = state();
  const chat = normalizeChatId(chatId);
  const sessionKey = chat ? s.chatSession.get(chat) : undefined;
  if (sessionKey) {
    return getSessionOutboundTags(sessionKey);
  }

  let freshest: (OutboundTags & { at: number }) | undefined;
  for (const tags of s.bySession.values()) {
    if (!freshest || tags.at > freshest.at) {
      freshest = tags;
    }
  }
  if (freshest && Date.now() - freshest.at <= UNBOUND_FRESH_MS) {
    return { step: freshest.step, reentry: freshest.reentry };
  }
  return undefined;
}

/** Заголовки для вызова Telegram `method` в чат `chatId`; пусто — метки нет. */
export function outboundTagHeaders(
  method: string,
  chatId: string | number | undefined,
): Record<string, string> {
  // Только отправки человеку: правка черновика или реакция — не новый ответ, и
  // роутер пишет в историю лишь `send*`.
  if (!/^send/i.test(method) || /^sendChatAction$/i.test(method)) {
    return {};
  }
  const tags =
    chatId === undefined ? resolveOutboundTagsForChat("") : resolveOutboundTagsForChat(chatId);
  if (!tags) {
    return {};
  }
  return {
    "X-NikaAI-Step": tags.step,
    "X-NikaAI-Reentry": tags.reentry ? "1" : "0",
  };
}

function methodFromUrl(input: unknown): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input && typeof input === "object" && "url" in input
          ? String((input as { url: unknown }).url)
          : "";
  const path = raw.split("?")[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `chat_id` из тела вызова.
 *
 * grammY шлёт JSON-строкой всё, кроме загрузки файлов; у загрузки тело — поток,
 * и читать его ради метки нельзя (он одноразовый). Тогда `undefined`, и метка
 * ищется по свежести.
 */
function chatIdFromBody(body: unknown): string | number | undefined {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { chat_id?: string | number };
      return parsed?.chat_id;
    } catch {
      return undefined;
    }
  }
  if (body instanceof URLSearchParams) {
    return body.get("chat_id") ?? undefined;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const value = body.get("chat_id");
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/** Оборачивает `fetch` Telegram: метка шага уезжает заголовками на `send*`. */
export function wrapFetchWithOutboundTags(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let extra: Record<string, string> = {};
    try {
      extra = outboundTagHeaders(methodFromUrl(input), chatIdFromBody(init?.body));
    } catch {
      extra = {};
    }
    if (Object.keys(extra).length === 0) {
      return fetchImpl(input, init);
    }
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extra)) {
      headers.set(name, value);
    }
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
  return wrapped;
}

/**
 * Вызов тула скилла, сделанный в сессии `sessionKey`.
 *
 * Шаг считает `skill-state`, а `call_skill` живёт в другом расширении: оно
 * сообщает о своих вызовах сюда, а `skill-state` слушает. Так таблица шагов
 * остаётся в одном месте.
 */
export function emitSkillToolCall(sessionKey: string | undefined, call: SkillToolCall): void {
  if (!sessionKey) {
    return;
  }
  for (const listener of state().listeners) {
    try {
      listener(sessionKey, call);
    } catch {
      // метка не стоит сломанного ответа
    }
  }
}

export function onSkillToolCall(listener: SkillToolCallListener): () => void {
  state().listeners.add(listener);
  return () => {
    state().listeners.delete(listener);
  };
}

export function resetOutboundTagsForTests(): void {
  const s = state();
  s.bySession.clear();
  s.chatSession.clear();
  s.listeners.clear();
}
