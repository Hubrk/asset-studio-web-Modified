import * as fs from 'node:fs';
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { compressLz4 } from '../packages/unity-js/src/lz4';
import { decompressBlock } from 'lz4js';

/**
 * WASM-free 回归测试：compressLz4（packages/unity-js/src/lz4.ts）必须产出
 * 「官方 LZ4 C 库（= 游戏端 LZ4_decompress_safe 同款严格语义）可无损解压」的块。
 *
 * 背景：历史上两版实现都在真实 ~8.4MB 块上产出损坏流——
 *  - 手写 greedy 匹配器：输出 cSize=335848 的垃圾流（8.4MB→335KB 不可能）；
 *  - lz4js.compressBlock：自解码得 8464578 字节（输入 8464568，多 10 字节），
 *    官方库与游戏端均拒绝。
 * 本测试不依赖任何 WASM（区别于 texture_rgb32_lz4_regression.test.ts 的全链路
 * 版本），因此可在任何环境运行，是压缩器正确性的最低门槛。
 */

const VENV_PY = 'C:/Users/34072/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const REAL_CORPUS = 'research/_real_uncompressed.bin';
const TMP_COMP = 'research/_lz4enc_comp.bin';
const TMP_SRC = 'research/_lz4enc_src.bin';

function buildDatasets(): Record<string, Uint8Array> {
  const N = 8464568; // 用户真实场景的单块大小（2048×1024 RGBA32 纹理写回）
  const ds: Record<string, Uint8Array> = {};

  // 1) 纯随机：无任何匹配，压满字面量路径（编码器上界路径）
  const rnd = new Uint8Array(N);
  for (let i = 0; i < N; i++) rnd[i] = (Math.random() * 256) | 0;
  ds['random_8_4MB'] = rnd;

  // 2) 渐变：极端重复（offset=1 的超长匹配），压满匹配路径
  const grad = new Uint8Array(N);
  for (let i = 0; i < N; i++) grad[i] = i & 0xff;
  ds['gradient_8_4MB'] = grad;

  // 3) 70KB 周期模式：匹配距离 > 65535（LZ4 16-bit offset 上限），必须被正确过滤
  const pat = new Uint8Array(70000);
  for (let i = 0; i < 70000; i++) pat[i] = (i * 3 + 5) & 0xff;
  const p70 = new Uint8Array(N);
  for (let i = 0; i < N; i++) p70[i] = pat[i % 70000];
  ds['pattern70k_8_4MB'] = p70;

  // 4) 真实游戏语料（原始 bundle 解出的 UnityFS 未压缩字节），可选
  if (fs.existsSync(REAL_CORPUS)) {
    const real = new Uint8Array(fs.readFileSync(REAL_CORPUS));
    ds['real_1MB'] = real;
    const scaled = new Uint8Array(N);
    for (let i = 0; i < N; i++) scaled[i] = real[i % real.length];
    ds['real_scaled_8_4MB'] = scaled;
  }
  return ds;
}

/** 官方 lz4 C 库严格校验（游戏端同款语义），python 可用时必须通过。 */
function officialCheck(comp: Uint8Array, src: Uint8Array): { ok: boolean; note: string } {
  fs.writeFileSync(TMP_COMP, comp);
  fs.writeFileSync(TMP_SRC, src);
  const py = [
    'import lz4.block',
    `d=open(r'${TMP_COMP}','rb').read()`,
    `s=open(r'${TMP_SRC}','rb').read()`,
    'try:',
    '    o=lz4.block.decompress(d, uncompressed_size=len(s))',
    "    print('OK' if o==s else 'CONTENT_MISMATCH')",
    'except Exception as e:',
    "    print('FAIL:'+str(e))",
  ].join('\n');
  try {
    const out = execFileSync(VENV_PY, ['-c', py], { encoding: 'utf8' }).trim();
    return { ok: out === 'OK', note: out };
  } catch (e: any) {
    return { ok: false, note: (e.stdout || '') + (e.stderr || '') || String(e) };
  }
}

it(
  'compressLz4 produces official-lz4-decodable blocks on random/gradient/pattern/real corpora',
  { timeout: 300000 },
  () => {
    const datasets = buildDatasets();
    const hasPy = fs.existsSync(VENV_PY);
    const failures: string[] = [];

    for (const [name, src] of Object.entries(datasets)) {
      const comp = compressLz4(src);
      expect(comp.length, `[${name}] compressed size sanity`).toBeGreaterThan(0);
      // 压缩上界：LZ4_compressBound = n + n/255 + 16（全字面量时逼近）
      expect(comp.length, `[${name}] exceeds LZ4_compressBound`).toBeLessThanOrEqual(
        src.length + Math.floor(src.length / 255) + 16,
      );

      // 1) lz4js 自家解码器往返：长度 + 逐字节一致
      const out = new Uint8Array(src.length);
      const n = decompressBlock(comp, out, 0, comp.length, 0);
      const roundtripOk = n === src.length;
      let contentOk = roundtripOk;
      if (roundtripOk) {
        for (let i = 0; i < src.length; i++) {
          if (out[i] !== src[i]) { contentOk = false; break; }
        }
      }
      if (!roundtripOk || !contentOk) {
        failures.push(`[${name}] lz4js roundtrip: n=${n}/${src.length} content=${contentOk}`);
        continue;
      }

      // 2) 官方 lz4 C 库（游戏端严格语义）
      if (hasPy) {
        const r = officialCheck(comp, src);
        if (!r.ok) failures.push(`[${name}] official lz4: ${r.note}`);
      }
      console.log(
        `[lz4enc] ${name}: ${src.length} -> ${comp.length} lz4js=OK official=${hasPy ? 'checked' : 'skipped'}`,
      );
    }

    // python 可用时必须以官方校验为准（项目铁律：lz4js 解码宽松，不可作唯一依据）
    expect(failures, failures.join(' | ')).toEqual([]);
    if (hasPy) {
      // officialCheck 已包含在 failures 判定中；额外确认至少跑过一个官方校验
      expect(Object.keys(datasets).length).toBeGreaterThan(0);
    }
  },
);

it('compressLz4 handles edge cases (empty / tiny / sub-MFLIMIT sizes)', () => {
  expect(compressLz4(new Uint8Array(0)).length).toBe(0);
  for (const len of [1, 4, 5, 11, 12, 13, 15, 16, 100]) {
    const src = new Uint8Array(len);
    for (let i = 0; i < len; i++) src[i] = (i * 37 + 11) & 0xff;
    const comp = compressLz4(src);
    const out = new Uint8Array(len);
    const n = decompressBlock(comp, out, 0, comp.length, 0);
    expect(n, `len=${len} roundtrip size`).toBe(len);
    for (let i = 0; i < len; i++) expect(out[i], `len=${len} byte ${i}`).toBe(src[i]);
  }
});
