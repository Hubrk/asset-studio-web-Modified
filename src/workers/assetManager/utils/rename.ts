import type { AssetExportItem } from '../loaders';

/** 重名文件去重后缀风格：foo (2).png 或 foo_2.png */
export type DuplicateNameStyle = 'paren' | 'underscore';

export class RenameProcessor {
  private readonly duplicateMap = new Map<string, number>();

  constructor(private readonly style: DuplicateNameStyle = 'paren') {}

  process(list: AssetExportItem[], prePath?: string) {
    prePath = prePath?.trim();
    return list.map(item => {
      const name = prePath ? `${prePath}/${item.name}` : item.name;
      const curTimes = this.duplicateMap.get(name) || 0;
      if (!curTimes) {
        this.duplicateMap.set(name, 1);
        return item;
      }
      const newName = this.rename(name, curTimes);
      this.duplicateMap.set(newName, curTimes + 1);
      return { ...item, name: newName };
    });
  }

  private rename(name: string, num: number) {
    const parts = name.split('.');
    if (parts.length === 1) return this.applyStyle(name, num);
    const ext = parts.pop();
    const baseName = parts.join('.');
    return `${this.applyStyle(baseName, num)}.${ext}`;
  }

  private applyStyle(baseName: string, num: number) {
    return this.style === 'paren' ? `${baseName} (${num})` : `${baseName}_${num}`;
  }
}
