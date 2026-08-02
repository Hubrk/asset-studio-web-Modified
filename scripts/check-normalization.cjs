/* eslint-disable no-console */
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('public/models/removebg-1.6/universal/model.json', 'utf8'));
const nodes = m.modelTopology.node;

// 找归一化相关节点
const normNodes = nodes.filter((n) => {
  const name = (n.name || '').toLowerCase();
  const op = (n.op || '').toLowerCase();
  return op === 'sub' || op === 'div' || op === 'mean' || op === 'mul' || op === 'add'
    || name.includes('mean') || name.includes('norm') || name.includes('sub') || name.includes('div')
    || name.includes('normalize') || name.includes('preprocess');
});

console.log('Total nodes:', nodes.length);
console.log('Normalization related nodes:', normNodes.length);
normNodes.slice(0, 30).forEach((n) => {
  // 提取常量值
  let valInfo = '';
  if (n.attr && n.attr.value && n.attr.value.tensor) {
    const t = n.attr.value.tensor;
    valInfo = ` dtype=${t.dtype} shape=[${(t.tensorShape.dim || []).map(d => d.size).join(',')}]`;
    if (t.floatVal) valInfo += ` floatVal=${JSON.stringify(t.floatVal).substring(0, 100)}`;
    if (t.tensorContent) valInfo += ` hasContent`;
  }
  console.log(`  ${n.name} | op=${n.op}${valInfo}`);
});

// 找 input_image 的消费者
const inputConsumers = nodes.filter((n) => {
  return (n.input || []).some((i) => i.includes('input_image'));
});
console.log('\nNodes consuming input_image:', inputConsumers.length);
inputConsumers.slice(0, 10).forEach((n) => {
  console.log(`  ${n.name} | op=${n.op} | inputs=${JSON.stringify(n.input)}`);
});
