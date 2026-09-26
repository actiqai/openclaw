import { describe, expect, it } from "vitest";
import { installPinnedHostnameTestHooks, resolveRequestUrl } from "../audio.test-helpers.js";
import { transcribeXaiAudio } from "./audio.js";

installPinnedHostnameTestHooks();

describe("transcribeXaiAudio", () => {
  it("posts to /stt with the file as the last form field", async () => {
    let seenUrl: string | null = null;
    let seenInit: RequestInit | undefined;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = resolveRequestUrl(input);
      seenInit = init;
      return new Response(JSON.stringify({ text: " привет ", duration: 1.5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await transcribeXaiAudio({
      buffer: Buffer.from("ogg-bytes"),
      fileName: "voice.ogg",
      apiKey: "instance-token",
      timeoutMs: 1000,
      baseUrl: "https://gateway.example.com/xai/v1/",
      language: " ru ",
      mime: "audio/ogg",
      fetchFn,
    });

    expect(result).toEqual({ text: "привет", model: "grok-voice-transcribe-2.0" });
    expect(seenUrl).toBe("https://gateway.example.com/xai/v1/stt");
    expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer instance-token");

    const form = seenInit?.body as FormData;
    expect([...form.keys()]).toEqual(["model", "language", "file"]);
    expect(form.get("model")).toBe("grok-voice-transcribe-2.0");
    expect(form.get("language")).toBe("ru");
  });

  it("fails loudly on an empty transcript", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      transcribeXaiAudio({
        buffer: Buffer.from("x"),
        fileName: "v.ogg",
        apiKey: "k",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).rejects.toThrow("missing text");
  });
});
