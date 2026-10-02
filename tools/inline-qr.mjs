/**
 * Inline `plugin/qr.js` into `plugin/client.js`.
 *
 * An installed bundle is registered with `window.__ModuleLoader__` as exactly
 * one module id (`<package>/client.js`) and its `require` resolves only platform
 * seed words, so the client half cannot `require('./qr.js')`. The encoder is
 * therefore carried inside the bundle, generated from its source module so the
 * two can never drift, and `tools/verify.mjs` regenerates the same text and
 * compares it against the block that is actually in the file.
 *
 * Usage: node tools/inline-qr.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const QR_PATH = new URL('../plugin/qr.js', import.meta.url)
const CLIENT_PATH = new URL('../plugin/client.js', import.meta.url)

const START = '    /* @@inlined qr.js:start@@ */'
const END = '    /* @@inlined qr.js:end@@ */'

const PREAMBLE = `    /**
     * \`plugin/qr.js\` — byte-mode QR encoder, EC level L, inlined with the
     * \`export\` keyword removed and nothing else changed.
     *
     * WHY INLINED. An installed bundle is registered with
     * \`window.__ModuleLoader__\` as exactly one module id
     * (\`<package>/client.js\`), and its \`require\` only resolves platform seed
     * words and other registered entries, so a relative import of a sibling
     * file has no registration to hit and throws. Package-local chunks are the
     * loader's other mechanism, but the bundle route only serves files matching
     * \`client.<name>.js\`. A single file is therefore the only shape that works
     * from the install path, while the source module stays separate so
     * \`tools/verify.mjs\` can import and unit-test it under Node.
     */`

/** The inlined IIFE, generated from `plugin/qr.js`. Exported for verification. */
export function renderInlinedQr(source = readFileSync(QR_PATH, 'utf8')) {
  const body = source
    .replace(/^export /gmu, '')
    .replace(/\s+$/u, '')
    .split('\n')
    .map(line => (line === '' ? '' : `      ${line}`))
    .join('\n')
  return [
    START,
    PREAMBLE,
    '    const __mcQr = (function () {',
    body,
    '      return { encodeQr, assertEncoderSoundness }',
    '    })()',
    END,
  ].join('\n')
}

/** Replace the marked block in one client source with the generated text. */
export function inlineQr(clientSource, source) {
  const start = clientSource.indexOf(START)
  const end = clientSource.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error('client.js is missing the @@inlined qr.js@@ markers')
  }
  return clientSource.slice(0, start) + renderInlinedQr(source) + clientSource.slice(end + END.length)
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, '/')}`).href) {
  const client = readFileSync(CLIENT_PATH, 'utf8')
  const next = inlineQr(client)
  writeFileSync(CLIENT_PATH, next)
  console.log(`inline-qr: client.js is ${String(next.length)} bytes`)
}
