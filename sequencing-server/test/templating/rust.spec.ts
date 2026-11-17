import { Mustache } from '../../src/lib/mustache/util/index.js';
import { SequencingLanguage } from '../../src/lib/mustache/enums/language.js';
import { stringifyActivity } from '../../src/lib/mustache/util/activity.js';

describe('Rust literal helpers', () => {
  const render = (template: string, data: any) => new Mustache(template, SequencingLanguage.TEXT).execute(data);

  it('renders typed literals', () => {
    const args = { label: 'say "hi"\\\n\u0001', count: '3', gain: '2', mode: 'ADD', on: 'true' };
    expect(
      render('X({{rust-string a.label}}, {{rust-int a.count}}, {{rust-float a.gain}}, {{rust-ident a.mode}}, {{rust-bool a.on}})', { a: args }),
    ).toEqual('X("say \\"hi\\"\\\\\\n\\u{1}", 3, 2.0, ADD, true)');
    expect(render('{{rust-float a.x}}', { a: { x: '1e21' } })).toEqual('1e+21');
    expect(render('{{rust-float a.x}}', { a: { x: '-0.5' } })).toEqual('-0.5');
  });

  it('refuses values that would be code, not literals', () => {
    expect(() => render('{{rust-ident a.m}}', { a: { m: 'ADD); exit(1' } })).toThrow(/rust-ident/);
    expect(() => render('{{rust-int a.n}}', { a: { n: '1 + f()' } })).toThrow(/rust-int/);
    expect(() => render('{{rust-float a.n}}', { a: { n: 'NaN' } })).toThrow(/rust-float/);
    expect(() => render('{{rust-float a.n}}', { a: { n: '0x10' } })).toThrow(/rust-float/);
    // A string can only ever become a string literal.
    expect(render('{{rust-string a.s}}', { a: { s: '"); exit(1); ("' } })).toEqual('"\\"); exit(1); (\\""');
  });

  it('checks numeric ranges instead of letting precision or width change values', () => {
    expect(render('{{rust-int a.n "u8"}}', { a: { n: '255' } })).toEqual('255');
    expect(() => render('{{rust-int a.n "u8"}}', { a: { n: '256' } })).toThrow(/in range for u8/);
    expect(() => render('{{rust-int a.n "i8"}}', { a: { n: '-129' } })).toThrow(/in range for i8/);
    expect(() => render('{{rust-int a.n "u7"}}', { a: { n: '1' } })).toThrow(/an integer type/);
    // 2^53 + 1 cannot have survived as a JavaScript number.
    expect(() => render('{{rust-int a.n}}', { a: { n: '9007199254740993' } })).toThrow(/exactly representable/);
    expect(() => render('{{rust-float a.x "f32"}}', { a: { x: '1e39' } })).toThrow(/in range for f32/);
  });

  it('renders arrays element by element', () => {
    expect(render('{{rust-array a.v "float" "f32"}}', { a: { v: '[1, 2.5]' } })).toEqual('[1.0, 2.5]');
    expect(render('{{rust-array a.v "string"}}', { a: { v: '["a\\"b"]' } })).toEqual('["a\\"b"]');
    expect(() => render('{{rust-array a.v "int" "u8"}}', { a: { v: '[1, 300]' } })).toThrow(/u8/);
    expect(() => render('{{rust-array a.v "int"}}', { a: { v: '[{"x": 1}]' } })).toThrow(/a scalar/);
    expect(() => render('{{rust-array a.v "int"}}', { a: { v: '5' } })).toThrow(/an array/);
  });

  it('passes structured activity arguments as JSON, not "[object Object]"', async () => {
    const activity = stringifyActivity({
      attributes: { arguments: { v: [1, 2] } },
      startOffset: 'PT0S',
      startTime: '2026-01-01T00:00:00Z',
    } as any);
    expect(render('{{rust-array a.attributes.arguments.v "int"}}', { a: activity })).toEqual('[1, 2]');
    // Values with their own string form (Temporal durations) are not JSON-quoted.
    const { Temporal } = await import('@js-temporal/polyfill');
    const timed = stringifyActivity({
      attributes: { arguments: { d: Temporal.Duration.from('PT3600S') } },
      startOffset: 'PT0S',
      startTime: '2026-01-01T00:00:00Z',
    } as any);
    expect(timed.attributes.arguments['d']).toEqual('PT3600S');
  });

  it('needs the deployment epoch for absolute times', () => {
    expect(() => render('{{rust-epoch-us t}}', { t: '2026-01-01T00:00:01.5Z' })).toThrow(/time epoch/);
    expect(render('{{rust-epoch-us t epoch="1970-01-01T00:00:00Z"}}', { t: '2026-01-01T00:00:01.5Z' })).toEqual(
      '1767225601500000',
    );
    // A mission clock counting from J2000 (as POSIX seconds; no leap seconds).
    expect(render('{{rust-epoch-us t epoch="2000-01-01T12:00:00Z"}}', { t: '2000-01-01T12:00:01Z' })).toEqual('1000000');
    expect(() => render('{{rust-epoch-us t epoch="2030-01-01T00:00:00Z"}}', { t: '2026-01-01T00:00:00Z' })).toThrow(
      /at or after the epoch/,
    );
  });

  it('converts relative durations to microseconds', () => {
    expect(render('{{rust-duration-us d}}', { d: 'PT1M0.25S' })).toEqual('60250000');
    expect(() => render('{{rust-duration-us d}}', { d: '-PT1S' })).toThrow(/non-negative/);
    expect(() => render('{{rust-duration-us d}}', { d: 'PT0.0000001S' })).toThrow(/whole number of microseconds/);
    expect(() => render('{{rust-duration-us d}}', { d: 'P1M' })).toThrow(/days or less/);
  });
});
