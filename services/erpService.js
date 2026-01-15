const axios = require('axios');
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

/**
 * Serviço de integração com ERPs externos
 */
class ERPService {
  
  /**
   * Processa uma leitura RFID e envia para todos os ERPs configurados
   */
  async processReading(reading) {
    const configs = db.prepare(`
      SELECT * FROM erp_config WHERE enabled = 1
    `).all();

    for (const config of configs) {
      try {
        const events = JSON.parse(config.events || '[]');
        if (!events.includes('TAG_READ') && !events.includes('MOVEMENT')) {
          continue;
        }

        // Preparar payload
        const payload = this.buildPayload(config, reading, 'TAG_READ');
        
        // Adicionar à fila
        const queueId = uuidv4();
        db.prepare(`
          INSERT INTO erp_queue (id, erp_config_id, event_type, payload, status)
          VALUES (?, ?, 'TAG_READ', ?, 'PENDING')
        `).run(queueId, config.id, JSON.stringify(payload));

        // Enviar (modo realtime)
        const syncMode = db.prepare("SELECT value FROM config WHERE key = 'erp_sync_mode'").get();
        if (syncMode?.value === 'realtime') {
          const result = await this.sendToErp(config, payload);
          
          db.prepare(`
            UPDATE erp_queue SET
              status = ?,
              attempts = 1,
              last_error = ?,
              processed_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            result.success ? 'SUCCESS' : 'ERROR',
            result.error || null,
            queueId
          );

          // Atualizar movimento como sincronizado
          if (result.success && reading.id) {
            db.prepare(`
              UPDATE movements SET synced_to_erp = 1, erp_response = ? WHERE id = ?
            `).run(JSON.stringify(result.response), reading.id);
          }
        }
      } catch (error) {
        console.error(`Erro ao processar ERP ${config.name}:`, error);
      }
    }
  }

  /**
   * Constrói o payload baseado no template ou formato padrão
   */
  buildPayload(config, data, eventType) {
    if (config.payload_template) {
      try {
        // Substituir variáveis no template
        let payload = config.payload_template;
        payload = payload.replace(/\{\{epc\}\}/g, data.epc || '');
        payload = payload.replace(/\{\{rssi\}\}/g, data.rssi || '');
        payload = payload.replace(/\{\{reader_id\}\}/g, data.reader_id || '');
        payload = payload.replace(/\{\{location_id\}\}/g, data.location_id || '');
        payload = payload.replace(/\{\{timestamp\}\}/g, new Date().toISOString());
        payload = payload.replace(/\{\{event_type\}\}/g, eventType);
        return JSON.parse(payload);
      } catch (e) {
        console.error('Erro ao processar template:', e);
      }
    }

    // Payload padrão
    return {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data: {
        epc: data.epc,
        rssi: data.rssi,
        reader_id: data.reader_id,
        location_id: data.location_id,
        movement_id: data.id
      }
    };
  }

  /**
   * Envia dados para um ERP específico
   */
  async sendToErp(config, payload) {
    try {
      const headers = config.headers ? JSON.parse(config.headers) : {};
      headers['Content-Type'] = 'application/json';

      // Autenticação
      if (config.auth_type === 'bearer' && config.auth_token) {
        headers['Authorization'] = `Bearer ${config.auth_token}`;
      } else if (config.auth_type === 'basic' && config.auth_user && config.auth_password) {
        const auth = Buffer.from(`${config.auth_user}:${config.auth_password}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      } else if (config.auth_type === 'api_key' && config.auth_token) {
        headers['X-API-Key'] = config.auth_token;
      }

      const response = await axios({
        method: config.method || 'POST',
        url: config.endpoint_url,
        headers,
        data: payload,
        timeout: 30000,
        validateStatus: (status) => status < 500
      });

      const success = response.status >= 200 && response.status < 300;

      return {
        success,
        status: response.status,
        response: response.data,
        error: success ? null : `HTTP ${response.status}: ${JSON.stringify(response.data)}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        response: null
      };
    }
  }

  /**
   * Processa fila de sincronização pendente (para modo batch)
   */
  async processQueue() {
    const pendingItems = db.prepare(`
      SELECT q.*, c.* 
      FROM erp_queue q
      JOIN erp_config c ON q.erp_config_id = c.id
      WHERE q.status = 'PENDING' AND c.enabled = 1
      ORDER BY q.created_at
      LIMIT 100
    `).all();

    let processed = 0;
    let success = 0;

    for (const item of pendingItems) {
      const payload = JSON.parse(item.payload);
      const result = await this.sendToErp(item, payload);

      db.prepare(`
        UPDATE erp_queue SET
          status = ?,
          attempts = attempts + 1,
          last_error = ?,
          processed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        result.success ? 'SUCCESS' : (item.attempts >= item.retry_count ? 'FAILED' : 'ERROR'),
        result.error || null,
        item.id
      );

      processed++;
      if (result.success) success++;

      // Delay entre requisições
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return { processed, success, failed: processed - success };
  }
}

module.exports = new ERPService();
