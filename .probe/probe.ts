import { generateText, Output, NoObjectGeneratedError } from 'npm:ai@7.0.128';
import { createGoogleGenerativeAI } from 'npm:@ai-sdk/google@4.0.88';
import { createAnthropic } from 'npm:@ai-sdk/anthropic@4.0.72';
import { createOpenAI } from 'npm:@ai-sdk/openai@4';
import { z } from 'npm:zod@4.6.5';

const json = (b: unknown) => async () => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const schema = z.object({ a: z.string() });
// deno-lint-ignore no-explicit-any
async function run(label: string, model: any) {
  try {
    const r = await generateText({ model, output: Output.object({ schema }), prompt: 'x', maxRetries: 0 });
    let out;
    try {
      out = r.output;
    } catch (e) {
      out = `THROWS ${(e as Error).name}`;
    }
    // deno-lint-ignore no-explicit-any
    console.log(label, 'OK finish=', JSON.stringify(r.finishReason), 'raw=', JSON.stringify((r as any).rawFinishReason), 'text=', JSON.stringify(r.text), 'out=', out, 'pm=', JSON.stringify(r.providerMetadata), 'content=', JSON.stringify(r.content));
    // deno-lint-ignore no-explicit-any
  } catch (e: any) {
    console.log(label, 'THREW', e.name, e.message, 'finish=', JSON.stringify(e.finishReason), NoObjectGeneratedError.isInstance(e));
  }
}
const g = (b: unknown) => createGoogleGenerativeAI({ apiKey: 'k', fetch: json(b) as never })('gemini-x');
await run('gemini promptFeedback', g({ promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] }, usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }));
await run('gemini SAFETY finish', g({ candidates: [{ finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', probability: 'HIGH', blocked: true }] }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }));
await run('gemini SAFETY finish w/ content', g({ candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 } }));
await run('gemini PROHIBITED_CONTENT', g({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }));
await run('gemini promptFeedback PROHIBITED', g({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }));
const a = createAnthropic({ apiKey: 'k', fetch: json({ id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } }) as never })('claude-x');
await run('anthropic refusal', a);
const o = (b: unknown) => createOpenAI({ apiKey: 'k', fetch: json(b) as never });
await run('openai chat refusal', o({ id: 'c', object: 'chat.completion', created: 1, model: 'g', choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: "I can't help with that." }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }).chat('gpt-x'));
await run('openai chat content_filter', o({ id: 'c', object: 'chat.completion', created: 1, model: 'g', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }).chat('gpt-x'));
await run('openai responses refusal', o({ id: 'r', object: 'response', created_at: 1, model: 'g', status: 'completed', output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: "I can't help with that." }] }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }).responses('gpt-x'));
