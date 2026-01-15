const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
require('dotenv').config();

const db = require('./database');
const readersRouter = require('./routes/readers');
const movementsRouter = require('./routes/movements');
const locationsRouter = require('./routes/locations');
const logsRouter = require('./routes/logs');
const configRouter = require('./routes/config');
const erpRouter = require('./routes/erp');
const rfidRouter = require('./routes/rfid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket connections para tempo real
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Cliente WebSocket conectado. Total:', clients.size);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('Cliente WebSocket desconectado. Total:', clients.size);
  });
  
  ws.on('error', (error) => {
    console.error('Erro WebSocket:', error);
    clients.delete(ws);
  });
});

// Função para broadcast de eventos em tempo real
function broadcast(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

// Disponibilizar broadcast para as rotas
app.set('broadcast', broadcast);

// Rotas da API
app.use('/api/readers', readersRouter);
app.use('/api/movements', movementsRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/logs', logsRouter);
app.use('/api/config', configRouter);
app.use('/api/erp', erpRouter);
app.use('/api/rfid', rfidRouter);

// Rota de status/health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    clients: clients.size
  });
});

// Rota para estatísticas do dashboard
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      readers: {
        total: db.prepare('SELECT COUNT(*) as count FROM readers WHERE type = ?').get('FIXO').count,
        online: db.prepare("SELECT COUNT(*) as count FROM readers WHERE type = ? AND status = ?").get('FIXO', 'ONLINE').count
      },
      movements: {
        today: db.prepare(`
          SELECT COUNT(*) as count FROM movements 
          WHERE date(created_at) = date('now')
        `).get().count,
        total: db.prepare('SELECT COUNT(*) as count FROM movements').get().count
      },
      tags: {
        unique: db.prepare('SELECT COUNT(DISTINCT epc) as count FROM movements').get().count
      },
      logs: {
        errors: db.prepare("SELECT COUNT(*) as count FROM logs WHERE level = 'ERROR'").get().count
      }
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback para SPA (Express 5 syntax)
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           RFID Middleware Server v1.0.0                   ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP Server:    http://localhost:${PORT}                    ║
║  WebSocket:      ws://localhost:${PORT}                      ║
║  API Docs:       http://localhost:${PORT}/api/status         ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  - POST /api/rfid/reading    (receber leitura do app)     ║
║  - POST /api/rfid/batch      (lote de leituras)           ║
║  - GET  /api/readers         (listar leitores)            ║
║  - GET  /api/movements       (listar movimentações)       ║
║  - POST /api/erp/webhook     (configurar integração ERP)  ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, server, broadcast };
