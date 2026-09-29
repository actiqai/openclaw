import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AudioTranscriptionRequest } from "./types.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

// Так настроен инстанс Actiq: голосовое распознаёт Grok, но через гейтвей — адрес
// и ключ (токен инстанса) лежат в `models.providers.xai`, а в `tools.media.audio`
// только выбор провайдера.
describe("runCapability with the xai audio provider", () => {
  it("takes the key and address from models.providers.xai", async () => {
    const tmpPath = path.join(os.tmpdir(), `openclaw-xai-audio-${Date.now()}.ogg`);
    await fs.writeFile(tmpPath, Buffer.from("OggS"));
    const ctx: MsgContext = { MediaPath: tmpPath, MediaType: "audio/ogg" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);

    let seen: AudioTranscriptionRequest | undefined;
    const providerRegistry = buildProviderRegistry({
      xai: {
        id: "xai",
        transcribeAudio: async (req) => {
          seen = req;
          return { text: "привет", model: req.model };
        },
      },
    });

    const cfg = {
      models: {
        providers: {
          xai: {
            baseUrl: "http://10.0.1.40:8082/xai/v1",
            apiKey: "instance-token",
            models: [],
          },
        },
      },
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ provider: "xai", model: "grok-voice-transcribe-2.0" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "audio",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });
      expect(result.decision.outcome).toBe("success");
      expect(result.outputs[0]?.text).toBe("привет");
      expect(seen?.apiKey).toBe("instance-token");
      expect(seen?.baseUrl).toBe("http://10.0.1.40:8082/xai/v1");
      expect(seen?.model).toBe("grok-voice-transcribe-2.0");
    } finally {
      await cache.cleanup();
      await fs.unlink(tmpPath).catch(() => {});
    }
  });
});
