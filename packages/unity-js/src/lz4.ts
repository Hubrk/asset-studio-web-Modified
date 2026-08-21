/**
 * Correct, dependency-free LZ4 raw-block compressor (no frame header).
 *
 * Produces blocks that are byte-for-byte decodable by the reference LZ4
 * decoder (verified against the official C `lz4` library). Used by
 * `bundle.rebuild(compressionMode)` and `khEncrypt` blocksInfo re-compression.
 *
 * Canonical LZ4_compress_default (fast) format:
 *  - MINMATCH = 4, LASTLITERALS = 5 (last 5 bytes are always literals),
 *  - MFLIMIT = 12 (matches are only searched while ip < iend - 12),
 *  - 16-bit match offsets (max distance 65535), 16-bit hash table.
 */

const MINMATCH = 4;
const LASTLITERALS = 5;
const MFLIMIT = 12;
const HASHLOG = 16;
const MAX_DISTANCE = 65535;

function read32(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

/** 16-bit hash of a 4-byte little-endian sequence (32-bit multiply, top 16 bits). */
function hashU32(v: number): number {
  return (Math.imul(v, 2654435761) >>> 16) & 0xffff;
}

function emitLiterals(dst: Uint8Array, op: number, src: Uint8Array, start: number, len: number): number {
  if (len >= 15) {
    dst[op++] = 15 << 4; // match-length nibble = 0
    let ll = len - 15;
    while (ll >= 255) {
      dst[op++] = 255;
      ll -= 255;
    }
    dst[op++] = ll;
  } else {
    dst[op++] = len << 4; // match-length nibble = 0
  }
  for (let i = 0; i < len; i++) dst[op++] = src[start + i];
  return op;
}

/**
 * Compress `src` into a raw LZ4 block. Returns a new Uint8Array containing only
 * the compressed bytes. An empty input returns an empty array.
 */
export function compressLz4(src: Uint8Array): Uint8Array {
  const n = src.length;
  if (n === 0) return new Uint8Array(0);

  const dst = new Uint8Array(n + ((n / 255) | 0) + 64); // LZ4_compressBound-safe
  const table = new Int32Array(1 << HASHLOG);
  table.fill(-(MAX_DISTANCE + 1)); // sentinel: distance always > MAX_DISTANCE

  let ip = 0;
  let op = 0;
  let anchor = 0;
  const mflimit = n - MFLIMIT; // matches searched while ip < mflimit
  const matchlimit = n - LASTLITERALS; // match extension stops here (exclusive)

  if (n < MFLIMIT + MINMATCH) {
    op = emitLiterals(dst, op, src, 0, n);
    return dst.slice(0, op);
  }

  while (ip < mflimit) {
    const seq = read32(src, ip);
    const h = hashU32(seq);
    const ref = table[h];
    table[h] = ip;
    if (ref >= 0 && ip - ref <= MAX_DISTANCE && read32(src, ref) === seq) {
      const litLen = ip - anchor;
      let mlen = MINMATCH;
      while (ip + mlen < matchlimit && src[ip + mlen] === src[ref + mlen]) mlen++;

      const tokenLit = litLen >= 15 ? 15 : litLen;
      const tokenMatch = mlen - MINMATCH >= 15 ? 15 : mlen - MINMATCH;
      dst[op++] = (tokenLit << 4) | tokenMatch;
      if (litLen >= 15) {
        let ll = litLen - 15;
        while (ll >= 255) {
          dst[op++] = 255;
          ll -= 255;
        }
        dst[op++] = ll;
      }
      for (let i = 0; i < litLen; i++) dst[op++] = src[anchor + i];

      const offset = ip - ref;
      dst[op++] = offset & 0xff;
      dst[op++] = (offset >> 8) & 0xff;

      if (mlen - MINMATCH >= 15) {
        let ml = mlen - MINMATCH - 15;
        while (ml >= 255) {
          dst[op++] = 255;
          ml -= 255;
        }
        dst[op++] = ml;
      }

      ip += mlen;
      anchor = ip;
    } else {
      ip++;
    }
  }

  op = emitLiterals(dst, op, src, anchor, n - anchor);
  return dst.slice(0, op);
}
