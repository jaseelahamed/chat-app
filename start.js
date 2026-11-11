const { spawn } = require('child_process');
const path = require('path');

const watchMode = process.argv.includes('--watch');
const backendPort = process.env.BACKEND_PORT || '5000';
const frontendPort = process.env.FRONTEND_PORT || '5173';

function launchService(name, cwd, script, port) {
  const args = watchMode ? ['--watch', script] : [script];
  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, cwd),
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: port
    }
  });

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[${name}] exited (${signal || code}). Stopping remaining service...`);
      shutdown(code || 1);
    }
  });

  return child;
}

let shuttingDown = false;
const children = [
  launchService('backend', 'backend', 'server.js', backendPort),
  launchService('frontend', 'frontend', 'server.js', frontendPort)
];

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

