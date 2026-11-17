import { Mustache } from '../../src/lib/mustache/util/index.js';
import { SequencingLanguage } from '../../src/lib/mustache/enums/language.js';

describe('Rust literal helpers', () => {
  const render = (template: string, data: any) => new Mustache(template, SequencingLanguage.TEXT).execute(data);

  it('renders typed literals', () => {
    const args = { label: 'say "hi"\\\n\u0001', count: '3', gain: '2', mode: 'ADD', on: 'true' };
    expect(
      render('X({{rust-string a.label}}, {{rust-int a.count}}, {{rust-float a.gain}}, {{rust-ident a.mode}}, {{rust-bool a.on}})', { a: args }),
    ).toEqual('X("say \\"hi\\"\\\\\\n\\u{1}", 3, 2.0, ADD, true)');
  });

  it('refuses values that would be code, not literals', () => {
    expect(() => render('{{rust-ident a.m}}', { a: { m: 'ADD); exit(1' } })).toThrow(/rust-ident/);
    expect(() => render('{{rust-int a.n}}', { a: { n: '1 + f()' } })).toThrow(/rust-int/);
    expect(() => render('{{rust-float a.n}}', { a: { n: 'NaN' } })).toThrow(/rust-float/);
    // A string can only ever become a string literal.
    expect(render('{{rust-string a.s}}', { a: { s: '"); exit(1); ("' } })).toEqual('"\\"); exit(1); (\\""');
  });

  it('converts times for asleep/rsleep', () => {
    expect(render('{{rust-epoch-us t}}', { t: '2026-01-01T00:00:01.5Z' })).toEqual('1767225601500000');
    expect(render('{{rust-duration-us d}}', { d: 'PT1M0.25S' })).toEqual('60250000');
  });
});
