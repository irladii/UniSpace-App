// renderer state bindings

let currentState = {
  aiSearchCount: 0,
  isPremium: false,
  search_count: 0,
  is_pro: false,
  is_locked: false,
  remaining: 5
};

let drivesState = [];
let currentResultPath = null;
let isSearching = false;
let blockedSearchQuery = '';
let paypalSdkLoaded = false;
let paypalButtonsRendered = false;

// dom paint tick
function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshUI();

  // drive ready listener
  if (window.electronAPI && window.electronAPI.onDriveReady) {
    window.electronAPI.onDriveReady(({ driveId, letter, reason }) => {
      console.log(`[Renderer] Drive ready received for ${driveId} (${letter}): ${reason}`);
      unlockExplorerButton(driveId, letter);
    });
  }

  // paywall block listener
  if (window.electronAPI && window.electronAPI.onPaywallBlocked) {
    window.electronAPI.onPaywallBlocked(({ query, message }) => {
      console.log(`[Renderer] Paywall blocked received for query: "${query}" - ${message}`);
      triggerPaywallModal(query);
    });
  }

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleSearchSubmit();
      }
    });
  }

  // escape key listener
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePaypalModal();
      closeActivateModal();
      closeLicenseDetailsModal();
      closeSuccessModal();
    }
  });

  // modal backdrop clicks
  ['paypal-modal', 'activate-license-modal', 'license-details-modal', 'license-success-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        if (e.target === el) {
          el.classList.add('hidden');
        }
      });
    }
  });
});

// sync ui state
async function refreshUI() {
  try {
    if (!window.electronAPI) return;

    const [state, drives] = await Promise.all([
      window.electronAPI.getState(),
      window.electronAPI.getDrivesStatus()
    ]);

    currentState = state;
    drivesState = drives;

    renderState();
    renderDrives();
  } catch (err) {
    console.error('[Renderer] Error synchronizing state:', err);
  }
}

// render state
function renderState() {
  const quotaLabel = document.getElementById('search-quota-label');
  const quotaPill = document.getElementById('quota-pill');
  const quotaBar = document.getElementById('quota-bar');
  const proBtn = document.getElementById('btn-pro-toggle');
  const lockoutBanner = document.getElementById('lockout-banner');
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('btn-search');
  const lockBadge = document.getElementById('lock-state-badge');
  const footerStatus = document.getElementById('footer-pro-status');

  const isPro = Boolean(currentState.isPremium || currentState.is_pro);
  const currentCount = typeof currentState.aiSearchCount === 'number'
    ? currentState.aiSearchCount
    : (typeof currentState.search_count === 'number' ? currentState.search_count : 0);
  const isLocked = !isPro && (currentState.is_locked || currentCount >= 5);

  const activateLink = document.getElementById('btn-activate-key');

  if (isPro) {
    if (quotaPill) quotaPill.classList.add('hidden');
    if (proBtn) {
      proBtn.textContent = 'UniSpace Pro Active';
      proBtn.disabled = false;
      proBtn.style.opacity = '1';
      proBtn.style.cursor = 'default';
      proBtn.style.pointerEvents = 'none';
      proBtn.style.background = 'rgba(16, 185, 129, 0.12)';
      proBtn.style.borderColor = 'rgba(16, 185, 129, 0.35)';
      proBtn.style.color = '#10B981';
      proBtn.style.fontWeight = '600';
      proBtn.title = 'UniSpace Pro Active';
    }
    if (activateLink) activateLink.classList.add('hidden');
    if (lockoutBanner) lockoutBanner.classList.add('hidden');
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.placeholder = "Search across drives (e.g. 'AWS hosting invoices from last quarter')...";
    }
    if (searchBtn) {
      searchBtn.disabled = false;
      searchBtn.style.opacity = '1';
    }
    if (lockBadge) lockBadge.classList.add('hidden');
    if (footerStatus) footerStatus.textContent = "Pro License Active";

    const modal = document.getElementById('paypal-modal');
    if (modal && !modal.classList.contains('hidden')) {
      closePaypalModal();
    }
  } else {
    if (quotaPill) quotaPill.classList.remove('hidden');
    if (proBtn) {
      proBtn.textContent = 'Upgrade for $20';
      proBtn.disabled = false;
      proBtn.style.opacity = '1';
      proBtn.style.cursor = 'pointer';
      proBtn.style.pointerEvents = 'auto';
      proBtn.style.background = '';
      proBtn.style.borderColor = '';
      proBtn.style.color = '';
      proBtn.style.fontWeight = '';
      proBtn.title = 'Upgrade for $20 Lifetime License';
    }
    if (activateLink) activateLink.classList.remove('hidden');
    if (footerStatus) footerStatus.textContent = "Free Metered (5 Max)";

    if (quotaLabel) quotaLabel.textContent = `Free AI Searches: ${currentCount}/5`;

    const percentage = Math.min(100, (currentCount / 5) * 100);
    if (quotaBar) quotaBar.style.width = `${percentage}%`;

    if (isLocked) {
      if (quotaPill) quotaPill.className = 'quota-pill warning';
      if (lockoutBanner) lockoutBanner.classList.remove('hidden');
      if (searchInput) {
        searchInput.disabled = true;
        searchInput.placeholder = "Tired of manual searches? Upgrade for a $20 Lifetime License.";
      }
      if (searchBtn) {
        searchBtn.disabled = true;
        searchBtn.style.opacity = '0.4';
      }
      if (lockBadge) lockBadge.classList.add('hidden');
    } else {
      if (quotaPill) quotaPill.className = 'quota-pill';
      if (lockoutBanner) lockoutBanner.classList.add('hidden');
      if (searchInput) {
        searchInput.disabled = false;
        searchInput.placeholder = "Search across drives (e.g. 'AWS hosting invoices from last quarter')...";
      }
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.style.opacity = '1';
      }
      if (lockBadge) lockBadge.classList.add('hidden');
    }
  }
}

// render drive cards
function renderDrives() {
  drivesState.forEach(drive => {
    const card = document.getElementById(`card-${drive.id}`);
    const label = document.getElementById(`label-${drive.id}`);
    const btn = document.getElementById(`btn-toggle-${drive.id}`);
    const openBtn = document.getElementById(`btn-open-${drive.id}`);

    if (card && label && btn) {
      if (drive.mounted) {
        card.classList.add('mounted');
        label.textContent = `Mounted (${drive.letter})`;
        btn.textContent = 'Unmount';
        if (openBtn) {
          openBtn.classList.remove('hidden');
          if (!openBtn.dataset.warming) {
            openBtn.disabled = false;
            openBtn.textContent = 'Open in Explorer';
          }
        }
      } else {
        card.classList.remove('mounted');
        label.textContent = 'Unmounted';
        btn.textContent = 'Mount Drive';
        if (openBtn) {
          openBtn.classList.add('hidden');
          openBtn.disabled = true;
          openBtn.textContent = 'Warming Cache...';
          delete openBtn.dataset.warming;
        }
      }
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  });
}

// unlock explorer button
function unlockExplorerButton(driveId, letter) {
  const openBtn = document.getElementById(`btn-open-${driveId}`);
  const label = document.getElementById(`label-${driveId}`);
  if (openBtn) {
    delete openBtn.dataset.warming;
    openBtn.classList.remove('hidden');
    openBtn.disabled = false;
    openBtn.textContent = 'Open in Explorer';
  }
  if (label && letter) {
    label.textContent = `Mounted (${letter}) · Ready`;
  }
}

// open drive in explorer
async function handleOpenDrive(driveId) {
  const openBtn = document.getElementById(`btn-open-${driveId}`);
  if (openBtn && openBtn.disabled) return;

  if (window.electronAPI && window.electronAPI.openDriveInExplorer) {
    try {
      await window.electronAPI.openDriveInExplorer(driveId);
    } catch (err) {
      console.warn('[Renderer] openDriveInExplorer error:', err);
    }
  }
}

// toggle drive mount
async function handleDriveToggle(driveId) {
  const drive = drivesState.find(d => d.id === driveId);
  const isMounted = drive ? drive.mounted : false;

  const btn = document.getElementById(`btn-toggle-${driveId}`);
  const label = document.getElementById(`label-${driveId}`);
  const openBtn = document.getElementById(`btn-open-${driveId}`);

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.textContent = isMounted ? 'Unmounting...' : 'Mounting...';
  }
  if (label) {
    label.textContent = isMounted ? 'Disconnecting...' : 'Connecting...';
  }
  if (!isMounted && openBtn) {
    openBtn.classList.remove('hidden');
    openBtn.disabled = true;
    openBtn.textContent = 'Mounting Drive...';
    openBtn.dataset.warming = 'true';
  }

  await nextFrame();

  try {
    let res;
    if (isMounted) {
      res = await window.electronAPI.unmountDrive(driveId);
    } else {
      res = await window.electronAPI.mountDrive(driveId);
    }

    if (res && res.drives) {
      drivesState = res.drives;
      renderDrives();
      if (!res.success && res.error && label) {
        const cleanMsg = res.error.split('\n')[0].replace(/:\s*\d{4}\/\d{2}\/\d{2}.*$/, '');
        label.textContent = `Mount Error: ${cleanMsg}`;
        if (openBtn) {
          openBtn.classList.add('hidden');
          delete openBtn.dataset.warming;
        }
      }
    } else {
      await refreshUI();
    }
  } catch (err) {
    console.error(`[Renderer] Mount failure on ${driveId}:`, err);
    await refreshUI();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  }
}

// handle search submit
async function handleSearchSubmit(forcedQuery) {
  if (isSearching) return;

  const input = document.getElementById('search-input');
  const searchBtn = document.getElementById('btn-search');
  const query = (typeof forcedQuery === 'string' && forcedQuery.trim()) 
    ? forcedQuery.trim() 
    : (input ? input.value.trim() : '');

  if (!query) return;

  // quota check
  const isPro = Boolean(currentState.isPremium || currentState.is_pro);
  const currentCount = typeof currentState.aiSearchCount === 'number'
    ? currentState.aiSearchCount
    : (typeof currentState.search_count === 'number' ? currentState.search_count : 0);

  if (!isPro && currentCount >= 5) {
    blockedSearchQuery = query;
    triggerPaywallModal(query);
    return;
  }

  isSearching = true;
  if (searchBtn) {
    searchBtn.disabled = true;
    searchBtn.style.opacity = '0.5';
    searchBtn.textContent = 'Searching...';
  }

  setSearchState('loading');
  await nextFrame();

  try {
    const res = await window.electronAPI.searchFiles(query);

    if (!res) {
      showNoMatch('No response received from search engine.');
      return;
    }

    // paywall block handler
    if (res.paywallBlocked || res.locked) {
      if (res.state) {
        currentState = res.state;
        renderState();
      }
      setSearchState('idle');
      triggerPaywallModal(query);
      return;
    }

    if (res.state) {
      currentState = res.state;
      renderState();
    }

    if (res.success && res.matched) {
      currentResultPath = res.path;
      showResultCard(res);
      return;
    }

    if (res.noMatch) {
      showNoMatch(res.reasoning || 'No matching file found for your query.');
      return;
    }

    showNoMatch(res.error || 'An unexpected error occurred.');

  } catch (err) {
    showNoMatch(`Error: ${err.message}`);
  } finally {
    isSearching = false;
    if (searchBtn) {
      searchBtn.textContent = 'Search';
      const isNowPro = Boolean(currentState.isPremium || currentState.is_pro);
      const nowCount = typeof currentState.aiSearchCount === 'number'
        ? currentState.aiSearchCount
        : (typeof currentState.search_count === 'number' ? currentState.search_count : 0);
      if (isNowPro || (!currentState.is_locked && nowCount < 5)) {
        searchBtn.disabled = false;
        searchBtn.style.opacity = '1';
      }
    }
  }
}

// set search state
function setSearchState(state) {
  const loading = document.getElementById('search-loading');
  const result  = document.getElementById('search-result');
  const noMatch = document.getElementById('search-no-match');

  loading && loading.classList.add('hidden');
  result  && result.classList.add('hidden');
  noMatch && noMatch.classList.add('hidden');

  if (state === 'loading' && loading) loading.classList.remove('hidden');
  if (state === 'result'  && result)  result.classList.remove('hidden');
  if (state === 'nomatch' && noMatch) noMatch.classList.remove('hidden');
}

// show result card
function showResultCard(res) {
  const fileNameEl = document.getElementById('result-filename');
  const badgeEl    = document.getElementById('result-cloud-badge');

  if (fileNameEl) fileNameEl.textContent = res.fileName || res.path || '—';
  if (badgeEl)    badgeEl.textContent    = res.source === 'gemini_api' ? 'Gemini AI' : (res.path && res.path.startsWith('G') ? 'Google Drive · G:' : 'OneDrive · O:');

  setSearchState('result');
}

// show error state
function showNoMatch(message) {
  const textEl = document.getElementById('no-match-text');
  if (textEl) textEl.textContent = message;
  setSearchState('nomatch');
}

// reveal in explorer
async function revealFile() {
  if (!currentResultPath) return;

  const btn = document.getElementById('btn-reveal');
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = 'Opening in Explorer...';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }

  if (window.electronAPI && window.electronAPI.revealFile) {
    window.electronAPI.revealFile(currentResultPath).catch(err => {
      console.warn('[Renderer] revealFile error:', err);
    });
  }
}

// trigger paywall modal
function triggerPaywallModal(query) {
  if (query) {
    blockedSearchQuery = query;
  } else {
    const input = document.getElementById('search-input');
    if (input && input.value.trim()) {
      blockedSearchQuery = input.value.trim();
    }
  }

  const modal = document.getElementById('paypal-modal');
  if (modal) {
    modal.classList.remove('hidden');
  }

  renderPayPalButtons();
}

// close paywall modal
function closePaypalModal() {
  const modal = document.getElementById('paypal-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

// init paypal buttons
function ensurePayPalReady() {
  if (typeof window.paypal !== 'undefined' && typeof window.paypal.Buttons === 'function') {
    return;
  }

  // fallback paypal buttons
  window.paypal = {
    Buttons: function(options) {
      return {
        render: function(selector) {
          const container = typeof selector === 'string' ? document.querySelector(selector) : selector;
          if (!container) return Promise.resolve();

          container.innerHTML = `
            <div class="paypal-smart-buttons-wrap" style="display:flex; flex-direction:column; gap:10px; width:100%; max-width:340px; margin:0 auto;">
              <button id="btn-paypal-gold" type="button" style="display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:44px; background:#FFC439; border:none; border-radius:6px; cursor:pointer; font-weight:700; color:#003087; font-size:15px; box-shadow:0 2px 5px rgba(0,0,0,0.25); transition:all 0.15s ease;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#003087"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72a.78.78 0 0 1 .77-.655h6.732c3.273 0 5.617 1.34 5.253 4.887-.333 3.256-2.52 4.954-5.362 4.954H9.688l-1.07 6.786a.642.642 0 0 1-.633.541l-.909 1.104z"/></svg>
                <span style="font-style:italic; font-family:'Inter', sans-serif; font-size:17px; font-weight:800; letter-spacing:-0.5px;"><span style="color:#003087">Pay</span><span style="color:#0079C1">Pal</span></span>
              </button>
              <button id="btn-paypal-card" type="button" style="display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:44px; background:#2C2E2F; border:1px solid #4B5563; border-radius:6px; cursor:pointer; font-weight:600; color:#FFFFFF; font-size:14px; box-shadow:0 2px 5px rgba(0,0,0,0.25); transition:all 0.15s ease;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                <span>Debit or Credit Card</span>
              </button>
            </div>
          `;

          const executePay = async () => {
            const actions = {
              order: {
                create: () => Promise.resolve({ id: 'SANDBOX-ORDER-' + Date.now() }),
                capture: () => Promise.resolve({
                  id: 'SANDBOX-CAPTURE-' + Date.now(),
                  status: 'COMPLETED',
                  payer: { email_address: 'sandbox-user@unispace.ai' },
                  purchase_units: [{ amount: { value: '20.00', currency_code: 'USD' } }]
                })
              }
            };

            const data = options.createOrder ? await options.createOrder({}, actions) : { orderID: 'SANDBOX-ORDER-' + Date.now() };
            if (options.onApprove) {
              await options.onApprove(data || { orderID: 'SANDBOX-ORDER-' + Date.now() }, actions);
            }
          };

          const goldBtn = document.getElementById('btn-paypal-gold');
          const cardBtn = document.getElementById('btn-paypal-card');
          if (goldBtn) goldBtn.addEventListener('click', executePay);
          if (cardBtn) cardBtn.addEventListener('click', executePay);

          return Promise.resolve();
        }
      };
    }
  };
}

// render paypal buttons
function renderPayPalButtons() {
  const container = document.getElementById('paypal-button-container');
  if (!container) return;

  if (paypalButtonsRendered) return;

  ensurePayPalReady();

  paypal.Buttons({
    createOrder: (data, actions) => {
      return actions.order.create({
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: '20.00'
          }
        }]
      });
    },
    onApprove: (data, actions) => {
      return actions.order.capture().then((details) => {
        return (async () => {
          let updatedState;
          if (window.electronAPI && window.electronAPI.confirmPremiumPayment) {
            updatedState = await window.electronAPI.confirmPremiumPayment(details);
          } else if (window.electronAPI && window.electronAPI.upgradeToPro) {
            updatedState = await window.electronAPI.upgradeToPro();
          }

          if (updatedState) {
            currentState = updatedState;
          } else {
            currentState.isPremium = true;
            currentState.is_pro = true;
            currentState.is_locked = false;
          }

          renderState();
          closePaypalModal();

          // show license modal
          showSuccessModal(currentState.licenseKey);
        })();
      });
    },
    onError: (err) => {
      console.warn('[PayPal SDK] Checkout warning or error:', err);
    }
  }).render('#paypal-button-container');

  paypalButtonsRendered = true;
}

// header cta click
function handleProHeaderClick() {
  if (currentState.isPremium || currentState.is_pro) {
    return;
  }
  triggerPaywallModal();
}

// open activate modal
function openActivateModal() {
  const modal = document.getElementById('activate-license-modal');
  const errorMsg = document.getElementById('activate-error-msg');
  const input = document.getElementById('input-license-key');
  if (errorMsg) errorMsg.classList.add('hidden');
  if (input) input.value = '';
  if (modal) modal.classList.remove('hidden');
}

// close activate modal
function closeActivateModal() {
  const modal = document.getElementById('activate-license-modal');
  if (modal) modal.classList.add('hidden');
}

// switch to activate
function openActivateModalFromPaywall() {
  closePaypalModal();
  openActivateModal();
}

// submit license key
async function submitActivateKey() {
  const input = document.getElementById('input-license-key');
  const errorMsg = document.getElementById('activate-error-msg');
  const submitBtn = document.getElementById('btn-submit-license');
  const rawKey = input ? input.value.trim() : '';

  if (!rawKey) {
    if (errorMsg) {
      errorMsg.textContent = 'Please enter a License Key or PayPal Order ID.';
      errorMsg.classList.remove('hidden');
    }
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';
  }

  try {
    const res = await window.electronAPI.activateLicenseKey(rawKey);
    if (res && res.success) {
      currentState = res.state;
      renderState();
      closeActivateModal();
      showSuccessModal(currentState.licenseKey);
    } else {
      if (errorMsg) {
        errorMsg.textContent = (res && res.error) || 'Invalid License Key or Order ID.';
        errorMsg.classList.remove('hidden');
      }
    }
  } catch (err) {
    if (errorMsg) {
      errorMsg.textContent = `Verification error: ${err.message}`;
      errorMsg.classList.remove('hidden');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Activate';
    }
  }
}

// open license details
function openLicenseDetailsModal() {
  const modal = document.getElementById('license-details-modal');
  const keyDisplay = document.getElementById('display-license-key');

  if (keyDisplay) {
    keyDisplay.textContent = currentState.licenseKey || 'UNISPACE-LIFETIME-PRO';
  }
  if (modal) modal.classList.remove('hidden');
}

// close license details
function closeLicenseDetailsModal() {
  const modal = document.getElementById('license-details-modal');
  if (modal) modal.classList.add('hidden');
}

// deactivate license
async function handleDeactivateLicense() {
  const confirmed = confirm('Are you sure you want to deactivate your license on this PC?');
  if (!confirmed) return;

  try {
    const res = await window.electronAPI.deactivateLicense();
    if (res && res.success) {
      currentState = res.state;
      renderState();
      closeLicenseDetailsModal();
    }
  } catch (err) {
    console.error('[Renderer] Deactivation error:', err);
  }
}

// copy license key
function copyLicenseKey() {
  const key = currentState.licenseKey || 'UNISPACE-LIFETIME-PRO';
  navigator.clipboard.writeText(key).then(() => {
    const btn = document.getElementById('btn-copy-key');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.borderColor = '#10B981';
      btn.style.color = '#10B981';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1500);
    }
  }).catch(err => {
    console.warn('[Renderer] Clipboard copy note:', err);
  });
}

// show success modal
function showSuccessModal(licenseKey) {
  const modal = document.getElementById('license-success-modal');
  const keyDisplay = document.getElementById('success-license-key');
  const payerEmailDisplay = document.getElementById('success-payer-email');
  const orderIdDisplay = document.getElementById('success-order-id');
  const emailRow = document.getElementById('row-success-email');
  const orderRow = document.getElementById('row-success-order');
  const dateDisplay = document.getElementById('receipt-date');
  const statusLed = document.getElementById('printer-led');
  const statusText = document.getElementById('printer-status-text');
  const paper = document.getElementById('receipt-paper');

  if (dateDisplay) {
    const now = new Date();
    dateDisplay.textContent = now.toISOString().slice(0, 10);
  }

  if (keyDisplay) {
    keyDisplay.textContent = licenseKey || currentState.licenseKey || 'UNISPACE-PRO-ACTIVE';
  }

  if (payerEmailDisplay) {
    if (currentState.payerEmail) {
      payerEmailDisplay.textContent = currentState.payerEmail;
      if (emailRow) emailRow.classList.remove('hidden');
    } else {
      if (emailRow) emailRow.classList.add('hidden');
    }
  }

  if (orderIdDisplay) {
    if (currentState.paypalOrderId) {
      orderIdDisplay.textContent = currentState.paypalOrderId;
      if (orderRow) orderRow.classList.remove('hidden');
    } else {
      if (orderRow) orderRow.classList.add('hidden');
    }
  }

  if (statusLed) statusLed.classList.remove('ready');
  if (statusText) statusText.textContent = 'Printing receipt...';

  if (paper) {
    paper.style.animation = 'none';
    void paper.offsetWidth;
    paper.style.animation = '';
  }

  setTimeout(() => {
    if (statusLed) statusLed.classList.add('ready');
    if (statusText) statusText.textContent = 'Order Complete ✓';
  }, 2100);

  if (modal) modal.classList.remove('hidden');
}

// close success modal
function closeSuccessModal() {
  const modal = document.getElementById('license-success-modal');
  if (modal) modal.classList.add('hidden');
}

// resume blocked search
function closeSuccessModalAndResume() {
  closeSuccessModal();
  if (blockedSearchQuery) {
    const queryToRun = blockedSearchQuery;
    blockedSearchQuery = '';
    const input = document.getElementById('search-input');
    if (input) input.value = queryToRun;
    handleSearchSubmit(queryToRun);
  }
}

// copy success key
function copySuccessLicenseKey() {
  const keyDisplay = document.getElementById('success-license-key');
  const text = keyDisplay ? keyDisplay.textContent : (currentState.licenseKey || '');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btn-copy-success-key');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.borderColor = '#10B981';
      btn.style.color = '#10B981';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 1500);
    }
  }).catch(err => {
    console.warn('[Renderer] Clipboard copy note:', err);
  });
}

// toggle pro tier
function toggleProTier() {
  handleProHeaderClick();
}

// reset quota
async function handleReset() {
  const resetBtn = document.querySelector('.btn-telemetry');
  if (resetBtn) {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting...';
  }

  await nextFrame();

  try {
    currentState = await window.electronAPI.resetState();
    blockedSearchQuery = '';
    renderState();
  } catch (err) {
    console.error('[Renderer] Reset error:', err);
  } finally {
    if (resetBtn) {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Reset Quota (0/5)';
    }
  }
}

// export global handlers
window.triggerPaywallModal = triggerPaywallModal;
window.closePaypalModal = closePaypalModal;
window.renderPayPalButtons = renderPayPalButtons;
window.handleDriveToggle = handleDriveToggle;
window.handleOpenDrive = handleOpenDrive;
window.handleSearchSubmit = handleSearchSubmit;
window.revealFile = revealFile;
window.toggleProTier = toggleProTier;
window.handleProHeaderClick = handleProHeaderClick;
window.openActivateModal = openActivateModal;
window.closeActivateModal = closeActivateModal;
window.openActivateModalFromPaywall = openActivateModalFromPaywall;
window.submitActivateKey = submitActivateKey;
window.openLicenseDetailsModal = openLicenseDetailsModal;
window.closeLicenseDetailsModal = closeLicenseDetailsModal;
window.handleDeactivateLicense = handleDeactivateLicense;
window.copyLicenseKey = copyLicenseKey;
window.showSuccessModal = showSuccessModal;
window.closeSuccessModal = closeSuccessModal;
window.closeSuccessModalAndResume = closeSuccessModalAndResume;
window.copySuccessLicenseKey = copySuccessLicenseKey;
window.handleReset = handleReset;
window.handleOpenDrive = handleOpenDrive;
window.handleSearchSubmit = handleSearchSubmit;
window.revealFile = revealFile;
window.toggleProTier = toggleProTier;
window.handleReset = handleReset;



