import { ArrayBufferReader } from '../utils/reader';
import { ArrayBufferWriter } from '../utils/writer';
import { AssetBase } from './base';
import type { ObjectInfo } from './types';
import { AssetType } from './types';

export class TextAsset extends AssetBase {
  readonly type = AssetType.TextAsset;
  readonly data: ArrayBuffer;
  _modifiedTextData?: Uint8Array;

  constructor(info: ObjectInfo, r: ArrayBufferReader) {
    super(info, r);
    const length = r.readInt32();
    this.data = r.readBuffer(length);
  }

  serialize(writer: ArrayBufferWriter): void {
    const littleEndian = !this.__info.asset.fileEndianness;
    const rawBytes = this.getRaw();
    const r = new ArrayBufferReader(rawBytes);
    r.setLittleEndian(littleEndian);
    writer.setLittleEndian(littleEndian);

    writer.writeAlignedString(this.name);
    r.readAlignedString();

    if (this._modifiedTextData) {
      writer.writeInt32(this._modifiedTextData.length);
      r.readInt32();
      r.readBuffer(this.data.byteLength);
      writer.writeBuffer(this._modifiedTextData);
    } else {
      const length = r.readInt32();
      writer.writeInt32(length);
      const data = r.readBuffer(length);
      writer.writeBuffer(data);
    }
  }
}
