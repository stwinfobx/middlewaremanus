const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

// GET /api/locations - Listar localizações
router.get('/', (req, res) => {
  try {
    const locations = db.prepare('SELECT * FROM locations ORDER BY name').all();
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/locations/:id - Obter localização
router.get('/:id', (req, res) => {
  try {
    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
    if (!location) {
      return res.status(404).json({ error: 'Localização não encontrada' });
    }
    res.json(location);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/locations - Criar localização
router.post('/', (req, res) => {
  try {
    const { name, description, type = 'AREA', parent_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    const id = uuidv4();
    
    db.prepare(`
      INSERT INTO locations (id, name, description, type, parent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, description, type, parent_id);

    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
    res.status(201).json(location);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/locations/:id - Atualizar localização
router.put('/:id', (req, res) => {
  try {
    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
    if (!location) {
      return res.status(404).json({ error: 'Localização não encontrada' });
    }

    const { name, description, type, parent_id } = req.body;

    db.prepare(`
      UPDATE locations SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        type = COALESCE(?, type),
        parent_id = COALESCE(?, parent_id),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(name, description, type, parent_id, req.params.id);

    const updated = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/locations/:id - Remover localização
router.delete('/:id', (req, res) => {
  try {
    if (req.params.id === 'default') {
      return res.status(400).json({ error: 'Não é possível remover a localização padrão' });
    }

    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id);
    if (!location) {
      return res.status(404).json({ error: 'Localização não encontrada' });
    }

    // Mover movimentações para localização padrão
    db.prepare(`
      UPDATE movements SET to_location = 'default' WHERE to_location = ?
    `).run(req.params.id);
    
    db.prepare(`
      UPDATE movements SET from_location = 'default' WHERE from_location = ?
    `).run(req.params.id);

    db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
    
    res.json({ success: true, message: 'Localização removida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
