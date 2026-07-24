import { byId } from '../dom.js';
import type { NetworkStats } from '../../shared/types.js';

export async function activateNetwork(): Promise<void> {
  try {
    const res = await fetch('/api/network');
    render(await res.json() as NetworkStats);
  } catch {
    byId('net-state').textContent = 'Unreachable';
    byId('net-source').textContent = 'Could not reach the dashboard server.';
  }
}

function render(data: NetworkStats): void {
  byId('net-dot').classList.toggle('connected', data.connected);
  byId('net-state').textContent = data.connected ? 'Connected' : 'Disconnected';
  byId('net-source').textContent = data.connected
    ? data.source === 'simulator'
      ? 'Simulator standing in for hardware (no physical ESP32 yet)'
      : 'Physical ESP32 hardware'
    : 'Waiting for a connection…';
  byId('net-last-update').textContent = data.last_update ?? '—';
  byId('net-connect-count').textContent = String(data.connect_count);
  byId('net-disconnect-count').textContent = String(data.disconnect_count);

  const log = byId('network-log');
  if (data.history.length === 0) {
    log.innerHTML = '<div class="event-item"><span class="event-msg">No connection events yet.</span></div>';
    return;
  }
  log.innerHTML = data.history
    .map((e) => `
      <div class="event-item">
        <span class="event-time">${e.time}</span>
        <span class="event-msg">${e.msg}</span>
      </div>
    `)
    .join('');
}
