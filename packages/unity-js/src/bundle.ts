import { decompressLz4, decompressLzmaWithSize } from '@arkntools/unity-js-tools';
import { zip } from 'es-toolkit';
import { Asset } from './asset';
import type { AssetFile, AssetFileLoadOptions } from './assetFile';
import { BundleEnv, FileType, getFileType, Signature } from './assetFile';
import type { Jimp } from './lib/jimp';
import { concatArrayBuffer } from './utils/buffer';
import { loopEach } from './utils/loop';
import { ArrayBufferReader } from './utils/reader';
import { UnityCN } from './utils/unitycn';
import { ArrayBufferWriter } from './utils/writer';
import { isVersionLargerThanOrEqual, parseVersion } from './utils/version';
import { AssetType } from '.';
import type { AssetBundle, AssetObject } from '.';

export interface BundleHeader {
  signature: string;
  version: number;
  unityVersion: string;
  unityReversion: string;
  size: number;
  compressedBlocksInfoSize: number;
  uncompressedBlocksInfoSize: number;
  flags: number;
}

interface StorageBlock {
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
}

enum StorageBlockFlags {
  COMPRESSION_TYPE_MASK = 0x3f,
  STREAMED = 0x40,
}

interface StorageNode {
  offset: number;
  size: number;
  flags: number;
  path: string;
}

enum ArchiveFlags {
  COMPRESSION_TYPE_MASK = 0x3f,
  BLOCKS_AND_DIRECTORY_INFO_COMBINED = 0x40,
  BLOCKS_INFO_AT_THE_END = 0x80,
  OLD_WEB_PLUGIN_COMPATIBILITY = 0x100,
  BLOCK_INFO_NEED_PADDING_AT_START = 0x200,
  UNITY_CN_ENCRYPTION = 0x400,
}

enum CompressionType {
  NONE,
  LZMA,
  LZ4,
  LZ4_HC,
  CUSTOM_4,
  CUSTOM_5,
}

export class BundleFile implements AssetFile {
  readonly header: BundleHeader;
  readonly nodes: StorageNode[] = [];
  readonly files: ArrayBuffer[] = [];
  readonly objectMap = new Map<bigint, AssetObject>();
  readonly objects: AssetObject[];
  readonly textureMixCache = new Map<string, Jimp>();
  readonly containerMap?: Map<bigint, String>;
  private readonly blockInfos: StorageBlock[] = [];
  private unityCN?: UnityCN;

  constructor(
    r: ArrayBufferReader,
    readonly options?: AssetFileLoadOptions,
  ) {
    const signature = r.readStringUntilZero();
    const version = r.readUInt32BE();
    const unityVersion = r.readStringUntilZero();
    const unityReversion = r.readStringUntilZero();

    this.header = {
      signature,
      version,
      unityVersion,
      unityReversion,
      size: 0,
      compressedBlocksInfoSize: 0,
      uncompressedBlocksInfoSize: 0,
      flags: 0,
    };

    switch (signature) {
      case Signature.UNITY_FS:
        this.readHeader(r);
        if (this.options?.unityCNKey) {
          this.readUnityCN(r, this.options.unityCNKey);
        }
        this.readBlocksInfoAndDirectory(r);
        this.files.push(...this.readFiles(this.readBlocks(r)));
        break;

      default:
        throw new Error(`Unsupported bundle type: ${signature}`);
    }

    let assetBundle: AssetBundle | undefined;

    zip(this.files, this.nodes)
      .filter(([f]) => getFileType(f) === FileType.ASSETS_FILE)
      .flatMap(([f, n]) => {
        try {
          return new Asset(this, f, n.path).objects();
        } catch (e) {
          console.warn(`[BundleFile] failed to parse asset file (${n.path}):`, e instanceof Error ? e.message : e);
          return [];
        }
      })
      .forEach(obj => {
        this.objectMap.set(obj.pathId, obj);
        if (obj.type === AssetType.AssetBundle) assetBundle = obj;
      });
    this.objects = Array.from(this.objectMap.values());

    if (assetBundle) {
      this.containerMap = assetBundle.containerMap;
    }

    for (const obj of this.objects) {
      if (obj.type !== AssetType.SpriteAtlas) continue;
      const { renderDataMap, packedSprites } = obj;
      if (!renderDataMap.size) continue;
      for (const packedSprite of packedSprites) {
        const sprite = packedSprite.object;
        if (!sprite) continue;
        if (sprite.spriteAtlas?.isNull) {
          sprite.spriteAtlas.set(obj);
        }
      }
    }
  }

  getContainer(pathId: bigint): string {
    return this.containerMap?.get(pathId)?.toString() || '';
  }

  /**
   * Rebuild the UnityFS binary from the (possibly modified) files array.
   *
   * Strategy: preserve the original block/node structure from blockInfos,
   * but split the concatenated file data across the original number of blocks
   * (each with compression type NONE). This matches the output of standard
   * unpacking tools, which keep the original block count and only change each
   * block's compression from LZ4/LZ4HC to NONE.
   *
   * If blockInfos is empty (unexpected), falls back to a single-block layout.
   */
  rebuild(): ArrayBuffer {
    // 1. Concatenate all files into block data
    const blockData = concatArrayBuffer([...this.files]);

    // 2. Build blocksInfo (uncompressed), preserving original block count
    const origBlockCount = this.blockInfos.length;

    // Determine each block's uncompressed size:
    // - If we have original blockInfos, use their uncompressedSize (preserves
    //   the original split, e.g. 3 blocks for 3 segments of data).
    // - Otherwise, put everything in one block.
    const blockSizes: number[] = [];
    if (origBlockCount > 0) {
      let sumOrig = 0;
      for (const bi of this.blockInfos) {
        blockSizes.push(bi.uncompressedSize);
        sumOrig += bi.uncompressedSize;
      }
      // If file data total doesn't match original sum (e.g. modified), fall
      // back to single block to avoid misalignment.
      if (sumOrig !== blockData.byteLength) {
        blockSizes.length = 0;
        blockSizes.push(blockData.byteLength);
      }
    } else {
      blockSizes.push(blockData.byteLength);
    }

    const biWriter = new ArrayBufferWriter(64 + this.nodes.length * 64);
    // hash (16 bytes zero — already zero from ArrayBuffer init)
    biWriter.move(16);
    // block count
    biWriter.writeUInt32BE(blockSizes.length);
    // block entries: uncompressedSize, compressedSize (same, uncompressed), flags (NONE)
    for (let i = 0; i < blockSizes.length; i++) {
      const sz = blockSizes[i];
      biWriter.writeUInt32BE(sz);
      biWriter.writeUInt32BE(sz); // compressed == uncompressed (NONE)
      // Preserve the STREAMED flag from the original block, set compression to NONE
      const origFlags = origBlockCount > 0 ? this.blockInfos[i].flags : 0;
      const newBlockFlags = (origFlags & ~StorageBlockFlags.COMPRESSION_TYPE_MASK) | CompressionType.NONE;
      biWriter.writeUInt16BE(newBlockFlags);
    }
    // node entries
    biWriter.writeUInt32BE(this.nodes.length);
    let nodeOffset = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const fileSize = this.files[i].byteLength;
      biWriter.writeUInt64BE(BigInt(nodeOffset));
      biWriter.writeUInt64BE(BigInt(fileSize));
      biWriter.writeUInt32BE(node.flags);
      biWriter.writeStringUntilZero(node.path);
      nodeOffset += fileSize;
    }
    const blocksInfo = biWriter.getBuffer().slice(0, biWriter.position);

    // 3. Compute total size with proper alignment
    const headerBaseSize =
      this.header.signature.length +
      1 + // signature + null
      4 + // version
      this.header.unityVersion.length +
      1 + // unityVersion + null
      this.header.unityReversion.length +
      1 + // unityReversion + null
      8 + // size (u64)
      4 + // compressedBlocksInfoSize
      4 + // uncompressedBlocksInfoSize
      4; // flags
    const headerPaddedSize = Math.ceil(headerBaseSize / 16) * 16;

    const blocksInfoEnd = headerPaddedSize + blocksInfo.byteLength;
    let blockDataStart = blocksInfoEnd;
    // If BLOCK_INFO_NEED_PADDING_AT_START, align block data to 16
    const needPaddingAtStart = !!(this.header.flags & ArchiveFlags.BLOCK_INFO_NEED_PADDING_AT_START);
    if (needPaddingAtStart && blockDataStart % 16 !== 0) {
      blockDataStart = blockDataStart - (blockDataStart % 16) + 16;
    }
    const totalSize = blockDataStart + blockData.byteLength;

    // 4. Build the final UnityFS buffer
    const writer = new ArrayBufferWriter(totalSize);
    // header
    writer.writeStringUntilZero(this.header.signature);
    writer.writeUInt32BE(this.header.version);
    writer.writeStringUntilZero(this.header.unityVersion);
    writer.writeStringUntilZero(this.header.unityReversion);
    writer.writeUInt64BE(BigInt(totalSize));
    writer.writeUInt32BE(blocksInfo.byteLength); // compressedBlocksInfoSize
    writer.writeUInt32BE(blocksInfo.byteLength); // uncompressedBlocksInfoSize (same)
    // Keep high bits of flags, set blocksInfo compression to NONE
    const newFlags = this.header.flags & ~ArchiveFlags.COMPRESSION_TYPE_MASK;
    writer.writeUInt32BE(newFlags);
    // align header to 16
    writer.align(16);
    // blocksInfo
    writer.writeBuffer(blocksInfo);
    // padding before block data if needed
    if (needPaddingAtStart) writer.align(16);
    // block data (uncompressed)
    writer.writeBuffer(blockData);

    return writer.getBuffer();
  }

  private readHeader(r: ArrayBufferReader) {
    const { header } = this;

    header.size = Number(r.readUInt64BE());
    header.compressedBlocksInfoSize = r.readUInt32BE();
    header.uncompressedBlocksInfoSize = r.readUInt32BE();
    header.flags = r.readUInt32BE();
  }

  private readUnityCN(r: ArrayBufferReader, key: string) {
    let mask: ArchiveFlags;

    const version = parseVersion(this.header.unityReversion);
    if (
      version[0] < 2020 || // 2020 and earlier
      (version[0] === 2020 && version[1] === 3 && version[2] <= 34) || // 2020.3.34 and earlier
      (version[0] === 2021 && version[1] === 3 && version[2] <= 2) || // 2021.3.2 and earlier
      (version[0] === 2022 && version[1] === 3 && version[2] <= 1)
    ) {
      // 2022.3.1 and earlier
      mask = ArchiveFlags.BLOCK_INFO_NEED_PADDING_AT_START;
    } else {
      mask = ArchiveFlags.UNITY_CN_ENCRYPTION;
      throw new Error(`Unsupported unity reversion: ${this.header.unityReversion}`);
    }

    if (this.header.flags & mask) {
      this.unityCN = new UnityCN(r, key);
    }
  }

  private readBlocksInfoAndDirectory(r: ArrayBufferReader) {
    const { version, flags, compressedBlocksInfoSize, uncompressedBlocksInfoSize } = this.header;
    const blocksAtEnd = !!(flags & ArchiveFlags.BLOCKS_INFO_AT_THE_END);

    const reversion = parseVersion(this.header.unityReversion);

    // When blocksInfo is at the end, we don't need to align here —
    // block data starts right after the header (with alignment).
    if (!blocksAtEnd) {
      if (version >= 7) r.align(16);
      else if (isVersionLargerThanOrEqual(reversion, [2019, 4])) {
        const preAlign = r.position;
        const align = (16 - (preAlign % 16)) % 16;
        if (align) r.move(align);
      }
    }

    let blockInfoBuffer: ArrayBuffer;
    if (blocksAtEnd) {
      // blocksInfo is stored at the very end of the file
      const blocksInfoStart = r.length - compressedBlocksInfoSize;
      if (blocksInfoStart < 0) {
        throw new Error(
          `Invalid BLOCKS_INFO_AT_THE_END: file too small (${r.length}) for blocksInfo (${compressedBlocksInfoSize})`,
        );
      }
      r.seek(blocksInfoStart);
      blockInfoBuffer = r.readBuffer(compressedBlocksInfoSize);
    } else {
      blockInfoBuffer = r.readBuffer(compressedBlocksInfoSize);
      // BLOCK_INFO_NEED_PADDING_AT_START (0x200): block data must start at a
      // 16-byte aligned offset. readBlocksInfoAndDirectory 在读取 blocksInfo 后
      // 需要补齐对齐，使 reader.position 与 getBlockDataOffset() 计算一致。
      // 否则 readBlocks 会因 position != calcOffset 而读取错误的块数据起点，
      // 导致 LZ4 解压失败（如 "output too small" 错误）。
      if (flags & ArchiveFlags.BLOCK_INFO_NEED_PADDING_AT_START) {
        r.align(16);
      }
    }

    const compressionType = flags & ArchiveFlags.COMPRESSION_TYPE_MASK;

    const blockInfoUncompressedBuffer = this.decompressBuffer(
      blockInfoBuffer,
      compressionType,
      uncompressedBlocksInfoSize,
    );

    this.readBlocksInfo(blockInfoUncompressedBuffer);
  }

  private readBlocksInfo(blockInfo: ArrayBuffer) {
    const r = new ArrayBufferReader(blockInfo);
    // const uncompressedDataHash = r.readBuffer(16);
    r.move(16);

    loopEach(r.readInt32BE(), () => {
      this.blockInfos.push({
        uncompressedSize: r.readUInt32BE(),
        compressedSize: r.readUInt32BE(),
        flags: r.readUInt16BE(),
      });
    });

    loopEach(r.readInt32BE(), () => {
      this.nodes.push({
        offset: Number(r.readUInt64BE()),
        size: Number(r.readUInt64BE()),
        flags: r.readUInt32BE(),
        path: r.readStringUntilZero(),
      });
    });
  }

  /**
   * Calculate the file offset where block data begins.
   * Mirrors UABEA's AssetBundleHeader.GetFileDataOffset().
   */
  private getBlockDataOffset(): number {
    const { header } = this;
    // Header fields size: signature + \0 + version(4) + unityVersion + \0 + unityReversion + \0
    //                     + size(8) + compressedBlocksInfoSize(4) + uncompressedBlocksInfoSize(4) + flags(4)
    let offset =
      header.signature.length + 1 +
      4 +
      header.unityVersion.length + 1 +
      header.unityReversion.length + 1 +
      8 + 4 + 4 + 4;

    // Align header to 16 bytes (version >= 7)
    if (header.version >= 7) {
      offset = (offset + 15) & ~15;
    }

    // Add blocksInfo size (when not stored at end)
    if (!(header.flags & ArchiveFlags.BLOCKS_INFO_AT_THE_END)) {
      offset += header.compressedBlocksInfoSize;
    }

    // Align before block data if BLOCK_INFO_NEED_PADDING_AT_START (0x200)
    if (header.flags & ArchiveFlags.BLOCK_INFO_NEED_PADDING_AT_START) {
      offset = (offset + 15) & ~15;
    }

    return offset;
  }

  private readBlocks(r: ArrayBufferReader) {
    const blocksAtEnd = !!(this.header.flags & ArchiveFlags.BLOCKS_INFO_AT_THE_END);
    const calcOffset = this.getBlockDataOffset();

    if (blocksAtEnd) {
      // BLOCKS_INFO_AT_THE_END: readBlocksInfoAndDirectory 把 reader seek 到了文件尾部
      // 读 blocksInfo，不会自动回到头部 → 必须按计算偏移 seek 回块数据起点
      r.seek(calcOffset);
    } else if (calcOffset !== r.position) {
      // readBlocksInfoAndDirectory 已经按正确顺序走完 header → align → blocksInfo →
      // (BLOCK_INFO_NEED_PADDING_AT_START 对齐)，当前 reader.position 就是块数据起点。
      //
      // 对于 UnityCN bundle：getBlockDataOffset 无法还原 UnityCN 消费的 70 字节，
      // calcOffset 偏小，此时必须信任 reader.position，绝不能 seek 到 calcOffset
      // （会截掉块数据开头导致解压失败）。
      //
      // 对于非 UnityCN bundle：readBlocksInfoAndDirectory 补齐了对齐后，
      // reader.position 应与 calcOffset 一致。若仍不一致（异常情况），信任 reader.position。
      if (!this.unityCN) {
        console.warn(
          `[BundleFile] readBlocks: reader (${r.position}) != calcOffset (${calcOffset}), seeking to calcOffset`,
        );
        r.seek(calcOffset);
      } else {
        console.warn(
          `[BundleFile] readBlocks: UnityCN active, trust reader (${r.position}) over calcOffset (${calcOffset})`,
        );
      }
    }

    // Fast path: when all blocks are uncompressed and no per-block decryption
    // is needed, slice the remaining buffer directly. This mirrors UABEA's
    // SegmentStream approach (UnpackInfoOnly -> CompressionType.None branch)
    // and gracefully handles bundles whose declared block sizes do not exactly
    // match the file size (e.g. off-by-one trailing padding bytes).
    const allUncompressed = this.blockInfos.every(
      bi => (bi.flags & StorageBlockFlags.COMPRESSION_TYPE_MASK) === CompressionType.NONE,
    );
    if (allUncompressed && !this.unityCN) {
      return r.readBuffer(r.length - r.position);
    }

    // Slow path: read and decompress each block individually.
    const results: ArrayBuffer[] = [];
    for (const [i, { flags, compressedSize, uncompressedSize }] of this.blockInfos.entries()) {
      const compressionType = flags & StorageBlockFlags.COMPRESSION_TYPE_MASK;
      const compressedBuffer = r.readBuffer(compressedSize);
      if (this.unityCN && flags & 0x100) {
        this.unityCN.decryptBlock(compressedBuffer, i);
      }
      const uncompressedBuffer = this.decompressBuffer(
        compressedBuffer,
        compressionType,
        uncompressedSize,
      );
      results.push(uncompressedBuffer);
    }

    return concatArrayBuffer(results);
  }

  private readFiles(data: ArrayBuffer) {
    const r = new ArrayBufferReader(data);
    const files: ArrayBuffer[] = [];

    for (const { offset, size } of this.nodes) {
      r.seek(offset);
      files.push(r.readBuffer(size));
    }

    return files;
  }

  private decompressBuffer(
    data: ArrayBuffer,
    type: number,
    uncompressedSize?: number,
  ): ArrayBuffer {
    if (type === CompressionType.NONE) return data;

    if (!uncompressedSize) throw new Error('Uncompressed size not provided');

    switch (type) {
      case CompressionType.LZMA:
        return decompressLzmaWithSize(
          new Uint8Array(data),
          uncompressedSize,
        ) as unknown as ArrayBuffer;

      case CompressionType.LZ4:
      case CompressionType.LZ4_HC:
        return decompressLz4(new Uint8Array(data), uncompressedSize)
          .buffer as unknown as ArrayBuffer;
    }

    const isArknights = this.options?.env === BundleEnv.ARKNIGHTS;

    if (isArknights && (type === CompressionType.CUSTOM_4 || type === CompressionType.CUSTOM_5)) {
      return decompressArkLz4(data, uncompressedSize).buffer as unknown as ArrayBuffer;
    }

    throw new Error(`Unsupported compression type: ${CompressionType[type] || type}`);
  }
}

const readLongLengthNoCheck = (ip: Uint8Array<ArrayBuffer>, pos: number): [number, number] => {
  let b = 0;
  let l = 0;
  while (true) {
    b = ip[pos];
    pos++;
    l += b;
    if (b !== 255) break;
  }
  return [l, pos];
};

// From https://github.com/MooncellWiki/UnityPy by Kengxxiao
const decompressArkLz4 = (data: ArrayBuffer, uncompressedSize: number) => {
  const AK_LITERAL_LENGTH_MASK = ((1 << 4) - 1) & 0xff;
  const AK_MATCH_LENGTH_MASK = ~AK_LITERAL_LENGTH_MASK & 0xff;

  const fixedCompressedData = new Uint8Array(data);

  let ip = 0;
  let op = 0;

  while (true) {
    let literalLength = fixedCompressedData[ip] & AK_LITERAL_LENGTH_MASK;
    let matchLength = ((fixedCompressedData[ip] & AK_MATCH_LENGTH_MASK) >> 4) & 0xff;

    fixedCompressedData[ip] = ((literalLength << 4) | matchLength) & 0xff;
    ip++;

    if (literalLength === 15) {
      const [l, newIp] = readLongLengthNoCheck(fixedCompressedData, ip);
      literalLength += l;
      ip = newIp;
    }

    op += literalLength;
    ip += literalLength;

    if (uncompressedSize <= op) break;

    const offset = fixedCompressedData[ip + 1] | (fixedCompressedData[ip] << 8);
    fixedCompressedData[ip] = offset & 0xff;
    fixedCompressedData[ip + 1] = (offset >> 8) & 0xff;
    ip += 2;

    if (matchLength === 15) {
      const [m, newIp] = readLongLengthNoCheck(fixedCompressedData, ip);
      matchLength += m;
      ip = newIp;
    }

    matchLength += 4;
    op += matchLength;
  }

  return decompressLz4(fixedCompressedData, uncompressedSize);
};
