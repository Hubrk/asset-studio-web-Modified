/* eslint-disable no-console */
/**
 * 下载 Removebg 1.5 Fast ONNX 模型
 * URL: https://r.removebg.one/models/removebg-1.5/fast/inspyrenet-fast.onnx
 * 输入: 384x384, ONNX 格式, 约 412MB
 *
 * 运行：node scripts/download-removebg-1.5-fast.cjs
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_URL = 'https://r.removebg.one/models/removebg-1.5/fast/inspyrenet-fast.onnx';
const OUTPUT_DIR = path.resolve(__dirname, '../public/models/removebg-1.5/fast');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'inspyrenet-fast.onnx');

const HEADERS = {
  Referer: 'https://removebg.one',
  Origin: 'https://removebg.one',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
};

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let downloaded = 0;
    let total = 0;

    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      total = parseInt(res.headers['content-length'] || '0', 10);
      console.log(`总大小: ${(total / 1024 / 1024).toFixed(1)} MB`);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = ((downloaded / total) * 100).toFixed(1);
          process.stdout.write(`\r  下载进度: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n');
          resolve(fs.statSync(destPath).size);
        });
      });
    });

    req.on('error', (e) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(e);
    });

    req.setTimeout(300000, () => {
      req.destroy(new Error('下载超时'));
    });
  });
}

async function main() {
  console.log('=== Removebg 1.5 Fast ONNX 模型下载 ===');
  console.log(`URL: ${MODEL_URL}`);
  console.log(`输出: ${OUTPUT_FILE}`);

  // 创建目录
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 检查是否已存在
  if (fs.existsSync(OUTPUT_FILE)) {
    const size = fs.statSync(OUTPUT_FILE).size;
    console.log(`文件已存在 (${(size / 1024 / 1024).toFixed(1)} MB)`);
    if (size > 100 * 1024 * 1024) {
      console.log('文件大小正常，跳过下载');
      return;
    }
    console.log('文件大小异常，重新下载...');
    fs.unlinkSync(OUTPUT_FILE);
  }

  // 下载
  console.log('开始下载...');
  try {
    const size = await downloadFile(MODEL_URL, OUTPUT_FILE);
    console.log(`下载完成: ${(size / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) {
    console.error('\n下载失败:', e.message);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
