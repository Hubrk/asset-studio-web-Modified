/**
 * KFB 二进制编解码器（浏览器移植版）。
 * 源自 research/xml_battle_logic_new/研究xml战斗逻辑/assets/kfb/kfb_schema_decoder.js
 * 保持字节级行为一致：二分/三分 wire 编解码 + 多态 typeId + 自定义序列化器。
 *
 * 主要改动：
 *  - 去除 Node fs/path 依赖（loadSchema 由外层直接传规范化后的 schema）
 *  - Buffer 替换为本仓库的浏览器 shim
 *  - CommonJS module.exports 改为 ES module 导出
 */

import { Buffer } from 'buffer';

const WIRE_NAMES = ['Variant', 'Fixed32', 'Fixed64', 'Object', 'String', 'List', 'Dictionary', 'Packed'];
const SIGNED_TYPES = new Set(['System.SByte', 'System.Int16', 'System.Int32', 'System.Int64']);
const UNSIGNED_TYPES = new Set(['System.Byte', 'System.UInt16', 'System.UInt32', 'System.UInt64', 'System.Char']);

class DecodeError extends Error {
  offset: number;
  objectPath: string;
  constructor(message: string, offset: number, objectPath = '') {
    super(`${message} at offset ${offset}${objectPath ? ` (${objectPath})` : ''}`);
    this.name = 'KfbDecodeError';
    this.offset = offset;
    this.objectPath = objectPath;
  }
}

function cloneJson(value: any): any {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseDefaultJson(value: any): any {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object') return cloneJson(value);
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    return JSON.parse(value);
  } catch (_e) {
    return {};
  }
}

/** 规范化 schema（raw 为 kfb_schema.json 解析对象） */
export function normalizeSchema(raw: any): any {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.types)) {
    throw new Error('KFB schema must contain a types array');
  }
  const schema: any = {
    raw,
    rootType: raw.root_type || 'KH.ActorData',
    polymorphicTypeField: raw.polymorphic_type_field || '$type',
    typesByName: new Map(),
    typesById: new Map(),
    customTypes: new Map(),
  };
  for (const entry of raw.custom_serializers || []) {
    const name = entry.type || entry.full_name;
    if (name) schema.customTypes.set(name, entry);
  }
  for (const entry of raw.types) {
    const fullName = entry.full_name || entry.name;
    if (!fullName) continue;
    const type: any = {
      ...entry,
      fullName,
      typeId: entry.type_id === undefined || entry.type_id === null ? null : Number(entry.type_id),
      baseType: entry.base_type || null,
      fields: Array.isArray(entry.fields)
        ? entry.fields.map((field: any) => ({
            ...field,
            tag: Number(field.tag),
            name: field.name || `field_${field.tag}`,
            fieldType: field.field_type || field.declared_type || 'System.Object',
            declaredBy: field.declared_by || fullName,
            displayType: field.display_type || null,
            editableName: field.editable_name || null,
          }))
        : [],
      defaultValue: parseDefaultJson(entry.default_json),
    };
    schema.typesByName.set(fullName, type);
    if (type.typeId !== null && Number.isInteger(type.typeId)) schema.typesById.set(type.typeId, type);
  }
  if (!schema.typesByName.has(schema.rootType)) {
    throw new Error(`schema does not contain root type ${schema.rootType}`);
  }
  return schema;
}

class Reader {
  buffer: Uint8Array;
  position: number;
  start: number;
  end: number;
  coverage: any[];
  objectPath: string;

  constructor(buffer: Uint8Array, start = 0, end = buffer.length, coverage: any[] | null = null, objectPath = '$') {
    this.buffer = buffer;
    this.position = start;
    this.start = start;
    this.end = end;
    this.coverage = coverage || [];
    this.objectPath = objectPath;
  }

  error(message: string, offset: number = this.position): never {
    throw new DecodeError(message, offset, this.objectPath);
  }
  remaining(): number {
    return this.end - this.position;
  }
  ensure(count: number, what: string): void {
    if (!Number.isInteger(count) || count < 0 || this.position + count > this.end) {
      this.error(`truncated ${what}`);
    }
  }
  mark(start: number, kind: string, detail = ''): void {
    this.coverage.push({ start, end: this.position, kind, path: this.objectPath, detail });
  }
  readByte(kind = 'byte'): number {
    this.ensure(1, kind);
    const start = this.position;
    const value = this.buffer[this.position++];
    this.mark(start, kind);
    return value;
  }
  peekByte(): number {
    this.ensure(1, 'byte');
    return this.buffer[this.position];
  }
  readBytes(count: number, kind = 'bytes'): Buffer {
    this.ensure(count, kind);
    const start = this.position;
    const result = Buffer.from(this.buffer.subarray(this.position, this.position + count));
    this.position += count;
    this.mark(start, kind, String(count));
    return result;
  }
  readVarint(kind = 'varint'): bigint {
    const start = this.position;
    let value = 0n;
    let shift = 0n;
    while (this.position < this.end && shift <= 63n) {
      const byte = this.buffer[this.position++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        this.mark(start, kind, value.toString());
        return value;
      }
      shift += 7n;
    }
    this.error(`truncated or oversized ${kind}`, start);
  }
  readLength(kind = 'length'): number {
    const value = this.readVarint(kind);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) this.error(`${kind} is too large`);
    const number = Number(value);
    if (number > this.remaining()) this.error(`${kind} ${number} exceeds enclosing block`);
    return number;
  }
  subReader(length: number, objectPath: string): Reader {
    this.ensure(length, 'subitem');
    const result = new Reader(this.buffer, this.position, this.position + length, this.coverage, objectPath);
    this.position += length;
    return result;
  }
}

function zigZag(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}
function safeIntegerOrString(value: bigint, forceString = false): number | string {
  if (forceString || value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return value.toString();
  }
  return Number(value);
}
function typeCode(field: any): string {
  return field.type_code || field.typeCode || '';
}
function isSigned(field: any, declaredType: string = field.fieldType): boolean {
  if (field.is_enum) {
    return ['SByte', 'Int16', 'Int32', 'Int64'].includes(field.enum_underlying_type_code);
  }
  return SIGNED_TYPES.has(declaredType) || ['SByte', 'Int16', 'Int32', 'Int64'].includes(typeCode(field));
}
function isUnsigned(field: any, declaredType: string = field.fieldType): boolean {
  if (field.is_enum) {
    return ['Byte', 'UInt16', 'UInt32', 'UInt64', 'Char'].includes(field.enum_underlying_type_code);
  }
  return UNSIGNED_TYPES.has(declaredType) || ['Byte', 'UInt16', 'UInt32', 'UInt64', 'Char'].includes(typeCode(field));
}
function isBoolean(field: any, declaredType: string = field.fieldType): boolean {
  return declaredType === 'System.Boolean' || typeCode(field) === 'Boolean';
}
function isString(field: any, declaredType: string = field.fieldType): boolean {
  return declaredType === 'System.String' || typeCode(field) === 'String';
}
function isFloat(field: any, declaredType: string = field.fieldType): boolean {
  return declaredType === 'System.Single' || typeCode(field) === 'Single';
}
function isDouble(field: any, declaredType: string = field.fieldType): boolean {
  return declaredType === 'System.Double' || typeCode(field) === 'Double';
}

function firstGenericTypeArgument(typeName: string): string | null {
  const text = String(typeName);
  const start = text.indexOf('[[');
  if (start < 0) return null;
  let depth = 0;
  for (let index = start + 2; index < text.length; index += 1) {
    const char = text[index];
    if (char === '[') depth += 1;
    else if (char === ']') {
      if (depth === 0) return text.slice(start + 2, index).trim();
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      return text.slice(start + 2, index).trim();
    }
  }
  return null;
}

function isListType(typeName: string): boolean {
  return String(typeName).startsWith('System.Collections.Generic.List`1[[');
}

function makeScalar(value: any, scalarType: string, offset: number, endOffset: number): any {
  return { semantic: value, ast: { kind: 'scalar', scalarType, value, offset, endOffset } };
}

function fieldCandidates(schema: any, type: any, tag: number): any[] {
  const candidates: any[] = [];
  let current = type;
  const visited = new Set<string>();
  while (current && !visited.has(current.fullName)) {
    visited.add(current.fullName);
    for (const field of current.fields) if (field.tag === tag) candidates.push(field);
    current = current.baseType ? schema.typesByName.get(current.baseType) : null;
  }
  return candidates;
}

function chooseField(schema: any, type: any, tag: number, declaringType: string): any {
  const candidates = fieldCandidates(schema, type, tag);
  if (candidates.length === 0) return null;
  return candidates.find((field) => field.declaredBy === declaringType) || candidates[0];
}

function editableFieldName(type: any, field: any): string {
  if (field.editableName) return field.editableName;
  const duplicates = type.fields.filter((candidate: any) => candidate.name === field.name);
  if (duplicates.length <= 1) return field.name;
  const declaring = String(field.declaredBy || type.fullName).split('.').pop();
  return `${declaring}.${field.name}`;
}

function customLayout(typeName: string): any {
  const layouts: Record<string, any> = {
    'Morefun.LockStep.FScalar': { components: ['value'], encoding: 'sint64', json: 'scalar' },
    'KH.FVector2': { components: ['x', 'y'], encoding: 'sint64', json: 'csv' },
    'KH.FVector3': { components: ['x', 'y', 'z'], encoding: 'sint64', json: 'csv' },
    'KH.FVector4': { components: ['x', 'y', 'z', 'w'], encoding: 'sint64', json: 'csv' },
    'KH.FQuaternion': { components: ['x', 'y', 'z', 'w'], encoding: 'sint64', json: 'csv' },
    'KH.FColor': { components: ['r', 'g', 'b', 'a'], encoding: 'sint64', json: 'csv' },
    'KH.TSKFLFloatArg': {
      components: [
        { name: 'source', encoding: 'sint32' },
        { name: 'variable', encoding: 'string' },
        { name: 'value', encoding: 'sint64' },
      ],
      json: 'csv',
    },
    'KH.TSKFLIntArg': {
      components: [
        { name: 'source', encoding: 'sint32' },
        { name: 'variable', encoding: 'string' },
        { name: 'value', encoding: 'sint32' },
      ],
      json: 'csv',
    },
    'KH.TSKFLStringArg': {
      components: [
        { name: 'source', encoding: 'sint32' },
        { name: 'variable', encoding: 'string' },
        { name: 'value', encoding: 'string' },
      ],
      json: 'csv',
    },
    'UnityEngine.Vector2': { components: ['x', 'y'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Vector3': { components: ['x', 'y', 'z'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Vector4': { components: ['x', 'y', 'z', 'w'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Vector3Int': { components: ['x', 'y', 'z'], encoding: 'sint32', json: 'csv' },
    'UnityEngine.Quaternion': { components: ['x', 'y', 'z', 'w'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Rect': { components: ['x', 'y', 'width', 'height'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Bounds': { components: ['cx', 'cy', 'cz', 'ex', 'ey', 'ez'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Color': { components: ['r', 'g', 'b', 'a'], encoding: 'float32', json: 'csv' },
    'UnityEngine.Color32': { components: ['r', 'g', 'b', 'a'], encoding: 'byte', json: 'csv' },
  };
  return layouts[typeName] || null;
}

function fixedToText(raw: bigint): string {
  const negative = raw < 0n;
  let absolute = negative ? -raw : raw;
  const integer = absolute >> 32n;
  const fractionRaw = absolute & 0xffffffffn;
  if (fractionRaw === 0n) return `${negative ? '-' : ''}${integer}`;
  let fraction = ((fractionRaw * 10000000000n) >> 32n).toString().padStart(10, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}.${fraction}`;
}

function formatSingle(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return '0';
  const text = value.toPrecision(9);
  const parts = text.split(/e/i);
  let mantissa = parts[0];
  if (mantissa.includes('.')) mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '');
  return parts.length === 2 ? `${mantissa}E${Number(parts[1])}` : mantissa;
}

function decodeUnityAnimationCurve(reader: Reader, typeName: string): any {
  const start = reader.position;
  const preWrapMode = zigZag(reader.readVarint('curve-pre-wrap'));
  const postWrapMode = zigZag(reader.readVarint('curve-post-wrap'));
  const countBig = zigZag(reader.readVarint('curve-key-count'));
  if (countBig < 0n || countBig > 1000000n) reader.error(`invalid AnimationCurve key count ${countBig}`, start);
  const count = Number(countBig);
  const keys: any[] = [];
  for (let index = 0; index < count; index += 1) {
    const values: string[] = [];
    for (let component = 0; component < 6; component += 1) {
      values.push(formatSingle(reader.readBytes(4, 'curve-float32').readFloatLE(0)));
    }
    values.push(zigZag(reader.readVarint('curve-weighted-mode')).toString());
    keys.push(values);
  }
  const semantic = [preWrapMode.toString(), postWrapMode.toString(), String(count), ...keys.map((values) => values.join(','))].join('|');
  return {
    semantic,
    ast: {
      kind: 'custom',
      type: typeName,
      value: semantic,
      components: { preWrapMode: preWrapMode.toString(), postWrapMode: postWrapMode.toString(), keys },
      offset: start,
      endOffset: reader.position,
    },
  };
}

function decodeCustom(reader: Reader, typeName: string): any {
  if (typeName === 'UnityEngine.AnimationCurve') return decodeUnityAnimationCurve(reader, typeName);
  const layout = customLayout(typeName);
  if (!layout) reader.error(`unknown custom serializer ${typeName}`);
  const start = reader.position;
  const components: Record<string, any> = {};
  for (const component of layout.components) {
    const name = typeof component === 'string' ? component : component.name;
    const encoding = typeof component === 'string' ? layout.encoding : component.encoding;
    if (encoding === 'sint64' || encoding === 'sint32') {
      components[name] = zigZag(reader.readVarint(`custom-${encoding}`));
    } else if (encoding === 'uint64' || encoding === 'uint32') {
      components[name] = reader.readVarint(`custom-${encoding}`);
    } else if (encoding === 'string') {
      const length = reader.readLength('custom-string-length');
      components[name] = reader.readBytes(length, 'custom-utf8').toString('utf8');
    } else if (encoding === 'float32') {
      const bytes = reader.readBytes(4, 'custom-fixed32');
      components[name] = formatSingle(bytes.readFloatLE(0));
    } else if (encoding === 'float64') {
      const bytes = reader.readBytes(8, 'custom-fixed64');
      components[name] = bytes.readDoubleLE(0);
    } else if (encoding === 'byte') components[name] = reader.readByte('custom-byte');
    else reader.error(`unsupported custom component encoding ${encoding}`);
  }
  const strings = layout.components.map((component: any) => {
    const name = typeof component === 'string' ? component : component.name;
    return String(components[name]);
  });
  const semantic = layout.json === 'scalar' ? strings[0] : strings.join(',');
  return {
    semantic,
    ast: {
      kind: 'custom',
      type: typeName,
      value: semantic,
      components: Object.fromEntries(
        Object.entries(components).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
      ),
      offset: start,
      endOffset: reader.position,
    },
  };
}

function decodePrimitiveRaw(reader: Reader, field: any, declaredType: string): any {
  const start = reader.position;
  if (isString(field, declaredType)) {
    const length = reader.readLength('string-length');
    const bytes = reader.readBytes(length, 'utf8');
    const value = bytes.toString('utf8');
    if (Buffer.from(value, 'utf8').length !== bytes.length) reader.error('invalid UTF-8 string', start);
    return { semantic: value, ast: { kind: 'string', value, offset: start, endOffset: reader.position } };
  }
  if (isFloat(field, declaredType)) {
    const bytes = reader.readBytes(4, 'fixed32');
    return makeScalar(Number(formatSingle(bytes.readFloatLE(0))), 'Single', start, reader.position);
  }
  if (isDouble(field, declaredType)) {
    const bytes = reader.readBytes(8, 'fixed64');
    return makeScalar(bytes.readDoubleLE(0), 'Double', start, reader.position);
  }
  const encoded = reader.readVarint(isSigned(field, declaredType) ? 'zigzag' : 'variant');
  const decoded = isSigned(field, declaredType) ? zigZag(encoded) : encoded;
  if (isBoolean(field, declaredType)) {
    if (decoded !== 0n && decoded !== 1n) reader.error(`invalid Boolean value ${decoded}`, start);
    return makeScalar(decoded === 1n, 'Boolean', start, reader.position);
  }
  const is64 =
    declaredType === 'System.Int64' || declaredType === 'System.UInt64' || typeCode(field) === 'Int64' || typeCode(field) === 'UInt64';
  return makeScalar(
    safeIntegerOrString(decoded, is64),
    field.is_enum ? declaredType : typeCode(field) || declaredType,
    start,
    reader.position,
  );
}

function decodeDeclaredItem(reader: Reader, field: any, declaredType: string, schema: any, objectPath: string): any {
  if (schema.customTypes.has(declaredType) || field.has_custom_serializer) {
    const markerOffset = reader.position;
    const marker = reader.readByte('item-wire');
    if (marker === 0) return { semantic: null, ast: { kind: 'null', offset: markerOffset, endOffset: reader.position } };
    if (marker !== 3) reader.error(`custom item ${declaredType} uses wire ${marker}, expected Object`, markerOffset);
    const length = reader.readLength('item-length');
    const sub = reader.subReader(length, objectPath);
    const result = decodeCustom(sub, declaredType);
    if (sub.remaining() !== 0) sub.error(`custom serializer ${declaredType} left ${sub.remaining()} bytes`);
    return result;
  }
  if (
    isString(field, declaredType) ||
    isBoolean(field, declaredType) ||
    isSigned(field, declaredType) ||
    isUnsigned(field, declaredType) ||
    isFloat(field, declaredType) ||
    isDouble(field, declaredType) ||
    field.is_enum
  ) {
    return decodePrimitiveRaw(reader, field, declaredType);
  }
  if (isListType(declaredType)) {
    const markerOffset = reader.position;
    const marker = reader.readByte('item-wire');
    if (marker === 0) return { semantic: null, ast: { kind: 'null', offset: markerOffset, endOffset: reader.position } };
    if (marker !== 5) reader.error(`nested List item uses wire ${marker}, expected List`, markerOffset);
    const elementType = firstGenericTypeArgument(declaredType);
    if (!elementType) reader.error(`cannot determine nested List element type ${declaredType}`, markerOffset);
    return decodeCollection(reader, {
      name: 'Item',
      fieldType: declaredType,
      is_list: true,
      is_array: false,
      is_dictionary: false,
      element_type: elementType,
    }, schema, objectPath);
  }
  if (schema.typesByName.has(declaredType) || field.is_kfb_serializable || field.polymorphic) {
    const markerOffset = reader.position;
    const marker = reader.readByte('item-wire');
    if (marker === 0) return { semantic: null, ast: { kind: 'null', offset: markerOffset, endOffset: reader.position } };
    if (marker !== 3) reader.error(`object item ${declaredType} uses wire ${marker}, expected Object`, markerOffset);
    const length = reader.readLength('item-length');
    const sub = reader.subReader(length, objectPath);
    return decodeObjectPayload(sub, declaredType, schema, objectPath, true);
  }
  reader.error(`unsupported declared collection item type ${declaredType}`);
}

function decodeCollection(reader: Reader, field: any, schema: any, objectPath: string): any {
  const start = reader.position;
  const countBig = reader.readVarint('collection-count');
  if (countBig > 10000000n) reader.error(`unreasonable collection count ${countBig}`, start);
  const count = Number(countBig);
  if (field.is_dictionary) {
    const entries: any[] = [];
    const semantic: Record<string, any> = {};
    for (let index = 0; index < count; index += 1) {
      const keyField = { fieldType: field.key_type, type_code: '', is_enum: false };
      const key = decodeDeclaredItem(reader, keyField, field.key_type, schema, `${objectPath}[${index}].Key`);
      const valueField = {
        ...field,
        fieldType: field.value_type,
        is_dictionary: false,
        is_list: false,
        is_array: false,
        has_custom_serializer: schema.customTypes.has(field.value_type),
        is_kfb_serializable: schema.typesByName.has(field.value_type),
      };
      const value = decodeDeclaredItem(reader, valueField, field.value_type, schema, `${objectPath}[${index}].Value`);
      const property = typeof key.semantic === 'string' ? key.semantic : String(key.semantic);
      if (Object.prototype.hasOwnProperty.call(semantic, property)) reader.error(`duplicate Dictionary key ${property}`);
      semantic[property] = value.semantic;
      entries.push({ key: key.ast, value: value.ast, index });
    }
    return { semantic, ast: { kind: 'dictionary', entries, offset: start, endOffset: reader.position } };
  }
  const elementType = field.element_type;
  if (!elementType) reader.error(`collection field ${field.name} lacks element_type`, start);
  const items: any[] = [];
  const semantic: any[] = [];
  for (let index = 0; index < count; index += 1) {
    const elementField = {
      ...field,
      fieldType: elementType,
      is_dictionary: false,
      is_list: false,
      is_array: false,
      has_custom_serializer: schema.customTypes.has(elementType),
      is_kfb_serializable: schema.typesByName.has(elementType),
    };
    const item = decodeDeclaredItem(reader, elementField, elementType, schema, `${objectPath}[${index}]`);
    items.push({ ...item.ast, index });
    semantic.push(item.semantic);
  }
  return { semantic, ast: { kind: field.is_array ? 'array' : 'list', items, offset: start, endOffset: reader.position } };
}

function decodePacked(reader: Reader, field: any, schema: any, objectPath: string): any {
  const start = reader.position;
  const length = reader.readLength('packed-length');
  const packed = reader.subReader(length, objectPath);
  const elementType = field.element_type;
  if (!elementType) packed.error(`packed field ${field.name} lacks element_type`);
  const items: any[] = [];
  const semantic: any[] = [];
  while (packed.remaining() > 0) {
    const elementField = { ...field, fieldType: elementType, is_array: false, is_list: false, is_dictionary: false };
    const item = decodePrimitiveRaw(packed, elementField, elementType);
    items.push({ ...item.ast, index: items.length });
    semantic.push(item.semantic);
  }
  return { semantic, ast: { kind: 'array', packed: true, items, offset: start, endOffset: reader.position } };
}

function decodeFieldValue(reader: Reader, wire: number, field: any, schema: any, objectPath: string): any {
  const start = reader.position;
  if (field.is_dictionary || wire === 6) {
    if (wire !== 6) reader.error(`field ${field.name} expected Dictionary wire, got ${WIRE_NAMES[wire]}`, start);
    return decodeCollection(reader, field, schema, objectPath);
  }
  if (field.is_list || (field.is_array && wire === 5) || wire === 5) {
    if (wire !== 5) reader.error(`field ${field.name} expected List wire, got ${WIRE_NAMES[wire]}`, start);
    return decodeCollection(reader, field, schema, objectPath);
  }
  if (wire === 7) return decodePacked(reader, field, schema, objectPath);
  if (schema.customTypes.has(field.fieldType) || field.has_custom_serializer) {
    if (wire !== 3) reader.error(`custom field ${field.name} expected Object wire, got ${WIRE_NAMES[wire]}`, start);
    const length = reader.readLength('object-length');
    const sub = reader.subReader(length, objectPath);
    const result = decodeCustom(sub, field.fieldType);
    if (sub.remaining() !== 0) sub.error(`custom serializer ${field.fieldType} left ${sub.remaining()} bytes`);
    return result;
  }
  if (isString(field)) {
    if (wire !== 4) reader.error(`String field ${field.name} uses ${WIRE_NAMES[wire]}`, start);
    return decodePrimitiveRaw(reader, field, field.fieldType);
  }
  if (wire === 0) return decodePrimitiveRaw(reader, field, field.fieldType);
  if (wire === 1) {
    const bytes = reader.readBytes(4, 'fixed32');
    return makeScalar(
      isFloat(field) ? Number(formatSingle(bytes.readFloatLE(0))) : bytes.readUInt32LE(0),
      isFloat(field) ? 'Single' : typeCode(field),
      start,
      reader.position,
    );
  }
  if (wire === 2) {
    const bytes = reader.readBytes(8, 'fixed64');
    return makeScalar(
      isDouble(field) ? bytes.readDoubleLE(0) : bytes.readBigUInt64LE(0).toString(),
      isDouble(field) ? 'Double' : typeCode(field),
      start,
      reader.position,
    );
  }
  if (wire === 3) {
    const length = reader.readLength('object-length');
    const sub = reader.subReader(length, objectPath);
    return decodeObjectPayload(sub, field.fieldType, schema, objectPath, true);
  }
  reader.error(`unsupported wire ${wire} for ${field.name}`, start);
}

function mergeSemantic(defaultValue: any, decoded: any): any {
  if (!defaultValue || typeof defaultValue !== 'object' || Array.isArray(defaultValue)) return decoded;
  return Object.assign(cloneJson(defaultValue), decoded);
}

function decodeObjectPayload(reader: Reader, declaredTypeName: string, schema: any, objectPath: string, allowPrefix: boolean): any {
  const start = reader.position;
  let actualTypeName = declaredTypeName;
  let prefixTypeId: number | null = null;
  if (allowPrefix && reader.remaining() > 0) {
    const saved = reader.position;
    const first = reader.readVarint('object-prefix');
    if (first === 0n && reader.remaining() > 0) {
      const encodedTypeId = reader.readVarint('type-id');
      const typeIdBig = zigZag(encodedTypeId);
      if (typeIdBig <= 0n || typeIdBig > 0x7fffffffn) reader.error(`invalid type ID ${typeIdBig}`);
      prefixTypeId = Number(typeIdBig);
      const actual = schema.typesById.get(prefixTypeId);
      if (!actual) reader.error(`unknown type ID ${prefixTypeId}`);
      actualTypeName = actual.fullName;
    } else {
      const decodedFirst = zigZag(first);
      const candidate = decodedFirst > 0n && decodedFirst <= 0x7fffffffn ? schema.typesById.get(Number(decodedFirst)) : null;
      const declared = schema.typesByName.get(declaredTypeName);
      if (declared && declared.polymorphic && candidate) {
        prefixTypeId = Number(decodedFirst);
        actualTypeName = candidate.fullName;
      } else {
        reader.position = saved;
        reader.coverage.pop();
      }
    }
  }
  const actualType = schema.typesByName.get(actualTypeName);
  if (!actualType) reader.error(`unknown object type ${actualTypeName}`, start);
  const decoded: Record<string, any> = {};
  const fields: any[] = [];

  function decodeFieldBlock(blockReader: Reader, declaringType: string): void {
    while (blockReader.remaining() > 0) {
      const headerOffset = blockReader.position;
      const header = blockReader.readVarint('field-header');
      const wire = Number(header & 7n);
      const tagBig = header >> 3n;
      if (wire > 7 || tagBig > 0x7fffffffn) blockReader.error('invalid field header', headerOffset);
      if (tagBig === 0n) {
        if (wire !== 3) blockReader.error(`invalid base-field wire ${wire}`, headerOffset);
        const current = schema.typesByName.get(declaringType);
        if (!current || !current.baseType || !schema.typesByName.has(current.baseType)) {
          blockReader.error(`unexpected base-field block for ${declaringType}`, headerOffset);
        }
        const baseLength = blockReader.readLength('base-object-length');
        const baseReader = blockReader.subReader(baseLength, objectPath);
        decodeFieldBlock(baseReader, current.baseType);
        if (baseReader.remaining() !== 0) baseReader.error(`base object left ${baseReader.remaining()} bytes`);
        continue;
      }
      const tag = Number(tagBig);
      const field = chooseField(schema, actualType, tag, declaringType);
      if (!field) blockReader.error(`unknown tag ${tag} for ${declaringType}`, headerOffset);
      const propertyName = editableFieldName(actualType, field);
      const value = decodeFieldValue(blockReader, wire, field, schema, `${objectPath}.${propertyName}`);
      decoded[propertyName] = value.semantic;
      fields.push({
        kind: 'field',
        tag,
        name: field.name,
        declaredType: field.fieldType,
        declaredBy: field.declaredBy,
        wire,
        wireName: WIRE_NAMES[wire],
        offset: headerOffset,
        endOffset: blockReader.position,
        value: value.ast,
      });
    }
  }

  decodeFieldBlock(reader, actualType.fullName);
  let semantic = mergeSemantic(actualType.defaultValue, decoded);
  if (actualTypeName === 'KH.CreateEffectArg' && semantic.effectID === -9999) {
    semantic.sceneRemapping = false;
  }
  return {
    semantic,
    ast: {
      kind: 'object',
      declaredType: declaredTypeName,
      type: actualTypeName,
      typeId: prefixTypeId,
      fields,
      offset: start,
      endOffset: reader.position,
    },
  };
}

function validateCoverage(coverage: any[], inputLength: number): any {
  const intervals = coverage
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let position = 0;
  for (const interval of intervals) {
    if (interval.start > position) throw new DecodeError(`unconsumed byte range ${position}-${interval.start}`, position);
    if (interval.start < position) {
      throw new DecodeError(`overlapping coverage ${interval.start}-${interval.end}`, interval.start);
    }
    position = interval.end;
  }
  if (position !== inputLength) throw new DecodeError(`unconsumed byte range ${position}-${inputLength}`, position);
  return { coveredBytes: position, intervals: intervals.length, unknownFields: 0 };
}

/** 解码 KFB 明文二进制 → { semantic, ast, coverage } */
export function decodeKfb(buffer: Uint8Array, normalizedSchema: any): any {
  if (!buffer || buffer.length === 0) throw new Error('KFB input is empty');
  const coverage: any[] = [];
  const reader = new Reader(buffer, 0, buffer.length, coverage, '$');
  const result = decodeObjectPayload(reader, normalizedSchema.rootType, normalizedSchema, '$', false);
  if (reader.remaining() !== 0) reader.error(`root object left ${reader.remaining()} bytes`);
  const coverageResult = validateCoverage(coverage, buffer.length);
  return { ...result, coverage: coverageResult };
}

function xmlEscape(value: any): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function encodeVarint(value: bigint | number): Buffer {
  let current = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0n);
  return Buffer.from(bytes);
}
function encodeZigZag(value: any): bigint {
  const v = BigInt(value);
  return (v << 1n) ^ (v >> 63n);
}
function fieldHeader(tag: number, wire: number): Buffer {
  return encodeVarint((BigInt(tag) << 3n) | BigInt(wire));
}
function stringRaw(value: string): Buffer {
  const data = Buffer.from(value);
  return Buffer.concat([encodeVarint(BigInt(data.length)), data]);
}

class EncodeError extends Error {
  objectPath: string;
  constructor(message: string, objectPath = '$') {
    super(`${message} (${objectPath})`);
    this.name = 'KfbEncodeError';
    this.objectPath = objectPath;
  }
}

function encodeError(message: string, objectPath: string): never {
  throw new EncodeError(message, objectPath);
}

function integerValue(value: any, objectPath: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) encodeError(`integer is outside the exact JSON range: ${value}`, objectPath);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  encodeError(`expected an integer, got ${JSON.stringify(value)}`, objectPath);
}

function encodePrimitiveRaw(value: any, field: any, declaredType: string, objectPath: string): Buffer {
  if (isString(field, declaredType)) return stringRaw(String(value));
  if (isFloat(field, declaredType)) {
    const output = Buffer.allocUnsafe(4);
    output.writeFloatLE(Number(value), 0);
    return output;
  }
  if (isDouble(field, declaredType)) {
    const output = Buffer.allocUnsafe(8);
    output.writeDoubleLE(Number(value), 0);
    return output;
  }
  if (isBoolean(field, declaredType)) {
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      encodeError(`expected Boolean, got ${JSON.stringify(value)}`, objectPath);
    }
    return encodeVarint(value === true || value === 1 ? 1n : 0n);
  }
  const integer = integerValue(value, objectPath);
  if (isUnsigned(field, declaredType) && integer < 0n) encodeError(`negative unsigned integer ${integer}`, objectPath);
  return encodeVarint(isSigned(field, declaredType) ? encodeZigZag(integer) : integer);
}

function parseCustomParts(value: any, count: number): string[] {
  const text = String(value);
  if (count === 1) return [text];
  const raw = text.split(',');
  if (raw.length < count) raw.push(...Array(count - raw.length).fill(''));
  if (raw.length > count) {
    const fixed = raw.slice(0, count - 1);
    fixed.push(raw.slice(count - 1).join(','));
    return fixed;
  }
  return raw;
}

function encodeAnimationCurve(value: any, objectPath: string): Buffer {
  const sections = String(value).split('|');
  if (sections.length < 3) encodeError('invalid AnimationCurve JSON value', objectPath);
  const preWrapMode = integerValue(sections[0], `${objectPath}.preWrapMode`);
  const postWrapMode = integerValue(sections[1], `${objectPath}.postWrapMode`);
  const count = Number(integerValue(sections[2], `${objectPath}.count`));
  if (!Number.isInteger(count) || count < 0 || count > 1000000 || sections.length !== count + 3) {
    encodeError(`invalid AnimationCurve key count ${count}`, objectPath);
  }
  const parts: Buffer[] = [
    encodeVarint(encodeZigZag(preWrapMode)),
    encodeVarint(encodeZigZag(postWrapMode)),
    encodeVarint(encodeZigZag(BigInt(count))),
  ];
  for (let index = 0; index < count; index += 1) {
    const values = sections[index + 3].split(',');
    if (values.length !== 7) encodeError(`AnimationCurve key ${index} must contain seven values`, objectPath);
    for (let component = 0; component < 6; component += 1) {
      const output = Buffer.allocUnsafe(4);
      output.writeFloatLE(Number(values[component]), 0);
      parts.push(output);
    }
    parts.push(encodeVarint(encodeZigZag(integerValue(values[6], `${objectPath}.keys[${index}].weightedMode`))));
  }
  return Buffer.concat(parts);
}

function encodeCustom(value: any, typeName: string, objectPath: string): Buffer {
  if (typeName === 'UnityEngine.AnimationCurve') return encodeAnimationCurve(value, objectPath);
  const layout = customLayout(typeName);
  if (!layout) encodeError(`unknown custom serializer ${typeName}`, objectPath);
  const parts = parseCustomParts(value, layout.components.length);
  const encoded: Buffer[] = [];
  for (let index = 0; index < layout.components.length; index += 1) {
    const component = layout.components[index];
    const name = typeof component === 'string' ? component : component.name;
    const encoding = typeof component === 'string' ? layout.encoding : component.encoding;
    const componentPath = `${objectPath}.${name}`;
    const current = parts[index];
    if (encoding === 'sint64' || encoding === 'sint32') {
      encoded.push(encodeVarint(encodeZigZag(integerValue(current, componentPath))));
    } else if (encoding === 'uint64' || encoding === 'uint32') {
      const integer = integerValue(current, componentPath);
      if (integer < 0n) encodeError(`negative unsigned integer ${integer}`, componentPath);
      encoded.push(encodeVarint(integer));
    } else if (encoding === 'string') encoded.push(stringRaw(current));
    else if (encoding === 'float32') {
      const output = Buffer.allocUnsafe(4);
      output.writeFloatLE(Number(current), 0);
      encoded.push(output);
    } else if (encoding === 'float64') {
      const output = Buffer.allocUnsafe(8);
      output.writeDoubleLE(Number(current), 0);
      encoded.push(output);
    } else if (encoding === 'byte') {
      const integer = integerValue(current, componentPath);
      if (integer < 0n || integer > 255n) encodeError(`byte is outside 0..255: ${integer}`, componentPath);
      encoded.push(Buffer.from([Number(integer)]));
    } else encodeError(`unsupported custom component encoding ${encoding}`, componentPath);
  }
  return Buffer.concat(encoded);
}

function actualTypeForValue(value: any, declaredType: string, schema: any, objectPath: string): any {
  let actual = schema.typesByName.get(declaredType);
  if (value && typeof value === 'object' && value.$tid !== undefined) {
    const typeId = Number(value.$tid);
    if (!Number.isInteger(typeId) || !schema.typesById.has(typeId)) encodeError(`unknown $tid ${value.$tid}`, objectPath);
    actual = schema.typesById.get(typeId);
  }
  if (!actual) encodeError(`unknown object type ${declaredType}`, objectPath);
  let current = actual;
  let assignable = actual.fullName === declaredType;
  const visited = new Set<string>();
  while (!assignable && current && current.baseType && !visited.has(current.fullName)) {
    visited.add(current.fullName);
    assignable = current.baseType === declaredType;
    current = schema.typesByName.get(current.baseType);
  }
  if (!assignable && schema.typesByName.has(declaredType)) {
    encodeError(`type ${actual.fullName} is not assignable to ${declaredType}`, objectPath);
  }
  return actual;
}

function isPrimitiveDeclared(field: any, declaredType: string): boolean {
  return (
    isString(field, declaredType) ||
    isBoolean(field, declaredType) ||
    isSigned(field, declaredType) ||
    isUnsigned(field, declaredType) ||
    isFloat(field, declaredType) ||
    isDouble(field, declaredType) ||
    field.is_enum
  );
}

function encodeDeclaredItem(value: any, field: any, declaredType: string, schema: any, objectPath: string): Buffer {
  const custom = schema.customTypes.has(declaredType) || field.has_custom_serializer;
  const nestedList = isListType(declaredType);
  const object = schema.typesByName.has(declaredType) || field.is_kfb_serializable || field.polymorphic;
  if (value === null || value === undefined) {
    if (custom || nestedList || object) return Buffer.from([0]);
    encodeError(`null primitive collection item ${declaredType}`, objectPath);
  }
  if (custom) {
    const body = encodeCustom(value, declaredType, objectPath);
    return Buffer.concat([Buffer.from([3]), encodeVarint(BigInt(body.length)), body]);
  }
  if (isPrimitiveDeclared(field, declaredType)) return encodePrimitiveRaw(value, field, declaredType, objectPath);
  if (nestedList) {
    const elementType = firstGenericTypeArgument(declaredType);
    if (!elementType) encodeError(`cannot determine nested List element type ${declaredType}`, objectPath);
    const body = encodeCollection(
      value,
      {
        name: 'Item',
        fieldType: declaredType,
        is_list: true,
        is_array: false,
        is_dictionary: false,
        element_type: elementType,
      },
      schema,
      objectPath,
    );
    return Buffer.concat([Buffer.from([5]), body]);
  }
  if (object) {
    const body = encodeObjectPayload(value, declaredType, schema, objectPath, true);
    return Buffer.concat([Buffer.from([3]), encodeVarint(BigInt(body.length)), body]);
  }
  encodeError(`unsupported declared collection item type ${declaredType}`, objectPath);
}

function encodeCollection(value: any, field: any, schema: any, objectPath: string): Buffer {
  if (field.is_dictionary) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) encodeError('Dictionary value must be an object', objectPath);
    const entries = Object.entries(value);
    const parts: Buffer[] = [encodeVarint(BigInt(entries.length))];
    for (let index = 0; index < entries.length; index += 1) {
      const [keyValue, itemValue] = entries[index];
      const keyField = { fieldType: field.key_type, type_code: '', is_enum: false };
      parts.push(encodeDeclaredItem(keyValue, keyField, field.key_type, schema, `${objectPath}[${index}].Key`));
      const valueField = {
        ...field,
        fieldType: field.value_type,
        is_dictionary: false,
        is_list: false,
        is_array: false,
        has_custom_serializer: schema.customTypes.has(field.value_type),
        is_kfb_serializable: schema.typesByName.has(field.value_type),
      };
      parts.push(encodeDeclaredItem(itemValue, valueField, field.value_type, schema, `${objectPath}[${index}].Value`));
    }
    return Buffer.concat(parts);
  }
  if (!Array.isArray(value)) encodeError('List/Array value must be an array', objectPath);
  const elementType = field.element_type;
  if (!elementType) encodeError(`collection field ${field.name} lacks element_type`, objectPath);
  const parts: Buffer[] = [encodeVarint(BigInt(value.length))];
  for (let index = 0; index < value.length; index += 1) {
    const elementField = {
      ...field,
      fieldType: elementType,
      is_dictionary: false,
      is_list: false,
      is_array: false,
      has_custom_serializer: schema.customTypes.has(elementType),
      is_kfb_serializable: schema.typesByName.has(elementType),
    };
    parts.push(encodeDeclaredItem(value[index], elementField, elementType, schema, `${objectPath}[${index}]`));
  }
  return Buffer.concat(parts);
}

function wireForField(field: any, schema: any): number {
  if (field.is_dictionary) return 6;
  if (field.is_list || field.is_array) return 5;
  if (schema.customTypes.has(field.fieldType) || field.has_custom_serializer) return 3;
  if (isString(field)) return 4;
  if (field.wire_type_hint === 'Fixed32' || isFloat(field)) return 1;
  if (field.wire_type_hint === 'Fixed64' || isDouble(field)) return 2;
  if (schema.typesByName.has(field.fieldType) || field.is_kfb_serializable || field.polymorphic) return 3;
  return 0;
}

function encodeFieldValue(value: any, wire: number, field: any, schema: any, objectPath: string): Buffer {
  if (wire === 6 || wire === 5) return encodeCollection(value, field, schema, objectPath);
  if (wire === 7) {
    if (!Array.isArray(value) || !field.element_type) encodeError('Packed value must be a typed array', objectPath);
    const elementField = { ...field, fieldType: field.element_type, is_array: false, is_list: false, is_dictionary: false };
    const body = Buffer.concat(
      value.map((item: any, index: number) => encodePrimitiveRaw(item, elementField, field.element_type, `${objectPath}[${index}]`)),
    );
    return Buffer.concat([encodeVarint(BigInt(body.length)), body]);
  }
  if (schema.customTypes.has(field.fieldType) || field.has_custom_serializer) {
    const body = encodeCustom(value, field.fieldType, objectPath);
    return Buffer.concat([encodeVarint(BigInt(body.length)), body]);
  }
  if (wire === 3) {
    const body = encodeObjectPayload(value, field.fieldType, schema, objectPath, true);
    return Buffer.concat([encodeVarint(BigInt(body.length)), body]);
  }
  return encodePrimitiveRaw(value, field, field.fieldType, objectPath);
}

function encodeObjectPayload(value: any, declaredTypeName: string, schema: any, objectPath: string, includePrefix: boolean): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) encodeError('object value must be a JSON object', objectPath);
  const actualType = actualTypeForValue(value, declaredTypeName, schema, objectPath);
  const chunks: Buffer[] = [];
  if (includePrefix) {
    if (actualType.typeId === null) encodeError(`object type ${actualType.fullName} has no type ID`, objectPath);
    chunks.push(Buffer.from([0]), encodeVarint(encodeZigZag(BigInt(actualType.typeId))));
  }

  function encodeFieldBlock(declaringType: string): Buffer {
    const parts: Buffer[] = [];
    const fields = actualType.fields.filter((field: any) => field.declaredBy === declaringType);
    for (const field of fields) {
      const propertyName = editableFieldName(actualType, field);
      let selectedName = propertyName;
      if (!Object.prototype.hasOwnProperty.call(value, selectedName)) {
        const duplicates = actualType.fields.filter((candidate: any) => candidate.name === field.name);
        const last = duplicates[duplicates.length - 1];
        if (last !== field || !Object.prototype.hasOwnProperty.call(value, field.name)) continue;
        selectedName = field.name;
      }
      const fieldValue = value[selectedName];
      if (fieldValue === null || fieldValue === undefined) continue;
      const wire = wireForField(field, schema);
      parts.push(fieldHeader(field.tag, wire));
      parts.push(encodeFieldValue(fieldValue, wire, field, schema, `${objectPath}.${selectedName}`));
    }
    const declaring = schema.typesByName.get(declaringType);
    if (declaring && declaring.baseType && schema.typesByName.has(declaring.baseType)) {
      const base = encodeFieldBlock(declaring.baseType);
      if (base.length > 0) parts.push(fieldHeader(0, 3), encodeVarint(BigInt(base.length)), base);
    }
    return Buffer.concat(parts);
  }

  chunks.push(encodeFieldBlock(actualType.fullName));
  return Buffer.concat(chunks);
}

/** 编码语义 JSON → KFB 明文二进制 */
export function encodeKfb(semantic: any, normalizedSchema: any): Uint8Array {
  if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) throw new Error('KFB semantic root must be an object');
  const output = encodeObjectPayload(semantic, normalizedSchema.rootType, normalizedSchema, '$', false);
  if (output.length === 0) throw new Error('encoded KFB is empty');
  return output;
}

/** 内置合成样本自检：验证 解码→XML→编码→解码 往返一致 */
export function runSyntheticSelfTest(): any {
  const childBody = Buffer.concat([Buffer.from([0]), encodeVarint(encodeZigZag(2)), fieldHeader(1, 0), encodeVarint(encodeZigZag(-7))]);
  const scalarBody = encodeVarint(encodeZigZag(6442450944n));
  const packedBody = Buffer.concat([encodeVarint(encodeZigZag(-1)), encodeVarint(encodeZigZag(2))]);
  const wide = 9007199254740993n;
  const fixture = Buffer.concat([
    fieldHeader(1, 4), stringRaw('Actor'),
    fieldHeader(2, 0), encodeVarint(encodeZigZag(-42)),
    fieldHeader(3, 5), encodeVarint(2), stringRaw('a'), stringRaw('b'),
    fieldHeader(4, 6), encodeVarint(1), encodeVarint(encodeZigZag(5)), stringRaw('five'),
    fieldHeader(5, 3), encodeVarint(BigInt(childBody.length)), childBody,
    fieldHeader(6, 3), encodeVarint(BigInt(scalarBody.length)), scalarBody,
    fieldHeader(7, 0), encodeVarint(encodeZigZag(wide)),
    fieldHeader(8, 7), encodeVarint(BigInt(packedBody.length)), packedBody,
    fieldHeader(9, 5), encodeVarint(1), Buffer.from([0]),
  ]);
  const schema = normalizeSchema({
    schema_version: 1,
    root_type: 'Test.Root',
    polymorphic_type_field: '$type',
    custom_serializers: [{ type: 'Morefun.LockStep.FScalar', serializer_type: 'Synthetic' }],
    types: [
      {
        type_id: 1,
        full_name: 'Test.Root',
        fields: [
          { tag: 1, name: 'name', field_type: 'System.String', type_code: 'String' },
          { tag: 2, name: 'signed', field_type: 'System.Int32', type_code: 'Int32' },
          { tag: 3, name: 'names', field_type: 'System.Collections.Generic.List<System.String>', is_list: true, element_type: 'System.String' },
          { tag: 4, name: 'map', field_type: 'System.Collections.Generic.Dictionary<System.Int32,System.String>', is_dictionary: true, key_type: 'System.Int32', value_type: 'System.String' },
          { tag: 5, name: 'child', field_type: 'Test.Child', is_kfb_serializable: true },
          { tag: 6, name: 'scalar', field_type: 'Morefun.LockStep.FScalar', has_custom_serializer: true },
          { tag: 7, name: 'wide', field_type: 'System.Int64', type_code: 'Int64' },
          { tag: 8, name: 'packed', field_type: 'System.Int32[]', is_array: true, element_type: 'System.Int32' },
          { tag: 9, name: 'nullableChildren', field_type: 'System.Collections.Generic.List<Test.Child>', is_list: true, element_type: 'Test.Child' },
        ],
      },
      {
        type_id: 2,
        full_name: 'Test.Child',
        fields: [{ tag: 1, name: 'value', field_type: 'System.Int32', type_code: 'Int32' }],
      },
    ],
  });
  const decoded = decodeKfb(fixture, schema);
  const expected = {
    name: 'Actor',
    signed: -42,
    names: ['a', 'b'],
    map: { 5: 'five' },
    child: { value: -7 },
    scalar: '6442450944',
    wide: wide.toString(),
    packed: [-1, 2],
    nullableChildren: [null],
  };
  if (JSON.stringify(decoded.semantic) !== JSON.stringify(expected)) throw new Error('synthetic semantic mismatch');
  const reencoded = encodeKfb(decoded.semantic, schema);
  const decodedAgain = decodeKfb(reencoded, schema);
  if (JSON.stringify(decodedAgain.semantic) !== JSON.stringify(expected)) throw new Error('synthetic encode round-trip mismatch');
  return {
    fixtureBytes: fixture.length,
    reencodedBytes: reencoded.length,
    encodeRoundTrip: true,
    semantic: decoded.semantic,
  };
}