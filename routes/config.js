const express = require('express');
const router = express.Router();
const db = require('../database');

// GET /api/config - Listar todas as configurações
router.get('/', (req, res) => {
  try {
    const configs = db.prepare('SELECT * FROM config ORDER BY key').all();
    res.json(configs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/config/:key - Obter configuração específica
router.get('/:key', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM config WHERE key = ?').get(req.params.key);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/config/:key - Atualizar configuração
router.put('/:key', (req, res) => {
  try {
    const { value, description } = req.body;
    
    db.prepare(`
      INSERT INTO config (key, value, description, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = COALESCE(excluded.description, description),
        updated_at = CURRENT_TIMESTAMP
    `).run(req.params.key, value, description);

    const config = db.prepare('SELECT * FROM config WHERE key = ?').get(req.params.key);
    
    // Broadcast
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast('CONFIG_UPDATED', config);
    
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/config/bulk - Atualizar múltiplas configurações
router.post('/bulk', (req, res) => {
  try {
    const { configs } = req.body;
    
    if (!configs || !Array.isArray(configs)) {
      return res.status(400).json({ error: 'Array de configurações é obrigatório' });
    }

    const updateConfig = db.prepare(`
      INSERT INTO config (key, value, description, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        description = COALESCE(excluded.description, description),
        updated_at = CURRENT_TIMESTAMP
    `);

    const updateMany = db.transaction((items) => {
      for (const item of items) {
        updateConfig.run(item.key, item.value, item.description);
      }
    });

    updateMany(configs);

    const allConfigs = db.prepare('SELECT * FROM config ORDER BY key').all();
    res.json(allConfigs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/config/:key - Remover configuração
router.delete('/:key', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM config WHERE key = ?').get(req.params.key);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    db.prepare('DELETE FROM config WHERE key = ?').run(req.params.key);
    res.json({ success: true, message: 'Configuração removida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
