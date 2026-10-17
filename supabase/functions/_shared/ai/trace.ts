// Human-readable dump of AI calls for the `yarn ai:*` scripts: what was sent, what came back, the
// tokens and the time. Any task's dev script installs it with `traceAiCalls()`.
import { setAiTraceListener, type AiTrace } from './run-ai-task.ts';

export type TraceOptions = {
  /** Also print the raw HTTP request and response bodies the provider saw. */
  raw?: boolean;
  /** Applied to the raw bodies before they're printed, e.g. to shorten image data. */
  redact?: (body: unknown) => unknown;
};

function section(title: string, body: string): string {
  return `── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}\n${body}`;
}

/** JSON text is re-indented so a structured answer reads as one field per line. */
function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

const count = (n: number | null) => (n === null ? '?' : n.toLocaleString('en-US'));

export function formatAiTrace(trace: AiTrace, n: number, options: TraceOptions = {}): string {
  const header = `━━ AI call #${n} · ${trace.task} · ${trace.model} · ${trace.status.toUpperCase()} `;
  const total = trace.input_tokens === null && trace.output_tokens === null ? null : (trace.input_tokens ?? 0) + (trace.output_tokens ?? 0);
  const facts = [
    ['call id', trace.id],
    ...(trace.fallback_of ? [['fallback of', trace.fallback_of]] : []),
    ['prompt version', trace.prompt_version],
    ['temperature', String(trace.temperature)],
    ['max output', `${count(trace.max_output_tokens)} tokens`],
    ['timeout', `${count(trace.timeout_ms)} ms`],
  ];
  const usage = [
    ['finish reason', trace.finish_reason ?? '?'],
    ['input tokens', `${count(trace.input_tokens)}${trace.cached_input_tokens ? ` (${count(trace.cached_input_tokens)} cached)` : ''}`],
    ['output tokens', `${count(trace.output_tokens)}${trace.reasoning_tokens ? ` (${count(trace.reasoning_tokens)} reasoning)` : ''}`],
    ['total tokens', count(total)],
    ['latency', `${count(trace.duration_ms)} ms`],
  ];
  const kv = (rows: string[][]) => rows.map(([k, v]) => `${(k + ':').padEnd(16)}${v}`).join('\n');

  const parts = [
    header + '━'.repeat(Math.max(0, 64 - [...header].length)),
    kv(facts),
    section('instructions (system)', trace.instructions),
    section('prompt (user)', trace.prompt),
    section('response', trace.response_text === null ? '(none)' : pretty(trace.response_text)),
  ];
  if (trace.warnings.length > 0) parts.push(section('warnings', pretty(trace.warnings)));
  if (trace.error) parts.push(section('error', trace.error));
  parts.push(section('usage', kv(usage)));
  if (options.raw) {
    const redact = options.redact ?? ((body: unknown) => body);
    parts.push(section('raw request body', trace.request_body === null ? '(none)' : pretty(redact(trace.request_body))));
    parts.push(section('raw response body', trace.response_body === null ? '(none)' : pretty(redact(trace.response_body))));
  }
  return parts.join('\n') + '\n';
}

/**
 * Prints every AI call made until the returned stop function is called, each as it finishes
 * (fallback attempts included). Returns the stop function.
 */
export function traceAiCalls(print: (text: string) => void, options: TraceOptions = {}): () => void {
  let n = 0;
  setAiTraceListener((trace) => print(formatAiTrace(trace, ++n, options)));
  return () => setAiTraceListener(null);
}
