import { createHash } from "node:crypto";
import { z } from "zod";

const finiteNumber = z.number().finite();

export const AudioQaFindingSchema = z.object({
  code: z.enum([
    "EXCESSIVE_SILENCE",
    "POSSIBLE_AUDIO_DROPOUT",
    "EXPECTED_SPEECH_PAUSE",
    "POSSIBLE_CLIPPING",
    "LOW_AUDIO_LEVEL",
    "HIGH_AUDIO_LEVEL",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  startSeconds: finiteNumber.nonnegative(),
  endSeconds: finiteNumber.nonnegative(),
  detail: z.string().min(1),
}).strict();

export const AudioQaReportSchema = z.object({
  version: z.literal(1),
  sampleRate: z.number().int().positive(),
  sampleFrames: z.number().int().positive(),
  durationSeconds: finiteNumber.positive(),
  peak: finiteNumber.nonnegative(),
  peakDbfs: finiteNumber,
  rms: finiteNumber.nonnegative(),
  rmsDbfs: finiteNumber,
  clippingFraction: finiteNumber.nonnegative(),
  findings: z.array(AudioQaFindingSchema),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type AudioQaReport = z.infer<
  typeof AudioQaReportSchema
>;

export interface AudioWordTiming {
  readonly text?: string;
  readonly word?: string;
  readonly startSeconds?: number;
  readonly endSeconds?: number;
  readonly startMs?: number;
  readonly endMs?: number;
}

export interface AudioQaOptions {
  windowMs?: number;
  silenceThresholdDbfs?: number;
  minimumSilenceMs?: number;
  dropoutMs?: number;
  clippingThreshold?: number;
  clippingFractionThreshold?: number;
  minimumRmsDbfs?: number;
  maximumRmsDbfs?: number;
  words?: readonly AudioWordTiming[];
  maxSentencePauseMs?: number;
  maxClausePauseMs?: number;
  maxLeadingSilenceMs?: number;
  maxTrailingSilenceMs?: number;
}

interface AudioWindow {
  startSample: number;
  endSampleExclusive: number;
  rms: number;
  rmsDbfs: number;
  silent: boolean;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function amplitudeToDbfs(
  amplitude: number,
): number {
  if (
    !Number.isFinite(amplitude) ||
    amplitude < 0
  ) {
    throw new Error(
      "M8 invalid audio amplitude",
    );
  }

  // -120 dBFS is the reporting floor for silence.
  // Do not use this floor when deciding if a
  // sample is truly zero.
  if (amplitude === 0) return -120;

  return Math.max(
    -120,
    20 * Math.log10(amplitude),
  );
}

function validateOptions(
  options: AudioQaOptions,
) {
  const settings = {
    windowMs: options.windowMs ?? 20,
    silenceThresholdDbfs:
      options.silenceThresholdDbfs ?? -45,
    minimumSilenceMs:
      options.minimumSilenceMs ?? 800,
    dropoutMs: options.dropoutMs ?? 450,
    clippingThreshold:
      options.clippingThreshold ?? 0.999,
    clippingFractionThreshold:
      options.clippingFractionThreshold ?? 0.001,
    minimumRmsDbfs:
      options.minimumRmsDbfs ?? -35,
    maximumRmsDbfs:
      options.maximumRmsDbfs ?? -10,
    words: options.words,
    maxSentencePauseMs: options.maxSentencePauseMs ?? 1500,
    maxClausePauseMs: options.maxClausePauseMs ?? 1000,
    maxLeadingSilenceMs: options.maxLeadingSilenceMs ?? 1500,
    maxTrailingSilenceMs: options.maxTrailingSilenceMs ?? 2500,
  };

  const milliseconds = [
    settings.windowMs,
    settings.minimumSilenceMs,
    settings.dropoutMs,
    settings.maxSentencePauseMs,
    settings.maxClausePauseMs,
    settings.maxLeadingSilenceMs,
    settings.maxTrailingSilenceMs,
  ];

  if (
    milliseconds.some(
      (value) =>
        !Number.isSafeInteger(value) ||
        value < 1,
    ) ||
    settings.windowMs > 1000 ||
    !Number.isFinite(
      settings.silenceThresholdDbfs,
    ) ||
    settings.silenceThresholdDbfs >= 0 ||
    !Number.isFinite(settings.minimumRmsDbfs) ||
    !Number.isFinite(settings.maximumRmsDbfs) ||
    settings.minimumRmsDbfs >=
      settings.maximumRmsDbfs ||
    !Number.isFinite(settings.clippingThreshold) ||
    settings.clippingThreshold <= 0 ||
    settings.clippingThreshold > 1 ||
    !Number.isFinite(
      settings.clippingFractionThreshold,
    ) ||
    settings.clippingFractionThreshold < 0 ||
    settings.clippingFractionThreshold > 1
  ) {
    throw new Error(
      "M8 invalid audio QA configuration",
    );
  }

  return settings;
}

/**
 * Input must be mono, signed 16-bit LE PCM.
 *
 * For MP4 audio use the existing M7
 * decodeMp4Audio() which outputs 16kHz mono.
 */
export function analyzeVideoQaAudio(
  pcm: Buffer,
  sampleRate: number,
  options: AudioQaOptions = {},
): AudioQaReport {
  if (
    pcm.length === 0 ||
    pcm.length % 2 !== 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0
  ) {
    throw new Error(
      "M8 invalid decoded audio",
    );
  }

  const cfg = validateOptions(options);

  const sampleFrames = pcm.length / 2;
  const windowSamples = Math.max(
    1,
    Math.round(
      sampleRate * cfg.windowMs / 1000,
    ),
  );

  let peak = 0;
  let totalSquares = 0;
  let clippedSamples = 0;

  const windows: AudioWindow[] = [];

  for (
    let start = 0;
    start < sampleFrames;
    start += windowSamples
  ) {
    const end = Math.min(
      sampleFrames,
      start + windowSamples,
    );

    let windowSquares = 0;

    for (let i = start; i < end; i++) {
      const sample =
        pcm.readInt16LE(i * 2) / 32768;

      const abs = Math.abs(sample);

      peak = Math.max(peak, abs);
      totalSquares += sample * sample;
      windowSquares += sample * sample;

      if (
        abs >= cfg.clippingThreshold
      ) {
        clippedSamples++;
      }
    }

    const rms = Math.sqrt(
      windowSquares / (end - start),
    );

    const rmsDbfs = amplitudeToDbfs(rms);

    windows.push({
      startSample: start,
      endSampleExclusive: end,
      rms,
      rmsDbfs,
      silent:
        rmsDbfs <=
        cfg.silenceThresholdDbfs,
    });
  }

  const rms = Math.sqrt(
    totalSquares / sampleFrames,
  );

  const rmsDbfs = amplitudeToDbfs(rms);
  const clippingFraction =
    clippedSamples / sampleFrames;

  const findings: z.infer<
    typeof AudioQaFindingSchema
  >[] = [];

  if (
    clippingFraction >=
    cfg.clippingFractionThreshold &&
    clippedSamples > 0
  ) {
    findings.push({
      code: "POSSIBLE_CLIPPING",
      severity: "error",
      startSeconds: 0,
      endSeconds:
        sampleFrames / sampleRate,
      detail:
        `${clippedSamples} samples near full scale ` +
        `(${(clippingFraction * 100).toFixed(3)}%)`,
    });
  }

  if (rmsDbfs < cfg.minimumRmsDbfs) {
    findings.push({
      code: "LOW_AUDIO_LEVEL",
      severity: "warning",
      startSeconds: 0,
      endSeconds:
        sampleFrames / sampleRate,
      detail:
        `Overall RMS ${rmsDbfs.toFixed(2)} dBFS`,
    });
  }

  if (rmsDbfs > cfg.maximumRmsDbfs) {
    findings.push({
      code: "HIGH_AUDIO_LEVEL",
      severity: "warning",
      startSeconds: 0,
      endSeconds:
        sampleFrames / sampleRate,
      detail:
        `Overall RMS ${rmsDbfs.toFixed(2)} dBFS`,
    });
  }

  // Find continuous quiet windows.
  let silenceStart = -1;

  function flushSilence(
    endWindowIndex: number,
  ) {
    if (silenceStart < 0) return;

    const first = windows[silenceStart]!;
    const last =
      windows[endWindowIndex - 1]!;

    const durationMs =
      (
        last.endSampleExclusive -
        first.startSample
      ) * 1000 / sampleRate;

    const leading = silenceStart === 0;
    const trailing =
      endWindowIndex === windows.length;

    const internal = !leading && !trailing;
    const startSec = first.startSample / sampleRate;
    const endSec = last.endSampleExclusive / sampleRate;

    if (cfg.words && cfg.words.length > 0) {
      const getWordText = (w: AudioWordTiming): string => w.text ?? w.word ?? "";
      const getWordStartSec = (w: AudioWordTiming): number =>
        w.startSeconds !== undefined ? w.startSeconds : (w.startMs !== undefined ? w.startMs / 1000 : 0);
      const getWordEndSec = (w: AudioWordTiming): number =>
        w.endSeconds !== undefined ? w.endSeconds : (w.endMs !== undefined ? w.endMs / 1000 : 0);
      const isPunctuation = (str: string) => /^[.,!?:;—\-…]+$/.test(str.trim());

      const isConjunctionWord = (str: string) =>
        /^(and|but|or|nor|for|yet|so|because|although|though|while|since|as|if|unless|until|when|where|whether|which|that|who)$/i.test(
          str.trim().toLowerCase().replace(/[^a-z]/g, ""),
        );

      const hasPunctuationAfter = (
        index: number,
      ): { isSentenceEnd: boolean; isClauseEnd: boolean; punctuation: string } => {
        const w = cfg.words![index]!;
        const wText = getWordText(w);
        if (/[.!?:]/.test(wText)) return { isSentenceEnd: true, isClauseEnd: false, punctuation: wText };
        if (/[,;—\-]/.test(wText)) return { isSentenceEnd: false, isClauseEnd: true, punctuation: wText };

        for (let j = index + 1; j < cfg.words!.length; j++) {
          const next = cfg.words![j]!;
          const nextText = getWordText(next);
          if (isPunctuation(nextText)) {
            if (/[.!?:]/.test(nextText)) return { isSentenceEnd: true, isClauseEnd: false, punctuation: nextText };
            if (/[,;—\-]/.test(nextText)) return { isSentenceEnd: false, isClauseEnd: true, punctuation: nextText };
          } else {
            if (isConjunctionWord(nextText)) {
              return { isSentenceEnd: false, isClauseEnd: true, punctuation: nextText };
            }
            break;
          }
        }

        return { isSentenceEnd: false, isClauseEnd: false, punctuation: "" };
      };

      // 1. Check if silence interval overlaps expected active speech
      let speechOverlapDetected = false;
      let overlappingWordText = "";
      let overlapMs = 0;

      for (let i = 0; i < cfg.words.length; i++) {
        const w = cfg.words[i]!;
        const text = getWordText(w);
        if (isPunctuation(text)) continue;
        const wStart = getWordStartSec(w);
        const wEnd = getWordEndSec(w);
        const wDur = wEnd - wStart;
        const overlap = Math.max(0, Math.min(endSec, wEnd) - Math.max(startSec, wStart));
        if (overlap > 0.06 && wDur > 0) {
          const boundary = hasPunctuationAfter(i);
          const isAtBoundary = boundary.isSentenceEnd || boundary.isClauseEnd;
          const isTrailingPause =
            isAtBoundary && startSec >= wStart + 0.08 && overlap / wDur < 0.75;
          const isLeadingPause =
            (startSec <= wStart + 0.08 || startSec < wStart) && endSec <= wStart + 0.18 && (wEnd - endSec) > 0.04;

          const midWordDropoutThresholdSec = 0.35;
          if (!isTrailingPause && !isLeadingPause && (overlap >= midWordDropoutThresholdSec || (overlap / wDur > 0.65 && overlap >= midWordDropoutThresholdSec * 0.85))) {
            speechOverlapDetected = true;
            overlappingWordText = text;
            overlapMs = Math.round(overlap * 1000);
            break;
          }
        }
      }

      if (speechOverlapDetected) {
        findings.push({
          code: "POSSIBLE_AUDIO_DROPOUT",
          severity: "warning",
          startSeconds: startSec,
          endSeconds: endSec,
          detail: `Silence overlaps expected speech for "${overlappingWordText}" (${overlapMs} ms overlap)`,
        });
        silenceStart = -1;
        return;
      }

      // 2. Silence is between words or at boundaries
      let prevSpoken: AudioWordTiming | undefined;
      let prevIndex = -1;
      let nextSpoken: AudioWordTiming | undefined;
      let nextIndex = -1;
      const punctuationBetween: string[] = [];

      for (let i = 0; i < cfg.words.length; i++) {
        const w = cfg.words[i]!;
        const text = getWordText(w);
        const wStart = getWordStartSec(w);
        const wEnd = getWordEndSec(w);
        if (!isPunctuation(text)) {
          if (wStart <= startSec + 0.05) {
            prevSpoken = w;
            prevIndex = i;
          }
          if (wEnd >= endSec - 0.05 && !nextSpoken && wStart >= startSec) {
            nextSpoken = w;
            nextIndex = i;
          }
        }
      }

      if (prevIndex >= 0) {
        const searchEnd = nextIndex >= 0 ? nextIndex : cfg.words.length;
        for (let j = prevIndex + 1; j < searchEnd; j++) {
          const t = getWordText(cfg.words[j]!);
          if (isPunctuation(t)) {
            punctuationBetween.push(t);
          }
        }
      }

      if (leading) {
        if (durationMs >= cfg.maxLeadingSilenceMs) {
          findings.push({
            code: "EXCESSIVE_SILENCE",
            severity: "warning",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms leading silence exceeds ${cfg.maxLeadingSilenceMs} ms`,
          });
        } else {
          findings.push({
            code: "EXPECTED_SPEECH_PAUSE",
            severity: "info",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms leading silence before speech`,
          });
        }
        silenceStart = -1;
        return;
      }

      if (trailing) {
        if (durationMs >= cfg.maxTrailingSilenceMs) {
          findings.push({
            code: "EXCESSIVE_SILENCE",
            severity: "warning",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms trailing silence exceeds ${cfg.maxTrailingSilenceMs} ms`,
          });
        } else {
          findings.push({
            code: "EXPECTED_SPEECH_PAUSE",
            severity: "info",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms trailing silence after speech`,
          });
        }
        silenceStart = -1;
        return;
      }

      // Internal silence
      const allPunctuation = [
        ...(prevSpoken ? [getWordText(prevSpoken)] : []),
        ...punctuationBetween,
      ].join(" ");

      const isSentenceEnd = /[.!?:]/.test(allPunctuation);
      const isClausePunctuation = /[,;—\-]/.test(allPunctuation);
      const nextWordClean = nextSpoken
        ? getWordText(nextSpoken).toLowerCase().replace(/[^a-z]/g, "")
        : "";
      const isClauseConnector = /^(and|but|or|nor|for|yet|so|because|although|though|while|since|as|if|unless|until|when|where|whether|which|that|who)$/.test(
        nextWordClean,
      );
      const isClauseBoundary = isClausePunctuation || isClauseConnector;

      if (isSentenceEnd) {
        if (durationMs >= cfg.maxSentencePauseMs) {
          findings.push({
            code: "EXCESSIVE_SILENCE",
            severity: "warning",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms pause at sentence boundary exceeds ${cfg.maxSentencePauseMs} ms`,
          });
        } else {
          findings.push({
            code: "EXPECTED_SPEECH_PAUSE",
            severity: "info",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms intentional pause at sentence boundary ("${prevSpoken ? getWordText(prevSpoken) : ""}")`,
          });
        }
      } else if (isClauseBoundary) {
        if (durationMs >= cfg.maxClausePauseMs) {
          findings.push({
            code: "EXCESSIVE_SILENCE",
            severity: "warning",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms pause at clause boundary exceeds ${cfg.maxClausePauseMs} ms`,
          });
        } else {
          findings.push({
            code: "EXPECTED_SPEECH_PAUSE",
            severity: "info",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms intentional pause at clause boundary ("${prevSpoken ? getWordText(prevSpoken) : ""}" -> "${nextSpoken ? getWordText(nextSpoken) : ""}")`,
          });
        }
      } else {
        if (durationMs >= cfg.dropoutMs) {
          findings.push({
            code: "POSSIBLE_AUDIO_DROPOUT",
            severity: "warning",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms unexpected quiet interval between words ("${prevSpoken ? getWordText(prevSpoken) : ""}" and "${nextSpoken ? getWordText(nextSpoken) : ""}")`,
          });
        } else {
          findings.push({
            code: "EXPECTED_SPEECH_PAUSE",
            severity: "info",
            startSeconds: startSec,
            endSeconds: endSec,
            detail: `${durationMs.toFixed(0)} ms word-transition gap`,
          });
        }
      }

      silenceStart = -1;
      return;
    }

    if (
      durationMs >= cfg.minimumSilenceMs
    ) {
      findings.push({
        code: "EXCESSIVE_SILENCE",
        severity: "warning",
        startSeconds:
          first.startSample / sampleRate,
        endSeconds:
          last.endSampleExclusive / sampleRate,
        detail:
          `${durationMs.toFixed(0)} ms continuous silence`,
      });
    } else if (
      internal &&
      durationMs >= cfg.dropoutMs
    ) {
      findings.push({
        code: "POSSIBLE_AUDIO_DROPOUT",
        severity: "warning",
        startSeconds:
          first.startSample / sampleRate,
        endSeconds:
          last.endSampleExclusive / sampleRate,
        detail:
          `${durationMs.toFixed(0)} ms internal quiet interval`,
      });
    }

    silenceStart = -1;
  }

  for (
    let index = 0;
    index < windows.length;
    index++
  ) {
    if (windows[index]!.silent) {
      if (silenceStart < 0) {
        silenceStart = index;
      }
    } else {
      flushSilence(index);
    }
  }

  flushSilence(windows.length);

  const payload = {
    version: 1 as const,
    sampleRate,
    sampleFrames,
    durationSeconds:
      sampleFrames / sampleRate,
    peak,
    peakDbfs: amplitudeToDbfs(peak),
    rms,
    rmsDbfs,
    clippingFraction,
    findings,
  };

  return AudioQaReportSchema.parse({
    ...payload,
    reportHash: hash(payload),
  });
}
