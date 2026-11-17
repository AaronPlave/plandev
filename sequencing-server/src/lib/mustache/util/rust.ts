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

const INTEGER_TYPES: Record<string, [bigint, bigint]> = Object.fromEntries(
  [8, 16, 32, 64].flatMap(bits => [
    [`u${bits}`, [0n, 2n ** BigInt(bits) - 1n]],
    [`i${bits}`, [-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits - 1) - 1n]],
  ]),
);
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * An integer literal. With a type (`{{rust-int v "u8"}}`) the value must fit it. Activity
 * arguments reach templates as JavaScript numbers, so integers beyond ±2^53 may already have been
 * rounded: those are refused rather than silently changed.
 */
export function rustInteger(value: unknown, type?: string): string {
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) fail('rust-int', value, 'an integer');
  const n = BigInt(text);
  if (n > SAFE || n < -SAFE) fail('rust-int', value, 'exactly representable (|n| ≤ 2^53 - 1); activity values are doubles');
  if (type !== undefined) {
    const range = INTEGER_TYPES[type] ?? fail('rust-int', type, `an integer type (${Object.keys(INTEGER_TYPES).join(', ')})`);
    if (n < range[0] || n > range[1]) fail('rust-int', value, `in range for ${type} [${range[0]}, ${range[1]}]`);
  }
  return n.toString();
}

const F32_MAX = 3.4028234663852886e38;

/** A float literal (always with `.`/`e`, so Rust reads it as a float). `"f32"` checks the range. */
export function rustFloat(value: unknown, type?: string): string {
  const text = String(value).trim();
  const n = Number(text);
  if (text === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) || !Number.isFinite(n)) {
    fail('rust-float', value, 'a finite decimal number');
  }
  if (type !== undefined && type !== 'f32' && type !== 'f64') fail('rust-float', type, 'f32 or f64');
  if (type === 'f32' && Math.abs(n) > F32_MAX) fail('rust-float', value, 'in range for f32');
  const literal = String(n);
  return /[.eE]/.test(literal) ? literal : `${literal}.0`;
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

const ELEMENT: Record<string, (v: unknown, type?: string) => string> = {
  bool: rustBool,
  float: rustFloat,
  ident: rustIdent,
  int: rustInteger,
  string: v => rustString(typeof v === 'string' ? v : fail('rust-array', v, 'a string')),
};

/**
 * An array literal from an array-valued activity argument: `{{rust-array v "float" "f32"}}`.
 * Every element is rendered by the named element helper. Structs have no generic Rust literal form
 * in the generated API, so struct-valued arguments are refused.
 */
export function rustArray(value: unknown, kind: string, type?: string): string {
  let items: unknown = value;
  if (typeof value === 'string') {
    try {
      items = JSON.parse(value);
    } catch {
      fail('rust-array', value, 'an array');
    }
  }
  if (!Array.isArray(items)) fail('rust-array', value, 'an array');
  const element = ELEMENT[kind] ?? fail('rust-array', kind, `an element kind (${Object.keys(ELEMENT).join(', ')})`);
  return `[${items.map(item => element(typeof item === 'object' && item !== null ? fail('rust-array', item, 'a scalar') : item, type)).join(', ')}]`;
}

/**
 * Microseconds from the deployment's time epoch, for `asleep(..)`. fprime-wasm defines the value
 * as "microseconds from system epoch", and which epoch (and clock) that is depends on the
 * deployment's time base, so the template must say: `{{rust-epoch-us startTime epoch="1970-01-01T00:00:00Z"}}`.
 * The difference is counted in POSIX (UTC, no leap second) microseconds.
 */
export function rustEpochMicros(instant: unknown, epoch: unknown): string {
  if (epoch === undefined || epoch === null || epoch === '') {
    throw new Error(
      'rust-epoch-us: give the deployment\'s time epoch, e.g. {{rust-epoch-us startTime epoch="1970-01-01T00:00:00Z"}}. ' +
        "asleep() takes microseconds since the flight software's system epoch, which depends on its time base.",
    );
  }
  let at: Temporal.Instant;
  let zero: Temporal.Instant;
  try {
    at = Temporal.Instant.from(String(instant));
  } catch {
    fail('rust-epoch-us', instant, 'an ISO-8601 instant');
  }
  try {
    zero = Temporal.Instant.from(String(epoch));
  } catch {
    fail('rust-epoch-us', epoch, 'an ISO-8601 instant (the epoch)');
  }
  const micros = (at.epochNanoseconds - zero.epochNanoseconds) / 1000n;
  if (micros < 0n) fail('rust-epoch-us', instant, `at or after the epoch ${epoch}`);
  return micros.toString();
}

/** Microseconds in a duration (e.g. an activity's `startOffset`), for `rsleep(..)`. */
export function rustDurationMicros(duration: unknown): string {
  let micros: number;
  try {
    micros = Temporal.Duration.from(String(duration)).total({ unit: 'microseconds' });
  } catch {
    fail('rust-duration-us', duration, 'an ISO-8601 duration of days or less (months/years vary in length)');
  }
  if (micros < 0) fail('rust-duration-us', duration, 'a non-negative duration');
  if (!Number.isSafeInteger(Math.round(micros)) || Math.abs(micros - Math.round(micros)) > 1e-6) {
    fail('rust-duration-us', duration, 'a whole number of microseconds');
  }
  return String(Math.round(micros));
}
