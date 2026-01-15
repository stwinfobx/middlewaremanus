const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET /api/readers - Listar todos os leitores
router.get('/', (req, res) => {
  try {
    const { type, status } = req.query;
    let query = 'SELECT * FROM readers WHERE 1=1';
    const params = [];
    
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const readers = db.prepare(query).all(...params);
    res.json(readers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/readers/:id - Obter leitor específico
router.get('/:id', (req, res) => {
  try {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    if (!reader) {
      return res.status(404).json({ error: 'Leitor não encontrado' });
    }
    res.json(reader);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/readers - Criar novo leitor
router.post('/', (req, res) => {
  try {
    const {
      name,
      serial_number,
      type = 'FIXO',
      connection_type = 'ETHERNET',
      ip_address,
      port = 5084,
      com_port,
      baud_rate = 115200,
      mac_address,
      location_id,
      power_level = 30
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    const id = uuidv4();
    
    db.prepare(`
      INSERT INTO readers (
        id, name, serial_number, type, connection_type, 
        ip_address, port, com_port, baud_rate, mac_address,
        location_id, power_level, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFLINE')
    `).run(
      id, name, serial_number, type, connection_type,
      ip_address, port, com_port, baud_rate, mac_address,
      location_id, power_level
    );

    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, 'INFO', 'SYSTEM', 'READER_CREATED', ?, ?)
    `).run(uuidv4(), `Leitor criado: ${name}`, JSON.stringify({ id, name, type }));

    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(id);
    
    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('READER_CREATED', reader);
    
    res.status(201).json(reader);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/readers/:id - Atualizar leitor
router.put('/:id', (req, res) => {
  try {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    if (!reader) {
      return res.status(404).json({ error: 'Leitor não encontrado' });
    }

    const {
      name,
      serial_number,
      type,
      connection_type,
      ip_address,
      port,
      com_port,
      baud_rate,
      mac_address,
      location_id,
      power_level,
      status
    } = req.body;

    db.prepare(`
      UPDATE readers SET
        name = COALESCE(?, name),
        serial_number = COALESCE(?, serial_number),
        type = COALESCE(?, type),
        connection_type = COALESCE(?, connection_type),
        ip_address = COALESCE(?, ip_address),
        port = COALESCE(?, port),
        com_port = COALESCE(?, com_port),
        baud_rate = COALESCE(?, baud_rate),
        mac_address = COALESCE(?, mac_address),
        location_id = COALESCE(?, location_id),
        power_level = COALESCE(?, power_level),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, serial_number, type, connection_type,
      ip_address, port, com_port, baud_rate, mac_address,
      location_id, power_level, status, req.params.id
    );

    const updatedReader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    
    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('READER_UPDATED', updatedReader);
    
    res.json(updatedReader);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/readers/:id - Remover leitor
router.delete('/:id', (req, res) => {
  try {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    if (!reader) {
      return res.status(404).json({ error: 'Leitor não encontrado' });
    }

    db.prepare('DELETE FROM readers WHERE id = ?').run(req.params.id);
    
    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, 'WARNING', 'SYSTEM', 'READER_DELETED', ?, ?)
    `).run(uuidv4(), `Leitor removido: ${reader.name}`, JSON.stringify({ id: reader.id }));

    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('READER_DELETED', { id: req.params.id });
    
    res.json({ success: true, message: 'Leitor removido' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/readers/:id/test - Testar conexão com leitor
router.post('/:id/test', async (req, res) => {
  try {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    if (!reader) {
      return res.status(404).json({ error: 'Leitor não encontrado' });
    }

    // Simular teste de conexão (em produção, faria conexão real)
    const success = Math.random() > 0.1; // 90% de sucesso simulado
    
    const result = {
      success,
      reader_id: reader.id,
      reader_name: reader.name,
      message: success ? 'Conexão estabelecida com sucesso' : 'Falha na conexão',
      rssi: success ? (-30 - Math.random() * 40).toFixed(1) : null,
      timestamp: new Date().toISOString()
    };

    // Atualizar status
    db.prepare(`
      UPDATE readers SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?
    `).run(success ? 'ONLINE' : 'OFFLINE', reader.id);

    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, ?, ?, 'READER_TEST', ?, ?)
    `).run(
      uuidv4(),
      success ? 'SUCCESS' : 'ERROR',
      reader.id,
      result.message,
      JSON.stringify(result)
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/readers/:id/stats - Estatísticas do leitor
router.get('/:id/stats', (req, res) => {
  try {
    const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(req.params.id);
    if (!reader) {
      return res.status(404).json({ error: 'Leitor não encontrado' });
    }

    const stats = {
      total_readings: db.prepare('SELECT COUNT(*) as count FROM movements WHERE reader_id = ?').get(req.params.id).count,
      today_readings: db.prepare(`
        SELECT COUNT(*) as count FROM movements 
        WHERE reader_id = ? AND date(created_at) = date('now')
      `).get(req.params.id).count,
      unique_tags: db.prepare('SELECT COUNT(DISTINCT epc) as count FROM movements WHERE reader_id = ?').get(req.params.id).count,
      last_reading: db.prepare(`
        SELECT created_at FROM movements WHERE reader_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(req.params.id)?.created_at,
      avg_rssi: db.prepare('SELECT AVG(rssi) as avg FROM movements WHERE reader_id = ? AND rssi IS NOT NULL').get(req.params.id).avg
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
