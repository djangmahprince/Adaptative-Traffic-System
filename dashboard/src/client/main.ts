import './style.css';
import { IntersectionScene } from './scene.js';
import { DashboardUI } from './ui.js';
import type { DashboardPayload } from '../shared/types.js';

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
