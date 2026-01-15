const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const erpService = require('../services/erpService');

// GET /api/erp/configs - Listar configurações de ERP
router.get('/configs', (req, res) => {
  try {
    const configs = db.prepare('SELECT * FROM erp_config ORDER BY name').all();
    
    // Parse JSON fields
    configs.forEach(config => {
      if (config.headers) {
        try { config.headers = JSON.parse(config.headers); } catch (e) {}
      }
      if (config.events) {
        try { config.events = JSON.parse(config.events); } catch (e) {}
      }
    });
    
    res.json(configs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/erp/configs/:id - Obter configuração específica
router.get('/configs/:id', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(req.params.id);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }
    
    if (config.headers) {
      try { config.headers = JSON.parse(config.headers); } catch (e) {}
    }
    if (config.events) {
      try { config.events = JSON.parse(config.events); } catch (e) {}
    }
    
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/erp/configs - Criar configuração de ERP
router.post('/configs', (req, res) => {
  try {
    const {
      name,
      endpoint_url,
      method = 'POST',
      headers,
      auth_type = 'none',
      auth_token,
      auth_user,
      auth_password,
      payload_template,
      retry_count = 3,
      retry_delay = 5000,
      events = ['TAG_READ', 'MOVEMENT'],
      enabled = true
    } = req.body;

    if (!name || !endpoint_url) {
      return res.status(400).json({ error: 'Nome e URL do endpoint são obrigatórios' });
    }

    const id = uuidv4();
    
    db.prepare(`
      INSERT INTO erp_config (
        id, name, endpoint_url, method, headers, auth_type, auth_token,
        auth_user, auth_password, payload_template, retry_count, retry_delay,
        events, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, endpoint_url, method,
      headers ? JSON.stringify(headers) : null,
      auth_type, auth_token, auth_user, auth_password,
      payload_template, retry_count, retry_delay,
      JSON.stringify(events), enabled ? 1 : 0
    );

    const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(id);
    
    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, 'INFO', 'SYSTEM', 'ERP_CONFIG_CREATED', ?, ?)
    `).run(uuidv4(), `Integração ERP criada: ${name}`, JSON.stringify({ id, name, endpoint_url }));

    res.status(201).json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/erp/configs/:id - Atualizar configuração
router.put('/configs/:id', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(req.params.id);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    const {
      name,
      endpoint_url,
      method,
      headers,
      auth_type,
      auth_token,
      auth_user,
      auth_password,
      payload_template,
      retry_count,
      retry_delay,
      events,
      enabled
    } = req.body;

    db.prepare(`
      UPDATE erp_config SET
        name = COALESCE(?, name),
        endpoint_url = COALESCE(?, endpoint_url),
        method = COALESCE(?, method),
        headers = COALESCE(?, headers),
        auth_type = COALESCE(?, auth_type),
        auth_token = COALESCE(?, auth_token),
        auth_user = COALESCE(?, auth_user),
        auth_password = COALESCE(?, auth_password),
        payload_template = COALESCE(?, payload_template),
        retry_count = COALESCE(?, retry_count),
        retry_delay = COALESCE(?, retry_delay),
        events = COALESCE(?, events),
        enabled = COALESCE(?, enabled),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, endpoint_url, method,
      headers ? JSON.stringify(headers) : null,
      auth_type, auth_token, auth_user, auth_password,
      payload_template, retry_count, retry_delay,
      events ? JSON.stringify(events) : null,
      enabled !== undefined ? (enabled ? 1 : 0) : null,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/erp/configs/:id - Remover configuração
router.delete('/configs/:id', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(req.params.id);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    db.prepare('DELETE FROM erp_config WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Configuração removida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/erp/configs/:id/test - Testar integração
router.post('/configs/:id/test', async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(req.params.id);
    if (!config) {
      return res.status(404).json({ error: 'Configuração não encontrada' });
    }

    const testPayload = {
      test: true,
      timestamp: new Date().toISOString(),
      epc: 'E2000TEST123456789',
      rssi: -45.5,
      event_type: 'TEST'
    };

    const result = await erpService.sendToErp(config, testPayload);
    
    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, ?, 'SYSTEM', 'ERP_TEST', ?, ?)
    `).run(
      uuidv4(),
      result.success ? 'SUCCESS' : 'ERROR',
      result.success ? `Teste ERP OK: ${config.name}` : `Teste ERP falhou: ${config.name}`,
      JSON.stringify(result)
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/erp/queue - Listar fila de sincronização
router.get('/queue', (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM erp_queue';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    
    const queue = db.prepare(query).all(...params);
    
    // Parse payload
    queue.forEach(item => {
      if (item.payload) {
        try { item.payload = JSON.parse(item.payload); } catch (e) {}
      }
    });
    
    res.json(queue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/erp/queue/retry - Reprocessar itens com erro
router.post('/queue/retry', async (req, res) => {
  try {
    const failedItems = db.prepare(`
      SELECT * FROM erp_queue WHERE status = 'ERROR' ORDER BY created_at
    `).all();
    
    let retried = 0;
    let success = 0;
    
    for (const item of failedItems) {
      const config = db.prepare('SELECT * FROM erp_config WHERE id = ?').get(item.erp_config_id);
      if (!config || !config.enabled) continue;
      
      const payload = JSON.parse(item.payload);
      const result = await erpService.sendToErp(config, payload);
      
      db.prepare(`
        UPDATE erp_queue SET
          status = ?,
          attempts = attempts + 1,
          last_error = ?,
          processed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        result.success ? 'SUCCESS' : 'ERROR',
        result.error || null,
        item.id
      );
      
      retried++;
      if (result.success) success++;
    }
    
    res.json({ retried, success, failed: retried - success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/erp/queue/clear - Limpar fila processada
router.delete('/queue/clear', (req, res) => {
  try {
    const result = db.prepare(`
      DELETE FROM erp_queue WHERE status = 'SUCCESS'
    `).run();
    
    res.json({ success: true, deleted: result.changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
