/**
 * KFB 端到端真实文件验证（可选）：
 * 用内置密钥库自动匹配 → 解密 KH bundle → 解容器 → 解码 → XML
 * 与已解密权威样本 XML 对比，证明 密钥库 + 工具链 全链路可用。
 *
 * 依赖桌面备份文件，CI 无文件时自动跳过（it.skipIf）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadAssetBundle, AssetType } from '@arkntools/unity-js';
import { decryptKfbContainerAuto, isKfbContainer } from '../kfbBundle';
import { decodeKfb, normalizeSchema, encodeKfb } from '../kfbSchemaDecoder';
import { semanticToLegacyXml, legacyXmlToSemantic } from '../kfbReadableAdapter';
import { getKfbKeys } from '../keys';

const BUNDLE = path.join('C:/Users/34072/Desktop/_assetstudio_rollback_backup/90059研究/3971289467.assetbundle');
const CANONICAL_XML = path.join('C:/Users/34072/Desktop/_assetstudio_rollback_backup/90059研究/kfb_xml/3971289467_90059_p.xml');
const SCHEMA_JSON = path.join(process.cwd(), 'research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_schema.json');

describe('kfb real bundle round-trip (inner key library)', () => {
  it.skipIf(!fs.existsSync(BUNDLE) || !fs.existsSync(CANONICAL_XML))(
    'auto-match key → decrypt → decode → encode/XML 写回无损闭环',
    async () => {
      const schema = normalizeSchema(JSON.parse(fs.readFileSync(SCHEMA_JSON, 'utf8')));

      // 1) 备份中的 bundle 已是解密版 UnityFS（容器层仍为 AES 加密）
      const fsBuf = fs.readFileSync(BUNDLE);

      // 2) 取 90059_p TextAsset 的容器
      const bundle = await loadAssetBundle(fsBuf.buffer.slice(fsBuf.byteOffset, fsBuf.byteOffset + fsBuf.byteLength) as ArrayBuffer);
      const obj = bundle.objects.find(
        (o) => o.type === AssetType.TextAsset && o.name === '90059_p',
      );
      expect(obj, '未找到 90059_p TextAsset').toBeTruthy();
      const container = new Uint8Array((obj as any).data as ArrayBuffer);
      expect(isKfbContainer(container)).toBe(true);

      // 3) 内置密钥库自动匹配解密
      const { plain, key, guess } = await decryptKfbContainerAuto(container, getKfbKeys());
      expect(key.length).toBe(64);
      expect(guess.cipherStart).toBe(20);

      // 4) 解码
      const decoded = decodeKfb(plain, schema);
      expect(decoded.coverage.coveredBytes).toBe(plain.length);
      expect(Object.keys(decoded.semantic.objectFrames || {}).length).toBeGreaterThan(0);
      expect(Array.isArray(decoded.semantic.clipsDataList)).toBe(true);

      // 5) 语义 → 明文 → 可完整解码回同构语义（写回无损 ①）
      //    注：decode/encode 会并入 schema 默认值字段，字节不必等于原文，但结构必须可被游戏解析
      const reencoded = encodeKfb(decoded.semantic, schema);
      const decoded2 = decodeKfb(reencoded, schema);
      expect(decoded2.coverage.coveredBytes).toBe(reencoded.length);
      expect(decoded2.semantic).toEqual(decoded.semantic);

      // 6) XML → 语义 → 明文，再解码同构（写回无损 ②，覆盖编辑器改 XML 路径）
      const xml = semanticToLegacyXml(decoded.semantic, schema);
      const semanticFromXml = legacyXmlToSemantic(xml, schema);
      const reencoded2 = encodeKfb(semanticFromXml, schema);
      expect(decodeKfb(reencoded2, schema).semantic).toEqual(decoded.semantic);
    },
  );
});