import type { TypeTreeNode } from '../serializedType';

/**
 * Extract all nodes belonging to the subtree starting at nodes[index].
 */
const getSubtreeNodes = (nodes: TypeTreeNode[], index: number): TypeTreeNode[] => {
  const result = [nodes[index]];
  const level = nodes[index].level;
  for (let i = index + 1; i < nodes.length; i++) {
    if (nodes[i].level <= level) return result;
    result.push(nodes[i]);
  }
  return result;
};

/**
 * Dynamic buffer that auto-grows when needed.
 */
class DynamicBuffer {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;
  private readonly le: boolean;
  private readonly enc = new TextEncoder();

  constructor(le: boolean, initialSize = 4096) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
    this.le = le;
  }

  get position() { return this.offset; }

  private grow(need: number) {
    const required = this.offset + need;
    if (required <= this.buffer.byteLength) return;
    let ns = this.buffer.byteLength;
    while (ns < required) ns *= 2;
    const nb = new ArrayBuffer(ns);
    new Uint8Array(nb).set(new Uint8Array(this.buffer, 0, this.offset));
    this.buffer = nb;
    this.view = new DataView(this.buffer);
  }

  toArrayBuffer(): ArrayBuffer { return this.buffer.slice(0, this.offset); }

  writeInt8(v: number) { this.grow(1); this.view.setInt8(this.offset, v); this.offset++; }
  writeUInt8(v: number) { this.grow(1); this.view.setUint8(this.offset, v); this.offset++; }
  writeBoolean(v: boolean) { this.writeUInt8(v ? 1 : 0); }
  writeInt16(v: number) { this.grow(2); this.view.setInt16(this.offset, v, this.le); this.offset += 2; }
  writeUInt16(v: number) { this.grow(2); this.view.setUint16(this.offset, v, this.le); this.offset += 2; }
  writeInt32(v: number) { this.grow(4); this.view.setInt32(this.offset, v, this.le); this.offset += 4; }
  writeUInt32(v: number) { this.grow(4); this.view.setUint32(this.offset, v, this.le); this.offset += 4; }
  writeInt64(v: bigint) { this.grow(8); this.view.setBigInt64(this.offset, v, this.le); this.offset += 8; }
  writeUInt64(v: bigint) { this.grow(8); this.view.setBigUint64(this.offset, v, this.le); this.offset += 8; }
  writeFloat32(v: number) { this.grow(4); this.view.setFloat32(this.offset, v, this.le); this.offset += 4; }
  writeFloat64(v: number) { this.grow(8); this.view.setFloat64(this.offset, v, this.le); this.offset += 8; }

  writeAlignedString(str: string) {
    const encoded = this.enc.encode(str ?? '');
    this.writeInt32(encoded.length);
    this.grow(encoded.length);
    new Uint8Array(this.buffer, this.offset, encoded.length).set(encoded);
    this.offset += encoded.length;
    this.align(4);
  }

  align(size: number) {
    const rem = this.offset % size;
    if (rem === 0) return;
    const after = this.offset - rem + size;
    this.grow(after - this.offset);
    new Uint8Array(this.buffer, this.offset, after - this.offset).fill(0);
    this.offset = after;
  }
}

/**
 * Recursive serializer: writes a JSON value to the buffer following TypeTree nodes.
 */
const writeValue = (
  nodes: TypeTreeNode[],
  ctx: { index: number },
  value: any,
  w: DynamicBuffer,
): void => {
  const node = nodes[ctx.index];
  let align = (node.metaFlag & 0x4000) !== 0;

  switch (node.type) {
    case 'SInt8': w.writeInt8(value); break;
    case 'UInt8': case 'char': w.writeUInt8(value); break;
    case 'short': case 'SInt16': w.writeInt16(value); break;
    case 'UInt16': case 'unsigned short': w.writeUInt16(value); break;
    case 'int': case 'SInt32': w.writeInt32(value); break;
    case 'UInt32': case 'unsigned int': case 'Type*': w.writeUInt32(value); break;
    case 'long long': case 'SInt64': w.writeInt64(BigInt(value)); break;
    case 'UInt64': case 'unsigned long long': case 'FileSize': w.writeUInt64(BigInt(value)); break;
    case 'float': w.writeFloat32(value); break;
    case 'double': w.writeFloat64(value); break;
    case 'bool': w.writeBoolean(value); break;
    case 'string': {
      w.writeAlignedString(value ?? '');
      const sub = getSubtreeNodes(nodes, ctx.index);
      ctx.index += sub.length - 1;
      break;
    }
    case 'map': {
      if ((nodes[ctx.index + 1].metaFlag & 0x4000) !== 0) align = true;
      const mapAll = getSubtreeNodes(nodes, ctx.index);
      ctx.index += mapAll.length - 1;
      const first = getSubtreeNodes(mapAll, 4);
      const second = getSubtreeNodes(mapAll, 4 + first.length);
      const entries = Object.entries(value ?? {});
      w.writeInt32(entries.length);
      for (let i = 0; i < entries.length; i++) {
        const [k, v] = entries[i];
        writeValue(first, { index: 0 }, k, w);
        writeValue(second, { index: 0 }, v, w);
      }
      break;
    }
    case 'TypelessData': {
      const arr: number[] = value ?? [];
      w.writeInt32(arr.length);
      for (let i = 0; i < arr.length; i++) w.writeUInt8(arr[i]);
      ctx.index += 2;
      break;
    }
    default: {
      if (ctx.index < nodes.length - 1 && nodes[ctx.index + 1].type === 'Array') {
        // vector
        if ((nodes[ctx.index + 1].metaFlag & 0x4000) !== 0) align = true;
        const vecAll = getSubtreeNodes(nodes, ctx.index);
        ctx.index += vecAll.length - 1;
        const arr: any[] = Array.isArray(value) ? value : [];
        w.writeInt32(arr.length);
        for (let i = 0; i < arr.length; i++) {
          writeValue(vecAll, { index: 3 }, arr[i], w);
        }
      } else {
        // struct / class
        const clzAll = getSubtreeNodes(nodes, ctx.index);
        ctx.index += clzAll.length - 1;
        const obj = value ?? {};
        for (let c2 = { index: 1 }; c2.index < clzAll.length; c2.index++) {
          const childNode = clzAll[c2.index];
          writeValue(clzAll, c2, obj[childNode.name], w);
        }
      }
      break;
    }
  }

  if (align) w.align(4);
};

/**
 * Serialize a complete asset's data from JSON using its TypeTree nodes.
 * The JSON structure must match the output of AssetBase.getTypeTree().
 */
export const serializeFromTypeTree = (
  nodes: TypeTreeNode[],
  data: Record<string, any>,
  littleEndian: boolean,
): ArrayBuffer => {
  const w = new DynamicBuffer(littleEndian);
  for (let ctx = { index: 0 }; ctx.index < nodes.length; ctx.index++) {
    const node = nodes[ctx.index];
    writeValue(nodes, ctx, data[node.name], w);
  }
  return w.toArrayBuffer();
};
