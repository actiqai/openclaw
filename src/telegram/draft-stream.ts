import type { Bot } from "grammy";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 500;

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  clear: () => Promise<void>;
  stop: () => void;
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  draftId?: number;
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const chatId = params.chatId;
  const threadParams = buildTelegramThreadParams(params.thread);
  const draftId = params.draftId ?? 1;

  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlightPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let useDraftApi = true;

  const sendDraft = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(
        `telegram stream preview stopped (text length ${trimmed.length} > ${maxChars})`,
      );
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    lastSentText = trimmed;
    lastSentAt = Date.now();
    try {
      if (useDraftApi) {
        await params.api.sendMessageDraft(chatId, draftId, trimmed, {
          ...threadParams,
        });
      } else {
        // Fallback: legacy edit-message approach (if sendMessageDraft unavailable).
        await params.api.editMessageText(chatId, draftId, trimmed);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (useDraftApi && errMsg.includes("unknown method")) {
        // Bot API too old for sendMessageDraft — fall back to legacy edit mode.
        useDraftApi = false;
        params.warn?.("sendMessageDraft not supported, falling back to editMessageText");
        return;
      }
      stopped = true;
      params.warn?.(`telegram stream preview failed: ${errMsg}`);
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!stopped) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      const trimmed = text.trim();
      if (!trimmed) {
        pendingText = "";
        return;
      }
      pendingText = "";
      const current = sendDraft(text).finally(() => {
        if (inFlightPromise === current) {
          inFlightPromise = undefined;
        }
      });
      inFlightPromise = current;
      await current;
      if (!pendingText) {
        return;
      }
    }
  };

  const clear = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pendingText = "";
    stopped = true;
    if (inFlightPromise) {
      await inFlightPromise;
    }
    // With sendMessageDraft, the draft disappears automatically when
    // the final sendMessage is sent. No cleanup needed.
    // Legacy edit mode also doesn't need cleanup here because the
    // dispatch layer handles the final message.
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) {
      return;
    }
    pendingText = text;
    if (inFlightPromise) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  params.log?.(
    `telegram draft stream ready (maxChars=${maxChars}, throttleMs=${throttleMs}, draftApi=true)`,
  );

  return {
    update,
    flush,
    // With sendMessageDraft there is no editable message to track; the draft
    // is ephemeral. Return undefined so the dispatch layer always sends the
    // final reply as a fresh sendMessage.
    messageId: () => undefined,
    clear,
    stop,
  };
}
