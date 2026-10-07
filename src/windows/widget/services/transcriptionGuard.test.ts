import { describe, expect, test } from "bun:test";

import {
  guardTranscriptionResult,
  isClearlySilentAudio,
} from "./transcriptionGuard";

describe("transcription hallucination guard", () => {
  test("rejects the Russian refusal hallucinated on silence", () => {
    expect(
      guardTranscriptionResult(
        {
          raw: "Извините, я не могу помочь с этой просьбой.",
          cleaned: "Извините, я не могу помочь с этой просьбой.",
        },
        "ru",
      ),
    ).toMatchObject({
      transcription: null,
      rejectionReason: "known-silence-hallucination",
    });
  });

  test("rejects a short Hangul-only result for Russian recognition", () => {
    expect(
      guardTranscriptionResult(
        { raw: "점심시간", cleaned: "점심시간" },
        "ru",
      ),
    ).toMatchObject({
      transcription: null,
      rejectionReason: "unexpected-short-script",
    });
    expect(
      guardTranscriptionResult({ raw: "", cleaned: "점심시간" }, "ru"),
    ).toMatchObject({
      transcription: null,
      rejectionReason: "unexpected-short-script",
    });
  });

  test("keeps existing caption hallucinations filtered", () => {
    expect(
      guardTranscriptionResult(
        { raw: "Продолжение следует...", cleaned: "Продолжение следует..." },
        "ru",
      ),
    ).toMatchObject({
      transcription: null,
      rejectionReason: "known-silence-hallucination",
    });
  });

  test("allows the same Korean phrase for Korean and automatic recognition", () => {
    expect(
      guardTranscriptionResult(
        { raw: "점심시간", cleaned: "점심시간" },
        "ko",
      ).transcription?.cleaned,
    ).toBe("점심시간");
    expect(
      guardTranscriptionResult(
        { raw: "점심시간", cleaned: "점심시간" },
        "auto",
      ).transcription?.cleaned,
    ).toBe("점심시간");
  });

  test("keeps ordinary short Russian speech", () => {
    expect(
      guardTranscriptionResult(
        { raw: "Добрый день.", cleaned: "Добрый день." },
        "ru",
      ).transcription,
    ).toEqual({ raw: "Добрый день.", cleaned: "Добрый день." });
  });

  test("falls back to recognized raw text when cleanup returns a refusal", () => {
    expect(
      guardTranscriptionResult(
        {
          raw: "Составь план встречи.",
          cleaned: "Извините, я не могу помочь с этой просьбой.",
        },
        "ru",
      ),
    ).toMatchObject({
      transcription: {
        raw: "Составь план встречи.",
        cleaned: "Составь план встречи.",
      },
      rejectionReason: null,
      cleanedFallbackReason: "known-silence-hallucination",
    });
  });

  test("detects only effectively silent audio stats", () => {
    expect(isClearlySilentAudio({ peak: 0, rms: 0 })).toBe(true);
    expect(isClearlySilentAudio({ peak: 0.0009, rms: 0.00009 })).toBe(true);
    expect(isClearlySilentAudio({ peak: 0.01, rms: 0.002 })).toBe(false);
    expect(isClearlySilentAudio(undefined)).toBe(false);
  });

  test("detects the near-zero microphone levels in the reported empty recording", () => {
    expect(isClearlySilentAudio({ peak: 0.000188, rms: 0.000007 })).toBe(true);
    expect(isClearlySilentAudio({ peak: 0.001, rms: 0.0001 })).toBe(false);
  });
});
