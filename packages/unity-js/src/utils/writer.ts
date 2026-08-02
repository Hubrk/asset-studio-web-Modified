export class ArrayBufferWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;
  private littleEndian = false;
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
