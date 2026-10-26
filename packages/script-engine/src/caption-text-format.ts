export interface CaptionToken {
  text: string;
}

export interface CaptionDisplayGroup<T extends CaptionToken> {
  text: string;
  tokens: T[];
}

/**
 * Closing punctuation attaches to the previous
 * token. Opening punctuation attaches to the next.
 *
 * The original tokens remain intact so karaoke
 * timing and token indices can still be used.
 */
const CLOSING = /^[,.;:!?%)\]\}]+$/u;
const OPENING = /^[(\[\{]+$/u;

export function groupCaptionTokens<T extends CaptionToken>(
  tokens: readonly T[],
): CaptionDisplayGroup<T>[] {
  const groups: CaptionDisplayGroup<T>[] = [];

  for (const token of tokens) {
    const text = token.text.trim();

    if (!text) continue;

    const previous = groups.at(-1);

    if (CLOSING.test(text) && previous) {
      previous.text += text;
      previous.tokens.push(token);
      continue;
    }

    if (
      previous &&
      OPENING.test(previous.text.slice(-1))
    ) {
      previous.text += text;
      previous.tokens.push(token);
      continue;
    }

    groups.push({
      text,
      tokens: [token],
    });
  }

  return groups;
}

export function formatCaptionText<T extends CaptionToken>(
  tokens: readonly T[],
): string {
  return groupCaptionTokens(tokens)
    .map((group) => group.text)
    .join(" ")
    .replace(/\s+([,.;:!?%)\]\}])/gu, "$1")
    .replace(/([(\[\{])\s+/gu, "$1")
    .trim();
}
