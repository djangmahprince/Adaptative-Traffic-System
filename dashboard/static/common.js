// Shared across all pages: header clock + connection/mode badges.
// Each page's own script (live.js/network.js/...) handles its own content.

function updateHeaderClock() {
  const now = new Date();
  const t = document.getElementById('header-time');
  const d = document.getElementById('header-date');
  if (t) t.textContent = now.toLocaleTimeString('en-GB', { hour12: false });
  if (d) d.textContent = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function setConnectionBadges(state) {
  const badge = document.getElementById('badge-connection');
  const text = document.getElementById('badge-connection-text');
  const mode = document.getElementById('badge-mode');
  if (badge && text) {
    badge.classList.toggle('connected', !!state.connected);
    text.textContent = state.connected ? 'ESP32 CONNECTED' : 'WAITING FOR ESP32';
  }
  if (mode) {
    if (state.source === 'simulator') {
      mode.textContent = 'SIMULATION MODE';
      mode.classList.remove('live');
    } else if (state.source === 'device') {
      mode.textContent = 'LIVE HARDWARE';
      mode.classList.add('live');
    } else {
      mode.textContent = 'NO SIGNAL';
      mode.classList.remove('live');
    }
  }
}

async function pollBadgesOnly() {
  try {
    const res = await fetch('/api/state');
    setConnectionBadges(await res.json());
  } catch {
    // page-specific pollers (live.js) surface connectivity errors; this is
    // just a background badge refresh for pages that don't poll /api/state themselves
  }
}

updateHeaderClock();
setInterval(updateHeaderClock, 1000);

// Only poll here if the current page hasn't already claimed responsibility
// for /api/state (live.js sets window.__handlesOwnState = true before this runs).
if (!window.__handlesOwnState) {
  pollBadgesOnly();
  setInterval(pollBadgesOnly, 2000);
}
