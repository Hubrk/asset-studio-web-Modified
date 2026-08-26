/**
 * 帧动画联动恢复验证（真实数据）：
 * 1) 帧动画 bundle → 按 Sprite 命名分组 → 动画组
 * 2) 战斗逻辑 bundle（内置密钥可解）→ 解出真实 clip 名（KFB 片段）
 * 3) 模拟 KfbSemanticSkillEditor.autoMatchGroup 匹配链，打印 clip ↔ 动画组配对全景
 * CI / 无文件时自动跳过。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AssetType, loadAssetBundle } from '@arkntools/unity-js';
import { decryptKfbContainerAuto, isKfbContainer } from '../kfb/kfbBundle';
import { decodeKfb, normalizeSchema } from '../kfb/kfbSchemaDecoder';
import { getKfbKeys } from '../kfb/keys';
import { buildFrameGroups, parseFrameName, stripFrameSuffix } from '../frameAnim';

const ANIM_FILES = [
  'C:/Users/34072/Desktop/胜利改牛逼/90110宇智波带土[暴怒]/帧动画/2539853437.assetbundle',
  'C:/Users/34072/Desktop/胜利改牛逼/90110宇智波带土[暴怒]/帧动画/234173134.assetbundle',
  'C:/Users/34072/Desktop/胜利改牛逼/90110宇智波带土[暴怒]/帧动画/511178771.assetbundle',
];
// 佐助 90059 战斗逻辑：kfb.real.test.ts 已证明内置密钥可自动匹配
const LOGIC_FILES = [
  'C:/Users/34072/Desktop/_assetstudio_rollback_backup/90059研究/3971289467.assetbundle',
];
const SCHEMA_JSON = path.join(process.cwd(), 'research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_schema.json');

const hasData =
  ANIM_FILES.some(f => fs.existsSync(f))
  && LOGIC_FILES.some(f => fs.existsSync(f))
  && fs.existsSync(SCHEMA_JSON);
const d = hasData ? it : it.skip;

/** 读取（必要时解密）UnityFS bundle */
async function loadFs(bytes: ArrayBuffer) {
  const { isKhBundle, decryptKhBundle } = await import('@/utils/khDecrypt');
  const fsBuf = isKhBundle(bytes) ? decryptKhBundle(bytes) : bytes;
  return loadAssetBundle(fsBuf.slice(0) as ArrayBuffer);
}

/** 与 KfbSemanticSkillEditor.autoMatchGroup 完全一致的匹配链 */
function autoMatchGroup(clipName: string, groupNames: string[]): string | undefined {
  if (groupNames.includes(clipName)) return clipName;
  const base = clipName.replace(/_?\d+$/, '');
  const matches = groupNames.filter(g => g.startsWith(base));
  if (matches.length === 1) return matches[0];
  const lowerBase = base.toLowerCase();
  const ciMatches = groupNames.filter(g => g.toLowerCase().startsWith(lowerBase));
  if (ciMatches.length === 1) return ciMatches[0];
  return undefined;
}

/** 从 bundle 提取全部帧动画组（跳过无 Sprite / 解不开的 bundle） */
async function collectAnimGroups(): Promise<{ name: string; frames: string[] }[]> {
  for (const file of ANIM_FILES.filter(f => fs.existsSync(f))) {
    try {
      const buf = fs.readFileSync(file);
      const bundle = await loadFs(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      const sprites = bundle.objects.filter(o => o.type === AssetType.Sprite) as any[];
      if (!sprites.length) continue;
      const gs = buildFrameGroups(
        sprites.map((s: any) => ({
          pathId: s.pathId,
          name: s.name,
          rect: { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h },
        })),
      );
      if (gs.length) {
        console.info(
          `[帧动画] ${path.basename(file)}: ${sprites.length} 个 Sprite → ${gs.length} 组`,
        );
        return gs.map(g => ({ name: g.name, frames: g.frames.map(f => f.name) }));
      }
    } catch (e) {
      console.warn(`[跳过] ${path.basename(file)}: ${String(e).slice(0, 120)}`);
    }
  }
  return [];
}

/** 从战斗逻辑 bundle 提取真实 clip 名（逐个容器试，成功即返回） */
async function collectClips(): Promise<{ name: string; frames: number }[] | null> {
  const schema = normalizeSchema(JSON.parse(fs.readFileSync(SCHEMA_JSON, 'utf8')));
  for (const file of LOGIC_FILES.filter(f => fs.existsSync(f))) {
    try {
      const buf = fs.readFileSync(file);
      const bundle = await loadFs(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      );
      const objs = bundle.objects.filter(
        o => o.type === AssetType.TextAsset && isKfbContainer(new Uint8Array((o as any).data as ArrayBuffer)),
      ) as any[];
      for (const o of objs) {
        try {
          const container = new Uint8Array(o.data as ArrayBuffer);
          const { key } = await decryptKfbContainerAuto(container, getKfbKeys());
          const decoded = decodeKfb(await decryptKfbContainerAuto(container, [key]).then(r => r.plain), schema);
          const sem: any = decoded.semantic;
          const clips = (sem.clipsDataList ?? []).map((c: any) => ({
            name: String(c.name ?? ''),
            frames: Number(c.totalframes ?? 0),
          }));
          if (!clips.length) continue;
          console.info(`[战斗逻辑] ${path.basename(file)} @ ${o.name}: key=${key.slice(0, 8)}…，${clips.length} 个 clip`);
          return clips;
        } catch {
          // 该容器 key 不匹配，试下一个
        }
      }
    } catch (e) {
      console.warn(`[跳过 logic] ${path.basename(file)}: ${String(e).slice(0, 120)}`);
    }
  }
  return null;
}

describe('帧动画联动（真实数据：clip ↔ 动画组配对）', () => {
  d('分组解析 + 自动匹配链全景', async () => {
    // 1) 动画组
    const groups = await collectAnimGroups();
    expect(groups.length).toBeGreaterThan(0);
    const groupNames = groups.map(g => g.name);

    // 2) 真实 clip 名
    const clips = await collectClips();
    expect(clips, '内置密钥库未能解开任一战斗逻辑 bundle').not.toBeNull();
    expect(clips!.length).toBeGreaterThan(0);

    // 3) 匹配全景
    const matched: string[] = [];
    const missed: string[] = [];
    for (const c of clips!) {
      const t = autoMatchGroup(c.name, groupNames);
      if (t) {
        const frames = groups.find(g => g.name === t)?.frames.length ?? 0;
        matched.push(`${c.name}(${c.frames}帧)→[${t}·${frames}帧]`);
      } else {
        missed.push(`${c.name}(${c.frames}帧)`);
      }
    }

    console.info(`[动画组] ${groupNames.length} 个：${groupNames.join(' / ')}`);
    console.info(`[clip] 共 ${clips!.length} 个`);
    console.info(`[自动匹配命中] ${matched.length} 个：`);
    console.info('  ' + (matched.join('\n  ') || '（本次样本无命中——见下方命名样例判断同源性）'));
    console.info(`[未命中] ${missed.join(' | ') || '（无）'}`);
    console.info(
      `[命名样例] 动画组示例：${groups.slice(0, 5).map(g => `${g.name} → ${g.frames.slice(0, 2).join(',')}…`).join(' | ')}`,
    );
    console.info(`[命名样例] clip 示例：${clips!.slice(0, 8).map(c => `${c.name}(${c.frames}帧)`).join(' | ')}`);
    // 演示匹配链降级：模拟一个"攻击片段"名
    console.info(`[演示] autoMatchGroup("attack1") =`, autoMatchGroup('attack1', groupNames) ?? '未命中');

    // 4) 分组正确性断言：组内帧号升序（不许倒序）
    for (const n of groupNames) {
      const frames = groups.find(g => g.name === n)!.frames;
      const nums = frames.map(f => parseFrameName(f)?.frame ?? -1);
      for (let i = 1; i < nums.length; i++) {
        expect(nums[i]! >= nums[i - 1]!, `${n} 组内帧序错乱：${frames.join(',')}`).toBe(true);
      }
    }
    // 组名去帧号后缀后应为原组名（分组稳定性）
    for (const n of groupNames) {
      const first = groups.find(g => g.name === n)!.frames[0]!;
      expect(stripFrameSuffix(first)).toBe(n);
    }
  });
});