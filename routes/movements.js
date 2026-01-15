const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET /api/movements - Listar movimentações
router.get('/', (req, res) => {
  try {
    const { 
      epc, 
      reader_id, 
      location_id, 
      movement_type,
      date_from,
      date_to,
      limit = 100,
      offset = 0,
      sort = '-created_at'
    } = req.query;

    let query = 'SELECT * FROM movements WHERE 1=1';
    const params = [];

    if (epc) {
      query += ' AND epc LIKE ?';
      params.push(`%${epc}%`);
    }
    if (reader_id) {
      query += ' AND reader_id = ?';
      params.push(reader_id);
    }
    if (location_id) {
      query += ' AND (to_location = ? OR from_location = ?)';
      params.push(location_id, location_id);
    }
    if (movement_type) {
      query += ' AND movement_type = ?';
      params.push(movement_type);
    }
    if (date_from) {
      query += ' AND created_at >= ?';
      params.push(date_from);
    }
    if (date_to) {
      query += ' AND created_at <= ?';
      params.push(date_to);
    }

    // Ordenação
    const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
    const sortDir = sort.startsWith('-') ? 'DESC' : 'ASC';
    query += ` ORDER BY ${sortField} ${sortDir}`;

    // Paginação
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const movements = db.prepare(query).all(...params);
    
    // Total para paginação
    let countQuery = 'SELECT COUNT(*) as total FROM movements WHERE 1=1';
    const countParams = [];
    if (epc) {
      countQuery += ' AND epc LIKE ?';
      countParams.push(`%${epc}%`);
    }
    if (reader_id) {
      countQuery += ' AND reader_id = ?';
      countParams.push(reader_id);
    }
    
    const total = db.prepare(countQuery).get(...countParams).total;

    res.json({
      data: movements,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + movements.length < total
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/movements/recent - Últimas movimentações (para dashboard)
router.get('/recent', (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const movements = db.prepare(`
      SELECT m.*, r.name as reader_name, l.name as location_name
      FROM movements m
      LEFT JOIN readers r ON m.reader_id = r.id
      LEFT JOIN locations l ON m.to_location = l.id
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(parseInt(limit));
    
    res.json(movements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/movements/by-epc/:epc - Histórico de uma tag
router.get('/by-epc/:epc', (req, res) => {
  try {
    const movements = db.prepare(`
      SELECT m.*, r.name as reader_name, l.name as location_name
      FROM movements m
      LEFT JOIN readers r ON m.reader_id = r.id
      LEFT JOIN locations l ON m.to_location = l.id
      WHERE m.epc = ?
      ORDER BY m.created_at DESC
    `).all(req.params.epc);
    
    res.json(movements);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/movements - Criar movimentação manual
router.post('/', (req, res) => {
  try {
    const {
      epc,
      from_location,
      to_location,
      reader_id,
      rssi,
      movement_type = 'MANUAL',
      notes
    } = req.body;

    if (!epc) {
      return res.status(400).json({ error: 'EPC é obrigatório' });
    }

    const id = uuidv4();
    
    db.prepare(`
      INSERT INTO movements (id, epc, from_location, to_location, reader_id, rssi, movement_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, epc, from_location, to_location, reader_id, rssi, movement_type, notes);

    const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(id);
    
    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('MOVEMENT_CREATED', movement);
    
    res.status(201).json(movement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/movements/stats - Estatísticas de movimentações
router.get('/stats', (req, res) => {
  try {
    const stats = {
      total: db.prepare('SELECT COUNT(*) as count FROM movements').get().count,
      today: db.prepare(`
        SELECT COUNT(*) as count FROM movements 
        WHERE date(created_at) = date('now')
      `).get().count,
      this_week: db.prepare(`
        SELECT COUNT(*) as count FROM movements 
        WHERE created_at >= date('now', '-7 days')
      `).get().count,
      unique_tags: db.prepare('SELECT COUNT(DISTINCT epc) as count FROM movements').get().count,
      by_type: db.prepare(`
        SELECT movement_type, COUNT(*) as count 
        FROM movements 
        GROUP BY movement_type
      `).all(),
      by_location: db.prepare(`
        SELECT to_location, COUNT(*) as count 
        FROM movements 
        GROUP BY to_location
        ORDER BY count DESC
        LIMIT 10
      `).all(),
      hourly_today: db.prepare(`
        SELECT strftime('%H', created_at) as hour, COUNT(*) as count
        FROM movements
        WHERE date(created_at) = date('now')
        GROUP BY hour
        ORDER BY hour
      `).all()
    };
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/movements/:id - Remover movimentação
router.delete('/:id', (req, res) => {
  try {
    const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(req.params.id);
    if (!movement) {
      return res.status(404).json({ error: 'Movimentação não encontrada' });
    }

    db.prepare('DELETE FROM movements WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Movimentação removida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
