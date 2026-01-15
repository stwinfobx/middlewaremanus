const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Criar banco de dados
const dbPath = process.env.DB_PATH || path.join(__dirname, 'rfid.db');
const db = new Database(dbPath);

// Habilitar foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Criar tabelas
db.exec(`
  -- Localizações
  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'AREA',
    parent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES locations(id)
  );

  -- Leitores RFID
  CREATE TABLE IF NOT EXISTS readers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    serial_number TEXT UNIQUE,
    type TEXT DEFAULT 'FIXO',
    connection_type TEXT DEFAULT 'ETHERNET',
    ip_address TEXT,
    port INTEGER DEFAULT 5084,
    com_port TEXT,
    baud_rate INTEGER DEFAULT 115200,
    mac_address TEXT,
    status TEXT DEFAULT 'OFFLINE',
    location_id TEXT,
    power_level INTEGER DEFAULT 30,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (location_id) REFERENCES locations(id)
  );

  -- Movimentações de Tags
  CREATE TABLE IF NOT EXISTS movements (
    id TEXT PRIMARY KEY,
    epc TEXT NOT NULL,
    from_location TEXT,
    to_location TEXT,
    reader_id TEXT,
    rssi REAL,
    movement_type TEXT DEFAULT 'LEITURA',
    notes TEXT,
    synced_to_erp INTEGER DEFAULT 0,
    erp_response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_location) REFERENCES locations(id),
    FOREIGN KEY (to_location) REFERENCES locations(id),
    FOREIGN KEY (reader_id) REFERENCES readers(id)
  );

  -- Logs do Sistema
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    level TEXT DEFAULT 'INFO',
    source TEXT,
    event_type TEXT,
    message TEXT NOT NULL,
    epc TEXT,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Configurações do Sistema
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Configurações de Integração ERP
  CREATE TABLE IF NOT EXISTS erp_config (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    endpoint_url TEXT NOT NULL,
    method TEXT DEFAULT 'POST',
    headers TEXT,
    auth_type TEXT DEFAULT 'none',
    auth_token TEXT,
    auth_user TEXT,
    auth_password TEXT,
    payload_template TEXT,
    retry_count INTEGER DEFAULT 3,
    retry_delay INTEGER DEFAULT 5000,
    events TEXT DEFAULT '["TAG_READ","MOVEMENT"]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Fila de Sincronização ERP
  CREATE TABLE IF NOT EXISTS erp_queue (
    id TEXT PRIMARY KEY,
    erp_config_id TEXT,
    event_type TEXT,
    payload TEXT,
    status TEXT DEFAULT 'PENDING',
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (erp_config_id) REFERENCES erp_config(id)
  );

  -- Jobs de Impressão
  CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    epc TEXT,
    template_id TEXT,
    data TEXT,
    status TEXT DEFAULT 'PENDING',
    printer_name TEXT,
    copies INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    printed_at DATETIME
  );

  -- Índices para performance
  CREATE INDEX IF NOT EXISTS idx_movements_epc ON movements(epc);
  CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);
  CREATE INDEX IF NOT EXISTS idx_movements_reader ON movements(reader_id);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_erp_queue_status ON erp_queue(status);
`);

// Inserir configurações padrão se não existirem
const defaultConfigs = [
  ['server_port', '3000', 'Porta do servidor HTTP'],
  ['rfid_power_level', '30', 'Potência padrão dos leitores (dBm)'],
  ['rfid_read_interval', '1000', 'Intervalo de leitura (ms)'],
  ['deduplication_window', '2', 'Janela de deduplicação (segundos)'],
  ['log_retention_days', '90', 'Dias para manter logs'],
  ['erp_sync_enabled', 'true', 'Sincronização com ERP habilitada'],
  ['erp_sync_mode', 'realtime', 'Modo de sincronização: realtime ou batch']
];

const insertConfig = db.prepare(`
  INSERT OR IGNORE INTO config (key, value, description) VALUES (?, ?, ?)
`);

defaultConfigs.forEach(([key, value, description]) => {
  insertConfig.run(key, value, description);
});

// Inserir localização padrão
const defaultLocation = db.prepare('SELECT id FROM locations WHERE id = ?').get('default');
if (!defaultLocation) {
  db.prepare(`
    INSERT INTO locations (id, name, description, type) 
    VALUES (?, ?, ?, ?)
  `).run('default', 'Localização Padrão', 'Localização padrão do sistema', 'AREA');
}

console.log('Banco de dados inicializado:', dbPath);

module.exports = db;
