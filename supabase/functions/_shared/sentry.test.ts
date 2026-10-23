import { assertEquals } from '@std/assert';

import { startFakeSentry } from './fake-sentry.ts';

// A failed ai_calls insert reaches Sentry: a local server stands in for it, and SENTRY_DSN points
// there before sentry.ts is loaded (it reads the DSN once, on import).

Deno.test({
  name: "runAiTask sends a failed ai_calls insert to Sentry and still returns the model's answer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const sentry = startFakeSentry();
    Deno.env.set('SENTRY_DSN', sentry.dsn);
    Deno.env.set('AI_MODEL_CATEGORIZE', 'mock');
    try {
      const { runAiTask } = await import('./ai/run-ai-task.ts');
      const res = await runAiTask(
        'categorize',
        { instructions: 'rules', prompt: 'Items:\n["milk"]', itemCount: 1 },
        // What supabase-js returns for a failed insert: a plain object, not an Error.
        {
          onCall: () =>
            Promise.reject({
              message: "Could not find the 'error_body' column of 'ai_calls' in the schema cache",
              code: 'PGRST204',
              details: null,
              hint: null,
            }),
        },
      );
      assertEquals(res.model, 'mock');

      await sentry.waitFor(1);
      assertEquals(sentry.events.length, 1);
      const [event] = sentry.events;
      assertEquals(event.exception, "Could not find the 'error_body' column of 'ai_calls' in the schema cache (PGRST204)");
      assertEquals([event.tags.function, event.tags.event, event.tags.task], ['ai_calls', 'ai_call_log_failed', 'categorize']);
    } finally {
      Deno.env.delete('SENTRY_DSN');
      Deno.env.delete('AI_MODEL_CATEGORIZE');
      await sentry.server.shutdown();
    }
  },
});
