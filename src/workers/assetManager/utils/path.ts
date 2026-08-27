/** 替换文件系统非法字符为下划线，与前端 src/utils/file.ts 规则保持一致 */
export const getLegalFileName = (name: string) => name.replace(/[/\\:*?"<>|]/g, '_');
