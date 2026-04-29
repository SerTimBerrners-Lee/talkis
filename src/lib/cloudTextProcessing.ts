import { AppSettings } from "./store";
import { logError } from "./logger";
import { formatErrorMessage } from "./utils";

const PROXY_BASE_URL = "https://proxy.talkis.ru";

export interface ProcessTextParams {
  text: string;
  prompt: string;
  settings: AppSettings;
  temperature?: number;
}

export async function processTextWithCloudPrompt({
  text,
  prompt,
  settings,
  temperature,
}: ProcessTextParams): Promise<string> {
  if (!settings.deviceToken?.trim()) {
    throw new Error("Talkis Cloud session missing");
  }

  const response = await fetch(`${PROXY_BASE_URL}/api/process-text`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      prompt,
      ...(temperature == null ? {} : { temperature }),
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    logError("CLOUD_PROCESS_TEXT", `Proxy error (${response.status}): ${body}`);
    throw new Error(`Proxy error (${response.status}): ${body}`);
  }

  try {
    const parsed = JSON.parse(body) as { result?: string };
    return typeof parsed.result === "string" ? parsed.result : "";
  } catch (error) {
    logError("CLOUD_PROCESS_TEXT", `Proxy response parse failed: ${formatErrorMessage(error)}; body=${body}`);
    throw new Error("Talkis Cloud returned an invalid response");
  }
}
