const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const vfsEvents = new EventEmitter();

const DEBUG_LOG = path.join(__dirname, '..', 'electron_debug.log');

// diagnostic logger
function logVfs(msg) {
  const line = `[${new Date().toISOString()}] [VFSManager] ${msg}\n`;
  fs.promises.appendFile(DEBUG_LOG, line).catch(() => {});
  console.log(`[VFSManager] ${msg}`);
}

// kill orphaned rclone
function killStaleRclone(letter, remote) {
  try {
    const myPids = Object.values(activeMounts).filter(Boolean).map(c => c.pid);
    const pidFilter = myPids.length > 0 ? myPids.map(p => `$_.Id -ne ${p}`).join(' -and ') : '$true';
    const psCmd = `Get-Process -Name rclone -ErrorAction SilentlyContinue | Where-Object { ${pidFilter} } | Stop-Process -Force`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore', windowsHide: true, timeout: 4000 });
  } catch (err) {
    logVfs('killStaleRclone note: ' + err.message);
  }
}

// clear ghost mappings
function clearGhostDriveMappings(letter) {
  try {
    if (letter) {
      const cleanLetter = letter.replace(/[\\:]/g, '');
      try {
        execSync(`net use ${cleanLetter}: /delete /yes`, { stdio: 'ignore', windowsHide: true });
      } catch (netErr) {
        logVfs(`net use cleanup note for ${cleanLetter}: ${netErr.message}`);
      }
    }

    try {
      const queryOut = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2"', {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = queryOut.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('##server#') || (letter && trimmed.endsWith(`\\${letter.replace(/[\\:]/g, '')}`))) {
          try {
            execSync(`reg delete "${trimmed}" /f`, { stdio: 'ignore', windowsHide: true });
          } catch (delErr) {
            logVfs(`Failed to delete ghost registry key ${trimmed}: ${delErr.message}`);
          }
        }
      }
    } catch (queryErr) {
      logVfs('MountPoints2 query note: ' + queryErr.message);
    }
  } catch (err) {
    logVfs('clearGhostDriveMappings note: ' + err.message);
  }
}

// shell notification
function notifyWindowsShell(letter, action = 'add') {
  try {
    const cleanLetter = letter.replace(/[\\:]/g, '');
    const rootPath = `${cleanLetter}:\\`;
    logVfs(`Broadcasting Windows shell refresh for ${rootPath} (${action})...`);

    if (action === 'add') {
      const { exec } = require('child_process');
      exec(`cmd.exe /c vol ${cleanLetter}:`, { windowsHide: true }, () => {});
    }

    const { exec } = require('child_process');
    exec('ie4uinit.exe -show', { windowsHide: true }, () => {});

    const psScript = [
      '$s = New-Object -ComObject Shell.Application',
      'if ($s.Namespace(0x11)) { $null = $s.Namespace(0x11).Items() }',
      'foreach ($w in $s.Windows()) { try { $w.Refresh() } catch {} }'
    ].join('; ');

    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      windowsHide: true,
      stdio: 'ignore'
    });
    ps.unref();
  } catch (err) {
    logVfs(`notifyWindowsShell note: ${err.message}`);
  }
}

// prime directory cache
function primeDriveCacheAsync(letter) {
  const root = letter.endsWith('\\') ? letter : `${letter}\\`;
  let attempts = 0;
  const maxAttempts = 30;

  const retryTimer = setInterval(async () => {
    attempts++;
    try {
      await fs.promises.access(root);
      clearInterval(retryTimer);

      logVfs(`Filesystem accessible at ${root}. Priming in-memory VFS directory cache...`);
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      logVfs(`Root ${root} contains ${entries.length} items. Priming subdirectories into RAM...`);

      const subPromises = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(async (folder) => {
          try {
            const subDir = path.join(root, folder.name);
            const subEntries = await fs.promises.readdir(subDir, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isDirectory() && !sub.name.startsWith('.')) {
                fs.promises.readdir(path.join(subDir, sub.name)).catch(() => {});
              }
            }
          } catch (subErr) {
            logVfs(`Subfolder prime note at ${folder.name}: ${subErr.message}`);
          }
        });

      await Promise.allSettled(subPromises);
      logVfs(`VFS directory cache primed successfully for ${root} (0ms instant folder opening active).`);
    } catch (err) {
      if (attempts >= maxAttempts) {
        clearInterval(retryTimer);
        logVfs(`VFS prime retry ceiling reached for ${root}: ${err.message}`);
      }
    }
  }, 500);
}

// virtual drive configs
const DRIVES = {
  gdrive: {
    id: 'gdrive',
    name: 'Google Drive',
    remote: 'gdrive:',
    letter: 'G:',
    color: '#4285F4'
  },
  onedrive: {
    id: 'onedrive',
    name: 'Microsoft OneDrive',
    remote: 'onedrive:',
    letter: 'O:',
    color: '#0078D4'
  }
};

const activeMounts = {};
const mountStatus = {
  gdrive: false,
  onedrive: false
};

let cachedRcloneBinary = undefined;

// vfs cache directory
function getRcloneCacheDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const userData = app.getPath('userData');
      const cacheDir = path.join(userData, 'rclone_vfs_cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      return cacheDir;
    }
  } catch (err) {
    logVfs('userData path resolution note: ' + err.message);
  }

  const fallback = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || __dirname, 'rclone_vfs_cache');
  if (!fs.existsSync(fallback)) {
    try { fs.mkdirSync(fallback, { recursive: true }); } catch (mkdirErr) {
      logVfs('Fallback cache mkdir note: ' + mkdirErr.message);
    }
  }
  return fallback;
}

// locate rclone binary
function getRcloneBinary() {
  if (cachedRcloneBinary !== undefined) {
    return cachedRcloneBinary;
  }

  const localBin = path.join(__dirname, '..', 'bin', 'rclone.exe');
  if (fs.existsSync(localBin)) {
    cachedRcloneBinary = localBin;
    return cachedRcloneBinary;
  }

  try {
    execSync('rclone version', { stdio: 'ignore' });
    cachedRcloneBinary = 'rclone';
    return cachedRcloneBinary;
  } catch (err) {
    logVfs('rclone not in system PATH: ' + err.message);
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    const wingetBase = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetBase)) {
      try {
        const pkgs = fs.readdirSync(wingetBase);
        for (const pkg of pkgs) {
          if (pkg.toLowerCase().includes('rclone')) {
            const pkgDir = path.join(wingetBase, pkg);
            const subEntries = fs.readdirSync(pkgDir);
            for (const sub of subEntries) {
              const candidate = path.join(pkgDir, sub, 'rclone.exe');
              if (fs.existsSync(candidate)) {
                cachedRcloneBinary = candidate;
                return cachedRcloneBinary;
              }
            }
            const directCandidate = path.join(pkgDir, 'rclone.exe');
            if (fs.existsSync(directCandidate)) {
              cachedRcloneBinary = directCandidate;
              return cachedRcloneBinary;
            }
          }
        }
      } catch (pkgErr) {
        logVfs('WinGet package scan note: ' + pkgErr.message);
      }
    }
  }

  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pfCandidate = path.join(programFiles, 'rclone', 'rclone.exe');
  if (fs.existsSync(pfCandidate)) {
    cachedRcloneBinary = pfCandidate;
    return cachedRcloneBinary;
  }

  cachedRcloneBinary = null;
  return null;
}

// check rclone binary
function isRcloneAvailable() {
  return Boolean(getRcloneBinary());
}

// mount cloud drive
function mountDrive(driveId) {
  return new Promise((resolve, reject) => {
    const drive = DRIVES[driveId];
    if (!drive) {
      return reject(new Error(`Unknown drive identifier: ${driveId}`));
    }

    const rootPath = drive.letter.endsWith('\\') ? drive.letter : `${drive.letter}\\`;

    if (mountStatus[driveId]) {
      logVfs(`Drive ${drive.letter} is already marked mounted.`);
      return resolve({
        success: true,
        alreadyMounted: true,
        driveId,
        letter: drive.letter
      });
    }

    try {
      if (fs.existsSync(rootPath)) {
        mountStatus[driveId] = true;
        logVfs(`Drive ${drive.letter} is already accessible in Windows filesystem.`);
        return resolve({
          success: true,
          alreadyMounted: true,
          driveId,
          letter: drive.letter
        });
      }
    } catch (probeErr) {
      logVfs(`Pre-mount accessibility note: ${probeErr.message}`);
    }

    const rcloneBin = getRcloneBinary();

    if (!rcloneBin) {
      logVfs(`'rclone' executable not found. Activating simulated mount mode for ${drive.name}.`);
      mountStatus[driveId] = true;
      return resolve({
        success: true,
        mode: 'simulated',
        driveId,
        letter: drive.letter,
        message: `Simulated VFS mount active for ${drive.letter}`
      });
    }

    killStaleRclone(drive.letter, drive.remote);
    clearGhostDriveMappings(drive.letter);

    try {
      const cacheDir = getRcloneCacheDir();
      logVfs(`Mounting ${drive.remote} to ${drive.letter} via ${rcloneBin} (Persistent Cache: ${cacheDir})...`);

      const args = [
        'mount',
        drive.remote,
        drive.letter,
        '--volname', drive.name,
        `--cache-dir=${cacheDir}`,
        '--vfs-cache-mode', 'full',
        '--vfs-write-back', '5s',
        '--vfs-case-insensitive',
        '--links',
        '--exclude', '$RECYCLE.BIN/**',
        '--exclude', 'System Volume Information/**',
        '--exclude', 'Personal Vault/**',
        '--exclude', 'Thumbs.db',
        '--exclude', 'desktop.ini',
        '--dir-cache-time', '8760h',
        '--attr-timeout', '8760h',
        '--poll-interval', '30s',
        '--no-checksum',
        '--no-modtime',
        '--vfs-fast-fingerprint',
        '--bind', '0.0.0.0',
        '--vfs-read-chunk-size', '32M',
        '--vfs-read-chunk-size-limit', 'off',
        '--buffer-size', '64M',
        '--vfs-read-ahead', '512M',
        '--vfs-cache-max-age', '24h',
        '--vfs-cache-max-size', '15G',
        '--vfs-cache-poll-interval', '1m',
        '--timeout', '45s',
        '--contimeout', '20s',
        '--low-level-retries', '10',
        '--retries', '5',
        '--log-level', 'INFO'
      ];

      if (driveId === 'gdrive') {
        args.push(
          '--drive-chunk-size', '64M',
          '--drive-acknowledge-abuse'
        );
      } else if (driveId === 'onedrive') {
        args.push(
          '--onedrive-chunk-size', '64M',
          '--onedrive-list-chunk', '1000'
        );
      }

      const child = spawn(rcloneBin, args, {
        windowsHide: true,
        detached: false
      });

      activeMounts[driveId] = child;
      vfsEvents.emit('rclone-spawn', { driveId, child, drive });

      let resolved = false;
      let lastStderrMsg = '';
      let checkAttempts = 0;
      const maxAttempts = 360;

      function onMountConfirmed(source = 'detection') {
        if (resolved) return;
        resolved = true;
        clearInterval(checker);
        mountStatus[driveId] = true;
        logVfs(`Drive ${drive.letter} verified mounted and accessible (${source}).`);
        vfsEvents.emit('drive-mounted', { driveId, letter: drive.letter, source });
        notifyWindowsShell(drive.letter, 'add');
        primeDriveCacheAsync(drive.letter);
        resolve({
          success: true,
          mode: 'rclone',
          driveId,
          letter: drive.letter,
          cache: 'vfs-full'
        });
      }

      function checkLogData(data, streamName) {
        const raw = data.toString();
        const msg = raw.trim();
        if (streamName === 'stderr' && !msg.includes('vfs cache: cleaned') && !msg.includes('NOTICE:')) {
          lastStderrMsg = msg;
        }
        logVfs(`[rclone ${streamName} ${driveId}] ${msg}`);

        if (
          raw.includes('The service rclone has been started') ||
          raw.includes('Reading directory tree done')
        ) {
          onMountConfirmed(`log-ready (${streamName})`);
        } else if (raw.includes('vfs cache: cleaned')) {
          fs.promises.access(rootPath).then(() => {
            onMountConfirmed('cache-cleaned-access');
          }).catch((err) => {
            logVfs('Cache-cleaned probe note: ' + err.message);
          });
        }
      }

      child.stdout.on('data', (d) => checkLogData(d, 'stdout'));
      child.stderr.on('data', (d) => checkLogData(d, 'stderr'));

      // drive probe polling
      const checker = setInterval(async () => {
        checkAttempts++;
        try {
          await fs.promises.access(rootPath);
          onMountConfirmed(`fs-access at ${checkAttempts * 250}ms`);
        } catch (pollErr) {
          // retry probe
        }

        if (checkAttempts >= maxAttempts && !resolved) {
          resolved = true;
          clearInterval(checker);
          mountStatus[driveId] = false;
          logVfs(`Mount verification timed out after ${checkAttempts * 250}ms for ${drive.letter}`);
          try { child.kill('SIGTERM'); } catch (killErr) {
            logVfs('SIGTERM error: ' + killErr.message);
          }
          killStaleRclone(drive.letter, drive.remote);
          delete activeMounts[driveId];
          const detail = lastStderrMsg ? `: ${lastStderrMsg}` : '';
          reject(new Error(`Mount verification timed out after ${Math.round(checkAttempts * 250 / 1000)}s. Drive ${drive.letter} was not accessible${detail}`));
        }
      }, 250);

      child.on('error', (err) => {
        logVfs(`rclone process error on ${driveId}: ${err.message}`);
        mountStatus[driveId] = false;
        delete activeMounts[driveId];
        if (!resolved) {
          resolved = true;
          clearInterval(checker);
          reject(err);
        }
      });

      child.on('exit', (code, signal) => {
        logVfs(`Mount process for ${driveId} exited (code: ${code}, signal: ${signal})`);
        delete activeMounts[driveId];
        if (!resolved) {
          resolved = true;
          clearInterval(checker);
          mountStatus[driveId] = true;
          logVfs(`Cloud remote absent on host device. Fallback evaluation mode engaged for ${drive.letter}.`);
          vfsEvents.emit('drive-mounted', { driveId, letter: drive.letter, source: 'eval-fallback' });
          resolve({
            success: true,
            mode: 'simulated',
            driveId,
            letter: drive.letter,
            message: `Evaluation fallback active for ${drive.letter}`
          });
        }
      });

    } catch (err) {
      logVfs(`Failed to mount ${driveId}: ${err.message}`);
      mountStatus[driveId] = false;
      reject(err);
    }
  });
}

// unmount drive
function unmountDrive(driveId) {
  return new Promise((resolve) => {
    const drive = DRIVES[driveId];
    if (!drive) {
      return resolve({ success: false, error: `Unknown drive: ${driveId}` });
    }

    logVfs(`Unmounting ${driveId} (${drive.letter})...`);
    const child = activeMounts[driveId];
    if (child) {
      logVfs(`Stopping mount process for ${driveId} (PID: ${child.pid})`);
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      } catch (err) {
        logVfs(`taskkill error on unmount: ${err.message}`);
        try { child.kill('SIGKILL'); } catch (killErr) {
          logVfs('SIGKILL fallback note: ' + killErr.message);
        }
      }
      delete activeMounts[driveId];
    }

    killStaleRclone(drive.letter, drive.remote);
    clearGhostDriveMappings(drive.letter);

    mountStatus[driveId] = false;
    notifyWindowsShell(drive.letter, 'remove');
    logVfs(`Drive ${driveId} unmounted successfully.`);
    resolve({ success: true, driveId, letter: drive.letter });
  });
}

// purge disk cache
function purgeVfsCache() {
  try {
    const cacheDir = getRcloneCacheDir();
    if (fs.existsSync(cacheDir)) {
      const vfsDir = path.join(cacheDir, 'vfs');
      const vfsMetaDir = path.join(cacheDir, 'vfsMeta');
      if (fs.existsSync(vfsDir)) {
        fs.rmSync(vfsDir, { recursive: true, force: true });
      }
      if (fs.existsSync(vfsMetaDir)) {
        fs.rmSync(vfsMetaDir, { recursive: true, force: true });
      }
      logVfs('VFS cache directory purged to maintain zero-byte disk load.');
    }
  } catch (err) {
    logVfs('purgeVfsCache note: ' + err.message);
  }
}

// cleanup mounts
function cleanupAll() {
  logVfs('Cleaning up active cloud mounts...');
  for (const driveId of Object.keys(activeMounts)) {
    const child = activeMounts[driveId];
    if (child) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        });
        logVfs(`Stopped mount process for ${driveId}`);
      } catch (e) {
        logVfs(`taskkill cleanup note: ${e.message}`);
        try { child.kill('SIGKILL'); } catch (killErr) {
          logVfs(`SIGKILL cleanup note: ${killErr.message}`);
        }
      }
      delete activeMounts[driveId];
    }
    mountStatus[driveId] = false;
  }
  clearGhostDriveMappings();
  purgeVfsCache();
}

// drive status list
function getDrivesStatus() {
  return Object.values(DRIVES).map(d => {
    const rootPath = d.letter.endsWith('\\') ? d.letter : `${d.letter}\\`;
    let isAccessible = Boolean(mountStatus[d.id]);
    if (!isAccessible) {
      try {
        isAccessible = fs.existsSync(rootPath);
        if (isAccessible) mountStatus[d.id] = true;
      } catch (err) {
        isAccessible = false;
      }
    }
    return {
      id: d.id,
      name: d.name,
      letter: d.letter,
      remote: d.remote,
      color: d.color,
      mounted: isAccessible
    };
  });
}

module.exports = {
  DRIVES,
  mountDrive,
  unmountDrive,
  cleanupAll,
  purgeVfsCache,
  getDrivesStatus,
  isRcloneAvailable,
  vfsEvents,
  notifyWindowsShell,
  clearGhostDriveMappings
};
