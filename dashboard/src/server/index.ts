import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PythonBridge } from './bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5000);

const app = express();
const clientDist = path.join(__dirname, '../../dist/client');
app.use(express.static(clientDist));

const bridge = new PythonBridge();

app.get('/api/state', (_req, res) => {
  const { state, bridgeReachable } = bridge.current;
  res.json({ ...state, connected: state.connected && bridgeReachable });
});

app.get('/api/metrics', (_req, res) => {
  res.json(bridge.current.metrics);
});

app.get('/api/events', (_req, res) => {
  res.json(bridge.current.state.events);
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload: unknown) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(bridge.current));
});

bridge.on('update', (payload) => broadcast(payload));
bridge.start();

server.listen(PORT, () => {
  console.log('='.repeat(54));
  console.log('  AI Traffic Control — Dashboard (Node/TypeScript)');
  console.log(`  http://localhost:${PORT}`);
  console.log('  Reading state from Python bridge at');
  console.log(`  ${process.env.PYTHON_BRIDGE_URL ?? 'http://127.0.0.1:5051/api/state'}`);
  console.log('='.repeat(54));
});
