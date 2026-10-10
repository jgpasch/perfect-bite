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
```

### What each call prints

```
━━ AI call #1 · categorize · google:gemini-3.8-flash · OK ━━━━━━━━━
call id:        …
prompt version: categorize.v1
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

After the calls come the results table and totals across all calls. Exit codes: 0 ok, 1 if any name failed, 2 for bad usage or an error.

### Evaluating a prompt or model change

```bash
yarn ai:eval                                      # golden set against the configured model
yarn ai:eval --model anthropic:claude-haiku-5-5   # or another model
```

It runs about 100 hard cases from `categorize-ingredients/eval/golden.json` and prints accuracy and every miss. It uses the real model, so it costs tokens. Run it before shipping a new prompt version or model.

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
