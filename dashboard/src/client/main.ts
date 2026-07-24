import './style.css';
import { IntersectionScene } from './scene.js';
import { DashboardUI } from './ui.js';
import { byId } from './dom.js';
import { initRouter, onActivate } from './router.js';
import { activateNetwork } from './pages/network.js';
import { activateAnalytics } from './pages/analytics.js';
import { activateReports } from './pages/reports.js';
import type { DashboardPayload, Lane } from '../shared/types.js';

const sceneContainer = document.getElementById('scene-container');
if (!sceneContainer) throw new Error('missing #scene-container');

const scene = new IntersectionScene(sceneContainer);
const ui = new DashboardUI();

function connectSocket(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener('message', (ev) => {
    const payload = JSON.parse(ev.data) as DashboardPayload;
    ui.apply(payload);
    scene.updateState(payload.state);
  });

  ws.addEventListener('close', () => {
    ui.setConnectionState(false, false);
    setTimeout(connectSocket, 2000);
  });

  ws.addEventListener('error', () => ws.close());
}

connectSocket();

function setOverrideStatus(msg: string, kind: 'ok' | 'error' | '' = ''): void {
  const el = byId('override-status');
  el.textContent = msg;
  el.className = 'override-status' + (kind ? ` ${kind}` : '');
}

async function sendOverride(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setOverrideStatus(err.error ?? 'Request failed', 'error');
      return;
    }
    setOverrideStatus('Applied', 'ok');
  } catch {
    setOverrideStatus('Server unreachable', 'error');
  }
}

byId<HTMLButtonElement>('btn-emergency').addEventListener('click', () => {
  const lane = byId<HTMLSelectElement>('override-lane').value as Lane;
  void sendOverride({ action: 'emergency', lane });
});

byId<HTMLButtonElement>('btn-congestion').addEventListener('click', () => {
  const lane = byId<HTMLSelectElement>('override-lane').value as Lane;
  const level = Number(byId<HTMLSelectElement>('override-level').value);
  void sendOverride({ action: 'congestion', lane, level });
});

byId<HTMLButtonElement>('btn-reset').addEventListener('click', () => {
  void sendOverride({ action: 'reset' });
});

onActivate('network', () => void activateNetwork());
onActivate('analytics', () => void activateAnalytics());
onActivate('reports', () => void activateReports());
initRouter();
