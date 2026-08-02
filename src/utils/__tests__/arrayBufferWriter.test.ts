import { describe, expect, it } from 'vitest';
import { ArrayBufferWriter, ArrayBufferReader } from '@arkntools/unity-js';

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
    w.align(4);
    expect(w.position).toBe(4);
    w.writeInt8(1);
    w.align(4);
    expect(w.position).toBe(8);
    const r = new ArrayBufferReader(w.getBuffer());
    r.readInt32();
    r.readInt8();
    r.align(4);
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

  it('writeStringUntilZero / readStringUntilZero round-trip', () => {
    const w = new ArrayBufferWriter(16);
    w.writeStringUntilZero('UnityFS');
    const buf = w.getBuffer();
    const r = new ArrayBufferReader(buf);
    expect(r.readStringUntilZero()).toBe('UnityFS');
  });
});
