/* eslint-disable no-console */
/**
 * 校验 Removebg 1.6 模型分片完整性
 * 用 HEAD 请求从服务器获取每个分片的 Content-Length，对比本地文件大小。
 *
 * 运行：node scripts/verify-removebg-model.cjs
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://r.removebg.one/models/removebg-1.6/universal';
const MODEL_DIR = path.resolve(__dirname, '../public/models/removebg-1.6/universal');
const MODEL_JSON = path.join(MODEL_DIR, 'model.json');

const HEADERS = {
  Referer: 'https://removebg.one',
  Origin: 'https://removebg.one',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
};

/** 用 HEAD 请求获取 Content-Length */
function getContentLength(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD', headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const len = parseInt(res.headers['content-length'] || '0', 10);
      resolve(len);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  console.log('=== 校验模型分片完整性（HEAD 请求对比 Content-Length）===\n');

  const modelJson = JSON.parse(fs.readFileSync(MODEL_JSON, 'utf8'));
  const manifest = modelJson.weightsManifest || [];
  const shards = new Set();
  for (const group of manifest) {
    for (const p of group.paths || []) shards.add(p);
  }
  const shardList = Array.from(shards).sort((a, b) => {
    const na = parseInt(a.match(/shard(\d+)of/)?.[1] || '0', 10);
    const nb = parseInt(b.match(/shard(\d+)of/)?.[1] || '0', 10);
    return na - nb;
  });

  console.log(`共 ${shardList.length} 个分片，逐个校验...\n`);

  let mismatchCount = 0;
  const mismatched = [];
  // 串行校验避免触发限速
  for (let i = 0; i < shardList.length; i++) {
    const name = shardList[i];
    const filePath = path.join(MODEL_DIR, name);
    let actualSize = 0;
    try {
      actualSize = fs.statSync(filePath).size;
    } catch {
      actualSize = -1;
    }
    let expectedSize = 0;
    try {
      expectedSize = await getContentLength(`${BASE_URL}/${name}`);
    } catch (e) {
      console.log(`  ? ${name}: 无法获取服务器大小 (${e.message})`);
      continue;
    }
    const match = actualSize === expectedSize;
    if (!match) {
      mismatchCount++;
      mismatched.push(name);
      console.log(
        `  ✗ ${name}: 服务器 ${(expectedSize / 1024).toFixed(1)} KB, 本地 ${
          actualSize > 0 ? (actualSize / 1024).toFixed(1) + ' KB' : '缺失'
        }`,
      );
    } else {
      // 只打印前几个和有问题的
      if (i < 3) {
        console.log(`  ✓ ${name}: ${(expectedSize / 1024).toFixed(1)} KB`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  if (mismatchCount === 0) {
    console.log('✓ 所有分片大小匹配，模型完整');
  } else {
    console.log(`✗ 发现 ${mismatchCount} 个分片大小不匹配：`);
    console.log(mismatched.join(', '));
    console.log('\n修复命令：');
    // 自动生成删除命令
    const delCmd = mismatched
      .map((n) => `Remove-Item "public\\models\\removebg-1.6\\universal\\${n}"`)
      .join('; ');
    console.log(`  ${delCmd}`);
    console.log('  node scripts/download-removebg-model.cjs');
  }
}

main().catch((e) => {
  console.error('校验失败:', e.message);
  process.exit(1);
});
