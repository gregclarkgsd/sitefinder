import { safeBoolean, safeBooleanWithFallback } from './values.ts';

Deno.test('safeBoolean does not treat the string false as true', () => {
  const cases: Array<[unknown, boolean]> = [
    [true, true],
    [false, false],
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['0', false],
    [1, true],
    [0, false],
    [null, false],
  ];
  for (const [input, expected] of cases) {
    if (safeBoolean(input) !== expected) {
      throw new Error(`Expected ${JSON.stringify(input)} to be ${expected}`);
    }
  }
});

Deno.test('safeBooleanWithFallback preserves an explicit false primary value', () => {
  if (safeBooleanWithFallback('false', 'true') !== false) {
    throw new Error('An explicit false primary value must not be overridden');
  }
  if (safeBooleanWithFallback(null, 'true') !== true) {
    throw new Error('The fallback should be used when the primary value is absent');
  }
});
