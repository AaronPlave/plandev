import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';

// Build-time configuration for the adaptation (see adaptation.js).
const config = {
  load: id => (id === 'fprime:config' ? `export const lspUrl = ${JSON.stringify(process.env.FPRIME_LSP_URL ?? null)};` : null),
  name: 'fprime-config',
  resolveId: id => (id === 'fprime:config' ? id : null),
};

// SeqDev injects these into adaptations: they must be the page's own instances.
const pageModules = /^(@codemirror\/(state|view|language|commands|autocomplete|lint)|@lezer\/(common|highlight|lr))$/;

export default [
  {
    external: id => pageModules.test(id),
    input: 'adaptation.js',
    output: { file: 'dist/adaptation.js', format: 'cjs', inlineDynamicImports: true },
    plugins: [config, nodeResolve({ browser: true }), commonjs()],
  },
  // Actions: the action server evaluates these as scripts, so `main` must stay a top-level function.
  ...['fprime-compile', 'fprime-new-sequence', 'fprime-test'].map(name => ({
    external: ['crypto'],
    input: `${name}.js`,
    output: { file: `dist/${name}.js`, format: 'cjs' },
    plugins: [nodeResolve(), commonjs()],
    treeshake: { moduleSideEffects: false },
  })),
];
