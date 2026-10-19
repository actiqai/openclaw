import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundMetaTurnBlock,
  buildInboundUserContextPrefix,
  readTurnTimeZone,
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

  // `CLT-070`: без времени сообщения модель не знала, какое сегодня число, и ставила
  // напоминание на позавчера.
  it("carries when the message was sent, in Moscow time with the offset", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock({
        ...CTX,
        Timestamp: Date.parse("2026-10-19T09:25:19Z"),
      } as TemplateContext),
    );

    expect(payload["sent_at"]).toBe("2026-10-19T12:25:19+03:00");
    expect(payload["sent_weekday"]).toBe("Monday");
  });

  it("dates a late-evening UTC message by the Moscow day", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock({
        ...CTX,
        Timestamp: Date.parse("2026-10-18T22:30:00Z"),
      } as TemplateContext),
    );

    expect(payload["sent_at"]).toBe("2026-10-19T01:30:00+03:00");
    expect(payload["sent_weekday"]).toBe("Monday");
  });

  // `CLT-072`: человеку из Белграда время — сразу по Белграду, переводить модели нечего.
  it("tells the time in the person's own zone, and names the zone", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock(
        { ...CTX, Timestamp: Date.parse("2026-10-19T14:24:19Z") } as TemplateContext,
        { timeZone: "Europe/Belgrade" },
      ),
    );

    expect(payload["sent_at"]).toBe("2026-10-19T16:24:19+02:00");
    expect(payload["sent_tz"]).toBe("Europe/Belgrade");
  });

  it("follows the zone's own clock change", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock(
        { ...CTX, Timestamp: Date.parse("2026-10-26T09:00:00Z") } as TemplateContext,
        { timeZone: "Europe/Belgrade" },
      ),
    );

    expect(payload["sent_at"]).toBe("2026-10-26T10:00:00+01:00");
  });

  it("names Moscow when no zone is given", () => {
    const payload = parseInboundMetaPayload(
      buildInboundMetaTurnBlock({
        ...CTX,
        Timestamp: Date.parse("2026-10-19T09:25:19Z"),
      } as TemplateContext),
    );

    expect(payload["sent_tz"]).toBe("Europe/Moscow");
  });

  it("omits the time when the channel gave none", () => {
    const payload = parseInboundMetaPayload(buildInboundMetaTurnBlock(CTX));

    expect(payload["sent_at"]).toBeUndefined();
    expect(payload["sent_weekday"]).toBeUndefined();
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

describe("readTurnTimeZone", () => {
  async function workspaceWith(content?: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-tz-"));
    if (content !== undefined) {
      await fs.writeFile(path.join(dir, "timezone"), content);
    }
    return dir;
  }

  it("reads the zone the agent wrote down", async () => {
    expect(await readTurnTimeZone(await workspaceWith("Europe/Belgrade\n"))).toBe(
      "Europe/Belgrade",
    );
  });

  it("falls back to Moscow without the file", async () => {
    expect(await readTurnTimeZone(await workspaceWith())).toBe("Europe/Moscow");
    expect(await readTurnTimeZone(undefined)).toBe("Europe/Moscow");
  });

  it("falls back to Moscow on a name Intl does not know", async () => {
    expect(await readTurnTimeZone(await workspaceWith("Белград, +2"))).toBe("Europe/Moscow");
  });
});
