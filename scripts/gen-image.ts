// `yarn ai:image "a bowl of shakshuka with feta, overhead, natural light"`: generates one image
// from the prompt with OpenAI's GPT Image mini and saves it to generated-images/ (git-ignored), to
// try out AI recipe photos by hand. Uses OPENAI_API_KEY from supabase/functions/.env.
// The prompt is sent as given, with nothing added.

const USAGE = `Usage: yarn ai:image [options] <prompt>

Options:
  --quality <low|medium|high|auto>   Default medium. Low is cheapest, high is several times the cost.
  --size <1536x1024|1024x1024|1024x1536|auto>
                                     Default 1536x1024 (landscape, closest to the app's 4:3 photos).
  --model <id>                       Default gpt-image-1-mini.
  --out <dir>                        Default generated-images.`;

const QUALITIES = ['low', 'medium', 'high', 'auto'];
const SIZES = ['1536x1024', '1024x1024', '1024x1536', 'auto'];

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  Deno.exit(1);
}

let quality = 'medium';
let size = '1536x1024';
let model = 'gpt-image-1-mini';
let outDir = 'generated-images';
const words: string[] = [];
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  const value = () => Deno.args[++i] ?? fail(`${arg} needs a value`);
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    Deno.exit(0);
  } else if (arg === '--quality') quality = value();
  else if (arg === '--size') size = value();
  else if (arg === '--model') model = value();
  else if (arg === '--out') outDir = value();
  else if (arg.startsWith('--')) fail(`Unknown option ${arg}`);
  else words.push(arg);
}

const prompt = words.join(' ').trim();
if (!prompt) fail('Give a prompt.');
if (!QUALITIES.includes(quality)) fail(`--quality must be one of ${QUALITIES.join(', ')}`);
if (!SIZES.includes(size)) fail(`--size must be one of ${SIZES.join(', ')}`);
const apiKey = Deno.env.get('OPENAI_API_KEY')?.trim();
if (!apiKey) fail('OPENAI_API_KEY is not set in supabase/functions/.env');

console.log(`${model}, ${quality}, ${size}: ${prompt}`);
const started = performance.now();
const res = await fetch('https://api.openai.com/v1/images/generations', {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, prompt, quality, size, n: 1, output_format: 'jpeg' }),
});
const body = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`OpenAI answered ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  Deno.exit(1);
}
const b64: string | undefined = body?.data?.[0]?.b64_json;
if (!b64) {
  console.error(`No image in the answer: ${JSON.stringify(body)}`);
  Deno.exit(1);
}

const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'image';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const path = `${outDir}/${slug}-${stamp}.jpg`;
await Deno.mkdir(outDir, { recursive: true });
await Deno.writeFile(path, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const usage = body.usage ? `, ${body.usage.input_tokens} in / ${body.usage.output_tokens} out tokens` : '';
console.log(`Wrote ${path} (${seconds}s${usage})`);
