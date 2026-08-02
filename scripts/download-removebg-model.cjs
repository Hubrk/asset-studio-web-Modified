/* eslint-disable no-console */
/**
 * 一次性下载脚本：从 r.removebg.one 下载 Removebg 1.6 TF.js 模型到本地 public 目录
 *
 * 运行：node scripts/download-removebg-model.cjs
 *
 * 原因：r.removebg.one 有 Cloudflare 校验，要求 Referer: https://removebg.one。
 *       浏览器里无法手动设置 Referer 头，所以用 Node.js 下载后本地托管。
 *       模型共 49 个权重分片（group1-shard1of49.bin ~ group1-shard49of49.bin），约 196MB。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://r.removebg.one/models/removebg-1.6/universal';
const OUTPUT_DIR = path.resolve(__dirname, '../public/models/removebg-1.6/universal');
const CONCURRENCY = 12; // 并发下载数

const HEADERS = {
  Referer: 'https://removebg.one',
  Origin: 'https://removebg.one',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
};

/** 下载单个 URL 到文件，返回字节数。下载后验证 Content-Length，不匹配则重试 */
async function download(url, destPath, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const size = await downloadOnce(url, destPath);
      // 验证 Content-Length
      const expected = await getContentLength(url);
      if (expected > 0 && size !== expected) {
        fs.unlinkSync(destPath);
        throw new Error(`大小不匹配: 实际 ${size}, 预期 ${expected}`);
      }
      return size;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

/** 获取服务器 Content-Length */
function getContentLength(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HEAD HTTP ${res.statusCode}`));
        return;
      }
      resolve(parseInt(res.headers['content-length'] || '0', 10));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** 单次下载 */
function downloadOnce(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          resolve(fs.statSync(destPath).size);
        });
      });
    });
    req.on('error', (e) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(e);
    });
    req.setTimeout(120000, () => {
      req.destroy(new Error(`timeout for ${url}`));
    });
  });
}

/** 限制并发数的池 */
async function pool(items, worker, concurrency) {
  const queue = items.map((item, idx) => ({ item, idx }));
  const results = new Array(items.length);
  let completed = 0;
  const total = items.length;
  async function run() {
    while (queue.length) {
      const { item, idx } = queue.shift();
      try {
        results[idx] = await worker(item, idx);
      } catch (e) {
        results[idx] = { error: e.message };
      }
      completed++;
      const pct = ((completed / total) * 100).toFixed(1);
      process.stdout.write(`\r  进度: ${completed}/${total} (${pct}%)`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  process.stdout.write('\n');
  return results;
}

async function main() {
  console.log('=== Removebg 1.6 模型下载工具 ===');
  console.log(`输出目录: ${OUTPUT_DIR}`);

  // 创建目录
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 1. 下载 model.json
  const modelJsonPath = path.join(OUTPUT_DIR, 'model.json');
  if (fs.existsSync(modelJsonPath)) {
    console.log('  model.json 已存在，跳过');
  } else {
    console.log('  下载 model.json ...');
    await download(`${BASE_URL}/model.json`, modelJsonPath);
    console.log(`  ✓ model.json (${fs.statSync(modelJsonPath).size} bytes)`);
  }

  // 2. 解析 model.json 获取分片列表
  const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
  const shards = [];
  for (const group of modelJson.weightsManifest || []) {
    for (const p of group.paths || []) {
      shards.push(p);
    }
  }
  console.log(`  发现 ${shards.length} 个权重分片`);

  // 3. 过滤已下载的
  const toDownload = shards.filter((name) => {
    const p = path.join(OUTPUT_DIR, name);
    return !fs.existsSync(p);
  });
  if (toDownload.length === 0) {
    console.log('  所有分片已存在，跳过下载');
  } else {
    console.log(`  需下载 ${toDownload.length} 个分片，并发 ${CONCURRENCY} ...`);
    let totalBytes = 0;
    let failed = 0;
    await pool(
      toDownload,
      async (name) => {
        const size = await download(`${BASE_URL}/${name}`, path.join(OUTPUT_DIR, name));
        totalBytes += size;
      },
      CONCURRENCY,
    );
    // 检查失败
    for (const name of toDownload) {
      const p = path.join(OUTPUT_DIR, name);
      if (!fs.existsSync(p)) failed++;
    }
    console.log(`  下载完成: ${(totalBytes / 1024 / 1024).toFixed(1)} MB${failed ? `, 失败 ${failed} 个` : ''}`);
  }

  // 4. 校验
  const files = fs.readdirSync(OUTPUT_DIR);
  console.log(`\n完成！目录包含 ${files.length} 个文件:`);
  console.log(`  ${OUTPUT_DIR}`);
  console.log('  文件列表:', files.slice(0, 5).join(', '), files.length > 5 ? `... 共 ${files.length} 个` : '');
}

main().catch((e) => {
  console.error('\n下载失败:', e.message);
  process.exit(1);
});
