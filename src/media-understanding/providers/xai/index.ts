import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeXaiAudio } from "./audio.js";

export const xaiProvider: MediaUnderstandingProvider = {
  id: "xai",
  capabilities: ["audio"],
  transcribeAudio: transcribeXaiAudio,
};
