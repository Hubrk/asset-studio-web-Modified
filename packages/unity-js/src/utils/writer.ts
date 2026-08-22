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

  // ====== 16-bit ======
  writeInt16(value: number): void { this.view.setInt16(this.offset, value, this.littleEndian); this.offset += 2; }
  writeUInt16(value: number): void { this.view.setUint16(this.offset, value, this.littleEndian); this.offset += 2; }
  writeInt16LE(value: number): void { this.view.setInt16(this.offset, value, true); this.offset += 2; }
  writeUInt16LE(value: number): void { this.view.setUint16(this.offset, value, true); this.offset += 2; }
  writeInt16BE(value: number): void { this.view.setInt16(this.offset, value, false); this.offset += 2; }
  writeUInt16BE(value: number): void { this.view.setUint16(this.offset, value, false); this.offset += 2; }

  // ====== 32-bit ======
  writeInt32(value: number): void { this.view.setInt32(this.offset, value, this.littleEndian); this.offset += 4; }
  writeUInt32(value: number): void { this.view.setUint32(this.offset, value, this.littleEndian); this.offset += 4; }
  writeInt32LE(value: number): void { this.view.setInt32(this.offset, value, true); this.offset += 4; }
  writeUInt32LE(value: number): void { this.view.setUint32(this.offset, value, true); this.offset += 4; }
  writeInt32BE(value: number): void { this.view.setInt32(this.offset, value, false); this.offset += 4; }
  writeUInt32BE(value: number): void { this.view.setUint32(this.offset, value, false); this.offset += 4; }

  // ====== 64-bit ======
  writeInt64(value: bigint): void { this.view.setBigInt64(this.offset, value, this.littleEndian); this.offset += 8; }
  writeUInt64(value: bigint): void { this.view.setBigUint64(this.offset, value, this.littleEndian); this.offset += 8; }
  writeInt64LE(value: bigint): void { this.view.setBigInt64(this.offset, value, true); this.offset += 8; }
  writeUInt64LE(value: bigint): void { this.view.setBigUint64(this.offset, value, true); this.offset += 8; }
  writeInt64BE(value: bigint): void { this.view.setBigInt64(this.offset, value, false); this.offset += 8; }
  writeUInt64BE(value: bigint): void { this.view.setBigUint64(this.offset, value, false); this.offset += 8; }

  // ====== Float ======
  writeFloat32(value: number): void { this.view.setFloat32(this.offset, value, this.littleEndian); this.offset += 4; }
  writeFloat64(value: number): void { this.view.setFloat64(this.offset, value, this.littleEndian); this.offset += 8; }
  writeFloat32LE(value: number): void { this.view.setFloat32(this.offset, value, true); this.offset += 4; }
  writeFloat64LE(value: number): void { this.view.setFloat64(this.offset, value, true); this.offset += 8; }
  writeFloat32BE(value: number): void { this.view.setFloat32(this.offset, value, false); this.offset += 4; }
  writeFloat64BE(value: number): void { this.view.setFloat64(this.offset, value, false); this.offset += 8; }
}
