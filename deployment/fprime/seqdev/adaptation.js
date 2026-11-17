// SeqDev sequence adaptation for F Prime parcels: `.seq` (fprime-seqgen) and `.rs` (fprime-wasm)
// against one F Prime dictionary. Built by `npm run build` into dist/adaptation.js and uploaded
// by setup.py; see ../README.md.
import { getFprimeAdaptation } from '@nasa-jpl/plandev-sequence-languages';
import { lspUrl as configuredLspUrl } from 'fprime:config';

// The toolchain service's rust-analyzer endpoint. Default: same host as SeqDev, port 9257 (the
// browser then sends the SeqDev cookie with the connection). Set FPRIME_LSP_URL at build time
// when the service is published elsewhere, e.g. behind the deployment's reverse proxy. An empty
// value disables it: `.rs` files then get highlighting and dictionary completion only.
const lspUrl =
  configuredLspUrl ??
  (typeof location === 'undefined'
    ? undefined
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:9257/lsp`);

export const adaptation = getFprimeAdaptation({ lspUrl: lspUrl || undefined });
