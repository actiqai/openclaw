import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindOutboundChat,
  emitSkillToolCall,
  normalizeChatId,
  onSkillToolCall,
  outboundTagHeaders,
  resetOutboundTagsForTests,
  setSessionOutboundTags,
  wrapFetchWithOutboundTags,
} from "./outbound-tags.js";

afterEach(() => {
  resetOutboundTagsForTests();
  vi.useRealTimers();
});

describe("outbound tags (CLT-056)", () => {
  it("tags a reply to the chat bound to the session", () => {
    setSessionOutboundTags("agent:main:main", { step: "workout.4.2", reentry: true });
    bindOutboundChat(12345, "agent:main:main");

    expect(outboundTagHeaders("sendMessage", 12345)).toEqual({
      "X-NikaAI-Step": "workout.4.2",
      "X-NikaAI-Reentry": "1",
    });
  });

  it("does not tag edits, reactions or typing — only new messages", () => {
    setSessionOutboundTags("s", { step: "meal.3.1", reentry: false });
    bindOutboundChat(1, "s");

    expect(outboundTagHeaders("editMessageText", 1)).toEqual({});
    expect(outboundTagHeaders("setMessageReaction", 1)).toEqual({});
    expect(outboundTagHeaders("sendChatAction", 1)).toEqual({});
    expect(outboundTagHeaders("sendPhoto", 1)["X-NikaAI-Step"]).toBe("meal.3.1");
  });

  it("a turn without a skill clears the tag", () => {
    setSessionOutboundTags("s", { step: "meal.3.1", reentry: false });
    bindOutboundChat(1, "s");
    setSessionOutboundTags("s", null);

    expect(outboundTagHeaders("sendMessage", 1)).toEqual({});
  });

  it("refuses a code the router would reject", () => {
    setSessionOutboundTags("s", { step: "meal.onboarding.age", reentry: false });
    bindOutboundChat(1, "s");

    expect(outboundTagHeaders("sendMessage", 1)).toEqual({});
  });

  it("a cron target with a channel prefix finds the same chat", () => {
    expect(normalizeChatId("telegram:12345")).toBe("12345");
    expect(normalizeChatId("-100777")).toBe("-100777");
    expect(normalizeChatId(undefined)).toBe("");

    setSessionOutboundTags("agent:main:cron:job1", { step: "workout.4.1", reentry: false });
    bindOutboundChat("telegram:12345", "agent:main:cron:job1");

    expect(outboundTagHeaders("sendMessage", 12345)["X-NikaAI-Step"]).toBe("workout.4.1");
  });

  it("an unbound chat takes only a fresh tag — a stale one is worse than none", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    setSessionOutboundTags("s", { step: "booking.5.1", reentry: false });

    expect(outboundTagHeaders("sendMessage", 999)["X-NikaAI-Step"]).toBe("booking.5.1");

    vi.setSystemTime(new Date("2026-10-01T10:05:00Z"));
    expect(outboundTagHeaders("sendMessage", 999)).toEqual({});
  });

  it("the wrapped fetch adds headers from the chat_id in a JSON body", async () => {
    setSessionOutboundTags("s", { step: "travel.3.1", reentry: false });
    bindOutboundChat(42, "s");

    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchWithOutboundTags(inner as unknown as typeof fetch);

    await wrapped("https://router/telegram/botTOKEN/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 42, text: "привет" }),
    });

    const init = (inner.mock.calls[0] as unknown[])[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-NikaAI-Step")).toBe("travel.3.1");
    expect(headers.get("X-NikaAI-Reentry")).toBe("0");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("without a tag the request goes through untouched", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchWithOutboundTags(inner as unknown as typeof fetch);
    const init = { method: "POST", body: JSON.stringify({ chat_id: 1 }) };

    await wrapped("https://router/telegram/botTOKEN/sendMessage", init);

    expect((inner.mock.calls[0] as unknown[])[1]).toBe(init);
  });

  it("relays skill tool calls to listeners and survives a broken one", () => {
    const seen: string[] = [];
    onSkillToolCall(() => {
      throw new Error("boom");
    });
    onSkillToolCall((key, call) => seen.push(`${key}:${call.tool}`));

    emitSkillToolCall("s", { tool: "call_skill", params: {}, result: null });
    emitSkillToolCall(undefined, { tool: "call_skill", params: {}, result: null });

    expect(seen).toEqual(["s:call_skill"]);
  });
});
