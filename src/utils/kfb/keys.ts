/**
 * KFB 容器 AES-256 密钥管理。
 *
 * - worker 侧：模块级可变数组，由主线程通过 setKfbKeys 同步（worker 无 localStorage）
 * - 主线程侧：localStorage 'kfbKeys' 持久化用户已验证的密钥，角色名 -> 64 位 hex
 *
 * 密钥格式：64 位十六进制字符串（32 字节 AES-256 key），一个角色一条。
 */
import { KFB_KEY_LIBRARY } from './kfbKeyLibrary';

export type KfbKeyEntry = { name: string; key: string };

let WORKER_USER_KEYS: string[] = [];

/** worker 侧：设置用户自定义密钥（自动匹配时内置库 + 用户库一起尝试） */
export function setKfbKeys(keys: string[]): void {
  WORKER_USER_KEYS = Array.isArray(keys) ? keys.slice() : [];
}

const DEDUP = new Set<string>();
/** worker 侧：读取当前可用密钥列表（内置库 + 用户库，去重） */
export function getKfbKeys(): string[] {
  DEDUP.clear();
  const out: string[] = [];
  for (const k of [...getKfbKeyLibrary(), ...WORKER_USER_KEYS]) {
    if (DEDUP.has(k)) continue;
    DEDUP.add(k);
    out.push(k);
  }
  return out;
}

let LIBRARY_CACHE: string[] | null = null;
/** 内置密钥库（懒加载缓存） */
export function getKfbKeyLibrary(): string[] {
  if (!LIBRARY_CACHE) LIBRARY_CACHE = KFB_KEY_LIBRARY.slice();
  return LIBRARY_CACHE;
}

const LS_KEY = 'kfbKeys';

/** 主线程侧：读取 localStorage 密钥库（[{name,key}]） */
export function loadKfbKeyLibrary(): KfbKeyEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.name === 'string' && typeof e.key === 'string');
  } catch {
    return [];
  }
}

/** 主线程侧：保存密钥库到 localStorage */
export function saveKfbKeyLibrary(entries: KfbKeyEntry[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // ignore quota/security errors
  }
}

/** 主线程侧：把密钥库条目提取为纯 key 字符串数组，供 worker 自动匹配 */
export function kfbKeyLibraryToKeyList(entries: KfbKeyEntry[]): string[] {
  return (entries || []).map((e) => e.key.trim()).filter((k) => k.length > 0);
}