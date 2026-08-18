import { last } from 'es-toolkit';
import { SpritePackingMode, SpritePackingRotation } from '..';
import type { SpriteSettings, SpriteTightInfo } from '..';
import { getJimpPNG, Jimp } from '../lib/jimp';
import type { RectF32, Vector2 } from '../types';
import { decodeTexture } from '../utils/decodeTexture';
import { ArrayBufferReader } from '../utils/reader';
import { ArrayBufferWriter } from '../utils/writer';
import type { GetImage } from './base';
import { AssetBase } from './base';
import type { ImgBitMap, ObjectInfo } from './types';
import { AssetType } from './types';

export interface StreamInfo {
  offset: number;
  size: number;
  path: string;
}

export interface TextureTransformedOptions {
  textureRect: RectF32;
  textureRectOffset?: Vector2;
  downscaleMultiplier?: number;
  settingsRaw?: SpriteSettings;
}

const jimpFlipVertical = (img: Jimp) => img.flip({ horizontal: false, vertical: true });
const jimpFlipHorizontal = (img: Jimp) => img.flip({ horizontal: true, vertical: false });

export class Texture2D extends AssetBase implements GetImage {
  readonly type = AssetType.Texture2D;
  readonly width: number;
  readonly height: number;
  readonly textureFormat: number;
  readonly streamData?: StreamInfo;
  readonly dataSize: number;
  private readonly image: TextureDecoder;
  /** 修改后的纹理数据。设置后 serialize() 会写入此数据而非原始数据。 */
  _modifiedImageData?: Uint8Array;
  _modifiedTextureFormat?: number;

  constructor(info: ObjectInfo, r: ArrayBufferReader) {
    super(info, r);
    const { version } = this.__info;
    if (version[0] > 2017 || (version[0] === 2017 && version[1] >= 3)) {
      r.move(5);
      if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
        r.move(1);
      }
      r.align(4);
    }
    this.width = r.readInt32();
    this.height = r.readInt32();
    r.move(4);
    if (version[0] >= 2020) r.move(4);
    this.textureFormat = r.readInt32();
    if (version[0] < 5 || (version[0] === 5 && version[1] < 2)) r.move(1);
    else r.move(4);
    if (version[0] > 2 || (version[0] === 2 && version[1] >= 6)) r.move(1);
    if (version[0] >= 2020) r.move(1);
    if (version[0] > 2019 || (version[0] === 2019 && version[1] >= 3)) r.move(1);
    if (version[0] >= 3 && (version[0] < 5 || (version[0] === 5 && version[1] <= 4))) r.move(1);
    if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) r.move(1);
    r.align(4);
    if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) r.move(4);
    r.move(8);
    this.readTextureSetting(r);
    if (version[0] >= 3) r.move(4);
    if (version[0] > 3 || (version[0] === 3 && version[1] >= 5)) r.move(4);
    if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
      r.readBuffer(r.readInt32());
      r.align(4);
    }
    const dataSize = r.readInt32();
    this.streamData =
      dataSize === 0 && ((version[0] === 5 && version[1] >= 3) || version[0] > 5) ? this.readStreamInfo(r) : undefined;
    const data = this.streamData?.path ? this.readData(this.streamData) : r.readBuffer(dataSize);
    this.dataSize = this.streamData?.size ?? dataSize;
    this.image = new TextureDecoder(this, new Uint8Array(data));
  }

  /**
   * Override getRaw to return exactly bytesSize bytes.
   * The base class uses `this.size` which for Texture2D returns
   * `bytesSize + dataSize` (including external stream data), causing
   * out-of-bounds reads. The serialized object is only `bytesSize` bytes.
   */
  getRaw() {
    const r = this.__info.getReader();
    return r.readBuffer(this.__info.bytesSize);
  }

  /**
   * Serialize this Texture2D back to binary form.
   *
   * Uses a "mirror constructor" strategy: reads from the original raw bytes
   * (via getRaw) using a temporary reader, and writes to the output writer
   * in the exact same order. For fields with saved properties (width, height,
   * textureFormat, name), writes the current property value. For skipped
   * fields (r.move), copies the original bytes verbatim.
   */
  serialize(writer: ArrayBufferWriter): void {
    const { version } = this.__info;
    // Mirror the endianness used when reading the original asset data
    const littleEndian = !this.__info.asset.fileEndianness;
    const rawBytes = this.getRaw();
    const r = new ArrayBufferReader(rawBytes);
    r.setLittleEndian(littleEndian);
    writer.setLittleEndian(littleEndian);

    // name (from AssetBase.readName → r.readAlignedString)
    writer.writeAlignedString(this.name);
    r.readAlignedString(); // skip

    if (version[0] > 2017 || (version[0] === 2017 && version[1] >= 3)) {
      this.copyMove(r, writer, 5);
      if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
        this.copyMove(r, writer, 1);
      }
      this.copyAlign(r, writer, 4);
    }
    writer.writeInt32(this.width);
    r.readInt32();
    writer.writeInt32(this.height);
    r.readInt32();
    this.copyMove(r, writer, 4);
    if (version[0] >= 2020) this.copyMove(r, writer, 4);
    writer.writeInt32(this._modifiedTextureFormat ?? this.textureFormat);
    r.readInt32();
    if (version[0] < 5 || (version[0] === 5 && version[1] < 2)) this.copyMove(r, writer, 1);
    else this.copyMove(r, writer, 4);
    if (version[0] > 2 || (version[0] === 2 && version[1] >= 6)) this.copyMove(r, writer, 1);
    if (version[0] >= 2020) this.copyMove(r, writer, 1);
    if (version[0] > 2019 || (version[0] === 2019 && version[1] >= 3)) this.copyMove(r, writer, 1);
    if (version[0] >= 3 && (version[0] < 5 || (version[0] === 5 && version[1] <= 4))) this.copyMove(r, writer, 1);
    if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) this.copyMove(r, writer, 1);
    this.copyAlign(r, writer, 4);
    if (version[0] > 2018 || (version[0] === 2018 && version[1] >= 2)) this.copyMove(r, writer, 4);
    this.copyMove(r, writer, 8);

    // writeTextureSetting
    this.copyMove(r, writer, 12);
    if (version[0] >= 2017) this.copyMove(r, writer, 12);
    else this.copyMove(r, writer, 4);
    if (this.__info.isArknightsEndfield()) this.copyMove(r, writer, 4);

    if (version[0] >= 3) this.copyMove(r, writer, 4);
    if (version[0] > 3 || (version[0] === 3 && version[1] >= 5)) this.copyMove(r, writer, 4);

    if (version[0] > 2020 || (version[0] === 2020 && version[1] >= 2)) {
      // plotting data: readBuffer(readInt32()) + align(4)
      const plotLen = r.readInt32();
      writer.writeInt32(plotLen);
      const plotData = r.readBuffer(plotLen);
      writer.writeBuffer(plotData);
      r.align(4);
      writer.align(4);
    }

    // dataSize / streamData
    if (this.streamData) {
      // streamData mode: write dataSize=0 + StreamInfo
      writer.writeInt32(0);
      r.readInt32(); // skip original dataSize (=0)
      // StreamInfo: offset + size + path
      if (version[0] >= 2020) {
        writer.writeUInt64(BigInt(this.streamData.offset));
        r.readUInt64();
      } else {
        writer.writeUInt32(this.streamData.offset);
        r.readUInt32();
      }
      writer.writeUInt32(this.streamData.size);
      r.readUInt32();
      writer.writeAlignedString(this.streamData.path);
      r.readAlignedString();
    } else {
      // embedded mode: write dataSize + data
      if (this._modifiedImageData) {
        writer.writeInt32(this._modifiedImageData.length);
        r.readInt32();
        r.move(this.dataSize); // skip original data in reader
        writer.writeBuffer(this._modifiedImageData);
      } else {
        writer.writeInt32(this.dataSize);
        r.readInt32();
        const data = r.readBuffer(this.dataSize);
        writer.writeBuffer(data);
      }
    }
  }

  /** Helper: copy n bytes from reader to writer (mirrors r.move(n)) */
  private copyMove(r: ArrayBufferReader, writer: ArrayBufferWriter, n: number): void {
    const data = r.readUInt8Slice(n);
    writer.writeBuffer(data);
  }

  /** Helper: align both reader and writer (mirrors r.align(size)) */
  private copyAlign(r: ArrayBufferReader, writer: ArrayBufferWriter, size: number): void {
    const before = r.position;
    r.align(size);
    const padding = r.position - before;
    for (let i = 0; i < padding; i++) {
      writer.writeUInt8(0);
    }
  }

  get size() {
    return this.__info.bytesSize + this.dataSize;
  }

  getImage() {
    return getJimpPNG(this.getImageJimp());
  }

  getImageJimp() {
    return jimpFlipVertical(this.getImageJimpRaw());
  }

  getImageBitmap(): ImgBitMap {
    const { bitmap } = this.getImageJimp();
    return {
      data: bitmap.data.buffer as unknown as ArrayBuffer,
      width: bitmap.width,
      height: bitmap.height,
    };
  }

  getMixJimp(alphaTexture: Texture2D) {
    return jimpFlipVertical(this.getMixJimpRaw(alphaTexture));
  }

  getTransformedImageJimp(
    { downscaleMultiplier = 1, textureRect, textureRectOffset, settingsRaw }: TextureTransformedOptions,
    alphaTexture?: Texture2D,
    tightInfo?: SpriteTightInfo,
  ) {
    const img = alphaTexture ? this.getMixJimpRaw(alphaTexture) : this.getImageJimpRaw();

    if (downscaleMultiplier > 0 && downscaleMultiplier !== 1) {
      img.resize({
        w: img.width / downscaleMultiplier,
        h: img.height / downscaleMultiplier,
      });
    }

    img.crop({
      x: textureRect.x,
      y: textureRect.y,
      w: textureRect.w,
      h: textureRect.h,
    });

    if (settingsRaw?.packed === 1) {
      switch (settingsRaw.packingRotation) {
        case SpritePackingRotation.FlipHorizontal:
          jimpFlipHorizontal(img);
          break;
        case SpritePackingRotation.FlipVertical:
          jimpFlipVertical(img);
          break;
        case SpritePackingRotation.Rotate180:
          img.rotate(180);
          break;
        case SpritePackingRotation.Rotate90:
          img.rotate(270);
          break;
      }
    }

    if (settingsRaw?.packingMode === SpritePackingMode.Tight && tightInfo) {
      const { pixelsToUnits, pivot, spriteRect } = tightInfo;
      const triangles = tightInfo.getTriangles();
      if (triangles.length > 0) {
        // Transform triangle vertices from Unity local-space units to pixel
        // coordinates within the cropped image:
        //   Scale(pixelsToUnits) * Translate(rect.w * pivot.x - offset.x, rect.h * pivot.y - offset.y)
        //
        // Math.fround keeps intermediate results in float32 precision to match
        // the original data; without it, float32 values like -0.9 (stored as
        // -0.89999997...) multiplied in float64 produce -89.99999... instead
        // of -90, causing 1px clipping.
        const f = Math.fround;
        const tx = f(f(spriteRect.w * pivot.x) - (textureRectOffset?.x ?? 0));
        const ty = f(f(spriteRect.h * pivot.y) - (textureRectOffset?.y ?? 0));
        const trianglesPx = triangles.map(([v0, v1, v2]): [number, number, number, number, number, number] => [
          f(f(v0.x * pixelsToUnits) + tx),
          f(f(v0.y * pixelsToUnits) + ty),
          f(f(v1.x * pixelsToUnits) + tx),
          f(f(v1.y * pixelsToUnits) + ty),
          f(f(v2.x * pixelsToUnits) + tx),
          f(f(v2.y * pixelsToUnits) + ty),
        ]);
        img.applyTightMask(trianglesPx);
      }
    }

    jimpFlipVertical(img);

    return img;
  }

  private getImageJimpRaw() {
    return new Jimp({ data: Buffer.from(this.image.data), width: this.width, height: this.height });
  }

  private getMixJimpRaw(alphaTexture: Texture2D) {
    const cacheMap = this.bundle.textureMixCache;
    const key = `${this.pathId},${alphaTexture.pathId}`;
    const cached = cacheMap.get(key);
    if (cached) return cached.clone();

    const rgb = this.getImageJimpRaw();
    const alpha = alphaTexture.getImageJimpRaw();

    if (this.width !== alphaTexture.width || this.height !== alphaTexture.height) {
      alpha.resize({ w: this.width, h: this.height });
    }

    rgb.mixAlpha(alpha);

    cacheMap.set(key, rgb);

    return rgb.clone();
  }

  private readTextureSetting(r: ArrayBufferReader) {
    const { version } = this.__info;
    r.move(12);
    if (version[0] >= 2017) r.move(12);
    else r.move(4);
    if (this.__info.isArknightsEndfield()) r.move(4);
  }

  private readStreamInfo(r: ArrayBufferReader): StreamInfo {
    const { version } = this.__info;
    return {
      offset: version[0] >= 2020 ? Number(r.readUInt64()) : r.readUInt32(),
      size: r.readUInt32(),
      path: r.readAlignedString(),
    };
  }

  private readData(streamInfo: StreamInfo) {
    const sPath = last(streamInfo.path.split('/'))!;
    const index = this.bundle.nodes.findIndex(({ path }) => path === sPath);
    if (index === -1) throw new Error(`Cannot find node by path: ${sPath}`);
    const file = this.bundle.files[index];
    const r = new ArrayBufferReader(file);
    // 防御：外部 streamData 的 offset/size 超出该节点文件范围时（如损坏/被
    // 修改过的文件），返回空数据而非抛异常导致整个 Texture2D 解析失败。
    // 空数据会在后续解码/展示时自然降级，不会阻断其它资产加载。
    const end = streamInfo.offset + streamInfo.size;
    if (streamInfo.offset < 0 || end > r.length || streamInfo.size <= 0) {
      return new Uint8Array(0);
    }
    r.seek(streamInfo.offset);
    return r.readBuffer(streamInfo.size);
  }
}

class TextureDecoder {
  protected readonly __doNotDump = true;
  private decoded = false;

  constructor(
    private readonly texture: Texture2D,
    private rawData: Uint8Array<ArrayBuffer>,
  ) {}

  get data() {
    this.decodeImageData();
    return this.rawData;
  }

  private decodeImageData() {
    if (this.decoded) return;
    this.rawData = decodeTexture(
      this.rawData,
      this.texture.width,
      this.texture.height,
      this.texture.textureFormat,
      this.texture.name,
    );
    this.decoded = true;
  }
}
