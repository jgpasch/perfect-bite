# LLM calls

How the app calls LLMs, how to run and inspect those calls yourself, and how to add a new one. The product rules for the calls are in [spec.md §6.4](spec.md).

## How it fits together

Every model call goes through one function, `runAiTask()` in `supabase/functions/_shared/ai/run-ai-task.ts`. It runs in the Supabase Edge Functions (Deno), never in the app, so provider keys stay on the server.

| File (under `supabase/functions/_shared/ai/`) | What it holds |
| --- | --- |
| `tasks.ts` | Every AI task: its output Zod schema, model env var, fallback, temperature, timeout, max output tokens, and mock model |
| `prompts/<task>.vN.ts` | The prompt for a task, versioned. A changed prompt is a new file and version |
| `registry.ts` | Turns a `provider:model` string (`google:gemini-3.8-flash`) into a model. A provider exists only if its key is set |
| `run-ai-task.ts` | Calls the model with structured output, retries once, tries the fallback model on API errors, logs each attempt to `ai_calls` |
| `trace.ts` | Prints each call in full for the `yarn ai:*` scripts |
| `mock-model.ts` | The deterministic fake used by tests and `--model mock` |

## Setup

Keys and model choices live in `supabase/functions/.env`. That file is gitignored (`supabase/.gitignore`); `supabase/functions/.env.example` is the committed template and must never hold a real key.

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

```ini
GOOGLE_GENERATIVE_AI_API_KEY=...          # Gemini
ANTHROPIC_API_KEY=                        # optional; Claude models
AI_MODEL_CATEGORIZE=google:gemini-3.8-flash
# AI_MODEL_CATEGORIZE_FALLBACK=anthropic:claude-haiku-5-5
```

Model values are `provider:model`, `mock` (fake, no key, no cost), or `off` (no call). In production, set them with `supabase secrets set`.

## Running a call yourself

Run from the repo root. The scripts use the function's own code, prompt and validation, with an in-memory store, so nothing is written to a database and rate limits don't apply.

```bash
yarn ai:categorize "za'atar" "chicken thighs" "call mom"   # full trace of every call
cat names.txt | yarn ai:categorize -                       # names from stdin, one per line
yarn ai:categorize --model anthropic:claude-haiku-5-5 milk # try another model for this run
yarn ai:categorize --raw milk        # also the raw HTTP request/response bodies
yarn ai:categorize --dry-run milk    # print the prompt only; no call, no cost
yarn ai:categorize --quiet milk      # just the results table and totals
yarn ai:categorize --json milk       # the exact { results } the app would get (trace on stderr)
yarn ai:categorize --model mock milk # fake model, no key needed

yarn ai:recipe <url>                 # fetch a recipe page, extract it and categorize the names
yarn ai:recipe --file page.html      # a saved page instead, sent as the client's page (no fetch)
yarn ai:recipe --model mock --categorize-model mock --file page.html  # fake models
yarn ai:recipe --quiet|--raw|--json <url>                             # as for ai:categorize

yarn ai:recipe-photo page1.jpg page2.jpg  # a recipe from photos of its pages (1 to 3), in order
yarn ai:recipe-photo IMG_0042.HEIC        # HEIC is converted to JPEG with sips (macOS) first
yarn ai:recipe-photo --model mock --categorize-model mock page.png    # fake models
yarn ai:recipe-photo --quiet|--raw|--json page.jpg                    # --raw shows image data as <N bytes base64>

yarn ai:tags "Chicken tikka" --ingredient "2 lb chicken thighs, skinless" --ingredient "1 cup yogurt"
yarn ai:tags --notes "Weeknight" --model mock "Tofu bowl"             # notes; fake model
yarn ai:tags --quiet|--raw|--dry-run|--json "<name>"                  # as for ai:categorize

yarn ai:steps <url>                  # fetch and extract a recipe page, then match its steps
yarn ai:steps --file page.html       # a saved page instead
yarn ai:steps --step "Juice one lime over the chicken" --step "Serve with the other limes" \
  --ingredient "2 lb chicken thighs" --ingredient "3 limes"           # a recipe typed in
yarn ai:steps --model mock --recipe-model mock --file page.html       # fake models
yarn ai:steps --quiet|--raw|--dry-run|--json <url>                    # as for ai:categorize
```

### What each call prints

```
━━ AI call #1 · categorize · google:gemini-3.8-flash · OK ━━━━━━━━━
call id:        …
prompt version: categorize.v2
temperature:    0
max output:     320 tokens
timeout:        20,000 ms
── instructions (system) ─────────── the system prompt
── prompt (user) ─────────────────── the user message, with the input
── response ──────────────────────── what the model returned (pretty-printed JSON)
── usage ─────────────────────────────
finish reason:  stop
input tokens:   314 (N cached, when any)
output tokens:  58 (N reasoning, when any)
total tokens:   372
latency:        4,284 ms
```

Warnings from the provider and errors get their own sections. If the main model fails and a fallback is set, the fallback prints as call #2. `--raw` adds two more sections: the exact JSON body sent to the provider (generation config and the JSON schema the model was held to) and the provider's raw reply.

After the calls come the results table and totals across all calls. Exit codes: 0 ok, 1 if any name failed, 2 for bad usage or an error. `ai:recipe` prints the recipe's name, servings, source and ingredient table, then totals per task; it exits 1 when the import fails (not a recipe, fetch failed, AI off or failing). `ai:recipe-photo` (spec 6.10) prints the same for a photo import, with the files as the source; each image shows in the prompt as its type, size and SHA-256, as `ai_calls` stores it. It uses `AI_MODEL_RECIPE_PHOTO`, else `AI_MODEL_RECIPE`, resizes a file over 2 MB to 2000 px with `sips` (and says so), and exits 1 when the import fails, 2 for an image it can't read or convert. `ai:tags` (spec 6.7) prints the suggested tags (`tags: Cuisine: Indian · Protein: Chicken`, or `-` when nothing fit) and the totals; it uses `AI_MODEL_TAGS`, else `AI_MODEL_RECIPE`, and exits 1 when the suggestion fails (AI off or failing). `ai:steps` (cook mode, spec 4.5, 6.8) runs the `match-recipe-steps` function's own handler (`matchSteps`: the request schema, the off switch, the call, its validation and the mapping back to ids) against an in-memory store that grants every feature and has no limits. The ingredients get the ids `"1"`, `"2"`, … in order. It prints each numbered step with the ingredients it uses indented under it, a split as its share ("Limes  1 of 3"), then "Not in a step" with the ones no step uses, then the totals per task; `--json` prints the request and the exact `{ steps, promptVersion }` the app would get. A link or file goes through the import's own fetch and extraction first (with `--recipe-model`, else `AI_MODEL_RECIPE`; categorize runs on the mock, since categories don't matter here). Matching uses `--model`, else `AI_MODEL_STEPS`, else `AI_MODEL_RECIPE`. It exits 1 when the import or the match fails (AI off, a provider error, an answer whose steps don't line up), or the recipe has no steps or ingredients.

### Evaluating a prompt or model change

```bash
yarn ai:eval                                      # golden set against the configured model
yarn ai:eval --model anthropic:claude-haiku-5-5   # or another model
yarn ai:eval:recipe                               # the 20 saved recipe pages against AI_MODEL_RECIPE
yarn ai:eval:steps                                # 16 labelled recipes against the steps model
yarn ai:eval:steps --only typed-chicken-tacos     # one recipe
```

`ai:eval` runs about 100 hard cases from `categorize-ingredients/eval/golden.json` and prints accuracy and every miss. `ai:eval:recipe` runs the pages in `import-recipe/eval/fixtures/` against `import-recipe/eval/expected.json` and prints per-page precision and recall on ingredient keys, unit and quantity accuracy, and every miss. `ai:eval:steps` runs `match-recipe-steps/eval/recipes.json` (fixed steps and ingredients, with hand-labelled matches) and prints precision and recall of (step, ingredient) pairs, the ingredients placed in no step, split-share accuracy, latency and tokens per recipe, whether the bar is met (docs/spikes.md §5), and every miss; `--price-in` and `--price-out` add a cost. They use the real model, so they cost tokens. Run them before shipping a new prompt version or model.

## Adding a new LLM task

For example, categories and a default weight, or parsing a recipe from a URL. Following these steps gives the new task the same logging, fallback, mock and trace output.

1. **Prompt**: create `_shared/ai/prompts/<task>.v1.ts` exporting `<TASK>_PROMPT_VERSION` and `build<Task>Prompt(input)`, which returns `{ instructions, prompt }`. Rules go in `instructions`. Untrusted input (user text, a fetched web page) goes only in `prompt`, marked as data to ignore instructions in.
2. **Task**: add an entry to `aiTasks` in `_shared/ai/tasks.ts` with:
   - an `output` Zod schema (the response is validated against it)
   - `model` and `fallbackModel`, read from `AI_MODEL_<TASK>` and `AI_MODEL_<TASK>_FALLBACK`
   - `temperature`, `timeoutMs` and `maxOutputTokens`
   - a `mock` model that returns valid output for the schema, so tests and `--model mock` need no key
3. **Call it** from the Edge Function: `runAiTask('<task>', { ...build<Task>Prompt(input), itemCount }, { onCall: logToAiCalls })`.
4. **Script**: add a `cli.ts` next to the function, modeled on `categorize-ingredients/cli.ts`:
   - call `traceAiCalls(print, { raw })` from `_shared/ai/trace.ts` before running the task, and its returned stop function after
   - support `--model`, `--raw`, `--quiet` and `--dry-run`
5. **Yarn script**: add `ai:<task>` to `package.json`, copying the `deno run … --env-file=supabase/functions/.env` line from `ai:categorize`.
6. **Tests**: Deno tests run from the function's folder with the mock model:
   `cd supabase/functions/<function> && deno test --allow-env --allow-read --allow-sys`.
