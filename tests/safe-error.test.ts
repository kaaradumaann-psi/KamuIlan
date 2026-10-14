import { describe, expect, it } from 'vitest';
import { safeErrorFields } from '../src/lib/safe-error';

describe('safeErrorFields', () => {
  it('omits error messages and stack contents that may contain record data', () => {
    const privateValue = 'private.person@example.test';
    const error = Object.assign(new Error(`duplicate key for ${privateValue}`), {
      code: '23505',
      stack: `Error: ${privateValue}\n    at query (${privateValue}:1:2)`,
    });

    const fields = safeErrorFields(error);

    expect(fields).toEqual({ errorType: 'Error', code: '23505' });
    expect(JSON.stringify(fields)).not.toContain(privateValue);
  });

  it('ignores malformed or overlong error codes', () => {
    const malformed = Object.assign(new Error('unsafe'), { code: 'value@example.test' });
    const tooLong = Object.assign(new Error('unsafe'), { code: 'x'.repeat(41) });

    expect(safeErrorFields(malformed)).toEqual({ errorType: 'Error' });
    expect(safeErrorFields(tooLong)).toEqual({ errorType: 'Error' });
  });

  it('reports a safe class label and non-Error primitive type', () => {
    class DatabaseFault extends Error {}

    expect(safeErrorFields(new DatabaseFault('private'))).toEqual({ errorType: 'DatabaseFault' });
    expect(safeErrorFields('private text')).toEqual({ errorType: 'string' });
  });
});
