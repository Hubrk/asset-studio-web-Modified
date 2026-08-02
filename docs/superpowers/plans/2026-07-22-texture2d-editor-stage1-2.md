# Texture2D 编辑器 - 阶段一+二：Fork unity-js 与序列化能力

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork @arkntools/unity-js 到本地，实现 ArrayBufferWriter、Texture2D.serialize()、Asset.rebuild()、BundleFile.rebuild()，使修改后的 bundle 能通过 round-trip 测试。

**Architecture:** 将 unity-js 源码复制到 packages/unity-js，作为本地依赖。新增 ArrayBufferWriter 类对标 Reader。为 Texture2D 添加 serialize 方法，为 Asset 和 BundleFile 添加 rebuild 方法，实现"解析→修改→重建"的完整循环。

**Tech Stack:** TypeScript, Vitest, lz4js, @arkntools/unity-js 源码

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `packages/unity-js/` | Fork 的 unity-js 包 | 创建 |
| `packages/unity-js/src/utils/writer.ts` | ArrayBufferWriter 二进制写入器 | 创建 |
| `packages/unity-js/src/classes/texture2d.ts` | Texture2D 类（新增 serialize 方法） | 修改 |
| `packages/unity-js/src/asset.ts` | Asset 类（新增 rebuild 方法） | 修改 |
| `packages/unity-js/src/bundle.ts` | BundleFile 类（新增 rebuild 方法） | 修改 |
| `packages/unity-js/src/index.ts` | 导出 ArrayBufferWriter | 修改 |
| `package.json` | 根项目（改依赖为本地路径） | 修改 |
| `src/utils/__tests__/arrayBufferWriter.test.ts` | Writer 单元测试 | 创建 |
| `src/utils/__tests__/texture2dSerialize.test.ts` | Texture2D 序列化 round-trip 测试 | 创建 |
| `src/utils/__tests__/bundleRebuild.test.ts` | Bundle 重建 round-trip 测试 | 创建 |

---

## Task 1: Fork unity-js 源码到本地

**Files:**
- Create: `packages/unity-js/` (从 node_modules 复制 src/)
- Modify: `package.json`

- [ ] **Step 1: 复制 unity-js 源码到 packages/unity-js**

```bash
# 复制源码和配置文件
cp -r node_modules/@arkntools/unity-js/src packages/unity-js/src
cp node_modules/@arkntools/unity-js/package.json packages/unity-js/package.json
cp node_modules/@arkntools/unity-js/tsconfig.json packages/unity-js/tsconfig.json 2>/dev/null || true
cp node_modules/@arkntools/unity-js/LICENSE packages/unity-js/LICENSE
```

- [ ] **Step 2: 修改 packages/unity-js/package.json**

将 `name` 改为 `@local/unity-js`，移除不需要的字段：

```json
{
  "name": "@local/unity-js",
  "version": "5.2.0-local",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@arkntools/fmod": "^1.0.4",
    "@arkntools/lame-wasm": "^1.0.2",
    "@arkntools/unity-js-tools": "^3.2.0",
    "@jimp/core": "^1.6.1",
    "@jimp/js-png": "^1.6.1",
    "@jimp/plugin-crop": "^1.6.1",
    "@jimp/plugin-flip": "^1.6.1",
    "@jimp/plugin-resize": "^1.6.1",
    "@jimp/plugin-rotate": "^1.6.1",
    "@jimp/types": "^1.6.1",
    "@jimp/wasm-png": "^1.6.1",
    "aes-js": "^3.1.2",
    "es-toolkit": "^1.47.0",
    "jszip": "^3.10.1"
  }
}
```

- [ ] **Step 3: 修改根 package.json**

将 `@arkntools/unity-js` 依赖改为本地路径：

```json
{
  "dependencies": {
    "@arkntools/unity-js": "file:packages/unity-js"
  }
}
```

- [ ] **Step 4: 重新安装依赖并验证**

```bash
npm install
```

验证导入正常：
```bash
npx tsx -e "import { load } from '@arkntools/unity-js'; console.log(typeof load)"
```
Expected: `function`

- [ ] **Step 5: 运行现有测试确认无回归**

```bash
npx vitest run
```
Expected: 所有现有测试通过

- [ ] **Step 6: Commit**

```bash
git add packages/unity-js package.json package-lock.json
git commit -m "feat: fork @arkntools/unity-js to packages/unity-js for write support"
```

---

## Task 2: 实现 ArrayBufferWriter

**Files:**
- Create: `packages/unity-js/src/utils/writer.ts`
- Create: `src/utils/__tests__/arrayBufferWriter.test.ts`
- Modify: `packages/unity-js/src/index.ts`

- [ ] **Step 1: 编写 ArrayBufferWriter 的失败测试**

创建 `src/utils/__tests__/arrayBufferWriter.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { ArrayBufferWriter } from '@arkntools/unity-js';
import { ArrayBufferReader } from '@arkntools/unity-js';

describe('ArrayBufferWriter', () => {
  it('writeInt32 / readInt32 round-trip', () => {
    const w = new ArrayBufferWriter(4);
    w.writeInt32(-123456);
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readInt32()).toBe(-123456);
  });

  it('writeUInt32BE / readUInt32BE round-trip', () => {
    const w = new ArrayBufferWriter(4);
    w.writeUInt32BE(0xDEADBEEF);
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readUInt32BE()).toBe(0xDEADBEEF);
  });

  it('writeUInt64 / readUInt64 round-trip', () => {
    const w = new ArrayBufferWriter(8);
    w.writeUInt64(0x123456789ABCDEF0n);
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readUInt64()).toBe(0x123456789ABCDEF0n);
  });

  it('writeFloat32 / readFloat32 round-trip', () => {
    const w = new ArrayBufferWriter(4);
    w.writeFloat32(3.14159);
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readFloat32()).toBeCloseTo(3.14159, 5);
  });

  it('writeAlignedString / readAlignedString round-trip', () => {
    const w = new ArrayBufferWriter(32);
    w.writeAlignedString('hello');
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readAlignedString()).toBe('hello');
    // 对齐后位置应为 12 (4字节长度 + 5字节字符串 + 3字节padding)
    expect(r.position).toBe(12);
  });

  it('writeBuffer / readBuffer round-trip', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const w = new ArrayBufferWriter(5);
    w.writeBuffer(data);
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    const read = new Uint8Array(r.readBuffer(5));
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5]);
  });

  it('align pads with zeros', () => {
    const w = new ArrayBufferWriter(8);
    w.writeInt32(42);
    w.align(4); // already aligned, no-op
    expect(w.position).toBe(4);
    w.writeInt8(1);
    w.align(4); // pad 3 bytes
    expect(w.position).toBe(8);
    const r = new ArrayBufferReader(w.getBuffer());
    r.readInt32(); // skip first int
    r.readInt8();  // skip byte
    r.align(4);    // align reader
    expect(r.position).toBe(8);
  });

  it('seek and position', () => {
    const w = new ArrayBufferWriter(16);
    w.writeInt32(1);
    w.writeInt32(2);
    expect(w.position).toBe(8);
    w.seek(0);
    expect(w.position).toBe(0);
    w.writeInt32(99);
    const r = new ArrayBufferReader(w.getBuffer());
    expect(r.readInt32()).toBe(99);
    expect(r.readInt32()).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/utils/__tests__/arrayBufferWriter.test.ts
```
Expected: FAIL — `ArrayBufferWriter` 未导出

- [ ] **Step 3: 实现 ArrayBufferWriter**

创建 `packages/unity-js/src/utils/writer.ts`：

```typescript
export class ArrayBufferWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;
  private littleEndian = true;
  private readonly textEncoder = new TextEncoder();

  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
  }

  get position(): number {
    return this.offset;
  }

  get length(): number {
    return this.buffer.byteLength;
  }

  getBuffer(): ArrayBuffer {
    return this.buffer;
  }

  setLittleEndian(value: boolean): void {
    this.littleEndian = value;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.length) {
      throw new Error(`Position ${pos} out of range ${this.length}`);
    }
    this.offset = pos;
  }

  move(delta: number): void {
    this.seek(this.offset + delta);
  }

  align(size: number): void {
    const remain = this.offset % size;
    if (remain === 0) return;
    const after = this.offset - remain + size;
    // 零填充 padding 区域
    while (this.offset < after) {
      this.writeUInt8(0);
    }
  }

  writeBuffer(buffer: ArrayBuffer | Uint8Array): void {
    const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dst = new Uint8Array(this.buffer, this.offset, src.length);
    dst.set(src);
    this.offset += src.length;
  }

  writeInt8(value: number): void {
    this.view.setInt8(this.offset, value);
    this.offset++;
  }

  writeUInt8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset++;
  }

  writeBoolean(value: boolean): void {
    this.writeUInt8(value ? 1 : 0);
  }

  writeAlignedString(str: string): void {
    const encoded = this.textEncoder.encode(str);
    this.writeUInt32(encoded.length);
    this.writeBuffer(encoded);
    this.align(4);
  }

  writeStringUntilZero(str: string): void {
    const encoded = this.textEncoder.encode(str);
    this.writeBuffer(encoded);
    this.writeUInt8(0);
  }

  // 动态生成各种 write 方法，对标 Reader 的动态生成模式
}

// 动态生成 writeInt16/UInt16/Int32/UInt32/Int64/UInt64/Float32/Float64 及 LE/BE 变体
for (const bits of [16, 32, 64]) {
  const size = Math.round(bits / 8);
  for (const unsigned of ['', 'U']) {
    for (const [littleEndian, suffix] of [
      [null, ''],
      [true, 'LE'],
      [false, 'BE'],
    ] as const) {
      const fnName = `write${unsigned}Int${bits}${suffix}`;
      const viewFnName = `set${bits === 64 ? 'Big' : ''}${unsigned ? 'Uint' : 'Int'}${bits}`;
      (ArrayBufferWriter.prototype as any)[fnName] = function (this: any, value: any) {
        const le = littleEndian === null ? this.littleEndian : littleEndian;
        this.view[viewFnName](this.offset, value, le);
        this.offset += size;
      };
    }
  }
}

for (const bits of [32, 64]) {
  const size = Math.round(bits / 8);
  for (const [littleEndian, suffix] of [
    [null, ''],
    [true, 'LE'],
    [false, 'BE'],
  ] as const) {
    const fnName = `writeFloat${bits}${suffix}`;
    const viewFnName = `setFloat${bits}`;
    (ArrayBufferWriter.prototype as any)[fnName] = function (this: any, value: any) {
      const le = littleEndian === null ? this.littleEndian : littleEndian;
      this.view[viewFnName](this.offset, value, le);
      this.offset += size;
    };
  }
}
```

- [ ] **Step 4: 在 index.ts 中导出 ArrayBufferWriter**

在 `packages/unity-js/src/index.ts` 末尾添加：

```typescript
export { ArrayBufferWriter } from './utils/writer';
```

- [ ] **Step 5: 运行测试验证通过**

```bash
npx vitest run src/utils/__tests__/arrayBufferWriter.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/unity-js/src/utils/writer.ts packages/unity-js/src/index.ts src/utils/__tests__/arrayBufferWriter.test.ts
git commit -m "feat: add ArrayBufferWriter for binary serialization"
```

---

## Task 3: Texture2D.serialize() — streamData 模式

**Files:**
- Modify: `packages/unity-js/src/classes/texture2d.ts`
- Create: `src/utils/__tests__/texture2dSerialize.test.ts`

- [ ] **Step 1: 编写 Texture2D serialize round-trip 失败测试**

创建 `src/utils/__tests__/texture2dSerialize.test.ts`：

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load, ArrayBufferWriter, ArrayBufferReader } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('Texture2D serialize round-trip', () => {
  // 使用火影手游的真实文件测试
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('Texture2D serialize → parse produces identical bytes (streamData mode)', async () => {
    if (!existsSync(testFile)) { console.warn('skip: test file not found'); return; }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) {
      buffer = decryptKhBundle(buffer);
    }

    const bundle = await load(buffer);
    // 找到第一个 Texture2D
    const tex = bundle.objects.find(o => o.type === 28); // AssetType.Texture2D = 28
    if (!tex) { console.warn('skip: no Texture2D found'); return; }

    // 获取原始字节
    const rawBytes = tex.getRaw();

    // serialize
    const writer = new ArrayBufferWriter(rawBytes.byteLength);
    tex.serialize(writer);
    const serialized = writer.getBuffer();

    // 验证 serialize 产生的字节与原始字节一致
    const rawView = new Uint8Array(rawBytes);
    const serView = new Uint8Array(serialized);
    expect(serView.length).toBe(rawView.length);
    for (let i = 0; i < rawView.length; i++) {
      expect(serView[i]).toBe(rawView[i]);
    }
  }, 30000);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/utils/__tests__/texture2dSerialize.test.ts
```
Expected: FAIL — `tex.serialize is not a function`

- [ ] **Step 3: 实现 Texture2D.serialize()**

在 `packages/unity-js/src/classes/texture2d.ts` 中，给 Texture2D 类添加 `serialize` 方法。实现要点：严格按构造函数中 `r.read*` / `r.move` 的顺序，用 writer 写入对应值。

```typescript
import { ArrayBufferWriter } from '../utils/writer';

// 在 Texture2D 类中添加：
serialize(writer: ArrayBufferWriter): void {
  const { version } = this.__info;
  // name (继承自 AssetBase，readName 读取的 aligned string)
  writer.writeAlignedString(this.name);

  if (version[0] > 2017 || (version[0] === 2017 && version[1] >= 3)) {
    writer.move(5); // r.move(5)
    if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
      writer.move(1);
    }
    writer.align(4);
  }
  writer.writeInt32(this.width);          // r.readInt32()
  writer.writeInt32(this.height);         // r.readInt32()
  writer.move(4);                         // r.move(4)
  if (version[0] >= 2020) writer.move(4); // r.move(4)
  writer.writeInt32(this.textureFormat);  // r.readInt32()
  if (version[0] < 5 || (version[0] === 5 && version[1] < 2))
    writer.move(1);
  else
    writer.move(4);
  if (version[0] > 2 || (version[0] === 2 && version[1] >= 6)) writer.move(1);
  if (version[0] >= 2020) writer.move(1);
  if (version[0] > 2019 || (version[0] === 2019 && version[1] >= 3)) writer.move(1);
  if (version[0] >= 3 && (version[0] < 5 || (version[0] === 5 && version[1] <= 4))) writer.move(1);
  if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) writer.move(1);
  writer.align(4);
  if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) writer.move(4);
  writer.move(8);

  // writeTextureSetting
  writer.move(12);
  if (version[0] >= 2017) writer.move(12);
  else writer.move(4);
  // 注意：isArknightsEndfield 的额外 4 字节需要根据 bundle options 判断
  if (this.__info.isArknightsEndfield?.()) writer.move(4);

  if (version[0] >= 3) writer.move(4);
  if (version[0] > 3 || (version[0] === 3 && version[1] >= 5)) writer.move(4);

  if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
    // r.readBuffer(r.readInt32()) + r.align(4)
    // 这里需要写入原始的 plotting data
    // 暂时跳过这个版本分支（火影手游通常不在这个版本范围）
    throw new Error('serialize: Unity 2020.2+ plotting data not supported yet');
  }

  // dataSize 或 streamData
  if (this.streamData) {
    // streamData 模式：写入 dataSize=0 + StreamInfo
    writer.writeInt32(0);
    // StreamInfo: offset + size + path
    if (version[0] >= 2020) {
      writer.writeUInt64(BigInt(this.streamData.offset));
    } else {
      writer.writeUInt32(this.streamData.offset);
    }
    writer.writeUInt32(this.streamData.size);
    writer.writeAlignedString(this.streamData.path);
  } else {
    // 内嵌模式：写入 dataSize + 数据
    writer.writeInt32(this.dataSize);
    writer.writeBuffer(this.image.rawData.buffer);
  }
}
```

注意：`this.image.rawData` 需要确保未被解码（`decoded === false`）。如果已解码，需要用原始数据。可以通过 `getRaw()` 获取原始字节中的 data 部分来替代。

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/utils/__tests__/texture2dSerialize.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/unity-js/src/classes/texture2d.ts src/utils/__tests__/texture2dSerialize.test.ts
git commit -m "feat: add Texture2D.serialize() for streamData and embedded modes"
```

---

## Task 4: Asset.rebuild() — 重建 SerializedFile

**Files:**
- Modify: `packages/unity-js/src/asset.ts`
- Create: `src/utils/__tests__/assetRebuild.test.ts`

- [ ] **Step 1: 编写 Asset rebuild round-trip 失败测试**

创建 `src/utils/__tests__/assetRebuild.test.ts`：

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('Asset rebuild round-trip', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('rebuild produces identical bytes for unmodified asset', async () => {
    if (!existsSync(testFile)) { console.warn('skip'); return; }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);
    // 获取第一个 .assets 文件对应的 Asset
    // bundle.files[0] 通常是 .assets 文件
    // 需要找到对应的 Asset 实例 — 但 Asset 不暴露在 bundle 上
    // 通过 ObjectInfo 访问 asset
    const obj = bundle.objects[0];
    if (!obj) { console.warn('skip: no objects'); return; }
    const asset = (obj as any).__info.asset;

    // 获取原始 SerializedFile 数据
    // asset.reader 指向原始数据
    const origData = asset.reader.rawBuffer.slice(0);

    // rebuild
    const rebuilt = asset.rebuild();

    // 验证重建后与原始一致
    const origView = new Uint8Array(origData);
    const rebView = new Uint8Array(rebuilt);
    expect(rebView.length).toBe(origView.length);
    for (let i = 0; i < origView.length; i++) {
      expect(rebView[i]).toBe(origView[i]);
    }
  }, 30000);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/utils/__tests__/assetRebuild.test.ts
```
Expected: FAIL — `asset.rebuild is not a function`

- [ ] **Step 3: 实现 Asset.rebuild()**

在 `packages/unity-js/src/asset.ts` 中添加 `rebuild` 方法。

关键：需要重新序列化 header + metadata + data。metadata 包含 types 和 objectInfos。data 是所有 ObjectInfo 的序列化数据。

```typescript
import { ArrayBufferWriter } from './utils/writer';

// 在 Asset 类中添加：
rebuild(): ArrayBuffer {
  // 1. 收集所有 ObjectInfo 的新序列化数据
  // 对于未修改的 Object，直接使用原始字节 (getRaw)
  // 对于已修改的 Object，使用 serialize 后的字节
  const objectDataList: ArrayBuffer[] = [];
  let dataOffset = 0;

  // 先计算 metadata 部分的大小来确定 dataOffset
  // metadata: header(16/20) + unityVersion + targetPlatform + types + objectInfos
  // 简化：使用原始 dataOffset
  dataOffset = this.header.dataOffset;

  // 为每个 ObjectInfo 分配新的 bytesStart
  let currentOffset = dataOffset;
  for (const info of this.objectInfos) {
    // 如果 ObjectInfo 有新的序列化数据，用新的；否则用原始的
    let objData: ArrayBuffer;
    if ((info as any)._modifiedData) {
      objData = (info as any)._modifiedData;
    } else {
      // 使用原始数据
      const r = info.getReader();
      objData = r.readBuffer(info.bytesSize);
    }

    // 更新 bytesStart
    (info as any).bytesStart = currentOffset;
    (info as any).bytesSize = objData.byteLength;

    objectDataList.push(objData);
    currentOffset += objData.byteLength;
  }

  // 2. 计算 metadata 大小
  // 简化：用两遍写入，第一遍计算大小，第二遍写入
  // 或者用动态大小的 buffer

  // 3. 写入 SerializedFile
  const fileSize = currentOffset; // dataOffset + 所有 object data
  const writer = new ArrayBufferWriter(fileSize);

  // header
  writer.writeUInt32BE(0); // metadataSize — 先占位，后面回填
  writer.writeUInt32(fileSize); // fileSize
  writer.writeUInt32(this.header.version); // version
  writer.writeUInt32(this.header.dataOffset); // dataOffset
  if (this.header.version >= 9) {
    writer.writeUInt8(this.fileEndianness);
    writer.move(3); // padding
  }
  if (this.header.version >= 22) {
    // 额外的 header 字段
    // metadataSize(u32) + fileSize(u64) + dataOffset(u64) + unknown(8)
    writer.seek(0);
    writer.writeUInt32BE(0); // metadataSize placeholder
    writer.writeUInt32(fileSize);
    writer.writeUInt32(this.header.version);
    writer.writeUInt32(this.header.dataOffset);
    writer.writeUInt8(this.fileEndianness);
    writer.move(3);
    writer.writeUInt32(0); // metadataSize (repeated)
    writer.writeUInt64(BigInt(fileSize));
    writer.writeUInt64(BigInt(this.header.dataOffset));
    writer.move(8);
  }

  // metadata
  writer.setLittleEndian(!this.fileEndianness);
  if (this.header.version >= 7) {
    // unityVersion string (null terminated)
    writer.writeStringUntilZero(this.unityVersion);
  }
  if (this.header.version >= 8) {
    writer.writeInt32(this.targetPlatform);
  }
  if (this.header.version >= 13) {
    writer.writeUInt8(this.enableTypeTree ? 1 : 0);
  }
  // types
  writer.writeUInt32(this.types.length);
  for (const type of this.types) {
    type.serialize(writer, this.enableTypeTree);
  }
  // objectInfos
  writer.writeUInt32(this.objectInfos.length);
  for (const info of this.objectInfos) {
    info.serialize(writer);
  }

  // 回填 metadataSize
  const metadataSize = writer.position - (this.header.version >= 22 ? 20 : 16);
  writer.seek(0);
  writer.writeUInt32BE(metadataSize);
  writer.seek(metadataSize + (this.header.version >= 22 ? 20 : 16));

  // data (所有 ObjectInfo 的序列化数据)
  for (const objData of objectDataList) {
    writer.writeBuffer(objData);
  }

  return writer.getBuffer();
}
```

注意：这需要 SerializedType 和 ObjectInfo 也有 `serialize` 方法。如果它们没有，需要先实现。

- [ ] **Step 4: 实现 ObjectInfo.serialize() 和 SerializedType.serialize()**

在 `packages/unity-js/src/object.ts` 中添加：

```typescript
import { ArrayBufferWriter } from './utils/writer';

// 在 ObjectInfo 类中添加：
serialize(writer: ArrayBufferWriter): void {
  if (this.asset.enableBigId) {
    writer.writeInt64(this.pathId);
  } else if (this.asset.header.version < 14) {
    writer.writeInt32(Number(this.pathId));
  } else {
    writer.align(4);
    writer.writeInt64(this.pathId);
  }
  if (this.asset.header.version >= 22) {
    writer.writeUInt64(BigInt(this.bytesStart - this.asset.header.dataOffset));
  } else {
    writer.writeUInt32(this.bytesStart - this.asset.header.dataOffset);
  }
  writer.writeUInt32(this.bytesSize);
  writer.writeInt32(this.typeId);
  if (this.asset.header.version < 16) {
    writer.writeUInt16(this.classId);
  }
  if (this.asset.header.version < 11) {
    writer.writeUInt16(this.isDestroyed);
  }
  if (this.asset.header.version >= 11 && this.asset.header.version < 17) {
    writer.writeUInt16(this.serializedType?.scriptTypeIndex ?? 0);
  }
  if (this.asset.header.version === 15 || this.asset.header.version === 16) {
    writer.writeUInt8(this.stripped);
  }
}
```

在 `packages/unity-js/src/serializedType.ts` 中添加：

```typescript
import { ArrayBufferWriter } from './utils/writer';

// 在 SerializedType 类中添加：
serialize(writer: ArrayBufferWriter, enableTypeTree: boolean): void {
  writer.writeInt32(this.classId);
  if (this.asset.header.version >= 16) {
    writer.writeUInt8(this.scriptTypeIndex ?? 0);
    writer.writeUInt8(this.stripped ?? 0);
    // typeHash
    writer.writeBuffer(this.typeHash ?? new ArrayBuffer(16));
  }
  // ... 根据 enableTypeTree 写入 TypeTree
  // 简化：如果原始有 TypeTree 数据，直接写入原始字节
}
```

注意：SerializedType 的 serialize 比较复杂，需要处理 TypeTree 序列化。对于火影手游的文件，如果 enableTypeTree=true，需要完整序列化 TypeTree；如果 enableTypeTree=false，则只需写入 classId 等基本字段。

- [ ] **Step 5: 运行测试验证通过**

```bash
npx vitest run src/utils/__tests__/assetRebuild.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/unity-js/src/asset.ts packages/unity-js/src/object.ts packages/unity-js/src/serializedType.ts src/utils/__tests__/assetRebuild.test.ts
git commit -m "feat: add Asset.rebuild(), ObjectInfo.serialize(), SerializedType.serialize()"
```

---

## Task 5: BundleFile.rebuild() — 重建 UnityFS

**Files:**
- Modify: `packages/unity-js/src/bundle.ts`
- Create: `src/utils/__tests__/bundleRebuild.test.ts`

- [ ] **Step 1: 编写 Bundle rebuild round-trip 失败测试**

创建 `src/utils/__tests__/bundleRebuild.test.ts`：

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('BundleFile rebuild round-trip', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('rebuild produces identical bytes for unmodified bundle', async () => {
    if (!existsSync(testFile)) { console.warn('skip'); return; }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);
    const rebuilt = bundle.rebuild();

    // 验证重建后与原始一致（或至少能重新解析）
    const bundle2 = await load(rebuilt);
    expect(bundle2.objects.length).toBe(bundle.objects.length);

    // 验证每个 object 的原始字节一致
    for (let i = 0; i < bundle.objects.length; i++) {
      const origRaw = bundle.objects[i].getRaw();
      const rebRaw = bundle2.objects[i].getRaw();
      const o = new Uint8Array(origRaw);
      const r = new Uint8Array(rebRaw);
      expect(r.length).toBe(o.length);
      for (let j = 0; j < o.length; j++) {
        expect(r[j]).toBe(o[j]);
      }
    }
  }, 30000);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/utils/__tests__/bundleRebuild.test.ts
```
Expected: FAIL — `bundle.rebuild is not a function`

- [ ] **Step 3: 实现 BundleFile.rebuild()**

在 `packages/unity-js/src/bundle.ts` 中添加：

```typescript
import { ArrayBufferWriter } from './utils/writer';
import { compressBlock, compressBound } from 'lz4js';

// 在 BundleFile 类中添加：
rebuild(): ArrayBuffer {
  // 1. 重新构建 files 数组（可能有 node 数据被修改）
  // 对每个 .assets 文件，调用 Asset.rebuild()
  // 对非 .assets 文件（如纹理数据），直接使用修改后的数据

  // 2. 拼接所有 files 为 block data
  const concatData = concatArrayBuffer(this.files);

  // 3. 重新压缩 block data
  const compressionType = this.header.flags & 0x3f;
  let compressedData: Uint8Array;
  if (compressionType === 0) {
    // 无压缩
    compressedData = new Uint8Array(concatData);
  } else if (compressionType === 2 || compressionType === 3) {
    // LZ4 / LZ4_HC
    const bound = compressBound(concatData.byteLength);
    const dst = new Uint8Array(bound);
    const hashTable = new Uint32Array(1 << 16);
    const compSize = compressBlock(new Uint8Array(concatData), dst, 0, concatData.byteLength, hashTable);
    compressedData = dst.slice(0, compSize);
  } else {
    throw new Error(`Unsupported compression type: ${compressionType}`);
  }

  // 4. 重建 blocksInfo
  const biWriter = new ArrayBufferWriter(1024);
  biWriter.move(16); // hash (16 bytes zero)
  biWriter.writeInt32BE(1); // block count
  // block entry: uncompressedSize(4) + compressedSize(4) + flags(2)
  biWriter.writeUInt32BE(concatData.byteLength);
  biWriter.writeUInt32BE(compressedData.length);
  biWriter.writeUInt16BE(this.blockInfos[0]?.flags ?? 0);
  // node entries
  biWriter.writeInt32BE(this.nodes.length);
  let nodeOffset = 0;
  for (const node of this.nodes) {
    biWriter.writeUInt64(BigInt(nodeOffset));
    biWriter.writeUInt64(BigInt(node.size));
    biWriter.writeUInt32(node.flags);
    biWriter.writeStringUntilZero(node.path);
    nodeOffset += node.size;
  }
  const blocksInfoData = biWriter.getBuffer();

  // 5. 重新压缩 blocksInfo（如果原 flags 指示压缩）
  let compressedBlocksInfo: Uint8Array;
  const archiveFlags = this.header.flags;
  const biCompression = archiveFlags & 0x3f;
  if (biCompression === 0) {
    compressedBlocksInfo = new Uint8Array(blocksInfoData);
  } else {
    const bound = compressBound(blocksInfoData.byteLength);
    const dst = new Uint8Array(bound);
    const hashTable = new Uint32Array(1 << 16);
    const compSize = compressBlock(new Uint8Array(blocksInfoData), dst, 0, blocksInfoData.byteLength, hashTable);
    compressedBlocksInfo = dst.slice(0, compSize);
  }

  // 6. 构建 UnityFS 文件
  const headerSize = this.header.signature.length + 1 + 4 + this.header.unityVersion.length + 1 + this.header.unityReversion.length + 1 + 8 + 4 + 4 + 4;
  const totalSize = headerSize + compressedBlocksInfo.length + compressedData.length;
  const writer = new ArrayBufferWriter(totalSize);

  // header
  writer.writeStringUntilZero(this.header.signature);
  writer.writeUInt32BE(this.header.version);
  writer.writeStringUntilZero(this.header.unityVersion);
  writer.writeStringUntilZero(this.header.unityReversion);
  writer.writeUInt64BE(BigInt(totalSize));
  writer.writeUInt32BE(compressedBlocksInfo.length); // compressedBlocksInfoSize
  writer.writeUInt32BE(blocksInfoData.byteLength); // uncompressedBlocksInfoSize
  writer.writeUInt32BE(this.header.flags);

  // align to 16
  writer.align(16);

  // blocksInfo
  writer.writeBuffer(compressedBlocksInfo);

  // block data
  writer.writeBuffer(compressedData);

  return writer.getBuffer();
}
```

注意：`concatArrayBuffer` 已在 `utils/buffer.ts` 中存在。需要确保 import 路径正确。

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/utils/__tests__/bundleRebuild.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/unity-js/src/bundle.ts src/utils/__tests__/bundleRebuild.test.ts
git commit -m "feat: add BundleFile.rebuild() for UnityFS container reconstruction"
```

---

## Task 6: 端到端修改测试 — 替换 Texture2D 像素数据

**Files:**
- Create: `src/utils/__tests__/textureModify.test.ts`

- [ ] **Step 1: 编写端到端修改测试**

创建 `src/utils/__tests__/textureModify.test.ts`：

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle, encryptUnityFsToKh } from '../khEncrypt';

describe('Texture2D 端到端修改测试', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('修改 Texture2D streamData → rebuild bundle → 重新解析验证', async () => {
    if (!existsSync(testFile)) { console.warn('skip'); return; }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);

    // 找到 Texture2D
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex) { console.warn('skip: no Texture2D'); return; }

    // 验证是 streamData 模式
    if (!tex.streamData) { console.warn('skip: not streamData mode'); return; }

    // 记录原始纹理数据
    const origRawData = new Uint8Array(tex.image.rawData);

    // 创建修改后的数据（将所有字节 +1，模拟修改）
    const modifiedData = new Uint8Array(origRawData.length);
    for (let i = 0; i < origRawData.length; i++) {
      modifiedData[i] = (origRawData[i] + 1) & 0xFF;
    }

    // 替换纹理数据
    // 在 bundle.files 中找到对应 node
    const nodeIndex = bundle.nodes.findIndex(n => n.path === tex.streamData.path.split('/').pop());
    expect(nodeIndex).toBeGreaterThanOrEqual(0);

    // 在 node 数据中替换
    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    const offset = tex.streamData.offset;
    const size = tex.streamData.size;
    expect(size).toBe(origRawData.length);

    // in-place 替换（大小不变）
    nodeData.set(modifiedData, offset);

    // rebuild bundle
    const rebuilt = bundle.rebuild();

    // 重新解析
    const bundle2 = await load(rebuilt);
    const tex2 = bundle2.objects.find(o => o.pathId === tex.pathId);
    expect(tex2).toBeDefined();

    // 验证修改后的数据
    const modifiedRawData = new Uint8Array(tex2.image.rawData);
    expect(modifiedRawData.length).toBe(origRawData.length);
    for (let i = 0; i < origRawData.length; i++) {
      expect(modifiedRawData[i]).toBe((origRawData[i] + 1) & 0xFF);
    }
  }, 30000);

  it('修改 → rebuild → 加密为 KH → 解密 → 验证', async () => {
    if (!existsSync(testFile)) { console.warn('skip'); return; }

    const raw = readFileSync(testFile).buffer;
    const isKh = isKhBundle(raw);
    let buffer: ArrayBuffer = raw;
    if (isKh) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex?.streamData) { console.warn('skip'); return; }

    // 修改纹理数据（大小不变）
    const nodeIndex = bundle.nodes.findIndex(n => n.path === tex.streamData.path.split('/').pop());
    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    const origByte = nodeData[tex.streamData.offset];
    nodeData[tex.streamData.offset] = (origByte + 1) & 0xFF;

    // rebuild
    const rebuilt = bundle.rebuild();

    // 加密为 KH（如果有原始 KH meta）
    if (isKh) {
      const encrypted = encryptUnityFsToKh(rebuilt, undefined, 'UnityKHFS');
      expect(isKhBundle(encrypted)).toBe(true);

      // 解密回来
      const decrypted = decryptKhBundle(encrypted);
      const bundle3 = await load(decrypted);
      const tex3 = bundle3.objects.find(o => o.pathId === tex.pathId);
      expect(tex3).toBeDefined();

      // 验证修改保持
      const finalData = new Uint8Array(tex3.image.rawData);
      expect(finalData[0]).toBe((origByte + 1) & 0xFF);
    }
  }, 30000);
});
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/utils/__tests__/textureModify.test.ts
```
Expected: PASS（如果所有序列化实现正确）

- [ ] **Step 3: Commit**

```bash
git add src/utils/__tests__/textureModify.test.ts
git commit -m "test: add end-to-end Texture2D modification test"
```

---

## Task 7: 运行全部测试确认无回归

- [ ] **Step 1: 运行全部测试**

```bash
npx vitest run
```
Expected: 所有测试通过（包括原有的 KH 加密/解密测试和新添加的序列化测试）

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "test: verify all tests pass after unity-js fork and serialization support"
```

---

## 后续阶段（单独的计划文件）

- **阶段三：WASM 纹理编码器** — 集成 BC7/ASTC/DXT 编码器，支持将 RGBA 编码为目标格式
- **阶段四：UI 与集成** — TextureEditor.vue 组件，AssetPreview Edit Tab，AssetManager.modifyTexture2D 方法
