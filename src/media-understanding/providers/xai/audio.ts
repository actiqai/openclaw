import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { assertOkOrThrowHttpError, fetchWithTimeoutGuarded, normalizeBaseUrl } from "../shared.js";

export const DEFAULT_XAI_AUDIO_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_AUDIO_MODEL = "grok-voice-transcribe-2.0";

// Распознавание речи у xAI — не OpenAI-совместимое: свой путь `/stt`, и файл обязан
// идти последним полем формы («The `file` parameter must be provided after all other
// parameters»), иначе поля после него сервер не видит.
export async function transcribeXaiAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_XAI_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/stt`;

  const model = params.model?.trim() || DEFAULT_XAI_AUDIO_MODEL;
  const form = new FormData();
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
  const blob = new Blob([new Uint8Array(params.buffer)], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    { method: "POST", headers, body: form },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = (await res.json()) as { text?: string };
    const text = payload.text?.trim();
    if (!text) {
      throw new Error("Audio transcription response missing text");
    }
    return { text, model };
  } finally {
    await release();
  }
}
