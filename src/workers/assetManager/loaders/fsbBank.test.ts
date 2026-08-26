import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectFsbBank, parseFsbBank } from './fsbBank';

const SAMPLE = resolve(__dirname, '../../../../nj_hanabi_wd..bank');

// 真实样本是用户的游戏资产，不进仓库；缺样本时本测试自动跳过，避免 CI 失败。
const hasSample = existsSync(SAMPLE);

describe('FSB bank 解析（真实样本）', () => {
  const bytes = hasSample ? new Uint8Array(readFileSync(SAMPLE)) : new Uint8Array(0);

  it.skipIf(!hasSample)('detectFsbBank 应识别 RIFF 包装的内嵌 FSB5', () => {
    const off = detectFsbBank(bytes, 'nj_hanabi_wd..bank');
    expect(off).not.toBeNull();
    expect(off!).toBeGreaterThan(0);
  });

  it.skipIf(!hasSample)('parseFsbBank 应解析出 98 个子音频且名字非空', () => {
    const off = detectFsbBank(bytes, 'nj_hanabi_wd..bank');
    const r = parseFsbBank(bytes, off);
    expect(r).not.toBeNull();
    const { samples } = r!;
    expect(samples.length).toBe(98);
    const named = samples.filter((s) => s.name && !s.name.startsWith('sample_'));
    expect(named.length).toBe(98);
    expect(samples[0].name).toMatch(/hanabi|hnb|6hnb|wd/i);
    expect(samples[0].mode).toBe(15);
    expect(samples[0].frequency).toBeGreaterThan(0);
    expect([1, 2]).toContain(samples[0].channels);
    expect(samples[0].duration).toBeGreaterThan(0);
  });

  it('parseFsbBank 对过短数据应安全返回 null', () => {
    expect(parseFsbBank(new Uint8Array(10), 0)).toBeNull();
  });
});
