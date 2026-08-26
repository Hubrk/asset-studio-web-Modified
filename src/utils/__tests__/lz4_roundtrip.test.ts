import { describe, it, expect } from 'vitest';
import { compressLz4 } from '@arkntools/unity-js';
import { decompressLz4 } from '@arkntools/unity-js-tools';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const roundtrip = (name: string, data: Uint8Array) => {
  const comp = compressLz4(data);
  if (data.length === 0) {
    expect(comp.length).toBe(0);
    return;
  }
  // 压缩后不应乱写越界；解压须还原原字节
  const out = decompressLz4(comp, data.length);
  expect(out.length, `${name}: decompressed length`).toBe(data.length);
  expect(bytesEqual(out, data), `${name}: content match`).toBe(true);
};

describe('compressLz4 roundtrip (standard LZ4 block vs decompressLz4)', () => {
  it('empty input', () => roundtrip('empty', new Uint8Array(0)));

  it('tiny inputs (below/around mflimit=12)', () => {
    for (const n of [1, 2, 3, 4, 5, 8, 12, 13, 16, 20]) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = (i * 37) & 0xff;
      roundtrip(`tiny-${n}`, buf);
    }
  });

  it('all-zero data (highly compressible)', () => {
    for (const n of [100, 4096, 65536, 100000]) {
      roundtrip(`zero-${n}`, new Uint8Array(n));
    }
  });

  it('repeated pattern (ABCD repeated)', () => {
    for (const n of [100, 4096, 70000]) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = 'ABCD'.charCodeAt(i & 3);
      roundtrip(`repeat-${n}`, buf);
    }
  });

  it('random data (incompressible -> must still roundtrip exactly)', () => {
    let seed = 123456789;
    const rnd = () => {
      // xorshift32
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed & 0xff;
    };
    for (const n of [100, 4096, 65536, 120000]) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = rnd();
      roundtrip(`random-${n}`, buf);
    }
  });

  it('text-like data with long matches', () => {
    const base = 'the quick brown fox jumps over the lazy dog. ';
    const big = base.repeat(5000);
    roundtrip('text-50k', new Uint8Array([...big].map(c => c.charCodeAt(0))));
  });

  it('boundary: exactly 12 / 13 bytes', () => {
    roundtrip('b12', new Uint8Array(12).fill(7));
    const b13 = new Uint8Array(13); b13[0] = 1; b13[12] = 2;
    roundtrip('b13', b13);
  });

  it('mixed: compressible prefix + random tail', () => {
    const n = 50000;
    const buf = new Uint8Array(n);
    buf.fill(0xAB, 0, 20000);
    let seed = 42;
    for (let i = 20000; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = seed & 0xff;
    }
    roundtrip('mixed', buf);
  });
});
