import { describe, expect, it } from "vitest";
import {
  findInternalLeak,
  guardReplyText,
  INTERNAL_LEAK_REPLACEMENT,
} from "./internal-leak-guard.js";

describe("internal leak guard", () => {
  // Ровно то, что человек получил на «здарова» 16.09.2026.
  const leakedReply = [
    'The user just said "Здарова" (Russian for "Hey/Hi"). This is a heartbeat poll',
    "followed by a casual greeting. The HEARTBEAT.md file has no active tasks, so I",
    "should respond with HEARTBEAT_OK acknowledgment plus a brief greeting.",
  ].join(" ");

  it("ловит настоящую утечку", () => {
    expect(findInternalLeak(leakedReply)).not.toBeNull();
  });

  it("заменяет утёкший ответ целиком", () => {
    const guarded = guardReplyText(leakedReply);

    expect(guarded.leaked).not.toBeNull();
    expect(guarded.text).toBe(INTERNAL_LEAK_REPLACEMENT);
    expect(guarded.text).not.toContain("HEARTBEAT");
  });

  it.each([
    ["HEARTBEAT_OK", "HEARTBEAT_OK"],
    ["имя файла", "Посмотрю, что записано в HEARTBEAT.md"],
    ["файл воркспейса", "Это лежит в AGENTS.md"],
    ["конфиг", "проверьте openclaw.json"],
    ["путь", "файл в /home/openclaw/.openclaw"],
  ])("режет %s", (_name, text) => {
    expect(findInternalLeak(text)).not.toBeNull();
  });

  /**
   * Главный риск такого фильтра — съесть законный ответ. Ассистент говорит про
   * тренировки, и пульс там — обычная тема.
   */
  it.each([
    "Здравствуйте! Чем помочь?",
    "Пульс в разминке держите около 120 ударов — это лёгкая зона.",
    "Keep your heartbeat under 140 bpm during the warm-up.",
    "Билеты Питер → Сочи на выходные от 5400 ₽.",
    "Записала: напомню завтра в 8 утра.",
  ])("не трогает живой текст: %s", (text) => {
    expect(findInternalLeak(text)).toBeNull();
    expect(guardReplyText(text).text).toBe(text);
  });

  it("пустой текст не считается утечкой", () => {
    expect(findInternalLeak("")).toBeNull();
    expect(findInternalLeak(undefined)).toBeNull();
    expect(findInternalLeak(null)).toBeNull();
  });
});
