export interface NarrationShotSlot {
  index: number;
  narrationText: string;
  estimatedDurationSeconds: number;
}

export interface NarrationSegmentationOptions {
  maxWordsPerShot: number;
  wordsPerMinute: number;
  minDurationSeconds?: number;
}

function tokenize(text: string): string[] {
  return text.match(/\S+/gu) ?? [];
}

function wordCount(text: string): number {
  return tokenize(text).length;
}

/**
 * Split at sentence-ending punctuation when followed
 * by whitespace or the end of the input.
 *
 * This is intentionally deterministic and lightweight.
 */
export function splitNarrationSentences(
  input: string,
): string[] {
  const text = input.trim();

  if (!text) {
    return [];
  }

  const sentences: string[] = [];
  const boundaries =
    /[.!?]+(?:["'”’])?(?=\s|$)/gu;

  let start = 0;

  for (const match of text.matchAll(boundaries)) {
    const end = match.index + match[0].length;

    const sentence = text
      .slice(start, end)
      .trim();

    if (sentence) {
      sentences.push(sentence);
    }

    start = end;
  }

  const remainder = text.slice(start).trim();

  if (remainder) {
    sentences.push(remainder);
  }

  return sentences;
}

/**
 * Build narration shot slots while keeping sentence
 * boundaries whenever possible.
 *
 * Oversized sentences are split by word count.
 */
export function segmentNarrationIntoShots(
  narration: string,
  options: NarrationSegmentationOptions,
): NarrationShotSlot[] {
  const { maxWordsPerShot, wordsPerMinute, minDurationSeconds } = options;

  if (
    !Number.isSafeInteger(maxWordsPerShot) ||
    maxWordsPerShot < 1
  ) {
    throw new Error("Invalid maxWordsPerShot");
  }

  if (
    !Number.isFinite(wordsPerMinute) ||
    wordsPerMinute <= 0
  ) {
    throw new Error("Invalid wordsPerMinute");
  }

  if (
    minDurationSeconds !== undefined &&
    (!Number.isFinite(minDurationSeconds) || minDurationSeconds < 0)
  ) {
    throw new Error("Invalid minDurationSeconds");
  }

  const sentences = splitNarrationSentences(narration);

  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }

    chunks.push(current.join(" "));
    current = [];
  };

  for (const sentence of sentences) {
    const sentenceTokens = tokenize(sentence);

    // Long sentences must be split into smaller shots.
    if (sentenceTokens.length > maxWordsPerShot) {
      flush();

      for (
        let start = 0;
        start < sentenceTokens.length;
        start += maxWordsPerShot
      ) {
        chunks.push(
          sentenceTokens
            .slice(start, start + maxWordsPerShot)
            .join(" "),
        );
      }

      continue;
    }

    // Prefer grouping short complete sentences.
    if (
      current.length > 0 &&
      current.length + sentenceTokens.length >
        maxWordsPerShot
    ) {
      flush();
    }

    current.push(...sentenceTokens);
  }

  flush();

  // If minDurationSeconds is specified, merge any sub-threshold chunk
  // into its neighboring chunk so accidental micro-cuts are avoided.
  let finalChunks = chunks;
  if (minDurationSeconds && minDurationSeconds > 0 && chunks.length > 1) {
    const minWords = Math.ceil((minDurationSeconds * wordsPerMinute) / 60);
    const merged: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const count = wordCount(chunk);

      if (count < minWords) {
        if (merged.length > 0) {
          merged[merged.length - 1] += " " + chunk;
        } else if (i + 1 < chunks.length) {
          chunks[i + 1] = chunk + " " + chunks[i + 1]!;
        } else {
          merged.push(chunk);
        }
      } else {
        merged.push(chunk);
      }
    }
    finalChunks = merged;
  }

  return finalChunks.map((text, index) => ({
    index,
    narrationText: text,
    estimatedDurationSeconds:
      (wordCount(text) / wordsPerMinute) * 60,
  }));
}
