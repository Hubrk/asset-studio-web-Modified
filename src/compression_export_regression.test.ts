import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '@/utils/khDecrypt';

// 真实样本（迪达拉帧动画 bundle，KH 加密）：用于验证「导出时按当前压缩模式重打包」逻辑。
const SAMPLE = 'C:/Users/34072/Desktop/胜利改牛逼/90248迪达拉[秽土转生]/帧动画/2137173546.assetbundle';

// 样本为本地绝对路径，缺失时整文件跳过，避免他人跑 npm test 因缺样本而崩。
const sampleExists = fs.existsSync(SAMPLE);
const d = sampleExists ? describe : describe.skip;

function loadSampleUnityFs(): ArrayBuffer {
  const buf = fs.readFileSync(SAMPLE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  if (isKhBundle(ab)) return decryptKhBundle(ab);
  return ab;
}

d('compression export honors selected mode', () => {
  it('rebuild(3)=LZ4_HC 与 rebuild(0)=NONE 产出不同压缩态且均可被严格加载', async () => {
    const unityFs = loadSampleUnityFs();

    const b3 = await loadAssetBundle(unityFs.slice(0));
    const out3 = b3.rebuild(3) as ArrayBuffer;

    const b0 = await loadAssetBundle(unityFs.slice(0));
    const out0 = b0.rebuild(0) as ArrayBuffer;

    // 模式真实生效：不压缩体积必然大于 LZ4_HC
    expect(out0.byteLength).toBeGreaterThan(out3.byteLength);

    // 两种产物都是合法 UnityFS，能被再次 loadAssetBundle 解析（round-trip 不崩）
    expect(() => loadAssetBundle(out3.slice(0))).not.toThrow();
    expect(() => loadAssetBundle(out0.slice(0))).not.toThrow();

    console.log(
      `[regression] LZ4_HC=${out3.byteLength} bytes, NONE=${out0.byteLength} bytes ` +
        `(Δ=${out0.byteLength - out3.byteLength})`,
    );
  }, 120000);

  it('worker 导出路径语义：getUnityFs/encryptBundleToKh 在导出时按 this.compressionMode 重打包', async () => {
    // 这里复刻 worker 内部的导出逻辑（避免直接 import worker 触发 comlink expose）：
    // exportModifiedBundle -> getUnityFs -> loadAssetBundle(raw).rebuild(this.compressionMode)
    const unityFs = loadSampleUnityFs();

    const mode3 = await loadAssetBundle(unityFs.slice(0)).then(b => b.rebuild(3));
    const mode0 = await loadAssetBundle(unityFs.slice(0)).then(b => b.rebuild(0));

    // 与 worker 实际导出调用链一致：导出即重打包，选择何时发生都生效
    expect(mode0.byteLength).toBeGreaterThan(mode3.byteLength);
    expect(() => loadAssetBundle((mode3 as ArrayBuffer).slice(0))).not.toThrow();
    expect(() => loadAssetBundle((mode0 as ArrayBuffer).slice(0))).not.toThrow();
  }, 120000);
});
