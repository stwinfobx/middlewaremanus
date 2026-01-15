const express = require('express');
const router = express.Router();
const db = require('../database');
const { v4: uuidv4 } = require('uuid');
const erpService = require('../services/erpService');

/**
 * POST /api/rfid/reading
 * Recebe uma leitura individual do app Android
 * 
 * Body:
 * {
 *   "epc": "E200001234567890",
 *   "rssi": -45.5,
 *   "reader_id": "reader-uuid",
 *   "reader_serial": "C72-12345",
 *   "location_id": "location-uuid",
 *   "timestamp": "2024-01-15T10:30:00Z"
 * }
 */
router.post('/reading', async (req, res) => {
  try {
    const { epc, rssi, reader_id, reader_serial, location_id, timestamp } = req.body;
    
    if (!epc) {
      return res.status(400).json({ error: 'EPC é obrigatório' });
    }

    // Verificar deduplicação
    const deduplicationWindow = db.prepare("SELECT value FROM config WHERE key = 'deduplication_window'").get();
    const windowSeconds = parseInt(deduplicationWindow?.value || '2');
    
    const recentReading = db.prepare(`
      SELECT id FROM movements 
      WHERE epc = ? AND reader_id = ? 
      AND datetime(created_at) > datetime('now', '-' || ? || ' seconds')
    `).get(epc, reader_id, windowSeconds);
    
    if (recentReading) {
      return res.json({ 
        success: true, 
        deduplicated: true, 
        message: 'Leitura duplicada ignorada' 
      });
    }

    // Buscar ou criar leitor pelo serial
    let readerId = reader_id;
    if (reader_serial && !reader_id) {
      const reader = db.prepare('SELECT id FROM readers WHERE serial_number = ?').get(reader_serial);
      if (reader) {
        readerId = reader.id;
      } else {
        // Criar leitor automaticamente
        readerId = uuidv4();
        db.prepare(`
          INSERT INTO readers (id, name, serial_number, type, status, last_seen)
          VALUES (?, ?, ?, 'MOBILE', 'ONLINE', CURRENT_TIMESTAMP)
        `).run(readerId, `Leitor ${reader_serial}`, reader_serial);
      }
    }

    // Atualizar status do leitor
    if (readerId) {
      db.prepare(`
        UPDATE readers SET status = 'ONLINE', last_seen = CURRENT_TIMESTAMP WHERE id = ?
      `).run(readerId);
    }

    // Criar movimentação
    const movementId = uuidv4();
    db.prepare(`
      INSERT INTO movements (id, epc, to_location, reader_id, rssi, movement_type, created_at)
      VALUES (?, ?, ?, ?, ?, 'LEITURA', ?)
    `).run(
      movementId, 
      epc, 
      location_id || 'default', 
      readerId,
      rssi,
      timestamp || new Date().toISOString()
    );

    // Criar log
    const logId = uuidv4();
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, epc, data)
      VALUES (?, 'INFO', ?, 'TAG_READ', ?, ?, ?)
    `).run(
      logId,
      readerId,
      `Tag lida: ${epc}`,
      epc,
      JSON.stringify({ rssi, location_id })
    );

    // Broadcast via WebSocket
    const broadcast = req.app.get('broadcast');
    if (broadcast) {
      broadcast('TAG_READ', {
        id: movementId,
        epc,
        rssi,
        reader_id: readerId,
        location_id: location_id || 'default',
        timestamp: timestamp || new Date().toISOString()
      });
    }

    // Enviar para ERP (assíncrono)
    erpService.processReading({
      id: movementId,
      epc,
      rssi,
      reader_id: readerId,
      location_id: location_id || 'default'
    }).catch(err => console.error('Erro ao enviar para ERP:', err));

    res.json({
      success: true,
      movement_id: movementId,
      message: 'Leitura registrada com sucesso'
    });

  } catch (error) {
    console.error('Erro ao processar leitura:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/rfid/batch
 * Recebe um lote de leituras do app Android (para sincronização offline)
 * 
 * Body:
 * {
 *   "readings": [
 *     { "epc": "...", "rssi": -45, "timestamp": "..." },
 *     ...
 *   ],
 *   "reader_serial": "C72-12345",
 *   "location_id": "location-uuid"
 * }
 */
router.post('/batch', async (req, res) => {
  try {
    const { readings, reader_serial, reader_id, location_id } = req.body;
    
    if (!readings || !Array.isArray(readings)) {
      return res.status(400).json({ error: 'Array de leituras é obrigatório' });
    }

    // Buscar ou criar leitor
    let readerId = reader_id;
    if (reader_serial && !reader_id) {
      const reader = db.prepare('SELECT id FROM readers WHERE serial_number = ?').get(reader_serial);
      if (reader) {
        readerId = reader.id;
      } else {
        readerId = uuidv4();
        db.prepare(`
          INSERT INTO readers (id, name, serial_number, type, status, last_seen)
          VALUES (?, ?, ?, 'MOBILE', 'ONLINE', CURRENT_TIMESTAMP)
        `).run(readerId, `Leitor ${reader_serial}`, reader_serial);
      }
    }

    // Processar leituras em transação
    const insertMovement = db.prepare(`
      INSERT INTO movements (id, epc, to_location, reader_id, rssi, movement_type, created_at)
      VALUES (?, ?, ?, ?, ?, 'LEITURA', ?)
    `);

    const results = {
      total: readings.length,
      inserted: 0,
      deduplicated: 0,
      errors: 0
    };

    const insertMany = db.transaction((items) => {
      for (const reading of items) {
        try {
          // Verificar deduplicação simples (mesmo EPC nos últimos 2 segundos)
          const recent = db.prepare(`
            SELECT id FROM movements 
            WHERE epc = ? AND reader_id = ? 
            AND datetime(created_at) > datetime(?, '-2 seconds')
          `).get(reading.epc, readerId, reading.timestamp || new Date().toISOString());
          
          if (recent) {
            results.deduplicated++;
            continue;
          }

          insertMovement.run(
            uuidv4(),
            reading.epc,
            location_id || 'default',
            readerId,
            reading.rssi,
            reading.timestamp || new Date().toISOString()
          );
          results.inserted++;
        } catch (err) {
          results.errors++;
        }
      }
    });

    insertMany(readings);

    // Atualizar status do leitor
    if (readerId) {
      db.prepare(`
        UPDATE readers SET status = 'ONLINE', last_seen = CURRENT_TIMESTAMP WHERE id = ?
      `).run(readerId);
    }

    // Broadcast atualização
    const broadcast = req.app.get('broadcast');
    if (broadcast) {
      broadcast('BATCH_SYNC', {
        reader_id: readerId,
        ...results
      });
    }

    // Log
    db.prepare(`
      INSERT INTO logs (id, level, source, event_type, message, data)
      VALUES (?, 'INFO', ?, 'BATCH_SYNC', ?, ?)
    `).run(
      uuidv4(),
      readerId,
      `Sincronização em lote: ${results.inserted} inseridas, ${results.deduplicated} duplicadas`,
      JSON.stringify(results)
    );

    res.json({
      success: true,
      ...results
    });

  } catch (error) {
    console.error('Erro ao processar lote:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/rfid/heartbeat
 * Heartbeat do leitor para manter status online
 */
router.post('/heartbeat', (req, res) => {
  try {
    const { reader_id, reader_serial, battery_level, signal_strength } = req.body;
    
    let readerId = reader_id;
    if (reader_serial && !reader_id) {
      const reader = db.prepare('SELECT id FROM readers WHERE serial_number = ?').get(reader_serial);
      readerId = reader?.id;
    }

    if (readerId) {
      db.prepare(`
        UPDATE readers SET status = 'ONLINE', last_seen = CURRENT_TIMESTAMP WHERE id = ?
      `).run(readerId);
    }

    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/rfid/config
 * Retorna configurações para o app Android
 */
router.get('/config', (req, res) => {
  try {
    const configs = db.prepare('SELECT key, value FROM config').all();
    const configObj = {};
    configs.forEach(c => configObj[c.key] = c.value);
    
    res.json({
      power_level: parseInt(configObj.rfid_power_level || '30'),
      read_interval: parseInt(configObj.rfid_read_interval || '1000'),
      deduplication_window: parseInt(configObj.deduplication_window || '2'),
      server_version: '1.0.0'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
