// Drop into an existing Node.js 20+ project. No npm dependencies.
// Required: IDEOGRAM_API_KEY environment variable.
// Default is safe: pricing-only dry runs. Pass --run to generate paid images.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.ideogram.ai';
const KEY = process.env.IDEOGRAM_API_KEY;
const run = process.argv.includes('--run');
const arg = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const reference = arg('reference', '');
const scenesCount = Number(arg('scenes', '1'));
const outDir = path.resolve(arg('out', 'output/ideogram-test'));

if (!KEY) throw new Error('Set IDEOGRAM_API_KEY in the environment.');
if (!Number.isInteger(scenesCount) || scenesCount < 1 || scenesCount > 3) {
  throw new Error('--scenes must be 1, 2, or 3');
}

const style = 'Premium 2D cartoon storybook illustration, hand-painted texture, expressive faces, warm golden lighting, clean shapes, richly detailed environments, no text or watermark.';
const hero = 'A young explorer with curly dark hair, mustard-yellow hoodie, blue backpack, dark trousers and red sneakers.';
const scenes = [
  'The explorer discovers a glowing blue compass on an old wooden desk inside a cozy attic, curious expression, medium shot.',
  'The explorer follows the blue compass into a misty enchanted forest, full-body shot, adventurous expression.',
  'The explorer reaches a waterfall hiding a magical doorway, looking amazed, dramatic wide shot.',
];

// Fixed unit prices from official published API pricing (USD, verify before scaling).
const models = [
  { name: 'p-image_very-low', endpoint: 'p-image-ideogram', price: .003,
    params: { quality: 'very_low', resolution: '1k', aspect_ratio: '1x1' } },
  { name: 'p-image_medium', endpoint: 'p-image-ideogram', price: .010,
    params: { quality: 'medium', resolution: '1k', aspect_ratio: '1x1' } },
  { name: 'ideogram-4_turbo', endpoint: 'ideogram-4', price: .030,
    params: { rendering_speed: 'turbo', resolution: '1024x1024' } },
  { name: 'ideogram-4.5_low', endpoint: 'ideogram-4-5', price: .030,
    params: { quality: 'low', size: '1024x1024' }, useReference: Boolean(reference) },
  { name: 'ideogram-4.5_medium', endpoint: 'ideogram-4-5', price: .060,
    params: { quality: 'medium', size: '1024x1024' }, useReference: Boolean(reference) },
  ...(reference ? [{ name: 'ideogram-4.5_very-low_ref', endpoint: 'ideogram-4-5', price: .008,
    params: { quality: 'very_low', size: '1024x1024' }, useReference: true }] : []),
];

const mime = (filename) => {
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: throw new Error('Reference must be a PNG, JPG, or WEBP image');
  }
};

async function request(model, prompt, dryRun) {
  const payload = {
    prompt, magic_prompt: 'off', num_images: 1,
    ...model.params,
  };
  let body;
  const headers = { 'Api-Key': KEY };
  if (model.useReference) {
    const form = new FormData();
    for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
    const data = await readFile(reference);
    form.append('images', new Blob([data], { type: mime(reference) }), path.basename(reference));
    body = form; // Node automatically sets multipart boundary.
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  const url = `${API}/v2/image/generate/${model.endpoint}${dryRun ? '?dry_run=true' : ''}`;
  const response = await fetch(url, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(180_000),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); } catch { result = { raw: raw.slice(0, 1000) }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

async function saveImage(url, baseName) {
  const result = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!result.ok) throw new Error(`Image download HTTP ${result.status}`);
  const type = result.headers.get('content-type') || '';
  const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const file = path.join(outDir, `${baseName}.${extension}`);
  await writeFile(file, Buffer.from(await result.arrayBuffer()));
  return file;
}

const totalEstimate = models.reduce((total, m) => total + m.price * scenesCount, 0);
console.log(`${run ? 'PAID GENERATION' : 'NO-CHARGE DRY RUN'} — ${models.length} configurations × ${scenesCount} scene(s)`);
console.log(`Estimated image charge if run: $${totalEstimate.toFixed(3)} (excluding other fees)`);
console.log(`Output: ${outDir}\n`);
if (run) await mkdir(outDir, { recursive: true });
const results = [];
for (const model of models) {
  for (let i = 0; i < scenesCount; i++) {
    const prompt = `${style}\nCharacter: ${hero}\nScene ${i + 1}: ${scenes[i]}\nMaintain the same recognizable character and illustration style. 1:1 framing.`;
    try {
      const response = await request(model, prompt, !run);
      if (!run) {
        console.log(`[QUOTE] ${model.name} scene ${i + 1}:`, JSON.stringify(response));
        results.push({ model: model.name, scene: i + 1, quote: response });
        continue;
      }
      const files = [];
      for (const [index, item] of (response.data ?? []).entries()) {
        if (!item.url) continue;
        files.push(await saveImage(item.url, `${model.name}_scene-${i + 1}_${index + 1}`));
      }
      console.log(`[OK] ${model.name}, scene ${i + 1}: ${files.join(', ') || 'no image returned'}`);
      results.push({ model: model.name, scene: i + 1, estimatedUsd: model.price,
        files, seed: response.seed, generationId: response.generation_id });
    } catch (error) {
      console.error(`[FAILED] ${model.name} scene ${i + 1}: ${error.message}`);
      results.push({ model: model.name, scene: i + 1, error: error.message });
    }
  }
}
if (run) {
  await writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved metadata: results.json');
}
console.log(`\nCompleted: ${results.filter((r) => !r.error).length}/${results.length} requests succeeded.`);