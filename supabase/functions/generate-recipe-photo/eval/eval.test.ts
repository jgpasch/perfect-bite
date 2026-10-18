// The AI photo eval's harness (spec 6.11): parsing cases.json, scoring and the report, with the
// mock model; nothing touches the network.
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { MOCK_PHOTO_DESCRIPTION } from '../../_shared/ai/mock-model.ts';
import { EvalUsageError, formatReport, isRight, parseArgs, parseCases, run, type CaseOutcome, type EvalCase, type EvalIo } from './eval.ts';

const food: EvalCase = { id: 'soup', title: 'Leek soup', ingredients: ['leeks', 'potatoes'], cuisines: ['French'], isFood: true };
const abusive: EvalCase = { id: 'slime', title: 'Slime, not food', ingredients: ['glue'], cuisines: [], isFood: false };
const outcome = (c: EvalCase, isFood: boolean | null, description: string | null = null): CaseOutcome => ({ case: c, isFood, description, error: null, calls: [] });

Deno.test('parseCases accepts the shipped cases.json: about 10, both kinds', async () => {
  const cases = parseCases(JSON.parse(await Deno.readTextFile(new URL('./cases.json', import.meta.url))));
  assert(cases.length >= 8 && cases.length <= 14, `${cases.length} cases`);
  assert(cases.some((c) => c.isFood) && cases.some((c) => !c.isFood));
  assertThrows(() => parseCases({ cases: [food, food] }), EvalUsageError, 'listed twice');
  assertThrows(() => parseCases({ cases: [] }), EvalUsageError, 'invalid');
});

Deno.test('isRight: the expected answer, and food needs 1 to 60 words', () => {
  assert(isRight(outcome(food, true, 'Pale green soup in a white bowl.')));
  assert(isRight(outcome(abusive, false)));
  assert(!isRight(outcome(abusive, true, 'Green slime.')), 'a missed refusal');
  assert(!isRight(outcome(food, false)), 'a wrong refusal');
  assert(!isRight(outcome(food, null)), 'a failed call');
  assert(!isRight(outcome(food, true, Array.from({ length: 61 }, () => 'w').join(' '))));
});

Deno.test('formatReport prints each case, the totals and the bar', () => {
  const report = formatReport([outcome(food, true, 'Soup.'), outcome(abusive, true, 'Slime.')]);
  assertStringIncludes(report, 'ok   soup (expected food;');
  assertStringIncludes(report, 'MISS slime (expected refused;');
  assertStringIncludes(report, 'right:      1/2');
  assertStringIncludes(report, 'abusive:    0/1 refused');
  assertStringIncludes(report, 'bar:        NOT met');
});

Deno.test('parseArgs reads the model, --only and the prices', () => {
  assertEquals(parseArgs(['--model', 'mock', '--only', 'a', '--only=b', '--price-in', '0.3', '--price-out=2.5']), {
    model: 'mock',
    only: ['a', 'b'],
    priceIn: 0.3,
    priceOut: 2.5,
    help: false,
  });
  assertThrows(() => parseArgs(['--price-in', 'free']), EvalUsageError, 'needs a price');
  assertThrows(() => parseArgs(['--what']), EvalUsageError, 'Unknown option');
});

function io(cases: unknown): { evalIo: EvalIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    evalIo: { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), readCases: async () => JSON.stringify(cases), env: () => undefined },
    out: () => out,
    err: () => err,
  };
}

Deno.test('run scores the mock end to end and restores AI_MODEL_PHOTO_DESCRIPTION', async () => {
  const saved = Deno.env.get('AI_MODEL_PHOTO_DESCRIPTION');
  Deno.env.set('AI_MODEL_PHOTO_DESCRIPTION', 'google:untouched');
  try {
    const { evalIo, out, err } = io({ cases: [food, abusive] });
    assertEquals(await run(['--model', 'mock'], evalIo), 0);
    assertStringIncludes(err(), 'its score means nothing');
    assertStringIncludes(out(), '2 cases, model mock');
    assertStringIncludes(out(), `food: ${MOCK_PHOTO_DESCRIPTION}`);
    assertStringIncludes(out(), 'right:      2/2');
    assertEquals(Deno.env.get('AI_MODEL_PHOTO_DESCRIPTION'), 'google:untouched');
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_PHOTO_DESCRIPTION');
    else Deno.env.set('AI_MODEL_PHOTO_DESCRIPTION', saved);
  }
});

Deno.test('run refuses an unknown --only id and a missing model', async () => {
  const unknown = io({ cases: [food] });
  assertEquals(await run(['--model', 'mock', '--only', 'nope'], unknown.evalIo), 2);
  assertStringIncludes(unknown.err(), 'No case with id nope');
  const noModel = io({ cases: [food] });
  assertEquals(await run([], noModel.evalIo), 2);
  assertStringIncludes(noModel.err(), 'The eval needs a model');
});
