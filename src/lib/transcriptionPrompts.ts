import manifest from "../config/transcription-prompts/manifest.json";

import type { AppSettings } from "./store";

interface PromptStyleConfig {
  file: string;
  uiTitle: string;
  uiDescription: string;
}

interface PromptConfig {
  version: number;
  defaultLanguage: string;
  defaultStyle: string;
  baseFile: string;
  styleOrder: string[];
  styles: Record<string, PromptStyleConfig>;
}

const config = manifest as PromptConfig;

export interface TranscriptionStyleOption {
  id: AppSettings["style"];
  title: string;
  description: string;
}

export const TRANSCRIPTION_STYLE_OPTIONS: TranscriptionStyleOption[] = config.styleOrder.map((id) => {
  const style = config.styles[id];

  return {
    id: id as AppSettings["style"],
    title: style.uiTitle,
    description: style.uiDescription,
  };
});
