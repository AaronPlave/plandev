/*
 * Handlebars helpers that render activity values as Rust literals, for F Prime Rust/WASM
 * sequence templates. Each one either produces a literal of the stated kind or throws, so a
 * value can never be spliced into the sequence as code (`{{{ }}}` would allow exactly that).
 */
import { Temporal } from '@js-temporal/polyfill';

function fail(helper: string, value: unknown, expected: string): never {
  throw new Error(`${helper}: ${JSON.stringify(value)} is not ${expected}`);
}

/** A Rust string literal: `"..."` with every character Rust would misread escaped. */
export function rustString(value: unknown): string {
  if (typeof value !== 'string') fail('rust-string', value, 'a string');
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, c => {
    switch (c) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      default: return `\\u{${c.charCodeAt(0).toString(16)}}`;
    }
  });
  return `"${escaped}"`;
}

export function rustInteger(value: unknown): string {
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) fail('rust-int', value, 'an integer');
  return text;
}

export function rustFloat(value: unknown): string {
  const n = Number(String(value).trim());
  if (String(value).trim() === '' || !Number.isFinite(n)) fail('rust-float', value, 'a finite number');
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export function rustBool(value: unknown): string {
  const text = String(value).trim();
  if (text !== 'true' && text !== 'false') fail('rust-bool', value, 'true or false');
  return text;
}

/** An enum constant (`ADD`); the F Prime macros resolve it against the argument's type. */
export function rustIdent(value: unknown): string {
  const text = String(value).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) fail('rust-ident', value, 'an identifier');
  return text;
}

/**
 * Microseconds since the Unix epoch, for `asleep(..)`. F Prime's sequencer interprets the
 * value in the deployment's time base: correct only where that base is UTC/Unix time.
 */
export function rustEpochMicros(instant: unknown): string {
  try {
    return (Temporal.Instant.from(String(instant)).epochNanoseconds / 1000n).toString();
  } catch {
    fail('rust-epoch-us', instant, 'an ISO-8601 instant');
  }
}

/** Microseconds in a duration (e.g. an activity's `startOffset`), for `rsleep(..)`. */
export function rustDurationMicros(duration: unknown): string {
  try {
    const d = Temporal.Duration.from(String(duration));
    return BigInt(Math.round(d.total({ unit: 'microseconds' }))).toString();
  } catch {
    fail('rust-duration-us', duration, 'an ISO-8601 duration');
  }
}
