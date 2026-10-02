/**
 * Independent QR readability check: encode with plugin/qr.js, decode with jsQR.
 *
 * The structural assertions in `tools/verify.mjs` (and the copy inlined into
 * `plugin/client.js`) prove the symbol is well-formed. Only a real decoder
 * proves it is READABLE, and an independent implementation is what makes that
 * evidence rather than a restatement of the encoder's own assumptions.
 *
 * The payload set spans versions 1-10 on purpose: capacity, block splitting and
 * interleaving all change with the version, and each was a separate defect an
 * earlier draft of this encoder got wrong.
 *
 * Usage: node tools/qr-decode.mjs   (requires `pnpm install` first)
 *
 * Exported as a function so `tools/verify.mjs` can fold it into the one command
 * that has to pass.
 */
import { encodeQr } from '../plugin/qr.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const SCALE = 4
const QUIET = 4

/** Payloads chosen to walk the version table, not to look realistic. */
const PAYLOADS = [
  'A',
  'http://127.0.0.1:19387',
  'http://192.168.1.24:19387/?token=0123456789abcdef',
  'http://10.0.0.7:19387/?token=' + 'f'.repeat(64),
  'http://192.168.31.9:19387/?token=abc&x=1',
  'http://192.168.31.9:19387/?token=' + 'a1b2c3d4'.repeat(8),
  'x'.repeat(200),
  'https://example.com/' + 'y'.repeat(250),
]

/** Render a module matrix to the RGBA buffer jsQR consumes. */
function toRgba(matrix) {
  const extent = matrix.size + QUIET * 2
  const pixels = extent * SCALE
  const data = new Uint8ClampedArray(pixels * pixels * 4)
  for (let y = 0; y < pixels; y += 1) {
    for (let x = 0; x < pixels; x += 1) {
      const mx = Math.floor(x / SCALE) - QUIET
      const my = Math.floor(y / SCALE) - QUIET
      const inSymbol = mx >= 0 && my >= 0 && mx < matrix.size && my < matrix.size
      const dark = inSymbol && matrix.modules[my][mx] === 1
      const value = dark ? 0 : 255
      const at = (y * pixels + x) * 4
      data[at] = value
      data[at + 1] = value
      data[at + 2] = value
      data[at + 3] = 255
    }
  }
  return { data, width: pixels, height: pixels }
}

/**
 * Round-trip every payload through an independent decoder.
 *
 * @param decode - the decoder, injected so this module carries no dependency.
 * @returns `{ passed, failures, versions }`.
 */
export function roundTrip(decode) {
  const failures = []
  const versions = new Set()
  let passed = 0
  for (const payload of PAYLOADS) {
    const matrix = encodeQr(payload)
    versions.add(matrix.version)
    const image = toRgba(matrix)
    const result = decode(image.data, image.width, image.height)
    if (result === null) {
      failures.push(`"${payload.slice(0, 40)}" (v${matrix.version}, size ${matrix.size}) decoded as nothing`)
      continue
    }
    if (result.data !== payload) {
      failures.push(`"${payload.slice(0, 40)}" round-tripped as "${result.data.slice(0, 40)}"`)
      continue
    }
    passed += 1
  }
  return { passed, failures, versions: [...versions].sort((left, right) => left - right) }
}

/* Standalone run. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const jsQR = (await import('jsqr')).default
  const { passed, failures, versions } = roundTrip(jsQR)
  console.log(`qr round-trip through jsQR: ${passed}/${PAYLOADS.length} decoded, versions ${versions.join(',')}`)
  if (failures.length > 0) {
    for (const failure of failures) console.error('  - ' + failure)
    process.exitCode = 1
  }
}
