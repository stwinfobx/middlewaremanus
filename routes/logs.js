const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET /api/logs - Listar logs
router.get('/', (req, res) => {
  try {
    const { 
      level, 
      source, 
      event_type,
      date_from,
      date_to,
      limit = 100,
      offset = 0 
    } = req.query;

    let query = 'SELECT * FROM logs WHERE 1=1';
    const params = [];

    if (level) {
      query += ' AND level = ?';
      params.push(level);
    }
    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }
    if (event_type) {
      query += ' AND event_type = ?';
      params.push(event_type);
    }
    if (date_from) {
      query += ' AND created_at >= ?';
      params.push(date_from);
    }
    if (date_to) {
      query += ' AND created_at <= ?';
      params.push(date_to);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const logs = db.prepare(query).all(...params);
    
    // Parse data JSON
    logs.forEach(log => {
      if (log.data) {
        try {
          log.data = JSON.parse(log.data);
        } catch (e) {}
      }
    });

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/logs/stats - Estatísticas de logs
router.get('/stats', (req, res) => {
  try {
    const stats = {
      by_level: db.prepare(`
        SELECT level, COUNT(*) as count 
        FROM logs 
        GROUP BY level
      `).all(),
      today_errors: db.prepare(`
        SELECT COUNT(*) as count FROM logs 
        WHERE level = 'ERROR' AND date(created_at) = date('now')
      `).get().count,
      recent_events: db.prepare(`
        SELECT event_type, COUNT(*) as count 
        FROM logs 
        WHERE created_at >= datetime('now', '-24 hours')
        GROUP BY event_type
        ORDER BY count DESC
      `).all()
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/logs - Criar log manual
router.post('/', (req, res) => {
  try {
    const { level = 'INFO', source, event_type, message, epc, data } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    const id = uuidv4();
    
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, epc, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, level, source, event_type, message, epc, data ? JSON.stringify(data) : null);

    const log = db.prepare('SELECT * FROM logs WHERE id = ?').get(id);
    
    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('LOG_CREATED', log);
    
    res.status(201).json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/logs/cleanup - Limpar logs antigos
router.delete('/cleanup', (req, res) => {
  try {
    const retentionDays = db.prepare("SELECT value FROM config WHERE key = 'log_retention_days'").get();
    const days = parseInt(retentionDays?.value || '90');
    
    const result = db.prepare(`
      DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(days);
    
    res.json({ 
      success: true, 
      deleted: result.changes,
      message: `${result.changes} logs removidos (mais antigos que ${days} dias)`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
