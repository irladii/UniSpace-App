const { spawn } = require('child_process');
const electronPath = require('electron');
const path = require('path');

// strip run-as-node env
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log('[Launcher] Launching UniSpace desktop app...');
console.log('[Launcher] App Directory:', __dirname);

const child = spawn(electronPath, ['--no-sandbox', __dirname], {
  env,
  detached: true,
  stdio: 'ignore'
});

child.unref();
console.log('[Launcher] Application launched successfully.');
process.exit(0);
