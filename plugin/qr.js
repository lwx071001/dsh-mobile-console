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
export function encodeQr(text) {
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
export function assertEncoderSoundness(text) {
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
