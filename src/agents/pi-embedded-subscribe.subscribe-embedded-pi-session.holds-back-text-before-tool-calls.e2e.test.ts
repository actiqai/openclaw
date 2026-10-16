import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

// CLT-065: текст перед вызовом инструмента («Запускаю скилл», «Хм, формат не
// тот…») человеку не уходит — только итоговый ответ хода.
function subscribe() {
  let handler: ((evt: unknown) => void) | undefined;
  const session: StubSession = {
    subscribe: (fn) => {
      handler = fn;
      return () => {};
    },
  };

  const subscription = subscribeEmbeddedPiSession({
    session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    runId: "run",
    // Как в настоящем ходе: раннер передаёт обработчик всегда, даже когда
    // потоковая отправка выключена и он ничего не шлёт (CLT-066).
    onBlockReply: () => {},
  });

  const say = (text: string, opts: { callsTool: boolean }) => {
    handler?.({ type: "message_start", message: { role: "assistant" } });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });
    const content: AssistantMessage["content"] = [{ type: "text", text }];
    if (opts.callsTool) {
      content.push({ type: "toolCall", id: "t1", name: "call_skill", arguments: {} });
    }
    handler?.({
      type: "message_end",
      message: {
        role: "assistant",
        content,
        stopReason: opts.callsTool ? "toolUse" : "stop",
      } as AssistantMessage,
    });
  };

  const end = () => handler?.({ type: "agent_end" });

  return { subscription, say, end };
}

describe("subscribeEmbeddedPiSession — text before tool calls", () => {
  it("delivers only the final answer, not the narration between tool calls", () => {
    const { subscription, say, end } = subscribe();

    say("Запускаю скилл.", { callsTool: true });
    say("Хм, формат не тот. Попробую иначе.", { callsTool: true });
    say("Вот план на сегодня.", { callsTool: false });
    end();

    expect(subscription.assistantTexts).toEqual(["Вот план на сегодня."]);
  });

  it("falls back to the last narration when the turn ends without an answer", () => {
    const { subscription, say, end } = subscribe();

    say("Запускаю скилл.", { callsTool: true });
    say("Не получилось, попробуй чуть позже.", { callsTool: true });
    end();

    expect(subscription.assistantTexts).toEqual(["Не получилось, попробуй чуть позже."]);
  });

  it("keeps a plain answer without tool calls as is", () => {
    const { subscription, say, end } = subscribe();

    say("Лавандовый 💜", { callsTool: false });
    end();

    expect(subscription.assistantTexts).toEqual(["Лавандовый 💜"]);
  });
});
