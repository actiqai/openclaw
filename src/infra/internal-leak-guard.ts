import { getLogger } from "../logging/logger.js";

/**
 * Защита от того, чтобы служебное уезжало человеку в чат.
 *
 * 16.09.2026 человек написал боту «здарова» и получил в ответ рассуждение
 * агента про самого себя: heartbeat-опрос, пустой `HEARTBEAT.md`, токен
 * `HEARTBEAT_OK`. Причину тогда убрали (`CLT-051`, пульс выключен), но причина
 * была одна из многих: служебные запросы и живой разговор живут в одном
 * контексте, и рано или поздно одно протекает в другое.
 *
 * Инструкция модели «не раскрывай внутреннее» — это совет. Здесь стоит правило:
 * ответ с именами наших файлов, токенов и путей наружу не уходит вовсе.
 *
 * Список маркеров намеренно узкий — только то, что не может означать ничего
 * другого. Слово «heartbeat» само по себе сюда НЕ входит: у нас ассистент
 * говорит и про тренировки, где пульс — законная тема разговора.
 */
const INTERNAL_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "HEARTBEAT_OK", pattern: /HEARTBEAT_OK/i },
  { name: "HEARTBEAT.md", pattern: /HEARTBEAT\.md/i },
  { name: "heartbeat poll", pattern: /heartbeat\s+(?:poll|prompt|run|token)/i },
  { name: "workspace file", pattern: /\b(?:AGENTS|IDENTITY|SOUL|USER)\.md\b/ },
  { name: "openclaw.json", pattern: /\bopenclaw\.json\b/i },
  { name: "workspace-state.json", pattern: /\bworkspace-state\.json\b/i },
  { name: "internal path", pattern: /\/(?:home\/openclaw|etc\/actiq)\b/ },
];

/**
 * Что человек видит вместо утёкшего ответа.
 *
 * Не «произошла ошибка»: ошибки не было, ответ был — просто не тот, который
 * можно показывать. Поэтому короткая просьба повторить, без подробностей,
 * которые мы как раз и прячем.
 */
export const INTERNAL_LEAK_REPLACEMENT = "Кажется, я отвлеклась. Повторите, пожалуйста.";

/** Имя маркера, из-за которого ответ нельзя показывать. `null` — всё чисто. */
export function findInternalLeak(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }

  for (const marker of INTERNAL_MARKERS) {
    if (marker.pattern.test(text)) {
      return marker.name;
    }
  }

  return null;
}

/**
 * Текст, который можно показывать.
 *
 * Утёкший ответ заменяется целиком, а не вырезается по кускам: утечка почти
 * всегда и есть всё сообщение, а половина рассуждения выглядит ещё страннее,
 * чем целое.
 */
export function guardReplyText(text: string | null | undefined): {
  text: string | null | undefined;
  leaked: string | null;
} {
  const leaked = findInternalLeak(text);

  if (!leaked) {
    return { text, leaked: null };
  }

  logInternalLeak(leaked, text ?? "");

  return { text: INTERNAL_LEAK_REPLACEMENT, leaked };
}

/**
 * В лог — сам факт и начало текста.
 *
 * Уровень warn, а не debug: это не шум, а поведение, которое видел человек.
 * Целиком не пишем — в утёкшем ответе может оказаться что угодно из разговора.
 */
export function logInternalLeak(marker: string, text: string): void {
  const preview = text.trim().slice(0, 160);

  try {
    getLogger().warn({ marker, preview }, "internal leak blocked in reply");
  } catch {
    // Логгер не должен решать, уйдёт ли сообщение человеку.
  }
}
