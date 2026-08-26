import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isUnityFs } from '@/utils/khDecrypt';
import { __kfbInternals, findCandidates, decryptBundle } from '@/workers/assetManager/loaders/kfbBundle';
import { kfbKeyList } from '@/workers/assetManager/kfb/kfbKeys';

const DIR = 'C:/Users/34072/Downloads/assets_2026-08-13_162117';
// 素材为本地大文件，缺失时跳过（与其他真实样本测试一致），避免 CI/无素材环境 ENOENT 失败
const hasFixtures = existsSync(DIR);
// 回归点：这批佐助新包是 UnityKH1FS，且数据块带 Unity 尾部 padding。
// 旧的 lz4Decompress 遇到 padding 直接抛「LZ4 数据块无效」，导致这些包无法在 web 端打开。
describe.skipIf(!hasFixtures)('kfbBundle can open the new Sasuke bundles (UnityKH1FS + LZ4 tail padding)', () => {
  const cases = ['2768148785', '656374055', '3971289467', '1436056470', '1128141370'];
  for (const id of cases) {
    it(`parses ${id}.assetbundle`, () => {
      const buf = readFileSync(join(DIR, `${id}.assetbundle`));
      const b = __kfbInternals.parse(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      expect(b.kh).toBe(2); // UnityKH1FS
      expect(b.data.length).toBeGreaterThan(0);
      expect(b.dirs.length).toBeGreaterThan(0);
    });
  }
});

describe.skipIf(!hasFixtures)('kfbBundle decrypts new Sasuke battle bundles with auto key', () => {
  // 字符主文件：656374055→90059、3971289467→90059_p、1436056470→90059__
  it('decrypts 656374055 (90059) and 3971289467 (90059_p)', async () => {
    for (const id of ['656374055', '3971289467']) {
      const buf = readFileSync(join(DIR, `${id}.assetbundle`));
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      let names: string[] = [];
      for (const key of kfbKeyList) {
        try {
          names = await findCandidates(bytes, key);
          if (names.length > 0) break;
        } catch { /* next key */ }
      }
      expect(names.length).toBeGreaterThan(0);
    }
  });
  it('decrypts 2768148785 skill pack (16 skill TextAssets)', async () => {
    const buf = readFileSync(join(DIR, '2768148785.assetbundle'));
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let names: string[] = [];
    for (const key of kfbKeyList) {
      try {
        names = await findCandidates(bytes, key);
        if (names.length > 0) break;
      } catch { /* next key */ }
    }
    expect(names.length).toBeGreaterThan(0);
  });
  it('decrypts 1436056470 (name=90059__)', async () => {
    const buf = readFileSync(join(DIR, '1436056470.assetbundle'));
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let ok = false;
    for (const key of kfbKeyList) {
      try {
        const r = await decryptBundle(bytes, key, '90059__');
        if (r.plain.length > 0) { ok = true; break; }
      } catch { /* next key */ }
    }
    expect(ok).toBe(true);
  });
});

describe.skipIf(!hasFixtures)('unity-js BundleFile load path (general asset loading)', () => {
  // 走 AssetManager 的真实链路：decryptKhBundle(.assetbundle) → loadAssetBundle。
  // 回归点：Unity 尾部 padding 使 LZ4 输出比块表声明多 4 字节，WASM 解码器
  // 曾抛 "provided output is too small"，现回退到宽松解码后应能正常解析。
  it('decryptKhBundle + loadAssetBundle works on all new bundles', async () => {
    for (const id of ['2768148785', '656374055', '3971289467', '1436056470', '1128141370']) {
      const buf = readFileSync(join(DIR, `${id}.assetbundle`));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      expect(isUnityFs(decryptKhBundle(ab))).toBe(true);
      const bf = await loadAssetBundle(decryptKhBundle(ab));
      expect(bf.files.length).toBeGreaterThan(0);
      console.log(`  ${id}: files=${bf.files.length} objects=${(bf as any).objects?.length ?? 0}`);
    }
  });
});
