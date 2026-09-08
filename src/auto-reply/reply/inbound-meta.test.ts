import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundMetaTurnBlock,
  buildInboundUserContextPrefix,
} from "./inbound-meta.js";

function parseInboundMetaPayload(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("missing inbound meta json block");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

const CTX = {
  MessageSid: "123",
  MessageSidFull: "123",
  ReplyToId: "99",
  OriginatingTo: "telegram:5494292670",
  OriginatingChannel: "telegram",
  Provider: "telegram",
  Surface: "telegram",
  ChatType: "direct",
} as TemplateContext;

// Системный блок стоит перед всей перепиской, поэтому всё, что в нём меняется,
// обнуляет кэш разговора целиком. Здесь остаётся только то, что постоянно в пределах
// диалога; конверт сообщения проверяется ниже, в блоке хода.
describe("buildInboundMetaSystemPrompt", () => {
  it("describes the conversation, not the message", () => {
    const payload = parseInboundMetaPayload(buildInboundMetaSystemPrompt(CTX));

    expect(payload["schema"]).toBe("openclaw.inbound_meta.v1");
    expect(payload["chat_id"]).toBe("telegram:5494292670");
    expect(payload["channel"]).toBe("telegram");
    expect(payload["chat_type"]).toBe("direct");
  });

  // Это и есть починка: одно меняющееся число здесь стоило порядка $0.19 за сообщение
  // вместо ~$0.02, и обнаружить его можно было только по одинаковой длине блока при
  // разном хэше.
  it("carries nothing that changes between messages", () => {
    const payload = parseInboundMetaPayload(buildInboundMetaSystemPrompt(CTX));

    expect(payload["message_id"]).toBeUndefined();
    expect(payload["message_id_full"]).toBeUndefined();
    expect(payload["reply_to_id"]).toBeUndefined();
    expect((payload["flags"] as Record<string, unknown>)["history_count"]).toBeUndefined();
  });

  it("is byte-identical for two different messages of one conversation", () => {
    const first = buildInboundMetaSystemPrompt({ ...CTX, MessageSid: "1" } as TemplateContext);
    const second = buildInboundMetaSystemPrompt({
      ...CTX,
      MessageSid: "2",
      InboundHistory: [{}, {}],
    } as TemplateContext);

    expect(first).toBe(second);
  });
});

describe("buildInboundMetaTurnBlock", () => {
  it("carries the ids the model needs to reply in thread", () => {
    const payload = parseInboundMetaPayload(buildInboundMetaTurnBlock(CTX));

    expect(payload["schema"]).toBe("openclaw.inbound_turn.v1");
    expect(payload["message_id"]).toBe("123");
    expect(payload["message_id_full"]).toBeUndefined();
    expect(payload["reply_to_id"]).toBe("99");
  });

  it("keeps message_id_full only when it differs from message_id", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock({
        ...CTX,
        MessageSid: "short-id",
        MessageSidFull: "full-provider-message-id",
      } as TemplateContext),
    );

    expect(payload["message_id"]).toBe("short-id");
    expect(payload["message_id_full"]).toBe("full-provider-message-id");
  });

  // Пустой конверт не печатается: лишний блок стоит токенов в каждом ходе, а сказать
  // ему нечего.
  it("prints nothing when there is nothing to say", () => {
    expect(buildInboundMetaTurnBlock({ ChatType: "direct" } as TemplateContext)).toBe("");
  });
});

describe("buildInboundUserContextPrefix", () => {
  it("omits conversation label block for direct chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "direct",
      ConversationLabel: "openclaw-tui",
    } as TemplateContext);

    expect(text).toBe("");
  });

  it("keeps conversation label for group chats", () => {
    const text = buildInboundUserContextPrefix({
      ChatType: "group",
      ConversationLabel: "ops-room",
    } as TemplateContext);

    expect(text).toContain("Conversation info (untrusted metadata):");
    expect(text).toContain('"conversation_label": "ops-room"');
  });
});
