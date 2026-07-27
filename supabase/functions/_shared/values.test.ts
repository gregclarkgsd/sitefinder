import { safeBoolean } from './values.ts';

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
