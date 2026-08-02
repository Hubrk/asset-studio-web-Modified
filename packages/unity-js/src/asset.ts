import { isNotNil } from 'es-toolkit';
import type { AssetFile } from './assetFile';
import { createAssetObject } from './classes';
import { ObjectInfo } from './object';
import { SerializedType } from './serializedType';
import { loopEach } from './utils/loop';
import { ArrayBufferReader } from './utils/reader';

export interface AssetHeader {
  metadataSize: number;
  fileSize: number;
  version: number;
  dataOffset: number;
  endianness: number;
}

export class Asset {
  readonly header: AssetHeader;
  readonly fileEndianness: number = 0;
  readonly unityVersion: string = '';
  readonly version: number[] = [];
  readonly buildType: string = '';
  readonly targetPlatform: number = 0;
  readonly enableTypeTree: boolean = false;
  readonly enableBigId: boolean = false;
  readonly types: SerializedType[] = [];
  readonly typeMap = new Map<number, SerializedType>();
  readonly objectInfos: ObjectInfo[] = [];
  readonly reader: ArrayBufferReader;
  /** Byte offset of the fileSize field within the SerializedFile (for metadata rebuild). */
  private _fileSizeFieldOffset = 4;
  /** Whether fileSize is stored as uint64 (version >= 22). */
  private _fileSizeIs64 = false;

  constructor(
    bundle: AssetFile,
    data: ArrayBuffer,
    readonly path: string,
  ) {
    const r = new ArrayBufferReader(data);
    this.reader = r;

    const header: AssetHeader = (this.header = {
      metadataSize: r.readUInt32BE(),
      fileSize: r.readUInt32BE(),
      version: r.readUInt32BE(),
      dataOffset: r.readUInt32BE(),
      endianness: 0,
    });

    if (header.version >= 9) {
      this.fileEndianness = header.endianness = r.readUInt8();
      r.move(3);
    } else {
      r.seek(header.fileSize - header.metadataSize);
      this.fileEndianness = r.readUInt8();
    }
    if (header.version >= 22) {
      header.metadataSize = r.readUInt32();
      this._fileSizeFieldOffset = r.position;
      header.fileSize = Number(r.readUInt64());
      this._fileSizeIs64 = true;
      header.dataOffset = Number(r.readUInt64());
      r.move(8);
    }
    r.setLittleEndian(!this.fileEndianness);
    if (header.version >= 7) {
      this.unityVersion = r.readStringUntilZero();
      this.version = this.unityVersion
        .replace(/[a-z]+/gi, '.')
        .split('.')
        .slice(0, 4)
        .map(s => Number(s));
      this.buildType = this.unityVersion.match(/[a-z]/i)?.[0] ?? '';
    }
    if (header.version >= 8) {
      this.targetPlatform = r.readInt32();
    }
    if (header.version >= 13) {
      this.enableTypeTree = !!r.readUInt8();
    }

    loopEach(r.readInt32(), () => {
      const type = new SerializedType(r, header, this.enableTypeTree, false);
      this.types.push(type);
      this.typeMap.set(type.classId, type);
    });

    if (header.version >= 7 && header.version < 14) {
      this.enableBigId = !!r.readInt32();
    }

    loopEach(r.readUInt32(), () => {
      this.objectInfos.push(new ObjectInfo(this, bundle));
    });

    // 未实现
  }

  objects() {
    return this.objectInfos.map(createAssetObject).filter(isNotNil);
  }

  /**
   * Rebuild the SerializedFile binary data.
   *
   * Two modes:
   * - If no modified ObjectInfo has a size change, copy the original buffer and
   *   patch modified objects' data in place (fast, byte-compatible except for
   *   patched regions).
   * - If any modified ObjectInfo has a different size, perform a full metadata
   *   rebuild: recalculate bytesStart/bytesSize for all objects, patch the
   *   metadata section, and rebuild the data section.
   */
  rebuild(): ArrayBuffer {
    const rawData = this.reader.rawBuffer;
    const modifiedInfos = this.objectInfos.filter(info => info._modifiedData);

    if (modifiedInfos.length === 0) {
      return rawData.slice(0);
    }

    const sizeChanged = modifiedInfos.some(
      info => info._modifiedData!.byteLength !== info.bytesSize,
    );

    if (!sizeChanged) {
      // Size unchanged: copy the original buffer and patch modified objects in place.
      const result = new Uint8Array(rawData.slice(0));
      for (const info of modifiedInfos) {
        const modifiedData = new Uint8Array(info._modifiedData!);
        result.set(modifiedData, info.bytesStart);
      }
      return result.buffer;
    }

    // --- Full metadata rebuild (size changed) ---
    const dataOffset = this.header.dataOffset;
    const le = !this.fileEndianness; // little-endian flag used for ObjectInfo fields

    // 1. Calculate new bytesStart/bytesSize for ALL objects (in order)
    const newSizes: number[] = [];
    const newStarts: number[] = [];
    let currentStart = dataOffset;
    for (const info of this.objectInfos) {
      const newSize = info._modifiedData ? info._modifiedData.byteLength : info.bytesSize;
      newSizes.push(newSize);
      newStarts.push(currentStart);
      currentStart += newSize;
    }
    const totalDataSize = currentStart - dataOffset;

    // 2. Copy metadata (0 to dataOffset) and patch bytesStart/bytesSize
    const metadataBytes = new Uint8Array(rawData.slice(0, dataOffset));
    const metaView = new DataView(metadataBytes.buffer);

    for (let i = 0; i < this.objectInfos.length; i++) {
      const info = this.objectInfos[i];
      // bytesStart stored in file is relative to dataOffset
      const relativeStart = newStarts[i] - dataOffset;
      if (this.header.version >= 22) {
        metaView.setBigUint64(info._bytesStartFieldOffset, BigInt(relativeStart), le);
      } else {
        metaView.setUint32(info._bytesStartFieldOffset, relativeStart, le); // LE for version < 22 (matches reader endianness)
      }
      metaView.setUint32(info._bytesSizeFieldOffset, newSizes[i], le);
    }

    // 3. Patch fileSize in header
    const newFileSize = dataOffset + totalDataSize;
    if (this._fileSizeIs64) {
      metaView.setBigUint64(this._fileSizeFieldOffset, BigInt(newFileSize), false);
    } else {
      metaView.setUint32(this._fileSizeFieldOffset, newFileSize, false); // BE
    }

    // 4. Build data section: concatenate all objects' data in order
    const dataSection = new Uint8Array(totalDataSize);
    let dataPos = 0;
    for (let i = 0; i < this.objectInfos.length; i++) {
      const info = this.objectInfos[i];
      const objData = info._modifiedData
        ? new Uint8Array(info._modifiedData)
        : new Uint8Array(rawData.slice(info.bytesStart, info.bytesStart + info.bytesSize));
      dataSection.set(objData, dataPos);
      dataPos += objData.byteLength;
    }

    // 5. Return metadata + data
    const result = new Uint8Array(dataOffset + totalDataSize);
    result.set(metadataBytes, 0);
    result.set(dataSection, dataOffset);
    return result.buffer;
  }
}
