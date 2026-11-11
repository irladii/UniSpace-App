const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DEBUG_LOG = path.join(__dirname, '..', 'electron_debug.log');

// debug logger
function logDebug(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.promises.appendFile(DEBUG_LOG, line).catch(() => {});
}

process.on('uncaughtException', (err) => {
  logDebug(`Uncaught Exception: ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  logDebug(`Unhandled Rejection: ${reason}`);
});

try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch (err) {
  logDebug('Environment load note: ' + err.message);
}

logDebug('Main process starting...');

const stateManager = require('./stateManager');
const vfsManager = require('./vfsManager');
const aiEngine = require('./ai_engine');

let mainWindow = null;

// window setup
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 850,
    minHeight: 600,
    backgroundColor: '#0A0D14',
    title: 'UniSpace',
    icon: path.join(__dirname, 'assets', 'unispace-logo.jpg'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // popup window handler
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    logDebug('Window open requested for:', url);

    const isBlank = !url || url === 'about:blank' || url.startsWith('about:');
    const isPayPal = url.includes('paypal.com') || url.includes('paypalobjects.com') || url.includes('cardinalcommerce.com');

    if (isBlank || isPayPal) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          autoHideMenuBar: true
        }
      };
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {});
    }

    return { action: 'deny' };
  });

  // nested popup handler
  mainWindow.webContents.on('did-create-window', (childWindow, { url }) => {
    logDebug('PayPal checkout popup window created for URL:', url);

    childWindow.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      const isBlank = !childUrl || childUrl === 'about:blank' || childUrl.startsWith('about:');
      const isPayPal = childUrl.includes('paypal.com') || childUrl.includes('paypalobjects.com') || childUrl.includes('cardinalcommerce.com');
      if (isBlank || isPayPal) {
        return { action: 'allow' };
      }
      if (childUrl.startsWith('http://') || childUrl.startsWith('https://')) {
        shell.openExternal(childUrl).catch(() => {});
      }
      return { action: 'deny' };
    });
  });

  // navigation guard
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logDebug('Renderer index.html loaded successfully.');
  });

  logDebug('createWindow() called successfully.');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// directory cache
let cachedDirectoryTree = '';
let lastTreeScanTime = 0;
const TREE_CACHE_TTL_MS = 45000;

function invalidateTreeCache() {
  cachedDirectoryTree = '';
  lastTreeScanTime = 0;
}

// path probe
async function isAccessible(targetPath) {
  try {
    return await Promise.race([
      fs.promises.access(targetPath).then(() => true).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 300))
    ]);
  } catch {
    return false;
  }
}

// directory crawler
async function harvestFilesAsync(roots, maxFiles = 400, maxDepth = 3) {
  const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', '.git', '.gemini']);
  let totalFiles = 0;

  async function walkDir(dir, depth) {
    if (depth > maxDepth || totalFiles >= maxFiles) return '';
    let accumulated = '';

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const subdirs = [];

      for (const e of entries) {
        if (totalFiles >= maxFiles) break;
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;

        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          subdirs.push(fullPath);
        } else {
          accumulated += fullPath + '\n';
          totalFiles++;
        }
      }

      if (subdirs.length > 0 && depth < maxDepth && totalFiles < maxFiles) {
        const subResults = await Promise.all(
          subdirs.map(sub => walkDir(sub, depth + 1))
        );
        accumulated += subResults.join('');
      }
    } catch (walkErr) {
      logDebug(`Directory crawl note at ${dir}: ${walkErr.message}`);
    }

    return accumulated;
  }

  const rootResults = await Promise.all(roots.map(r => walkDir(r, 0)));
  return rootResults.join('');
}

// explorer file reveal
function safeRevealInExplorer(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return;
  const normalized = path.normalize(targetPath).trim();

  try {
    const shown = shell.showItemInFolder(normalized);
    if (shown) return;
  } catch (e) {
    logDebug(`shell.showItemInFolder note: ${e.message}`);
  }

  try {
    const safePath = normalized.replace(/["%^&]/g, '');
    const child = spawn('explorer.exe', [`/select,${safePath}`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (err) {
    logDebug(`spawn explorer error: ${err.message}`);
  }
}

// ipc handlers
function setupIpcHandlers() {
  ipcMain.handle('get-state', async () => {
    return stateManager.getState();
  });

  ipcMain.handle('upgrade-to-pro', async () => {
    return stateManager.upgradeToPro();
  });

  ipcMain.handle('confirm-premium-payment', async (event, paymentDetails) => {
    logDebug(`[PayPal Unlock] Payment approved: ${JSON.stringify(paymentDetails)}`);
    const updatedState = stateManager.upgradeToPro(paymentDetails);
    return updatedState;
  });

  ipcMain.handle('activate-license-key', async (event, rawKey) => {
    logDebug(`[License] Activating key: ${rawKey}`);
    return stateManager.activateLicenseKey(rawKey);
  });

  ipcMain.handle('deactivate-license', async () => {
    logDebug('[License] Deactivating license on this machine...');
    return stateManager.deactivateLicense();
  });

  ipcMain.handle('reset-state', async () => {
    return stateManager.resetState();
  });

  ipcMain.handle('get-drives-status', async () => {
    return vfsManager.getDrivesStatus();
  });

  ipcMain.handle('mount-drive', async (event, driveId) => {
    invalidateTreeCache();
    logDebug(`[mount-drive IPC] Initiating mount for ${driveId}...`);
    try {
      const res = await vfsManager.mountDrive(driveId);
      logDebug(`[mount-drive IPC] Successfully mounted ${driveId}: ${JSON.stringify(res)}`);
      return { success: true, ...res, drives: vfsManager.getDrivesStatus() };
    } catch (err) {
      logDebug(`[mount-drive IPC] Error mounting ${driveId}: ${err.message}`);
      return { success: false, error: err.message, drives: vfsManager.getDrivesStatus() };
    }
  });

  ipcMain.handle('unmount-drive', async (event, driveId) => {
    invalidateTreeCache();
    logDebug(`[unmount-drive IPC] Initiating unmount for ${driveId}...`);
    try {
      const res = await vfsManager.unmountDrive(driveId);
      logDebug(`[unmount-drive IPC] Successfully unmounted ${driveId}: ${JSON.stringify(res)}`);
      return { success: true, ...res, drives: vfsManager.getDrivesStatus() };
    } catch (err) {
      logDebug(`[unmount-drive IPC] Error unmounting ${driveId}: ${err.message}`);
      return { success: false, error: err.message, drives: vfsManager.getDrivesStatus() };
    }
  });

  ipcMain.handle('open-drive-in-explorer', async (event, driveId) => {
    const status = vfsManager.getDrivesStatus();
    const drive = status.find(d => d.id === driveId);
    if (drive && drive.mounted) {
      let root = drive.letter.endsWith('\\') ? drive.letter : `${drive.letter}\\`;
      if (!fs.existsSync(root)) {
        const demoDir = driveId === 'gdrive'
          ? path.join(__dirname, '..', 'demo_drives', 'GoogleDrive')
          : path.join(__dirname, '..', 'demo_drives', 'OneDrive');
        if (fs.existsSync(demoDir)) root = demoDir;
      }
      try {
        const child = spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', root], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        return { success: true };
      } catch (err) {
        logDebug(`open-drive-in-explorer error: ${err.message}`);
        return { success: false, error: err.message };
      }
    }
    return { success: false, error: 'Drive is not currently mounted.' };
  });

  // drive ready listener
  vfsManager.vfsEvents.on('drive-mounted', ({ driveId, letter, source }) => {
    logDebug(`[Warm-Up Lock] Unlocking Explorer button for ${driveId} (${source})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('drive-ready', {
        driveId,
        letter,
        reason: source
      });
    }
  });

  ipcMain.handle('reveal-file', async (event, filePath) => {
    safeRevealInExplorer(filePath);
    return true;
  });

  // search handler
  ipcMain.handle('search-files', async (event, query) => {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { success: false, error: 'Search query cannot be empty.' };
    }

    const currentState = stateManager.getState();

    // quota paywall gate
    if (!currentState.isPremium && currentState.aiSearchCount >= 5) {
      logDebug(`[Paywall] Blocked search for "${query.trim()}". Free quota exhausted (${currentState.aiSearchCount}/5). Emitting paywall-blocked.`);
      event.sender.send('paywall-blocked', {
        query: query.trim(),
        aiSearchCount: currentState.aiSearchCount,
        isPremium: false,
        message: 'Tired of manual searches? Upgrade for a $20 Lifetime License.'
      });
      return {
        success: false,
        paywallBlocked: true,
        locked: true,
        query: query.trim(),
        state: currentState
      };
    }

    const drivesStatus = vfsManager.getDrivesStatus();
    const anyMounted = drivesStatus.some(d => d.mounted);
    if (!anyMounted) {
      return {
        success: false,
        error: 'No drives mounted. Click "Mount Drive" on Google Drive or OneDrive first, then search.'
      };
    }

    try {
      let directoryTree = '';
      const now = Date.now();

      if (cachedDirectoryTree && (now - lastTreeScanTime < TREE_CACHE_TTL_MS)) {
        directoryTree = cachedDirectoryTree;
      } else {
        const demoG = path.join(__dirname, '..', 'demo_drives', 'GoogleDrive');
        const demoO = path.join(__dirname, '..', 'demo_drives', 'OneDrive');

        const roots = [];
        const gDriveMounted = drivesStatus.find(d => d.id === 'gdrive' && d.mounted);
        const oDriveMounted = drivesStatus.find(d => d.id === 'onedrive' && d.mounted);

        const [gRealOk, oRealOk, gDemoOk, oDemoOk] = await Promise.all([
          gDriveMounted ? isAccessible('G:\\') : Promise.resolve(false),
          oDriveMounted ? isAccessible('O:\\') : Promise.resolve(false),
          isAccessible(demoG),
          isAccessible(demoO)
        ]);

        if (gRealOk) roots.push('G:\\');
        else if (gDriveMounted && gDemoOk) roots.push(demoG);

        if (oRealOk) roots.push('O:\\');
        else if (oDriveMounted && oDemoOk) roots.push(demoO);

        if (roots.length === 0) {
          if (gDemoOk) roots.push(demoG);
          if (oDemoOk) roots.push(demoO);
        }

        directoryTree = await harvestFilesAsync(roots, 400, 3);

        if (directoryTree.trim()) {
          cachedDirectoryTree = directoryTree;
          lastTreeScanTime = now;
        }
      }

      if (!directoryTree.trim()) {
        return { success: false, error: 'No files found. Ensure your mounted drives have accessible files.' };
      }

      const result = await aiEngine.semanticSearch(query.trim(), directoryTree);
      const updatedState = stateManager.incrementSearchCount();

      if (result.matched) {
        setImmediate(() => {
          safeRevealInExplorer(result.path);
        });

        return { success: true, ...result, state: updatedState };
      }

      return { success: false, noMatch: true, reasoning: result.reasoning, state: updatedState };

    } catch (err) {
      logDebug(`[search-files] Error: ${err.stack || err.message}`);
      return { success: false, error: err.message };
    }
  });
}

// app lifecycle
app.whenReady().then(() => {
  logDebug('app.whenReady resolved! Initializing...');

  try {
    vfsManager.cleanupAll();
    vfsManager.clearGhostDriveMappings('G:');
    vfsManager.clearGhostDriveMappings('O:');
    vfsManager.clearGhostDriveMappings('Z:');
  } catch (err) {
    logDebug('Pre-flight ghost cleanup note: ' + err.message);
  }

  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  logDebug(`app.whenReady error: ${err.stack || err.message}`);
});

app.on('before-quit', () => {
  vfsManager.cleanupAll();
});

app.on('window-all-closed', () => {
  vfsManager.cleanupAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
