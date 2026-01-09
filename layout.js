export default function renderLayout({
  title,
  user,
  isAdmin,
  content,
  layoutClass = ''
}) {

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <link rel="stylesheet" href="/styles.css" />

  <!-- Leaflet (global, safe) -->
  <!-- Leaflet (global, safe) -->
<link
  rel="stylesheet"
  href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
/>
<script
  src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  defer
></script>
<!-- Leaflet JS -->
<script src="/icao-map.js"></script>
<script src="/wf-world-map.js"></script>
<script src="/socket.io/socket.io.js"></script>
<script src="/slot-banners.js" defer></script>


</head>

<body>

  <aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <img src="/logo.png" class="sidebar-logo" />
    <button id="sidebarToggle" class="sidebar-toggle" aria-label="Toggle sidebar">
  ☰
</button>


  </div>

  <nav class="sidebar-nav">
    <div class="nav-section">
      <div class="nav-title">Pilots</div>
      <a href="/dashboard" class="nav-item">
        <span class="icon">🏠</span>
        <span class="label">WF Schedule</span>
      </a>
      
      <a href="#" class="nav-item" id="openAirportPortal">
  <span class="icon">🛫</span>
  <span class="label">Airport Portal</span>
</a>

      
      <a href="/wf/world-map" class="nav-item">
        <span class="icon">🗺️</span>
        <span class="label">Route Map</span>
      </a>
      <a href="/my-slots" class="nav-item">
        <span class="icon">✈️</span>
        <span class="label">My Slots</span>
      </a>
    </div>

    <div class="nav-section">
      <div class="nav-title">Controllers</div>
      <a href="/atc" class="nav-item">
        <span class="icon">🎧</span>
        <span class="label">WF Slot Management</span>
      </a>
    </div>

    ${isAdmin ? `
    <div class="nav-section nav-admin">
      <div class="nav-title">Admin</div>
      <a href="/wf-schedule" class="nav-item">
        <span class="icon">🛠️</span>
        <span class="label">WF Schedule / Flow</span>
      </a>
      <a href="/official-teams" class="nav-item">
        <span class="icon">👥</span>
        <span class="label">Official Teams</span>
      </a>
      <a href="/admin/scenery" class="nav-item" id="sceneryNavItem">
  <span class="icon">🗺️</span>
  <span class="label">
    Scenery Submissions
    <span id="sceneryBadge" class="nav-badge hidden"></span>
  </span>
</a>

<a href="/admin/documentation-access" class="nav-item" id="docAccessNavItem">
  <span class="icon">📄</span>
  <span class="label">
    Doc Upload Perms
    <span id="docAccessBadge" class="nav-badge hidden"></span>
  </span>
</a>



    </div>
    ` : ''}
  </nav>
</aside>




  <!-- ===== TOPBAR ===== -->
  <header class="topbar">

  <div class="header-center">${title}</div>

  <div class="header-right">

  <div id="utcClock" class="utc-clock">00:00:00 UTC</div>

  ${user ? `
    <div class="user-menu">
      <button id="userMenuToggle" class="user-trigger">
        Welcome, ${user.personal?.name_full}
        <span class="chevron">▾</span>
      </button>

      <div id="userMenu" class="user-dropdown">
        <a href="/logout" class="logout-btn compact">
          <svg
            class="logout-icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 2v10" />
            <path d="M6.2 5.2a9 9 0 1 0 11.6 0" />
          </svg>
          <span class="logout-text">Logout</span>
        </a>
      </div>
    </div>
  ` : `
    <a href="/auth/login" class="login-btn">
      Login with VATSIM
    </a>
  `}
</div>

</header>


  <!-- ===== PAGE CONTENT ===== -->
  <main class="dashboard ${layoutClass}">
    ${content}
  </main>

     <!-- ===== CALLSIGN MODAL ===== -->
  <div id="callsignModal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-card card">
      <h3 id="modalTitle">Enter Callsign</h3>
<p id="modalHelp" class="modal-help">
        This callsign will be used for your TOBT and SimBrief planning.
      </p>

      <input
        id="callsignModalInput"
        type="text"
        placeholder="e.g. BAW47C"
        maxlength="10"
        autocomplete="off"
      />

      <div class="modal-actions">
        <button id="callsignCancel" class="action-btn">Cancel</button>
        <button id="callsignConfirm" class="action-btn primary">Confirm</button>
      </div>
    </div>
  </div>
<div id="airportPortalModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-dialog">
    <h3>Open Airport Portal</h3>

    <form id="airportPortalForm">
      <input
        type="text"
        id="airportPortalIcao"
        placeholder="Enter ICAO (e.g. EGCC)"
        maxlength="4"
        required
        autocomplete="off"
      />

      <div class="modal-actions">
        <button type="button" id="closeAirportPortal" class="modal-btn">
          Cancel
        </button>
        <button type="submit" class="modal-btn modal-btn-submit">
          Open
        </button>
      </div>
    </form>
  </div>
</div>
<!-- ===== UPLOAD DOCUMENTATION MODAL ===== -->
<div id="uploadDocModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-card card">
    <h3>Upload Airport Document</h3>

    <form id="uploadDocForm">
      <input type="hidden" id="uploadDocIcao" name="icao">

      <label>
    File name
    <input type="text" placeholder="Pilot Brief 2026" name="filename" required>
  </label>

  <label>
    File
    <input type="file" name="file" required>
  </label>

      <div class="modal-actions">
        <button
          type="button"
          id="uploadDocCancel"
          class="action-btn"
        >
          Cancel
        </button>

        <button
          type="submit"
          class="action-btn primary"
        >
          Upload
        </button>
      </div>
    </form>
  </div>
</div>




  <!-- ===== CALLSIGN MODAL LOGIC ===== -->
  <script>
    function openCallsignModal() {
      return new Promise(resolve => {
        const modal = document.getElementById('callsignModal');
        const input = document.getElementById('callsignModalInput');
        const confirm = document.getElementById('callsignConfirm');
        const cancel = document.getElementById('callsignCancel');

        modal.classList.remove('hidden');
        input.value = '';
        input.focus();

        function close(result) {
          modal.classList.add('hidden');
          confirm.removeEventListener('click', onConfirm);
          cancel.removeEventListener('click', onCancel);
          input.removeEventListener('keydown', onKey);
          resolve(result);
        }

        function onConfirm() {
          const value = input.value.trim().toUpperCase();
          if (!value) return;
          close(value);
        }

        function onCancel() {
          close(null);
        }

        function onKey(e) {
          if (e.key === 'Enter') onConfirm();
          if (e.key === 'Escape') onCancel();
        }

        confirm.addEventListener('click', onConfirm);
        cancel.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
      });
    }
  </script>

<script>
  function openConfirmModal({ title, message }) {
    return new Promise(resolve => {
      const modal = document.getElementById('callsignModal');
      const card = modal.querySelector('.modal-card');

      // Reuse existing elements
      const h3 = card.querySelector('h3');
      const help = card.querySelector('.modal-help');
      const input = document.getElementById('callsignModalInput');
      const confirm = document.getElementById('callsignConfirm');
      const cancel = document.getElementById('callsignCancel');

      // Set confirm content
      if (h3) h3.textContent = title || 'Confirm';
      if (help) help.textContent = message || '';

      // Hide input for confirmations
      input.style.display = 'none';

      modal.classList.remove('hidden');
      cancel.focus();

      function close(result) {
        modal.classList.add('hidden');
        input.style.display = ''; // restore
        confirm.removeEventListener('click', onConfirm);
        cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }

      function onConfirm() { close(true); }
      function onCancel() { close(false); }

      function onKey(e) {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      }

      confirm.addEventListener('click', onConfirm);
      cancel.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }
   </script>
<script>
function openConfirmModalAsync({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm }) {
  const modal = document.getElementById('callsignModal');
  const card = modal.querySelector('.modal-card');

  const h3 = card.querySelector('h3');
  const help = card.querySelector('.modal-help');
  const input = document.getElementById('callsignModalInput');
  const confirm = document.getElementById('callsignConfirm');
  const cancel = document.getElementById('callsignCancel');

  if (h3) h3.textContent = title || 'Confirm';
  if (help) help.textContent = message || '';

  // hide input for confirmations
  if (input) input.style.display = 'none';

  // reset buttons
  confirm.textContent = confirmText;
  cancel.textContent = cancelText;
  cancel.style.display = '';

  modal.classList.remove('hidden');

  function cleanup() {
    confirm.removeEventListener('click', onConfirmClick);
    cancel.removeEventListener('click', onCancelClick);
    document.removeEventListener('keydown', onKey);
    if (input) input.style.display = ''; // restore for callsign usage
  }

  function closeModal() {
    modal.classList.add('hidden');
    cleanup();
  }

  function showState(newTitle, newMessage, okText) {
    if (h3) h3.textContent = newTitle;
    if (help) help.textContent = newMessage;
    confirm.textContent = okText || 'OK';
    cancel.style.display = 'none';
  }

  async function onConfirmClick() {
    // prevent double-submit
    confirm.disabled = true;
    cancel.disabled = true;

    // optional: show sending state
    showState(title || 'Confirm', 'Submitting request...', 'Submitting...');

    try {
      const result = await onConfirm({
        set: (t, m) => showState(t, m, 'OK'),
        close: closeModal,
        showOk: (t, m) => {
          showState(t, m, 'OK');
          confirm.disabled = false;
          confirm.onclick = closeModal; // OK closes modal
        }
      });

      // If handler returns true/false and didn't explicitly showOk/close, default to OK-close
      if (result === true) {
        confirm.disabled = false;
        confirm.onclick = closeModal;
      } else if (result === false) {
        // allow retry
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.textContent = confirmText;
        cancel.style.display = '';
      }
    } catch (err) {
      // show error and allow retry
      if (h3) h3.textContent = 'Request failed';
      if (help) help.textContent = 'Unable to submit access request. Please try again.';
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = 'Retry';
      cancel.style.display = '';
    }
  }

  function onCancelClick() {
    closeModal();
  }

  function onKey(e) {
    if (e.key === 'Escape') onCancelClick();
  }

  confirm.onclick = null; // remove any prior inline onclick
  confirm.addEventListener('click', onConfirmClick);
  cancel.addEventListener('click', onCancelClick);
  document.addEventListener('keydown', onKey);
}
</script>





  <!-- existing scripts follow -->
  <script>
    (() => {
      const sidebar = document.getElementById('sidebar');
    })();
  </script>


  <script>
    (() => {
      const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');

  function setCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('sidebarCollapsed', collapsed);
  }

  // Restore previous state
  const saved = localStorage.getItem('sidebarCollapsed') === 'true';
  if (saved !== null) {
  setCollapsed(saved === 'true');
} else {
  setCollapsed(window.innerWidth < 900);
}


  toggle.addEventListener('click', () => {
    setCollapsed(!sidebar.classList.contains('collapsed'));
  });

  window.addEventListener('resize', () => {
    setCollapsed(window.innerWidth < 900);
  });
  // ===== USER MENU DROPDOWN =====
const userToggle = document.getElementById('userMenuToggle');
const userMenu = document.getElementById('userMenu');

if (userToggle && userMenu) {
  userToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    userMenu.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    userMenu.classList.remove('open');
  });
}

})();
</script>
<script>
(function () {
  function updateUtcClock() {
    const now = new Date();

    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');

    const el = document.getElementById('utcClock');
    if (el) {
      el.textContent = hh + ':' + mm + ':' + ss + ' UTC';
    }
  }

  updateUtcClock();
  setInterval(updateUtcClock, 1000);
})();
</script>
<script>
document.getElementById('refreshSceneryLinksBtn')?.addEventListener('click', async () => {
  const ok = confirm('Regenerate scenery links file from the current WF schedule?');
  if (!ok) return;

  const res = await fetch('/admin/scenery/refresh-links', { method: 'POST' });
  const data = await res.json();

  if (!res.ok || !data.success) {
    alert('Failed to refresh scenery links');
    return;
  }

  alert('Scenery links refreshed for ' + data.count + ' WF airports');
});
</script>

<script>
document.addEventListener('DOMContentLoaded', function () {
  const openBtn  = document.getElementById('openAirportPortal');
  const modal    = document.getElementById('airportPortalModal');
  const closeBtn = document.getElementById('closeAirportPortal');
  const form     = document.getElementById('airportPortalForm');
  const input    = document.getElementById('airportPortalIcao');

  if (!openBtn || !modal || !form || !input) return;

  function openModal() {
    modal.classList.remove('hidden');
    input.value = '';
    input.focus();
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  openBtn.addEventListener('click', function (e) {
    e.preventDefault();
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);

  var backdrop = modal.querySelector('.modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', closeModal);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var raw = input.value.trim().toUpperCase();
var icao = null;

// 3-letter US shorthand → assume K prefix
if (/^[A-Z]{3}$/.test(raw)) {
  icao = 'K' + raw;
}
// Full ICAO
else if (/^[A-Z]{4}$/.test(raw)) {
  icao = raw;
}
else {
  alert('Please enter a valid ICAO (e.g. LAX or KLAX)');
  return;
}

window.location.href = '/icao/' + icao;

  });
});
</script>




<div id="mapModal" class="modal map-modal hidden">

  <div class="map-modal-backdrop"></div>

  <div class="map-modal-panel">
    <div class="map-modal-header">
      <span id="mapModalTitle">Airport Map</span>
      <button id="closeMapModal" aria-label="Close map">✕</button>
    </div>

    <div class="icao-map">
      <div id="mapModalMap"></div>

      <!-- 🔑 ADD THIS BLOCK -->
      <div class="map-overlay-controls">
        <button
          id="toggleMapThemeBtnModal"
          class="map-overlay-btn"
          title="Toggle map theme"
          aria-label="Toggle map theme"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" class="theme-icon">
            <g class="sun">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
              <line x1="4.5" y1="4.5" x2="6.5" y2="6.5" />
              <line x1="17.5" y1="17.5" x2="19.5" y2="19.5" />
              <line x1="17.5" y1="6.5" x2="19.5" y2="4.5" />
              <line x1="4.5" y1="19.5" x2="6.5" y2="17.5" />
            </g>

            <path
              class="moon"
              d="M21 12.79A9 9 0 1111.21 3
                 7 7 0 0021 12.79z"
            />
          </svg>
        </button>
      </div>
    </div>
  </div>
</div>

<div id="flightPlanModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-card">
<div class="fp-strip">

  <!-- HEADER -->
  <div class="fp-strip-header">
  <div class="fp-callsign-group">
    <span class="fp-callsign" id="fpCallsign"></span>
    <span
  id="fpRouteWarning"
  class="fp-route-warning hidden"
  title="Filed route does not match WorldFlight ATC route"
  aria-label="Route mismatch warning"
>
  <svg
    class="fp-warning-icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    role="img"
    aria-hidden="true"
  >
    <path
      d="M12 2L1 22h22L12 2z"
      fill="currentColor"
    />
    <rect x="11" y="8" width="2" height="7" fill="#0b1220" />
    <rect x="11" y="17" width="2" height="2" fill="#0b1220" />
  </svg>
</span>

  </div>

  <span class="fp-aircraft" id="fpAircraft"></span>
  <span class="fp-status" id="fpStatus"></span>
</div>



  <!-- NAVIGATION / FILING -->
  <div class="fp-strip-row">
    <span class="fp-label">DEP</span>
    <span class="fp-value" id="fpDep"></span>

    <span class="fp-label">DEST</span>
    <span class="fp-value" id="fpDest"></span>
  </div>

  <div class="fp-strip-row">
  <span class="fp-label">RULES</span>
  <span class="fp-value" id="fpRules"></span>

  <span class="fp-label">REG</span>
  <span class="fp-value" id="fpReg"></span>
</div>

<div class="fp-strip-row">
  <span class="fp-label">A/C TYPE</span>
  <span class="fp-value" id="fpType"></span>
</div>


  <!-- PERFORMANCE -->
  <div class="fp-strip-row">
    <span class="fp-label">WAKE</span>
    <span class="fp-value" id="fpWake"></span>

    <span class="fp-label">CRZ LVL</span>
    <span class="fp-value" id="fpCruise"></span>
  </div>

  <div class="fp-strip-row">
    <span class="fp-label">TAS</span>
    <span class="fp-value" id="fpTasGs"></span>
  </div>

  <!-- PILOT -->
  <div class="fp-strip-row">
    <span class="fp-label">PILOT</span>
    <span class="fp-value" id="fpPilot"></span>
  </div>

  <div class="fp-strip-row">
    <span class="fp-label">CID</span>
    <span class="fp-value" id="fpCid"></span>
  </div>

  <!-- TIME -->
  <div class="fp-strip-row">
    <span class="fp-label">TOBT</span>
    <span class="fp-value" id="fpTobt"></span>

    <span class="fp-label">TSAT</span>
    <span class="fp-value" id="fpTsat"></span>
  </div>

  <!-- ROUTE (NORMAL) -->
  <div id="fpRouteNormalBlock" class="fp-route-block">
    <div class="fp-route-label">ATC ROUTE</div>
    <pre class="fp-route" id="fpRoute"></pre>
  </div>

  <!-- ROUTE (WF MISMATCH ONLY) -->
  <div id="fpRouteFiledBlock" class="fp-route-block hidden">
    <div class="fp-route-label">ATC ROUTE (FILED)</div>
    <pre class="fp-route" id="fpRouteFiled"></pre>

    <div class="fp-route-label">WF EVENT ROUTE (EXPECTED)</div>
    <pre class="fp-route" id="fpRouteWf"></pre>

    <div class="fp-route-alert">
  <span class="fp-route-alert-icon">⚠</span>
  <span class="fp-route-alert-text">
    WF ROUTE VALIDATION FAILED
  </span>
</div>

  </div>

  <!-- ACTIONS -->
  <div class="fp-actions">
    <button id="closeFpModal" class="fp-close">CLOSE</button>
  </div>

</div>

  </div>
</div>
<script>
async function openFlightPlanModal(callsign) {
  const res = await fetch('/api/atc/flight/' + callsign);
  if (!res.ok) return;

  const d = await res.json();

  document.getElementById('fpCallsign').textContent = d.callsign;
  const statusEl = document.getElementById('fpStatus');
statusEl.textContent = d.wfStatus;
statusEl.className = 'fp-status'; // reset
if (d.wfStatus === 'WF – BOOKED') {
  statusEl.classList.add('fp-status-booked');
}

  document.getElementById('fpAircraft').textContent = d.aircraft || '—';

  const tas = Number(d.filedTas);
  document.getElementById('fpTasGs').textContent =
    Number.isFinite(tas) && tas > 0 ? tas + ' / —' : '—';

  document.getElementById('fpDep').textContent = d.dep;
  document.getElementById('fpDest').textContent = d.dest;
  document.getElementById('fpCruise').textContent = d.cruiseLevel;

  document.getElementById('fpPilot').textContent = d.pilotName;
  document.getElementById('fpCid').textContent = d.pilotCid;

  document.getElementById('fpTobt').textContent = d.tobt;
  document.getElementById('fpTsat').textContent = d.tsat;

  const rulesMap = {
  I: 'IFR',
  V: 'VFR',
  S: 'SVFR'
};

const ruleCode = (d.flightRules || '').toUpperCase();

document.getElementById('fpRules').textContent =
  rulesMap[ruleCode] || ruleCode || '—';

  document.getElementById('fpReg').textContent = d.registration || '—';
  document.getElementById('fpType').textContent = d.aircraftType || '—';
  document.getElementById('fpWake').textContent = d.wake || '—';

  const normalBlock = document.getElementById('fpRouteNormalBlock');
  const filedBlock = document.getElementById('fpRouteFiledBlock');
  const warningIcon = document.getElementById('fpRouteWarning');

  if (d.wfStatus === 'WF – ROUTE') {
    normalBlock.classList.add('hidden');
    filedBlock.classList.remove('hidden');
    warningIcon.classList.remove('hidden');

   document.getElementById('fpRouteFiled').innerHTML = d.filedRoute;
document.getElementById('fpRouteWf').innerHTML = d.wfRoute;

  } else {
    filedBlock.classList.add('hidden');
    normalBlock.classList.remove('hidden');
    warningIcon.classList.add('hidden');

    document.getElementById('fpRoute').textContent = d.route;
  }

  // ✅ THIS MUST BE INSIDE THE FUNCTION
  document
    .getElementById('flightPlanModal')
    .classList.remove('hidden');
}
</script>

<script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#closeFpModal');
  if (!btn) return;

  const modal = document.getElementById('flightPlanModal');
  if (modal) {
    modal.classList.add('hidden');
  }
});
</script>
<script>
(async function updateSceneryBadge() {
  try {
    const res = await fetch('/api/admin/scenery/pending-count');
    if (!res.ok) return;

    const { count } = await res.json();
    const badge = document.getElementById('sceneryBadge');

    if (!badge) return;

    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    console.error('Failed to load scenery badge', err);
  }
})();
</script>
<script>
(async function updateDocAccessBadge() {
  try {
    const res = await fetch('/admin/api/documentation-access-requests/pending-count');
    if (!res.ok) return;

    const { count } = await res.json();
    const badge = document.getElementById('docAccessBadge');

    if (!badge) return;

    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (err) {
    console.error('Failed to load documentation access badge', err);
  }
})();

</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.book-slot-btn');
  if (!btn) return;

  const isArrival = btn.classList.contains('arrival');
  const isDeparture = btn.classList.contains('departure');

  const callsign = await openCallsignModal();
  if (!callsign) return;

  if (isArrival) {
    bookArrivalSlot(callsign);
  } else if (isDeparture) {
    bookDepartureSlot(callsign);
  }
});
</script>


</body>
</html>`;
}