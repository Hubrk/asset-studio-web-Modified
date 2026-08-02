import { loopMap } from './loop';

export interface ArrayBufferReaderOptions {
  littleEndian?: boolean;
  offset?: number;
  length?: number;
}

export class ArrayBufferReader {
  private offset = 0;
  private readonly view: DataView<ArrayBuffer>;
  private readonly textDecoder = new TextDecoder();

  constructor(
    buffer: ArrayBuffer,
    private readonly options: ArrayBufferReaderOptions = {},
  ) {
    this.view = new DataView(buffer, options.offset, options.length);
  }

  get length() {
    return this.view.byteLength;
  }

  get position() {
    return this.offset;
  }

  get rawBuffer() {
    return this.view.buffer;
  }

  clone(options?: ArrayBufferReaderOptions) {
    return new ArrayBufferReader(this.view.buffer, { ...this.options, ...options });
  }

  setLittleEndian(value: boolean) {
    this.options.littleEndian = value;
  }

  seek(position: number) {
    this.checkPosition(position);
    this.offset = position;
  }

  move(offset: number) {
    this.seek(this.offset + offset);
  }

  align(size: number) {
    const before = this.offset;
    const remain = before % size;
    const after = remain === 0 ? before : before - remain + size;
    if (after > this.length) throw new Error('Align error');
    this.seek(after);
  }

  readBuffer(length: number) {
    const end = this.checkLength(length);
    const buffer = this.view.buffer.slice(this.offset, end);
    this.offset += length;
    return buffer;
  }

  readUInt8Slice(length: number): Uint8Array<ArrayBuffer> {
    this.checkLength(length);
    const slice = new Uint8Array(this.view.buffer, this.offset, length);
    this.offset += length;
    return slice;
  }

  readString(length: number) {
    const end = this.checkLength(length);
    const buffer = this.view.buffer.slice(this.offset, end);
    const str = this.bufferToString(buffer);
    this.offset += length;
    return str;
  }

  readStringUntilZero() {
    const startOffset = this.offset;
    const totalLen = this.length;
    // 空 buffer 直接返回空串
    if (startOffset >= totalLen) {
      return '';
    }
    let length = 0;
    const maxRead = totalLen - startOffset;
    while (length < maxRead) {
      const byteOffset = startOffset + length;
      // 二次保险：确保 byteOffset 在 DataView 的可访问范围内
      if (byteOffset < 0 || byteOffset >= this.view.byteLength) break;
      if (this.view.getUint8(byteOffset) === 0) break;
      length++;
    }
    // 没找到 0 结尾（读到 buffer 末尾）—— 当作读到末尾的非 0 结尾字符串
    if (length >= maxRead) {
      return this.readString(maxRead);
    }
    // 正常分支：找到了终止符 0
    const str = this.readString(length);
    this.offset++;
    return str;
  }

  readAlignedString() {
    const length = this.readUInt32();
    const str = this.readString(length);
    this.align(4);
    return str;
  }

  readAlignedStringArray() {
    return loopMap(this.readUInt32(), () => this.readAlignedString());
  }

  readBoolean() {
    return Boolean(this.readUInt8());
  }

  readInt8() {
    const value = this.view.getInt8(this.offset);
    this.offset++;
    return value;
  }

  readUInt8() {
    const value = this.view.getUint8(this.offset);
    this.offset++;
    return value;
  }

  readRectF32() {
    return {
      x: this.readFloat32(),
      y: this.readFloat32(),
      w: this.readFloat32(),
      h: this.readFloat32(),
    };
  }

  readVector2() {
    return {
      x: this.readFloat32(),
      y: this.readFloat32(),
    };
  }

  readVector3() {
    return {
      x: this.readFloat32(),
      y: this.readFloat32(),
      z: this.readFloat32(),
    };
  }

  readVector4() {
    return {
      x: this.readFloat32(),
      y: this.readFloat32(),
      z: this.readFloat32(),
      w: this.readFloat32(),
    };
  }

  readColor() {
    return {
      r: this.readFloat32(),
      g: this.readFloat32(),
      b: this.readFloat32(),
      a: this.readFloat32(),
    };
  }

  readUInt16Array(size: number) {
    return loopMap(size, () => this.readUInt16());
  }

  private checkPosition(position: number) {
    if (position < 0) throw new Error(`Position (${position}) must be no negative`);
    if (position > this.length) {
      throw new Error(`Position ${position} out of range ${this.length}`);
    }
  }

  private checkLength(length: number) {
    if (length < 0) throw new Error(`Length (${length}) must be no negative`);
    const end = this.offset + length;
    if (end > this.length) {
      throw new Error(`End position (${end}) out of boundary (${this.length})`);
    }
    return end;
  }

  private bufferToString(buffer: ArrayBuffer) {
    return this.textDecoder.decode(buffer);
  }

  // ====== 16-bit ======
  readInt16() {
    const v = this.view.getInt16(this.offset, this.options.littleEndian);
    this.offset += 2;
    return v;
  }
  readUInt16() {
    const v = this.view.getUint16(this.offset, this.options.littleEndian);
    this.offset += 2;
    return v;
  }
  readInt16LE() {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  readUInt16LE() {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  readInt16BE() {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }
  readUInt16BE() {
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  // ====== 32-bit ======
  readInt32() {
    const v = this.view.getInt32(this.offset, this.options.littleEndian);
    this.offset += 4;
    return v;
  }
  readUInt32() {
    const v = this.view.getUint32(this.offset, this.options.littleEndian);
    this.offset += 4;
    return v;
  }
  readInt32LE() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readUInt32LE() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readInt32BE() {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }
  readUInt32BE() {
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  // ====== 64-bit ======
  readInt64() {
    const v = this.view.getBigInt64(this.offset, this.options.littleEndian);
    this.offset += 8;
    return v;
  }
  readUInt64() {
    const v = this.view.getBigUint64(this.offset, this.options.littleEndian);
    this.offset += 8;
    return v;
  }
  readInt64LE() {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  readUInt64LE() {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  readInt64BE() {
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }
  readUInt64BE() {
    const v = this.view.getBigUint64(this.offset, false);
    this.offset += 8;
    return v;
  }

  // ====== Float ======
  readFloat32() {
    const v = this.view.getFloat32(this.offset, this.options.littleEndian);
    this.offset += 4;
    return v;
  }
  readFloat32LE() {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readFloat32BE() {
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }
  readFloat64() {
    const v = this.view.getFloat64(this.offset, this.options.littleEndian);
    this.offset += 8;
    return v;
  }
  readFloat64LE() {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
  readFloat64BE() {
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }
}

for (const bits of [16, 32, 64]) {
  const addOffset = Math.round(bits / 8);
  for (const unsigned of ['', 'U']) {
    for (const [littleEndian, suffix] of [
      [null, ''],
      [true, 'LE'],
      [false, 'BE'],
    ]) {
      const fnName = `read${unsigned}Int${bits}${suffix}`;
      const viewFnName = `get${bits === 64 ? 'Big' : ''}${unsigned ? 'Uint' : 'Int'}${bits}`;
      (ArrayBufferReader.prototype as any)[fnName] =
        littleEndian === null
          ? function (this: any) {
              const value = this.view[viewFnName](this.offset, this.options.littleEndian);
              this.offset += addOffset;
              return value;
            }
          : function (this: any) {
              const value = this.view[viewFnName](this.offset, littleEndian);
              this.offset += addOffset;
              return value;
            };
    }
  }
}

for (const bits of [32, 64]) {
  const addOffset = Math.round(bits / 8);
  for (const [littleEndian, suffix] of [
    [null, ''],
    [true, 'LE'],
    [false, 'BE'],
  ]) {
    const fnName = `readFloat${bits}${suffix}`;
    const viewFnName = `getFloat${bits}`;
    (ArrayBufferReader.prototype as any)[fnName] =
      littleEndian === null
        ? function (this: any) {
            const value = this.view[viewFnName](this.offset, this.options.littleEndian);
            this.offset += addOffset;
            return value;
          }
        : function (this: any) {
            const value = this.view[viewFnName](this.offset, littleEndian);
            this.offset += addOffset;
            return value;
          };
  }
}
