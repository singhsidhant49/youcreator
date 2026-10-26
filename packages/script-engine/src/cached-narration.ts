import {
  ScriptPartCache,
  scriptPartHash,
  type ScriptPartInput,
} from "./script-part-cache.js";

export interface CachedNarrationResult {
  narration: string;
  cacheHit: boolean;
}

export async function getOrGenerateNarration(
  cache: ScriptPartCache | undefined,
  input: ScriptPartInput,
  generate: () => Promise<string>,
): Promise<CachedNarrationResult> {
  const hash = scriptPartHash(input);

  if (cache) {
    const existing = await cache.load(hash);

    if (existing?.trim()) {
      return {
        narration: existing,
        cacheHit: true,
      };
    }
  }

  const narration = await generate();

  if (!narration.trim()) {
    throw new Error(
      `Generated empty narration: ${input.kind}/${input.id}`,
    );
  }

  if (cache) {
    await cache.save(hash, narration);
  }

  return {
    narration,
    cacheHit: false,
  };
}
