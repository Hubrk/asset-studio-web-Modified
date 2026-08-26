/**
 * 通用 Protobuf 解码工具。
 *
 * 用于解析 Unity 中 `aininjadata` 等配置目录下的 protobuf 二进制 TextAsset
 * （区别于 KFB 加密容器）。支持 varint / fixed32 / fixed64 / length-delimited
 * （嵌套 message 自动识别）等 wire type，输出为可递归渲染的节点树。
 */

/** protobuf wire type */
export const WIRE = {
  VARINT: 0,
  FIXED64: 1,
  LEN: 2,
  START: 3,
  END: 4,
  FIXED32: 5,
} as const;

export type ProtoKind = 'varint' | 'fixed32' | 'fixed64' | 'message' | 'string' | 'bytes';

/** 解码后的单个字段节点 */
export interface ProtoNode {
  /** 字段序号 */
  field: number;
  /** wire type */
  wire: number;
  /** 语义分类（用于渲染） */
  kind: ProtoKind;
  /** 展示用的值（varint 十进制/hex、fixed 十六进制+float、string 原文、bytes hex） */
  value: string;
  /** 原始字节长度（string/bytes/message） */
  byteLen?: number;
  /** 嵌套 message 的子字段 */
  children?: ProtoNode[];
  // ── 可编辑的原始值（编辑后通过 encodeProtoMessage 重编码） ──
  /** varint 原始值 */
  rawVarint?: bigint;
  /** fixed32 原始值（uint32） */
  rawFixed32?: number;
  /** fixed64 原始值 */
  rawFixed64?: bigint;
  /** string/bytes 原始字节 */
  rawBytes?: Uint8Array;
  /** 语义标注（按已知 aininjadata 结构启发式识别） */
  semantic?: string;
  /** 是否强影响字段（对实际战斗有直接影响） */
  strong?: boolean;
}

/**
 * 按已知的 aininjadata 配置结构，启发式标注常见强影响字段的语义。
 * 仅当结构匹配时标注，不匹配则保持未标注。用于查看器展示与引导编辑。
 */
export function annotateProtoTree(nodes: ProtoNode[]): void {
  for (const n of nodes) {
    if (n.kind !== 'message') {
      if (n.field === 15 && n.kind === 'string') n.semantic = '唯一标识(hash，不建议改)';
      continue;
    }
    if (n.field === 2) {
      n.semantic = '技能列表';
      n.strong = true;
      // 技能项子字段：1 = 技能ID
      for (const item of n.children ?? []) {
        if (item.kind !== 'message') continue;
        const id = item.children?.find(c => c.field === 1);
        if (id) id.semantic = '技能ID';
      }
    } else if (n.field === 3) {
      n.semantic = '战斗数值';
      n.strong = true;
    } else if (n.field === 7) {
      n.semantic = '基础属性';
      n.strong = true;
    } else if (n.field === 18) {
      n.semantic = '资源引用';
    } else if (n.field === 1) {
      // 字段1 内的 field4 = 关联技能（奥义等）
      for (const c of n.children ?? []) {
        if (c.field === 4) {
          c.semantic = '关联技能';
          c.strong = true;
        }
      }
    }
  }
}

/** 读取 varint，返回 BigInt 值 + 下一位置 */
function readVarint(buf: Uint8Array, p: number): { value: bigint; next: number } {
  let v = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (p >= buf.length) throw new Error('varint EOF');
    const byte = buf[p++];
    v |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: v, next: p };
    shift += 7n;
  }
  throw new Error('varint too long');
}

/** 格式化 varint：大数/负数给 hex 辅助 */
function fmtInt(n: bigint): string {
  if (n >= 0n && n <= 0xffffffffn) return n.toString();
  // 负数或超大数：给 hex
  return `${n.toString(16)}h (${n.toString()})`;
}

/** 解释 fixed32 为 IEEE754 float（当字节能组成合理 float 时） */
function fixed32AsFloat(buf: Uint8Array, p: number): number | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const f = dv.getFloat32(p, true);
  if (Number.isFinite(f)) return f;
  return null;
}

/** 判断一段字节是否看起来是合法的嵌套 protobuf message */
export function looksLikeMessage(buf: Uint8Array, start: number, end: number): boolean {
  let p = start;
  try {
    while (p < end) {
      const { value: tag, next } = readVarint(buf, p);
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field <= 0) return false;
      p = next;
      switch (wire) {
        case WIRE.VARINT: {
          const r = readVarint(buf, p);
          p = r.next;
          break;
        }
        case WIRE.FIXED64:
          p += 8;
          break;
        case WIRE.FIXED32:
          p += 4;
          break;
        case WIRE.LEN: {
          const r = readVarint(buf, p);
          const len = Number(r.value);
          p = r.next + len;
          break;
        }
        default:
          return false;
      }
      if (p > end) return false;
    }
    return p === end;
  } catch {
    return false;
  }
}

/** 判断整个数据是否为 protobuf message（首字段 wire2 + 可完整解码） */
export function isProtoMessage(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 2) return false;
  // 排除 KFB 加密容器（00 0e / 00 0f 开头）
  if (bytes[0] === 0x00 && (bytes[1] === 0x0e || bytes[1] === 0x0f)) return false;
  try {
    // 首 tag 必须是 field>0 的 wire 2（大部分配置 protobuf 首字段为 length-delimited）
    const tag = readVarint(bytes, 0).value;
    if (Number(tag >> 3n) <= 0) return false;
    return looksLikeMessage(bytes, 0, bytes.length);
  } catch {
    return false;
  }
}

/** 尝试把一段 bytes 当作 UTF-8 字符串渲染 */
function fmtText(buf: Uint8Array): string {
  let printable = true;
  for (const x of buf) {
    if (x === 0x0a || x === 0x0d || x === 0x09 || (x >= 0x20 && x < 0x7f)) continue;
    printable = false;
    break;
  }
  if (printable) return JSON.stringify(new TextDecoder().decode(buf));
  const hex = Array.from(buf)
    .map(x => x.toString(16).padStart(2, '0'))
    .join(' ');
  return `[${buf.length}B] ${hex}`;
}

/** 递归解码一段 protobuf message */
export function decodeProtoMessage(buf: Uint8Array, start = 0, end = buf.length): ProtoNode[] {
  const nodes: ProtoNode[] = [];
  let p = start;
  while (p < end) {
    const { value: tagRaw, next } = readVarint(buf, p);
    const field = Number(tagRaw >> 3n);
    const wire = Number(tagRaw & 7n);
    p = next;

    switch (wire) {
      case WIRE.VARINT: {
        const r = readVarint(buf, p);
        p = r.next;
        nodes.push({ field, wire, kind: 'varint', value: fmtInt(r.value), rawVarint: r.value });
        break;
      }
      case WIRE.FIXED64: {
        if (p + 8 > end) throw new Error('fixed64 EOF');
        let v = 0n;
        for (let i = 0; i < 8; i++) v |= BigInt(buf[p + i]) << BigInt(8 * i);
        p += 8;
        nodes.push({ field, wire, kind: 'fixed64', value: `${v.toString(16)}h (${v.toString()})`, rawFixed64: v });
        break;
      }
      case WIRE.FIXED32: {
        if (p + 4 > end) throw new Error('fixed32 EOF');
        const raw = (buf[p] & 255) | ((buf[p + 1] & 255) << 8) | ((buf[p + 2] & 255) << 16) | ((buf[p + 3] & 255) << 24);
        const f = fixed32AsFloat(buf, p);
        p += 4;
        const hex = `0x${(raw >>> 0).toString(16)}`;
        nodes.push({
          field,
          wire,
          kind: 'fixed32',
          value: f !== null ? `${raw} (${hex} = float ${f})` : `${raw} (${hex})`,
          rawFixed32: raw >>> 0,
        });
        break;
      }
      case WIRE.LEN: {
        const r = readVarint(buf, p);
        const len = Number(r.value);
        p = r.next;
        if (p + len > end) throw new Error('len EOF');
        const subEnd = p + len;
        if (looksLikeMessage(buf, p, subEnd)) {
          nodes.push({
            field,
            wire,
            kind: 'message',
            value: `message (${len}B)`,
            byteLen: len,
            children: decodeProtoMessage(buf, p, subEnd),
          });
        } else {
          const rawBytes = buf.subarray(p, subEnd);
          nodes.push({ field, wire, kind: 'string', value: fmtText(rawBytes), byteLen: len, rawBytes });
        }
        p = subEnd;
        break;
      }
      case WIRE.START:
      case WIRE.END:
        nodes.push({ field, wire, kind: 'bytes', value: `group ${wire === WIRE.START ? 'start' : 'end'}` });
        break;
      default:
        throw new Error(`unsupported wire ${wire}`);
    }
  }
  return nodes;
}

/** 把节点树渲染为纯文本（缩进树），供复制导出 */
export function protoTreeToText(nodes: ProtoNode[], depth = 0): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'message') {
      lines.push(`${indent}[${n.field}] ${n.value} {`);
      lines.push(protoTreeToText(n.children ?? [], depth + 1));
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}[${n.field}] ${n.value}`);
    }
  }
  return lines.join('\n');
}

/** 把节点树序列化为 JSON（便于查看/导出） */
export function protoTreeToJson(nodes: ProtoNode[]): unknown {
  return nodes.map(n => {
    const base: Record<string, unknown> = { field: n.field, wire: n.wire, kind: n.kind };
    if (n.byteLen !== undefined) base.byteLen = n.byteLen;
    if (n.kind === 'message') {
      base.children = protoTreeToJson(n.children ?? []);
    } else {
      base.value = n.value;
    }
    return base;
  });
}

// ============================================================================
// 编辑 + 重编码
// ============================================================================

/** 把一个非负 BigInt 编码为 protobuf varint 字节 */
export function encodeVarint(n: bigint): Uint8Array {
  let v = n;
  const bytes: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    bytes.push(b);
  } while (v !== 0n);
  return Uint8Array.from(bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 把一列节点递归重编码为 protobuf 字节（保留字段顺序与结构，仅按编辑后的值输出） */
export function encodeProtoMessage(nodes: ProtoNode[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const n of nodes) {
    const tag = encodeVarint((BigInt(n.field) << 3n) | BigInt(n.wire));
    switch (n.kind) {
      case 'message': {
        const child = encodeProtoMessage(n.children ?? []);
        parts.push(tag, encodeVarint(BigInt(child.length)), child);
        break;
      }
      case 'varint':
        parts.push(tag, encodeVarint(n.rawVarint ?? 0n));
        break;
      case 'fixed32': {
        const b = new Uint8Array(4);
        const r = (n.rawFixed32 ?? 0) >>> 0;
        b[0] = r & 255;
        b[1] = (r >> 8) & 255;
        b[2] = (r >> 16) & 255;
        b[3] = (r >> 24) & 255;
        parts.push(tag, b);
        break;
      }
      case 'fixed64': {
        const b = new Uint8Array(8);
        let v = n.rawFixed64 ?? 0n;
        for (let i = 0; i < 8; i++) {
          b[i] = Number(v & 255n);
          v >>= 8n;
        }
        parts.push(tag, b);
        break;
      }
      case 'string':
      case 'bytes': {
        const rb = n.rawBytes ?? new Uint8Array(0);
        parts.push(tag, encodeVarint(BigInt(rb.length)), rb);
        break;
      }
    }
  }
  return concatBytes(parts);
}

function parseBigInt(s: string): bigint {
  return BigInt(s); // BigInt 原生支持 0x/0o/0b 前缀与十进制
}

function parseUint32(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff || !Number.isInteger(n)) throw new Error('必须是 0~4294967295 的整数');
  return n >>> 0;
}

/** 编辑一个标量字段的值：更新原始值并重算展示字符串。输入支持十进制及 0x 十六进制前缀。 */
export function editNodeValue(node: ProtoNode, input: string): { ok: boolean; msg?: string } {
  const s = input.trim();
  try {
    switch (node.kind) {
      case 'varint': {
        const v = parseBigInt(s);
        if (v < 0n) return { ok: false, msg: 'varint 不能为负' };
        node.rawVarint = v;
        node.value = fmtInt(v);
        return { ok: true };
      }
      case 'fixed32': {
        const v = parseUint32(s);
        node.rawFixed32 = v;
        const dv = new DataView(new ArrayBuffer(4));
        dv.setUint32(0, v, true);
        const f = dv.getFloat32(0, true);
        const hex = `0x${v.toString(16)}`;
        node.value = Number.isFinite(f) ? `${v} (${hex} = float ${f})` : `${v} (${hex})`;
        return { ok: true };
      }
      case 'fixed64': {
        const v = parseBigInt(s);
        node.rawFixed64 = v;
        node.value = `${v.toString(16)}h (${v.toString()})`;
        return { ok: true };
      }
      case 'string': {
        const rb = new TextEncoder().encode(s);
        node.rawBytes = rb;
        node.byteLen = rb.length;
        node.value = JSON.stringify(s);
        return { ok: true };
      }
      case 'bytes': {
        const hex = s.replace(/[\s,]/g, '');
        if (hex.length % 2 !== 0) return { ok: false, msg: 'hex 长度必须为偶数' };
        const arr = new Uint8Array(hex.length / 2);
        for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
        node.rawBytes = arr;
        node.byteLen = arr.length;
        node.value = `[${arr.length}B] ${hex}`;
        return { ok: true };
      }
      default:
        return { ok: false, msg: '该类型暂不支持编辑' };
    }
  } catch (e) {
    return { ok: false, msg: `${e}` };
  }
}
