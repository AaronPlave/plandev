import { readFileSync } from 'node:fs';

/** The sequencing-server version, recorded on every Generation's expansion snapshot. */
export const GENERATOR_VERSION: string = (() => {
  try {
    // Resolves to sequencing-server/package.json from both src/ (tests) and build/ (runtime).
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();
