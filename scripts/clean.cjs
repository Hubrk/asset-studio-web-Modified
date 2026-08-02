// Cross-platform clean - removes files/dirs using built-in Node fs.rm
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
for (const t of targets) {
  const abs = path.isAbsolute(t) ? t : path.join(ROOT, t);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
    console.log('Removed:', path.relative(ROOT, abs));
  }
}
