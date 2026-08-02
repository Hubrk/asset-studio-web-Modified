// Cross-platform kill process listening on a given port
const { execSync } = require('child_process');
const port = process.argv[2];
if (!port) { console.error('Usage: node kill-port.cjs <port>'); process.exit(1); }
const isWin = process.platform === 'win32';
function run(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return ''; } }
let pid = null;
if (isWin) {
  const out = run(`netstat -ano | findstr :${port}`);
  const lines = out.split(/\r?\n/).filter(l => l.trim());
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) pid = parts[parts.length - 1];
  }
} else {
  pid = run(`lsof -ti:${port}`).trim();
}
if (!pid) { console.log('No process on port', port); process.exit(0); }
const pids = Array.from(new Set(pid.split(/\s+/).filter(Boolean)));
for (const id of pids) {
  console.log('Killing PID', id, 'on port', port);
  if (isWin) run(`taskkill /F /PID ${id}`);
  else run(`kill -9 ${id}`);
}
