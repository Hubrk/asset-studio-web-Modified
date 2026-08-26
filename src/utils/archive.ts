/**
 * 导入时自动展开压缩包：遇到 .zip 会先解压，把内部条目当作正常文件交给加载管线。
 * 这样「拖入一个 zip」等价于「拖入解压后的那一堆文件」。
 *
 * 设计要点：
 * - 非 zip 文件原样透传（快速路径：无 zip 时直接返回，零开销、不加载 jszip）
 * - zip 用 jszip 动态导入（仅当检测到 zip 时才加载，避免常驻包体）
 * - 解压失败的 zip 仍原样透传，避免单个坏包导致整批导入失败
 * - 支持一层嵌套 zip（如 zip 里又包了 zip），最多递归 MAX_DEPTH 层
 */
const ZIP_EXT = /\.zip$/i;
const MAX_DEPTH = 3;

export async function expandArchives(files: File[], depth = MAX_DEPTH): Promise<File[]> {
  if (!files.some((f) => ZIP_EXT.test(f.name))) return files;

  const JSZip = (await import('jszip')).default;
  const out: File[] = [];

  for (const file of files) {
    if (!ZIP_EXT.test(file.name)) {
      out.push(file);
      continue;
    }
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      for (const entry of entries) {
        const data = await entry.async('uint8array');
        const f = new File([data as unknown as BlobPart], entry.name);
        if (ZIP_EXT.test(entry.name) && depth > 1) {
          out.push(...(await expandArchives([f], depth - 1)));
        } else {
          out.push(f);
        }
      }
    } catch (err) {
      console.error(`[expandArchives] 无法解压 ${file.name}，已作为原文件透传:`, err);
      out.push(file);
    }
  }
  return out;
}
