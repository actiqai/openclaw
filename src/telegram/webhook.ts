import type { Update } from "grammy/types";
import type { IncomingMessage, ServerResponse } from "node:http";
import { webhookCallback } from "grammy";
import { createServer } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS = 10_000;

const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

function secretTokenHeader(req: IncomingMessage): string | undefined {
  const value = req.headers[SECRET_TOKEN_HEADER];

  return Array.isArray(value) ? value[0] : value;
}

/**
 * Адаптер grammy, которому тело уже прочитано и разобрано.
 *
 * Штатный адаптер `"http"` читает поток сам, и `JSON.parse` у него стоит внутри
 * обработчика `end` — без try/catch. Тело, которое не разбирается, выбрасывает
 * исключение мимо промиса: оно не становится отказом, его нечем поймать снаружи,
 * и процесс умирает целиком.
 *
 * Достаётся это не только мусорным запросам. Пока лимит тела вешал на тот же
 * поток свой `data`-слушатель, поток уходил в flowing-режим сразу, и если тело
 * приходило одним куском раньше, чем grammy успевал подписаться, до grammy не
 * доезжало ничего: пустая строка, исключение, перезапуск. Снаружи это выглядело
 * как «бот молчит», а человек в чате видел «Обрабатываем ваш запрос» от роутера,
 * которому в этот момент некуда было переслать сообщение (16.09.2026).
 *
 * Поэтому поток читает ровно один читатель — мы, — а grammy получает готовый
 * объект.
 */
function parsedUpdateAdapter(req: IncomingMessage, res: ServerResponse, update: Update) {
  return {
    update: Promise.resolve(update),
    header: secretTokenHeader(req),
    end: () => res.end(),
    respond: (json: string) => res.writeHead(200, { "Content-Type": "application/json" }).end(json),
    unauthorized: () => res.writeHead(401).end("secret token is wrong"),
  };
}

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  const secret = typeof opts.secret === "string" ? opts.secret.trim() : "";
  if (!secret) {
    throw new Error(
      "Telegram webhook mode requires a non-empty secret token. " +
        "Set channels.telegram.webhookSecret in your config.",
    );
  }
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  const handler = webhookCallback(bot, parsedUpdateAdapter, {
    secretToken: secret,
    onTimeout: "return",
    timeoutMilliseconds: TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS,
  });

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }

    // Секрет проверяется до чтения тела: чужому запросу незачем давать
    // набирать мегабайт в нашей памяти, и разбирать его тело тоже незачем.
    // grammy сверит заголовок ещё раз — это не дублирование, а вторая дверь.
    if (secretTokenHeader(req) !== secret) {
      res.writeHead(401).end("secret token is wrong");

      return;
    }

    void (async () => {
      let body: string;

      try {
        body = await readRequestBodyWithLimit(req, {
          maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
        });
      } catch (err) {
        if (isRequestBodyLimitError(err)) {
          if (!res.headersSent) {
            res.writeHead(err.statusCode, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(requestBodyErrorToText(err.code));
          }

          return;
        }

        throw err;
      }

      let update: Update;

      try {
        const parsed: unknown = JSON.parse(body);

        // `JSON.parse` принимает и `123`, и `"строка"`, и `null` — всё это не
        // обновление, и дальше по коду оно превратится в чтение поля у не-объекта.
        if (typeof parsed !== "object" || parsed === null) {
          throw new TypeError("update is not an object");
        }

        update = parsed as Update;
      } catch {
        // Отвечаем отказом, а не падаем. Раньше на этом месте умирал процесс —
        // вместе с ним и все остальные разговоры инстанса.
        runtime.log?.("webhook: request body is not valid JSON, answering 400");
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end("Invalid JSON");

        return;
      }

      // Обёртка не украшение: с собственным адаптером типы grammy не обещают
      // промис, хотя обработчик асинхронный. Без неё тип-ориентированный линтер
      // справедливо ругается на `await` над не-thenable.
      await Promise.resolve(handler(req, res, update));

      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    })().catch((err: unknown) => {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook handler failed: ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });

  const publicUrl =
    opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  await withTelegramApiErrorLogging({
    operation: "setWebhook",
    runtime,
    fn: () =>
      bot.api.setWebhook(publicUrl, {
        secret_token: secret,
        allowed_updates: resolveTelegramAllowedUpdates(),
      }),
  });

  // Знакомимся с самими собой до того, как начнём слушать.
  //
  // Иначе это делает grammy — лениво, на первом же пришедшем обновлении, — и то
  // обновление пропадает: Telegram не дожидается ответа, считает доставку неудачной
  // и присылает то же сообщение заново через минуту. Для человека в чате это
  // выглядит как «бот проигнорировал и ответил только спустя минуту», причём ровно
  // один раз после каждого перезапуска.
  await withTelegramApiErrorLogging({
    operation: "init",
    runtime,
    fn: () => bot.init(),
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  runtime.log?.(`webhook listening on ${publicUrl}`);

  const shutdown = () => {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
