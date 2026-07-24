import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PythonBridge } from './bridge.js';
import { PYTHON_BRIDGE_BASE } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5000);

const app = express();
app.use(express.json());
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

/** Forwards a GET straight through to the Python bridge, query string
 * included. Used for endpoints backed by SQLite history rather than the
 * live in-memory state (which is already served above from bridge.current). */
function proxyGet(pythonPath: string) {
  return async (req: Request, res: Response) => {
    try {
      const url = new URL(pythonPath, PYTHON_BRIDGE_BASE);
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') url.searchParams.set(key, value);
      }
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = await r.json();
      res.status(r.status).json(body);
    } catch {
      res.status(502).json({ error: 'python bridge unreachable' });
    }
  };
}

app.get('/api/history', proxyGet('/api/history'));
app.get('/api/events/log', proxyGet('/api/events'));
app.get('/api/network', proxyGet('/api/network'));
app.get('/api/reports/summary', proxyGet('/api/reports/summary'));
app.get('/api/model', proxyGet('/api/model'));

app.post('/api/override', async (req, res) => {
  try {
    const r = await fetch(`${PYTHON_BRIDGE_BASE}/api/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(3000),
    });
    res.status(r.status).json(await r.json());
  } catch {
    res.status(502).json({ error: 'python bridge unreachable' });
  }
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
  console.log(`  ${PYTHON_BRIDGE_BASE}`);
  console.log('='.repeat(54));
});
