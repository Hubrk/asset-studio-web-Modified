/**
 * KFB 编解码器回归测试：
 * 以 research（权威实现，Node 原生 Buffer）为基准，验证移植版字节级一致。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { decodeKfb, encodeKfb, normalizeSchema, runSyntheticSelfTest } from '../kfbSchemaDecoder';
import { legacyXmlToSemantic, semanticToLegacyXml } from '../kfbReadableAdapter';
import { decryptKfbContainer, encryptKfbContainer, isKfbContainer, lz4Store } from '../kfbBundle';

// 权威实现（research/js，Node 原生）
import { decodeKfb as cDecode, encodeKfb as cEncode, normalizeSchema as cNorm } from '../../../../research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_schema_decoder.js';
import {
  legacyXmlToSemantic as cXmlToSem,
  semanticToLegacyXml as cSemToXml,
} from '../../../../research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_readable_adapter.js';

const ROOT = path.resolve(__dirname, '../../../../');
const SCHEMA_PATH = path.join(ROOT, 'research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_schema.json');
const SAMPLE_XML = path.join(
  'C:/Users/34072/Desktop/_assetstudio_rollback_backup/90059研究/kfb_xml/3971289467_90059_p.xml',
);

describe('kfb codec vs canonical research implementation', () => {
  const schema = normalizeSchema(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
  const cSchema = cNorm(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));

  it('synthetic self test passes', () => {
    const result = runSyntheticSelfTest();
    expect(result.encodeRoundTrip).toBe(true);
  });

  it('port matches canonical for real Sasuke XML (encode byte-identical + semantic round-trip)', () => {
    const xml = fs.readFileSync(SAMPLE_XML, 'utf8');
    const semantic = cXmlToSem(xml, cSchema);

    // 1) 编码：移植版产物与权威版逐字节一致
    const canonicalBytes = cEncode(semantic, cSchema);
    const portedBytes = encodeKfb(semantic, schema);
    expect(Buffer.from(portedBytes).equals(Buffer.from(canonicalBytes))).toBe(true);

    // 2) 解码：移植版解权威版字节 → semantic 与权威解码一致（Deep equal，忽略键序）
    const decoded = decodeKfb(canonicalBytes, schema);
    const canonicalDecoded = cDecode(canonicalBytes, cSchema);
    expect(decoded.semantic).toEqual(canonicalDecoded.semantic);

    // 3) XML 输出：移植版与权威版逐字一致
    const canonicalXml = cSemToXml(semantic, cSchema);
    const portedXml = semanticToLegacyXml(semantic, schema);
    expect(portedXml).toBe(canonicalXml);

    // 4) 移植版 XML 解析回 semantic 一致
    expect(legacyXmlToSemantic(portedXml, schema)).toEqual(semantic);
  });

  it('ported decode of canonical encoded bytes is fully covered', () => {
    const xml = fs.readFileSync(SAMPLE_XML, 'utf8');
    const semantic = cXmlToSem(xml, cSchema);
    const bytes = cEncode(semantic, cSchema);
    const decoded = decodeKfb(bytes, schema);
    expect(decoded.coverage.coveredBytes).toBe(bytes.length);
  });

  it('container encrypt → decrypt round-trip works (new & old-tool layouts)', async () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const header = new Uint8Array([0x00, 0x0e, 0xaa, 0xbb]);
    const counter = new Uint8Array(16);
    counter.set(new TextEncoder().encode('123456789012'), 0);
    const plain = new TextEncoder().encode('hello kfb round-trip');

    // 新布局：[header 4][counter 16][cipher at 20]，与原版游戏容器字节布局一致
    const container = await encryptKfbContainer(plain, key, header, counter);
    expect(isKfbContainer(container)).toBe(true);
    expect(container.length).toBe(4 + 16 + lz4Store(plain).length);
    const back = await decryptKfbContainer(container, key);
    expect(new TextDecoder().decode(back)).toBe('hello kfb round-trip');

    // 旧工具布局：[header 4][iv 12][cipher at 16]（缺 counter 块尾 4 字节），也需能解
    const oldTool = new Uint8Array(container.length - 4);
    oldTool.set(container.subarray(0, 4), 0);
    oldTool.set(container.subarray(4, 16), 4);
    oldTool.set(container.subarray(20), 16);
    const back2 = await decryptKfbContainer(oldTool, key);
    expect(new TextDecoder().decode(back2)).toBe('hello kfb round-trip');
  });
});