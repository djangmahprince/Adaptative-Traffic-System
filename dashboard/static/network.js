async function loadNetwork() {
  try {
    const res = await fetch('/api/network');
    const data = await res.json();
    document.getElementById('net-dot').classList.toggle('connected', !!data.connected);
    document.getElementById('net-state').textContent = data.connected ? 'Connected' : 'Disconnected';
    document.getElementById('net-source').textContent = data.connected
      ? (data.source === 'simulator' ? 'Simulator standing in for hardware (no physical ESP32 yet)' : 'Physical ESP32 hardware')
      : 'Waiting for a connection…';
    document.getElementById('net-last-update').textContent = data.last_update || '—';
    document.getElementById('net-connect-count').textContent = data.connect_count;
    document.getElementById('net-disconnect-count').textContent = data.disconnect_count;

    const log = document.getElementById('network-log');
    if (!data.history.length) {
      log.innerHTML = '<div class="event-log-row"><span class="m">No connection events yet.</span></div>';
      return;
    }
    log.innerHTML = data.history.map((e) => `
      <div class="event-log-row"><span class="t">${e.time}</span><span class="m">${e.msg}</span></div>
    `).join('');
  } catch {
    document.getElementById('net-state').textContent = 'Unreachable';
  }
}

loadNetwork();
setInterval(loadNetwork, 3000);
