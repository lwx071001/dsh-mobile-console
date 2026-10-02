/**
 * mobile-console — CLIENT half.
 *
 * One job: hand this page's URL to a phone. The panel that does it is a small
 * window beside the sidebar — it never covers the interface, never re-registers
 * a shipped slot, and never changes what the page is showing, so the main
 * interface stays exactly where it was and closing the panel is the only way it
 * ends.
 *
 * WHAT IT OPENS IS THE REAL GUI. The phone is pointed at this deployment's own
 * browser surface through the Host half's LAN bridge, with the process launch
 * token the bridge hands back. The phone therefore runs the shipped interface
 * over the shipped protocol — there is no second client to keep in step and no
 * reduced "phone mode" whose gaps would show up as missing features.
 *
 * WHAT IT DELIBERATELY IS NOT. No session list, no transcript, no composer, no
 * approval answering: every one of those is the shipped GUI's own job, and a
 * parallel copy of them on this side is a second implementation of the same
 * durable log. This half owns a QR code, one address, and a switch.
 *
 * WHY ITS OWN ROOT. The panel is a `position: fixed` layer appended to
 * `<body>`, not a seat in the shell's slot tree. Overlay seats are ordered
 * children of a column's own render tree, so mounting there would tie the
 * panel's lifetime to that column staying mounted — and the shell unmounts
 * columns as panels change. The one seat this plugin takes is
 * `sidebar.footer.action`, because that is genuinely a row in the sidebar.
 */

window.__ModuleLoader__.load({
  id: '@local/mobile-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ================================================================ *
     * Constants
     * ================================================================ */

    /** Read the bridge state and the phone URL. */
    const HANDOFF_PATH = '/api/mobile-console/handoff'

    /** Start or stop the bridge. */
    const BRIDGE_PATH = '/api/mobile-console/bridge'

    /** The sidebar foot, beside Settings. */
    const FOOTER_SLOT = 'sidebar.footer.action'

    /** Attribute the outside-click guard uses to recognise the launcher. */
    const LAUNCHER_ATTR = 'data-mobile-console-launcher'

    /**
     * The QR symbol is black on white in every theme, and that is deliberate:
     * it is a machine-readable symbol, not a themed surface. A dark-mode token
     * pair here would be a code many phone cameras refuse to read.
     */
    const CSS = `
.mc-window {
  --mc-touch: 40px;
  --mc-gap: 10px;
  position: fixed;
  left: 12px;
  bottom: 64px;
  z-index: 60;
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 96px);
  overflow: auto;
  padding: 14px;
  text-align: left;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  box-shadow: 0 16px 40px var(--dsw-alias-bg-overlay);
}
.mc-window * { box-sizing: border-box; }
.mc-head { display: flex; align-items: center; gap: var(--mc-gap); }
.mc-title { flex: 1 1 auto; font-size: 14px; font-weight: 600; }
.mc-x {
  appearance: none; -webkit-appearance: none;
  flex: 0 0 auto;
  width: 28px; height: 28px; padding: 0;
  font: inherit; font-size: 14px; line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: transparent; border: none; border-radius: 8px; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.mc-x:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mc-body { margin-top: 10px; }
.mc-lead { margin: 0 0 var(--mc-gap); font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.mc-primary {
  appearance: none; -webkit-appearance: none;
  display: block; width: 100%; min-height: var(--mc-touch);
  margin: 0; padding: 10px 14px;
  font: inherit; font-size: 14px; font-weight: 600;
  /* The primary action is marked by its brighter label and heavier weight, not
     by a filled brand block: on this surface a solid accent reads as a glare
     patch rather than as emphasis. */
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; cursor: pointer;
  transition: border-color 120ms ease, transform 80ms ease;
  -webkit-tap-highlight-color: transparent;
}
.mc-primary:hover { border-color: var(--dsw-alias-border-l2); }
.mc-primary:active { transform: scale(0.99); }
.mc-primary[disabled] { opacity: 0.6; cursor: default; }
.mc-stop {
  appearance: none; -webkit-appearance: none;
  display: block; width: 100%; min-height: var(--mc-touch);
  margin: var(--mc-gap) 0 0; padding: 10px 14px;
  font: inherit; font-size: 14px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.mc-stop:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.mc-qr {
  display: block;
  width: 100%; max-width: 236px;
  margin: 0 auto var(--mc-gap);
  background: var(--dsw-alias-bg-base);
  border-radius: 10px;
}
.mc-url {
  display: block; width: 100%;
  padding: 8px 10px;
  font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  user-select: all; -webkit-user-select: all;
}
.mc-copy {
  appearance: none; -webkit-appearance: none;
  display: block; width: 100%; min-height: var(--mc-touch);
  margin: 6px 0 0; padding: 8px 14px;
  font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.mc-steps { margin: var(--mc-gap) 0 0; padding-left: 20px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-primary); }
.mc-steps li { margin: 2px 0; }
.mc-note { margin: var(--mc-gap) 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.mc-error {
  margin: var(--mc-gap) 0 0; padding: 9px 11px;
  font-size: 12px; line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 9px;
}
.mc-launcher {
  appearance: none; -webkit-appearance: none;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  /* The footer-action slot is a centred flex row that also holds the cordis
     panel chip, so the bar takes every pixel left over instead of a fixed
     100%: flex-basis starts at the full width and flex-shrink hands the
     sibling its natural size back. */
  flex: 1 1 auto;
  width: 100%; min-width: 0;
  align-self: center;
  min-height: 32px;
  margin: 2px 0; padding: 5px 14px;
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1.4;
  white-space: nowrap; overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  /* No fill of its own: the capsule must sit on the sidebar's own surface, so
     it shows exactly the background behind it (transparent — not a token that
     merely looks close), and the border alone draws the capsule. */
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, transform 80ms ease;
  -webkit-tap-highlight-color: transparent;
}
.mc-launcher:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.mc-launcher:active { transform: scale(0.99); }
.mc-launcher[data-on="true"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.mc-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.mc-dot[data-on="true"] { background: var(--dsw-alias-state-success-primary); }
@media (max-width: 560px) {
  .mc-window { left: 8px; right: 8px; width: auto; bottom: 8px; max-height: calc(100vh - 16px); }
}
`

    /* @@inlined qr.js:start@@ */
    /**
     * `plugin/qr.js` — byte-mode QR encoder, EC level L, inlined with the
     * `export` keyword removed and nothing else changed.
     *
     * WHY INLINED. An installed bundle is registered with
     * `window.__ModuleLoader__` as exactly one module id
     * (`<package>/client.js`), and its `require` only resolves platform seed
     * words and other registered entries, so a relative import of a sibling
     * file has no registration to hit and throws. Package-local chunks are the
     * loader's other mechanism, but the bundle route only serves files matching
     * `client.<name>.js`. A single file is therefore the only shape that works
     * from the install path, while the source module stays separate so
     * `tools/verify.mjs` can import and unit-test it under Node.
     */
    const __mcQr = (function () {
      /**
       * mobile-console — QR encoder (byte mode, EC level L).
       *
       * A self-contained ISO/IEC 18004 encoder for the one thing this plugin needs:
       * a byte-mode QR symbol big enough for a LAN URL (a token-bearing link is well
       * under 200 bytes, so versions 1-10 cover it and no alphanumeric or kanji mode
       * is warranted).
       *
       * WHY HAND-ROLLED. The client bundle is a classic script resolved through
       * `window.__ModuleLoader__`, whose require table is a fixed platform seed
       * (`react`, `react-dom`, `@deepseek-ai/*`). A third-party QR package is not in
       * it, and a vendored copy would be several hundred kilobytes for one glyph.
       * The encoder is therefore written here and pinned by structure assertions
       * (`assertEncoderSoundness`) that check the generated matrix against facts the
       * specification guarantees — they would fail on a wrong block split, a missing
       * format bit, or a misplaced timing pattern.
       *
       * Reference: ISO/IEC 18004:2015, sections 7.4 (data encoding), 7.5 (error
       * correction), 7.7 (module placement), 7.8 (format and version information).
       */

      /* ------------------------------------------------------------------ *
       * Galois field GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d)
       * ------------------------------------------------------------------ */

      const EXP = new Uint8Array(512)
      const LOG = new Uint8Array(256)
      ;(function initField() {
        let x = 1
        for (let i = 0; i < 255; i += 1) {
          EXP[i] = x
          LOG[x] = i
          x <<= 1
          if (x & 0x100) x ^= 0x11d
        }
        for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
      })()

      /** Multiply two field elements. */
      function gfMul(a, b) {
        if (a === 0 || b === 0) return 0
        return EXP[LOG[a] + LOG[b]]
      }

      /** Generator polynomial for `degree` error-correction codewords. */
      function generatorPoly(degree) {
        let poly = [1]
        for (let i = 0; i < degree; i += 1) {
          const next = new Array(poly.length + 1).fill(0)
          for (let j = 0; j < poly.length; j += 1) {
            next[j] ^= poly[j]
            next[j + 1] ^= gfMul(poly[j], EXP[i])
          }
          poly = next
        }
        return poly
      }

      /**
       * Compute `ecCount` Reed-Solomon codewords for one data block.
       * @param data - data codewords of this block.
       * @param ecCount - codewords to append.
       * @returns the EC codewords.
       */
      function reedSolomon(data, ecCount) {
        const gen = generatorPoly(ecCount)
        const remainder = new Uint8Array(ecCount)
        for (const byte of data) {
          const factor = byte ^ remainder[0]
          remainder.copyWithin(0, 1)
          remainder[ecCount - 1] = 0
          if (factor !== 0) {
            for (let i = 0; i < ecCount; i += 1) {
              remainder[i] ^= gfMul(gen[i + 1], factor)
            }
          }
        }
        return remainder
      }

      /* ------------------------------------------------------------------ *
       * Version tables (EC level L only)
       * ------------------------------------------------------------------ */

      /**
       * Total codewords (data + EC) per version, and the EC-level-L block layout.
       *
       * `ecPerBlock` is the EC codeword count of each block; `groups` is
       * `[blockCount, dataCodewordsPerBlock]` pairs in the order the spec lists them
       * (group 1 first). `align` is the alignment-pattern centre coordinate list.
       */
      const VERSIONS = [
        // v1
        { totalCodewords: 26, ecPerBlock: 7, groups: [[1, 19]], align: [] },
        // v2
        { totalCodewords: 44, ecPerBlock: 10, groups: [[1, 34]], align: [6, 18] },
        // v3
        { totalCodewords: 70, ecPerBlock: 15, groups: [[1, 55]], align: [6, 22] },
        // v4
        { totalCodewords: 100, ecPerBlock: 20, groups: [[1, 80]], align: [6, 26] },
        // v5
        { totalCodewords: 134, ecPerBlock: 26, groups: [[1, 108]], align: [6, 30] },
        // v6
        { totalCodewords: 172, ecPerBlock: 18, groups: [[2, 68]], align: [6, 34] },
        // v7
        { totalCodewords: 196, ecPerBlock: 20, groups: [[2, 78]], align: [6, 22, 38] },
        // v8
        { totalCodewords: 242, ecPerBlock: 24, groups: [[2, 97]], align: [6, 24, 42] },
        // v9
        { totalCodewords: 292, ecPerBlock: 30, groups: [[2, 116]], align: [6, 26, 46] },
        // v10
        { totalCodewords: 346, ecPerBlock: 18, groups: [[2, 68], [2, 69]], align: [6, 28, 50] },
      ]

      /** The five most significant bits of the EC-level-L format field. */
      const EC_LEVEL_L = 0b01

      /**
       * Encode one UTF-8 string into a QR module matrix.
       *
       * @param text - the payload.
       * @returns `{ size, modules }` where `modules[y][x]` is 1 for a dark module.
       * @throws when the payload does not fit the supported versions.
       */
      function encodeQr(text) {
        const bytes = utf8Bytes(text)
        const version = pickVersion(bytes.length)
        const spec = VERSIONS[version - 1]

        const dataCodewords = spec.groups.reduce((sum, [count, capacity]) => sum + count * capacity, 0)

        /* -- 7.4: bit stream, byte mode (mode indicator 0100) -- */
        const bits = []
        const push = (value, length) => {
          for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
        }
        push(0b0100, 4)
        push(bytes.length, version < 10 ? 8 : 16)
        for (const byte of bytes) push(byte, 8)

        // Terminator (up to four zero bits), then pad to a codeword boundary.
        const capacityBits = dataCodewords * 8
        if (bits.length > capacityBits) throw new Error('mobile-console: QR payload exceeds selected version')
        push(0, Math.min(4, capacityBits - bits.length))
        while (bits.length % 8 !== 0) bits.push(0)

        // Pad codewords alternate 0xEC / 0x11 per the specification.
        const padBytes = [0xec, 0x11]
        let padIndex = 0
        while (bits.length < capacityBits) {
          push(padBytes[padIndex % 2], 8)
          padIndex += 1
        }

        const data = new Uint8Array(dataCodewords)
        for (let i = 0; i < dataCodewords; i += 1) {
          let byte = 0
          for (let b = 0; b < 8; b += 1) byte = (byte << 1) | bits[i * 8 + b]
          data[i] = byte
        }

        /* -- 7.5: split into blocks, append EC, interleave -- */
        const dataBlocks = []
        const ecBlocks = []
        let offset = 0
        for (const [count, perBlock] of spec.groups) {
          for (let b = 0; b < count; b += 1) {
            const block = data.subarray(offset, offset + perBlock)
            offset += perBlock
            dataBlocks.push(block)
            ecBlocks.push(reedSolomon(block, spec.ecPerBlock))
          }
        }

        const interleaved = []
        const maxData = Math.max(...dataBlocks.map(block => block.length))
        for (let i = 0; i < maxData; i += 1) {
          for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i])
        }
        for (let i = 0; i < spec.ecPerBlock; i += 1) {
          for (const block of ecBlocks) interleaved.push(block[i])
        }
        if (interleaved.length !== spec.totalCodewords) {
          throw new Error(`mobile-console: QR codeword count ${interleaved.length} != ${spec.totalCodewords} for version ${version}`)
        }

        /* -- 7.7: place modules -- */
        const size = version * 4 + 17
        const modules = new Uint8Array(size * size)
        const reserved = new Uint8Array(size * size)
        const dark = (x, y) => {
          if (x < 0 || y < 0 || x >= size || y >= size) return
          modules[y * size + x] = 1
          reserved[y * size + x] = 1
        }
        const light = (x, y) => {
          if (x < 0 || y < 0 || x >= size || y >= size) return
          modules[y * size + x] = 0
          reserved[y * size + x] = 1
        }

        // Finder patterns plus their separators, at three corners.
        const finder = (originX, originY) => {
          for (let dy = -1; dy <= 7; dy += 1) {
            for (let dx = -1; dx <= 7; dx += 1) {
              const x = originX + dx
              const y = originY + dy
              if (x < 0 || y < 0 || x >= size || y >= size) continue
              const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
              const isDark = inRing && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
              if (isDark) dark(x, y)
              else light(x, y)
            }
          }
        }
        finder(0, 0)
        finder(size - 7, 0)
        finder(0, size - 7)

        // Timing patterns connect the finders.
        for (let i = 8; i < size - 8; i += 1) {
          if (i % 2 === 0) {
            dark(i, 6)
            dark(6, i)
          } else {
            light(i, 6)
            light(6, i)
          }
        }

        // Alignment patterns, skipping the three finder corners.
        const centres = spec.align
        for (const cy of centres) {
          for (const cx of centres) {
            const nearFinder = (cx <= 8 && cy <= 8)
              || (cx >= size - 9 && cy <= 8)
              || (cx <= 8 && cy >= size - 9)
            if (nearFinder) continue
            for (let dy = -2; dy <= 2; dy += 1) {
              for (let dx = -2; dx <= 2; dx += 1) {
                const isDark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
                if (isDark) dark(cx + dx, cy + dy)
                else light(cx + dx, cy + dy)
              }
            }
          }
        }

        // Reserve the format-information areas (filled once the mask is chosen).
        // The matrix is indexed `row * size + column`, so `(x, y)` is `y * size + x`.
        for (let i = 0; i < 9; i += 1) {
          if (i === 6) continue // the timing pattern already owns row/column 6
          reserved[8 * size + i] = 1
          reserved[i * size + 8] = 1
        }
        for (let i = 0; i < 8; i += 1) {
          reserved[8 * size + (size - 1 - i)] = 1
          reserved[(size - 1 - i) * size + 8] = 1
        }
        // The always-dark module sits at (x = 8, y = size - 8). It is reserved, so
        // masking cannot touch it, and `writeFormat` must skip index 7 of the second
        // copy — which is exactly that cell.
        reserved[(size - 8) * size + 8] = 1
        dark(8, size - 8)

        // Reserve the version-information areas for versions 7 and up.
        if (version >= 7) {
          for (let i = 0; i < 6; i += 1) {
            for (let j = 0; j < 3; j += 1) {
              reserved[(size - 11 + j) * size + i] = 1
              reserved[i * size + (size - 11 + j)] = 1
            }
          }
        }

        /* -- 7.7.3: zig-zag data placement, skipping the vertical timing column -- */
        const dataBits = []
        for (const byte of interleaved) for (let b = 7; b >= 0; b -= 1) dataBits.push((byte >> b) & 1)

        let bitIndex = 0
        let upward = true
        for (let right = size - 1; right >= 1; right -= 2) {
          if (right === 6) right = 5 // skip the timing column
          for (let step = 0; step < size; step += 1) {
            const y = upward ? size - 1 - step : step
            for (const x of [right, right - 1]) {
              if (reserved[y * size + x] === 1) continue
              const bit = bitIndex < dataBits.length ? dataBits[bitIndex] : 0
              bitIndex += 1
              modules[y * size + x] = bit
            }
          }
          upward = !upward
        }

        /* -- 7.8: mask selection by penalty, then format information -- */
        let bestMask = 0
        let bestPenalty = Infinity
        let bestMatrix = null
        for (let mask = 0; mask < 8; mask += 1) {
          const candidate = applyMask(modules, reserved, size, mask)
          writeFormat(candidate, size, mask)
          if (version >= 7) writeVersion(candidate, size, version)
          const penalty = penaltyScore(candidate, size)
          if (penalty < bestPenalty) {
            bestPenalty = penalty
            bestMask = mask
            bestMatrix = candidate
          }
        }
        if (bestMatrix === null) throw new Error('mobile-console: QR mask selection produced no candidate')

        const rows = []
        for (let y = 0; y < size; y += 1) {
          rows.push(Array.from(bestMatrix.subarray(y * size, (y + 1) * size)))
        }
        return { size, version, mask: bestMask, modules: rows }
      }

      /** UTF-8 bytes of a string. */
      function utf8Bytes(text) {
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(text)
        const out = []
        for (const char of text) {
          const code = char.codePointAt(0)
          if (code < 0x80) out.push(code)
          else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
          else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
          else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
        }
        return Uint8Array.from(out)
      }

      /** Smallest supported version whose data capacity holds `byteLength` payload bytes. */
      function pickVersion(byteLength) {
        for (let version = 1; version <= VERSIONS.length; version += 1) {
          const spec = VERSIONS[version - 1]
          const dataCodewords = spec.groups.reduce((sum, [count, capacity]) => sum + count * capacity, 0)
          const countBits = version < 10 ? 8 : 16
          const neededBits = 4 + countBits + byteLength * 8
          if (neededBits <= dataCodewords * 8) return version
        }
        throw new Error(`mobile-console: payload of ${byteLength} bytes exceeds the supported QR versions (max ~270)`)
      }

      /** The eight data masks of 18004 Table 10. */
      function maskBit(mask, x, y) {
        switch (mask) {
          case 0: return (x + y) % 2 === 0
          case 1: return y % 2 === 0
          case 2: return x % 3 === 0
          case 3: return (x + y) % 3 === 0
          case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
          case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
          case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
          case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
          default: throw new Error(`mobile-console: unknown QR mask ${mask}`)
        }
      }

      /** Apply one mask to the data modules, leaving function patterns intact. */
      function applyMask(modules, reserved, size, mask) {
        const out = Uint8Array.from(modules)
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            if (reserved[y * size + x] === 1) continue
            if (maskBit(mask, x, y)) out[y * size + x] ^= 1
          }
        }
        return out
      }

      /** BCH(15,5) format information for one mask under EC level L. */
      function formatBits(mask) {
        const data = (EC_LEVEL_L << 3) | mask
        let value = data << 10
        for (let i = 14; i >= 10; i -= 1) {
          if ((value >> i) & 1) value ^= 0b101_0011_0111 << (i - 10)
        }
        return ((data << 10) | value) ^ 0b101_0100_0001_0010
      }

      /** Write the two copies of the format information. */
      function writeFormat(matrix, size, mask) {
        const bits = formatBits(mask)
        for (let i = 0; i < 15; i += 1) {
          const bit = (bits >> i) & 1

          // First copy stays with the top-left finder: bits 0-5 run right along row 8
          // (columns 0-5), skipping the timing column, then bits 6 and 7 sit in the
          // two row-8 cells that flank that gap, and bits 8-14 climb column 8.
          //
          // Second copy is the OTHER pair of strips, and getting this backwards is
          // the defect that makes a symbol undecodable while every structural check
          // still passes: bits 0-7 run up the bottom of column 8 (rows size-1 back to
          // size-8, which is why the always-dark cell at row size-8 carries no format
          // bit), and bits 8-14 run right along row 8 from the column just left of
          // the top-right finder's separator out to the last column.
          if (i < 6) matrix[8 * size + i] = bit
          else if (i === 6) matrix[8 * size + 7] = bit
          else if (i === 7) matrix[8 * size + 8] = bit
          else if (i === 8) matrix[7 * size + 8] = bit
          else matrix[(14 - i) * size + 8] = bit

          if (i < 8) matrix[8 * size + (size - 1 - i)] = bit
          else matrix[(size - 15 + i) * size + 8] = bit
        }
      }

      /** BCH(18,6) version information for versions 7 and up. */
      function versionBits(version) {
        let value = version << 12
        for (let i = 17; i >= 12; i -= 1) {
          if ((value >> i) & 1) value ^= 0b1_1111_0010_0101 << (i - 12)
        }
        return (version << 12) | value
      }

      /** Write the two copies of the version information. */
      function writeVersion(matrix, size, version) {
        const bits = versionBits(version)
        for (let i = 0; i < 18; i += 1) {
          const bit = (bits >> i) & 1
          const a = Math.floor(i / 3)
          const b = i % 3
          matrix[(size - 11 + b) * size + a] = bit
          matrix[a * size + (size - 11 + b)] = bit
        }
      }

      /** 18004 7.8.3 penalty rules 1-4. */
      function penaltyScore(matrix, size) {
        let penalty = 0
        const at = (x, y) => matrix[y * size + x]

        // Rule 1: runs of five or more same-coloured modules in a row or column.
        for (let y = 0; y < size; y += 1) {
          let runColour = at(0, y)
          let runLength = 1
          for (let x = 1; x < size; x += 1) {
            if (at(x, y) === runColour) runLength += 1
            else {
              if (runLength >= 5) penalty += runLength - 2
              runColour = at(x, y)
              runLength = 1
            }
          }
          if (runLength >= 5) penalty += runLength - 2
        }
        for (let x = 0; x < size; x += 1) {
          let runColour = at(x, 0)
          let runLength = 1
          for (let y = 1; y < size; y += 1) {
            if (at(x, y) === runColour) runLength += 1
            else {
              if (runLength >= 5) penalty += runLength - 2
              runColour = at(x, y)
              runLength = 1
            }
          }
          if (runLength >= 5) penalty += runLength - 2
        }

        // Rule 2: every 2x2 block of one colour.
        for (let y = 0; y < size - 1; y += 1) {
          for (let x = 0; x < size - 1; x += 1) {
            const colour = at(x, y)
            if (at(x + 1, y) === colour && at(x, y + 1) === colour && at(x + 1, y + 1) === colour) penalty += 3
          }
        }

        // Rule 3: the 1:1:3:1:1 finder-like pattern with a four-module light margin.
        const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
        const reversed = [...pattern].reverse()
        const matches = (line, start, target) => {
          for (let i = 0; i < target.length; i += 1) if (line[start + i] !== target[i]) return false
          return true
        }
        for (let y = 0; y < size; y += 1) {
          const line = Array.from(matrix.subarray(y * size, (y + 1) * size))
          for (let x = 0; x + 11 <= size; x += 1) {
            if (matches(line, x, pattern) || matches(line, x, reversed)) penalty += 40
          }
        }
        for (let x = 0; x < size; x += 1) {
          const line = []
          for (let y = 0; y < size; y += 1) line.push(at(x, y))
          for (let y = 0; y + 11 <= size; y += 1) {
            if (matches(line, y, pattern) || matches(line, y, reversed)) penalty += 40
          }
        }

        // Rule 4: deviation of the dark-module proportion from 50%, in 5% steps.
        let darkCount = 0
        for (const value of matrix) if (value === 1) darkCount += 1
        const percent = (darkCount * 100) / (size * size)
        penalty += Math.floor(Math.abs(percent - 50) / 5) * 10

        return penalty
      }

      /**
       * Assert the encoder against facts the specification guarantees.
       *
       * These are the checks a wrong table or a misplaced pattern actually breaks:
       * the three finder patterns and their separators, the alternating timing rows,
       * the single always-dark module, both format-information copies agreeing, and
       * the interleaved codeword count. Returns a list of failures (empty = sound).
       *
       * @param text - a payload to encode.
       * @returns human-readable failures.
       */
      function assertEncoderSoundness(text) {
        const failures = []
        const { size, modules, version, mask } = encodeQr(text)
        const at = (x, y) => modules[y][x]

        if (size !== version * 4 + 17) failures.push(`size ${size} does not match version ${version}`)

        // Finder patterns: the 7x7 ring is dark on its border, light inside, with a
        // dark 3x3 core; the separating ring one module out is entirely light.
        for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
          for (let dy = 0; dy < 7; dy += 1) {
            for (let dx = 0; dx < 7; dx += 1) {
              const expected = (dx === 0 || dx === 6 || dy === 0 || dy === 6
                || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)) ? 1 : 0
              if (at(ox + dx, oy + dy) !== expected) failures.push(`finder module (${ox + dx},${oy + dy}) is ${at(ox + dx, oy + dy)}, expected ${expected}`)
            }
          }
        }

        // Timing patterns alternate, starting dark at index 8.
        for (let i = 8; i < size - 8; i += 1) {
          const expected = i % 2 === 0 ? 1 : 0
          if (at(i, 6) !== expected) failures.push(`horizontal timing (${i},6) is ${at(i, 6)}, expected ${expected}`)
          if (at(6, i) !== expected) failures.push(`vertical timing (6,${i}) is ${at(6, i)}, expected ${expected}`)
        }

        // The always-dark module, at (x = 8, y = size - 8).
        if (at(8, size - 8) !== 1) failures.push(`always-dark module (8,${size - 8}) is ${at(8, size - 8)}`)

        // Both format-information copies must exist AND be in the strips the
        // specification names. Checking that the two copies merely *agree* is not
        // enough: an earlier version of this encoder wrote both copies into the wrong
        // strips, which agreed with each other perfectly and produced a symbol that
        // no decoder would read. So each index is checked against the exact cell
        // `writeFormat` is required to use, in both copies.
        const expectedWord = formatBits(mask)
        const copyACells = []
        const copyBCells = []
        for (let i = 0; i < 15; i += 1) {
          // First copy: along row 8 (skipping the timing column at column 6), then
          // climbing column 8.
          if (i < 6) copyACells.push([i, 8])
          else if (i === 6) copyACells.push([7, 8])
          else if (i === 7) copyACells.push([8, 8])
          else if (i === 8) copyACells.push([8, 7])
          else copyACells.push([8, 14 - i])
          // Second copy: along row 8 from the last column leftwards, then climbing
          // column 8 from the row just above the always-dark module.
          if (i < 8) copyBCells.push([size - 1 - i, 8])
          else copyBCells.push([8, size - 15 + i])
        }

        const seen = new Map()
        for (const [label, cells] of [['first', copyACells], ['second', copyBCells]]) {
          for (let i = 0; i < cells.length; i += 1) {
            const [x, y] = cells[i]
            const bit = (expectedWord >> i) & 1
            if (at(x, y) !== bit) {
              failures.push(`${label} format copy bit ${i} at (${x},${y}) is ${at(x, y)}, expected ${bit}`)
              break
            }
            const key = `${x},${y}`
            if (seen.has(key)) {
              failures.push(`format cell (${x},${y}) is claimed by both ${seen.get(key)} and ${label} index ${i}`)
              break
            }
            seen.set(key, `${label} index ${i}`)
          }
        }

        // The format cells must not overlap the always-dark module or the timing
        // patterns, which is exactly the confusion that produced the defect above.
        if (at(6, 6) !== 1) failures.push(`corner of both timing patterns (6,6) is ${at(6, 6)}, expected 1`)
        if (at(6, 8) !== undefined && at(6, 8) !== 1) {
          failures.push(`the timing column survived masking at (6,8): ${at(6, 8)}`)
        }
        if (seen.has(`${6},8`)) failures.push('a format cell landed on the timing column at (6,8)')
        if (seen.has(`${8},${size - 8}`)) failures.push('a format cell landed on the always-dark module')

        return failures
      }
      return { encodeQr, assertEncoderSoundness }
    })()
    /* @@inlined qr.js:end@@ */

    /* ================================================================ *
     * Small window
     * ================================================================ */

    /** One QR matrix as a scalable SVG path, quiet zone included. */
    function QrCode({ text: payload, label }) {
      const matrix = React.useMemo(() => {
        try {
          return __mcQr.encodeQr(payload)
        } catch (error) {
          return null
        }
      }, [payload])

      if (matrix === null) {
        return h('div', { className: 'mc-error' }, '这个地址太长，无法生成二维码，请手动输入下方地址。')
      }

      const commands = []
      for (let y = 0; y < matrix.size; y += 1) {
        for (let x = 0; x < matrix.size; x += 1) {
          if (matrix.modules[y][x] === 1) commands.push(`M${x} ${y}h1v1h-1z`)
        }
      }
      const quiet = 4
      const extent = matrix.size + quiet * 2

      return h('svg', {
        className: 'mc-qr',
        viewBox: `0 0 ${extent} ${extent}`,
        role: 'img',
        'aria-label': label,
        shapeRendering: 'crispEdges',
      }, [
        h('rect', { key: 'quiet', x: 0, y: 0, width: extent, height: extent, fill: '#ffffff' }),
        h('path', { key: 'modules', d: commands.join(' '), fill: '#000000', transform: `translate(${quiet} ${quiet})` }),
      ])
    }

    /** The connection instructions, in the order a user actually does them. */
    function Steps() {
      return h('ol', { className: 'mc-steps' }, [
        h('li', { key: 'net' }, '手机和这台电脑连同一个 Wi-Fi。'),
        h('li', { key: 'scan' }, '用手机相机或微信扫描上面的二维码。'),
        h('li', { key: 'use' }, '打开的页面就是这台电脑上的 DSH，会话与界面完全相同。'),
      ])
    }

    /** The small window itself. */
    function Panel({ state, actions }) {
      const report = state.report
      const listening = state.bridge === 'listening'
      const url = report !== null && typeof report.url === 'string' ? report.url : null

      let body
      if (listening && url !== null) {
        body = [
          h(QrCode, { key: 'qr', text: url, label: '手机访问二维码' }),
          h('code', { key: 'url', className: 'mc-url' }, url),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'mc-copy',
            onClick: () => actions.copy(url),
          }, state.copied ? '已复制' : '复制地址'),
          h(Steps, { key: 'steps' }),
          h('p', { key: 'note', className: 'mc-note' }, '同一个局域网里拿到这个地址的人都能打开。不用时点下面的停止。'),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'mc-stop',
            disabled: state.busy,
            onClick: () => actions.setBridge('stop'),
          }, state.busy ? '正在停止…' : '停止手机访问'),
        ]
      } else if (listening) {
        body = [
          h('p', { key: 'lead', className: 'mc-lead' }, report !== null && typeof report.hint === 'string'
            ? report.hint
            : '通道已开启，但没有找到局域网 IPv4 地址。'),
          h('button', {
            key: 'stop',
            type: 'button',
            className: 'mc-stop',
            disabled: state.busy,
            onClick: () => actions.setBridge('stop'),
          }, state.busy ? '正在停止…' : '停止手机访问'),
        ]
      } else {
        body = [
          h('p', { key: 'lead', className: 'mc-lead' }, '在手机上打开这个 DSH：开启后本机会建立一个只对局域网开放的通道，用二维码即可打开同一个界面。'),
          h('button', {
            key: 'start',
            type: 'button',
            className: 'mc-primary',
            disabled: state.busy,
            onClick: () => actions.setBridge('start'),
          }, state.busy ? '正在开启…' : '开启手机访问'),
          state.report !== null && typeof state.report.hint === 'string' && state.report.networkCount === 0
            ? h('p', { key: 'no-net', className: 'mc-note' }, state.report.hint)
            : null,
        ]
      }

      return h('div', {
        className: 'mc-window',
        role: 'dialog',
        'aria-label': '手机访问',
      }, [
        h('div', { key: 'head', className: 'mc-head' }, [
          h('span', { key: 'title', className: 'mc-title' }, '手机访问'),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'mc-x',
            'aria-label': '关闭',
            onClick: actions.close,
          }, '✕'),
        ]),
        h('div', { key: 'body', className: 'mc-body' }, [
          ...body,
          state.error === null ? null : h('p', { key: 'error', className: 'mc-error' }, state.error),
        ]),
      ])
    }

    /* ================================================================ *
     * Stylesheet ownership
     * ================================================================ */

    /**
     * Installed bundles receive no `styles` closure symbol (that seat belongs
     * to dynamic packages), so the plugin owns its `<style>` tags. Each tag
     * carries `data-mobile-console` so a leftover sheet is identifiable.
     */
    function createStyleDesk() {
      const tags = new Set()
      return {
        insert(css) {
          const tag = document.createElement('style')
          tag.dataset.mobileConsole = ''
          tag.textContent = typeof css === 'string' ? css : ''
          document.head.append(tag)
          tags.add(tag)
          let dropped = false
          return () => {
            if (dropped) return
            dropped = true
            tags.delete(tag)
            tag.remove()
          }
        },
        dropAll() {
          for (const tag of [...tags]) tag.remove()
          tags.clear()
        },
      }
    }

    /* ================================================================ *
     * Plugin
     * ================================================================ */

    return {
      /** Only the slot seat is required: this half talks HTTP, not Remote. */
      inject: ['slots'],
      apply(ctx) {
        const desk = createStyleDesk()
        ctx.effect(() => desk.insert(CSS), 'mobile-console: stylesheet')
        ctx.effect(() => () => desk.dropAll(), 'mobile-console: stylesheet teardown')

        /* -- the panel's own root, appended to the document -- */
        const root = document.createElement('div')
        root.dataset.mobileConsoleRoot = ''
        document.body.append(root)
        ctx.effect(() => () => root.remove(), 'mobile-console: panel root teardown')

        /* -- one external store, so the launcher and the panel agree -- */
        let state = {
          open: false,
          bridge: 'stopped',
          report: null,
          error: null,
          busy: false,
          copied: false,
        }
        const subscribers = new Set()

        function commit(patch) {
          state = { ...state, ...patch }
          for (const subscriber of subscribers) subscriber()
        }

        function subscribe(listener) {
          subscribers.add(listener)
          return () => subscribers.delete(listener)
        }

        function messageOf(error) {
          return error !== undefined && error !== null && error.message ? String(error.message) : String(error)
        }

        /**
         * Call one of the Host half's control routes.
         *
         * Same-origin, so the browser attaches the session cookie the page
         * already holds — that cookie is the whole reason these routes can hand
         * back a token-bearing URL and stay closed to anyone else.
         */
        async function call(path, body) {
          const init = body === undefined
            ? { credentials: 'same-origin' }
            : {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          const response = await fetch(path, init)
          const raw = await response.text()
          let value = null
          try {
            value = raw === '' ? null : JSON.parse(raw)
          } catch (error) {
            value = null
          }
          if (!response.ok) {
            throw new Error(value !== null && typeof value.message === 'string'
              ? value.message
              : `请求失败（HTTP ${response.status}）`)
          }
          return value
        }

        async function refresh() {
          try {
            const report = await call(HANDOFF_PATH)
            commit({
              report,
              bridge: report !== null && typeof report.bridge === 'string' ? report.bridge : 'stopped',
              error: null,
            })
          } catch (error) {
            commit({ error: messageOf(error) })
          }
        }

        async function setBridge(action) {
          commit({ busy: true, error: null })
          try {
            const report = await call(BRIDGE_PATH, { action })
            commit({
              report,
              bridge: report !== null && typeof report.bridge === 'string' ? report.bridge : 'stopped',
              busy: false,
              copied: false,
            })
          } catch (error) {
            commit({ busy: false, error: messageOf(error) })
          }
        }

        function copy(value) {
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(value).then(() => commit({ copied: true }), () => {})
              return
            }
          } catch (error) {
            /* fall through to the selection-based copy */
          }
          try {
            const area = document.createElement('textarea')
            area.value = value
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.append(area)
            area.select()
            document.execCommand('copy')
            area.remove()
            commit({ copied: true })
          } catch (error) {
            /* the address stays selectable either way */
          }
        }

        function open() {
          commit({ open: true })
          void refresh()
        }

        function close() {
          commit({ open: false })
        }

        function toggle() {
          if (state.open) close()
          else open()
        }

        const actions = { close, toggle, setBridge, copy }

        /* -- dismissal: Escape, and a click that lands outside the window -- *
         * The launcher is exempted by attribute: its own click handler already
         * toggles, and closing here first would make that click reopen instead
         * of closing.
         * ---------------------------------------------------------------- */
        ctx.effect(() => {
          function onKeyDown(event) {
            if (event.key === 'Escape' && state.open) close()
          }
          function onPointerDown(event) {
            if (!state.open) return
            const target = event.target
            if (target !== null && typeof target.closest === 'function'
              && (root.contains(target) || target.closest(`[${LAUNCHER_ATTR}]`) !== null)) return
            close()
          }
          window.addEventListener('keydown', onKeyDown)
          document.addEventListener('mousedown', onPointerDown, true)
          return () => {
            window.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('mousedown', onPointerDown, true)
          }
        }, 'mobile-console: panel dismissal')

        /* -- the React root ------------------------------------------- */
        function createRoot() {
          let create = null
          try {
            create = require('react-dom/client').createRoot
          } catch (error) {
            create = null
          }
          if (typeof create !== 'function') return { render() {}, unmount() {} }
          const instance = create(root)
          return {
            render(element) {
              instance.render(element)
            },
            unmount() {
              try {
                instance.unmount()
              } catch (error) {
                /* already gone */
              }
            },
          }
        }
        const mounted = createRoot()
        ctx.effect(() => () => mounted.unmount(), 'mobile-console: react teardown')

        /**
         * Bridge the external store to React.
         *
         * The subscription hook is registered unconditionally: an early return
         * before it would change the hook count between the closed and open
         * renders and break the component.
         */
        function Container() {
          const [snapshot, setSnapshot] = React.useState(() => state)
          React.useEffect(() => {
            setSnapshot(state)
            return subscribe(() => setSnapshot(state))
          }, [])
          return snapshot.open ? h(Panel, { state: snapshot, actions }) : null
        }

        function render() {
          mounted.render(h(Container, {}))
        }
        render()

        /* -- the one seat: the sidebar foot, beside Settings -- */
        ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
          name: FOOTER_SLOT,
          id: 'mobile-console',
          order: 20,
          label: '手机访问',
        }, function MobileConsoleLauncher(ownerProps) {
          const [snapshot, setSnapshot] = React.useState(() => state)
          React.useEffect(() => {
            setSnapshot(state)
            return subscribe(() => setSnapshot(state))
          }, [])
          // The owner reports whether the sidebar is wide or a 56px rail. The
          // strict comparison keeps the label when the prop is absent, and drops
          // it in the rail, where a four-character label cannot fit anyway.
          const wide = ownerProps === undefined || ownerProps.wide !== false
          return h('button', {
            type: 'button',
            className: 'mc-launcher',
            [LAUNCHER_ATTR]: '',
            'data-on': snapshot.bridge === 'listening' ? 'true' : 'false',
            'aria-expanded': snapshot.open ? 'true' : 'false',
            'aria-label': '手机访问',
            title: '在手机上打开这个 DSH',
            onClick: toggle,
          }, [
            h('span', { key: 'dot', className: 'mc-dot', 'data-on': snapshot.bridge === 'listening' ? 'true' : 'false' }),
            wide ? h('span', { key: 'label', className: 'mc-launcher-label' }, '手机访问') : null,
          ])
        }))

        // Read the bridge state once so the launcher's dot is honest before the
        // panel is ever opened.
        void refresh()
      },
    }
  },
})
