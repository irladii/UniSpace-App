const fs = require('fs');
const path = require('path');

const SEARCH_LIMIT = 5;

const DEFAULT_CONFIG = {
  aiSearchCount: 0,
  isPremium: false,
  search_count: 0,
  is_pro: false,
  licenseKey: null,
  paypalOrderId: null,
  activatedAt: null,
  deviceLimit: 1
};

let memoryState = null;

// generate license key
function generateLicenseKey() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const seg = () => {
    let s = '';
    for (let i = 0; i < 4; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
  };
  return `UNISPACE-${seg()}-${seg()}-${seg()}`;
}

// config path resolver
function getConfigPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const userData = app.getPath('userData');
      if (!fs.existsSync(userData)) {
        fs.mkdirSync(userData, { recursive: true });
      }
      return path.join(userData, 'unispace_license.json');
    }
  } catch (err) {
    // app.getPath unavailable outside Electron lifecycle, using local fallback
  }

  const fallbackDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || __dirname, 'unispace');
  if (!fs.existsSync(fallbackDir)) {
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch (mkdirErr) {
      console.warn('[StateManager] Fallback directory creation note:', mkdirErr.message);
    }
  }
  return path.join(fallbackDir, 'unispace_license.json');
}

// load persisted state
function loadInitialState() {
  const configPath = getConfigPath();
  const candidates = [
    configPath,
    path.join(__dirname, '..', 'unispace_license.json'),
    path.join(__dirname, '..', 'config.json')
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        const count = typeof parsed.aiSearchCount === 'number'
          ? parsed.aiSearchCount
          : (typeof parsed.search_count === 'number' ? parsed.search_count : 0);
        const premium = typeof parsed.isPremium === 'boolean'
          ? parsed.isPremium
          : Boolean(parsed.is_pro);

        return {
          aiSearchCount: count,
          isPremium: premium,
          search_count: count,
          is_pro: premium,
          licenseKey: parsed.licenseKey || null,
          paypalOrderId: parsed.paypalOrderId || null,
          activatedAt: parsed.activatedAt || null,
          deviceLimit: parsed.deviceLimit || 1
        };
      }
    } catch (readErr) {
      // Candidate file absent or unparseable, evaluating next candidate
    }
  }
  return { ...DEFAULT_CONFIG };
}

// async state persistence
function persistStateAsync() {
  if (!memoryState) return;
  const configPath = getConfigPath();
  const count = Number(memoryState.aiSearchCount) || 0;
  const premium = Boolean(memoryState.isPremium);

  const payload = JSON.stringify({
    aiSearchCount: count,
    isPremium: premium,
    search_count: count,
    is_pro: premium,
    licenseKey: memoryState.licenseKey || null,
    paypalOrderId: memoryState.paypalOrderId || null,
    activatedAt: memoryState.activatedAt || null,
    deviceLimit: memoryState.deviceLimit || 1,
    updatedAt: new Date().toISOString()
  }, null, 2);

  fs.promises.writeFile(configPath, payload, 'utf-8').catch(err => {
    const localFallback = path.join(__dirname, '..', 'unispace_license.json');
    fs.promises.writeFile(localFallback, payload, 'utf-8').catch(fallbackErr => {
      console.warn('[StateManager] Fallback disk sync failed:', fallbackErr.message);
    });
  });
}

function ensureState() {
  if (!memoryState) {
    memoryState = loadInitialState();
  }
  return memoryState;
}

// quota lockout check
function isLockedOut() {
  const state = ensureState();
  if (state.isPremium) return false;
  return state.aiSearchCount >= SEARCH_LIMIT;
}

// increment search count
function incrementSearchCount() {
  const state = ensureState();
  if (!state.isPremium) {
    state.aiSearchCount = (state.aiSearchCount || 0) + 1;
    state.search_count = state.aiSearchCount;
    persistStateAsync();
  }
  return getState();
}

// pro tier upgrade
function upgradeToPro(details) {
  const state = ensureState();
  state.isPremium = true;
  state.is_pro = true;

  if (!state.licenseKey) {
    state.licenseKey = generateLicenseKey();
  }

  if (details) {
    state.paypalOrderId = details.id || details.orderID || state.paypalOrderId || ('SANDBOX-ORDER-' + Date.now());
  } else if (!state.paypalOrderId) {
    state.paypalOrderId = 'SANDBOX-ORDER-' + Date.now();
  }

  if (!state.activatedAt) {
    state.activatedAt = new Date().toISOString();
  }

  persistStateAsync();
  return getState();
}

// activate license key
function activateLicenseKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') {
    return { success: false, error: 'Please enter a valid License Key or PayPal Order ID.' };
  }

  const cleaned = rawKey.trim().toUpperCase();
  const isKeyPattern = /^UNISPACE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(cleaned);
  const isOrderId = /^(SANDBOX-|PAYID-|I-|ORD-)?[A-Z0-9_-]{8,35}$/i.test(cleaned);

  if (!isKeyPattern && !isOrderId) {
    return {
      success: false,
      error: 'Invalid format. Key must look like UNISPACE-XXXX-XXXX-XXXX or your PayPal Order ID.'
    };
  }

  const state = ensureState();
  state.isPremium = true;
  state.is_pro = true;
  state.licenseKey = isKeyPattern ? cleaned : (state.licenseKey || generateLicenseKey());
  state.paypalOrderId = isOrderId ? cleaned : (state.paypalOrderId || cleaned);
  state.activatedAt = new Date().toISOString();

  persistStateAsync();
  return { success: true, state: getState() };
}

// deactivate local license
function deactivateLicense() {
  const state = ensureState();
  state.isPremium = false;
  state.is_pro = false;
  state.licenseKey = null;
  state.paypalOrderId = null;
  state.activatedAt = null;

  persistStateAsync();
  return { success: true, state: getState() };
}

function setPremium(isPremium = true) {
  const state = ensureState();
  state.isPremium = Boolean(isPremium);
  state.is_pro = Boolean(isPremium);
  if (state.isPremium && !state.licenseKey) {
    state.licenseKey = generateLicenseKey();
    state.activatedAt = new Date().toISOString();
  }
  persistStateAsync();
  return getState();
}

function resetState() {
  memoryState = { ...DEFAULT_CONFIG };
  persistStateAsync();
  return getState();
}

// state snapshot
function getState() {
  const state = ensureState();
  const locked = isLockedOut();
  const remaining = state.isPremium ? Infinity : Math.max(0, SEARCH_LIMIT - state.aiSearchCount);

  return {
    aiSearchCount: state.aiSearchCount,
    isPremium: state.isPremium,
    search_count: state.aiSearchCount,
    is_pro: state.isPremium,
    search_limit: SEARCH_LIMIT,
    is_locked: locked,
    remaining,
    licenseKey: state.licenseKey || null,
    paypalOrderId: state.paypalOrderId || null,
    activatedAt: state.activatedAt || null,
    deviceLimit: state.deviceLimit || 1
  };
}

module.exports = {
  getState,
  isLockedOut,
  incrementSearchCount,
  upgradeToPro,
  activateLicenseKey,
  deactivateLicense,
  generateLicenseKey,
  setPremium,
  resetState,
  SEARCH_LIMIT
};
