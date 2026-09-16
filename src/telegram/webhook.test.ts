import { describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.fn(
  (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  },
);
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();
const initSpy = vi.fn();
const webhookCallbackSpy = vi.fn(() => handlerSpy);

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy },
  init: initSpy,
  stop: stopSpy,
}));

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    webhookCallback: (...args: unknown[]) => webhookCallbackSpy(...args),
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

/** Обновление в том виде, в каком его шлёт Telegram: с секретом и телом. */
async function postUpdate(
  port: number,
  body: string = JSON.stringify({ update_id: 1 }),
  secret: string | null = "secret",
) {
  return await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret }),
    },
    body,
  });
}

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    createTelegramBotSpy.mockClear();
    webhookCallbackSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      accountId: "opie",
      config: cfg,
      port: 0, // random free port
      abortSignal: abort.signal,
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(setWebhookSpy).toHaveBeenCalled();
    expect(webhookCallbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        api: expect.objectContaining({
          setWebhook: expect.any(Function),
        }),
      }),
      // Адаптер теперь наш: тело читает и разбирает вызывающий код, а grammy
      // получает готовое обновление. Штатный "http" парсил JSON внутри
      // обработчика `end`, и любой неразбираемый запрос убивал процесс.
      expect.any(Function),
      {
        secretToken: "secret",
        onTimeout: "return",
        timeoutMilliseconds: 10_000,
      },
    );

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    await postUpdate(addr.port);
    expect(handlerSpy).toHaveBeenCalled();
    abort.abort();
  });

  it("initializes the bot before the first update can arrive", async () => {
    initSpy.mockClear();
    handlerSpy.mockClear();
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      config: { bindings: [] },
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    // Ленивая инициализация внутри grammy съедала бы первое обновление, и Telegram
    // переприсылал бы его через минуту.
    expect(initSpy).toHaveBeenCalled();

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    await postUpdate(addr.port);
    expect(handlerSpy).toHaveBeenCalled();

    abort.abort();
  });

  it("rejects startup when webhook secret is missing", async () => {
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });
});

describe("телега: кривое тело не роняет процесс", () => {
  async function startOnFreePort() {
    handlerSpy.mockClear();
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      config: { bindings: [] },
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }

    return { port: addr.port, abort };
  }

  // Ради этого всё и делалось. Штатный адаптер grammy разбирает тело внутри
  // обработчика `end`, без try/catch: исключение улетает в uncaughtException и
  // убивает инстанс целиком — вместе со всеми остальными разговорами.
  it("отвечает 400 на пустое тело, а не умирает", async () => {
    const { port, abort } = await startOnFreePort();

    const res = await postUpdate(port, "");

    expect(res.status).toBe(400);
    expect(handlerSpy).not.toHaveBeenCalled();
    abort.abort();
  });

  it("отвечает 400 на тело, которое не разбирается", async () => {
    const { port, abort } = await startOnFreePort();

    const res = await postUpdate(port, "{ это не json");

    expect(res.status).toBe(400);
    expect(handlerSpy).not.toHaveBeenCalled();
    abort.abort();
  });

  it("передаёт разобранное обновление обработчику", async () => {
    const { port, abort } = await startOnFreePort();

    await postUpdate(port, JSON.stringify({ update_id: 42 }));

    expect(handlerSpy).toHaveBeenCalled();
    expect(handlerSpy.mock.calls[0]?.[2]).toEqual({ update_id: 42 });
    abort.abort();
  });

  // Чужому запросу незачем давать набирать мегабайт в нашей памяти: секрет
  // сверяется до чтения тела.
  it("отвечает 401 без секрета и не читает тело", async () => {
    const { port, abort } = await startOnFreePort();

    const res = await postUpdate(port, JSON.stringify({ update_id: 1 }), null);

    expect(res.status).toBe(401);
    expect(handlerSpy).not.toHaveBeenCalled();
    abort.abort();
  });
});
