-- GridPulse Relational Schema (SQLite / PostgreSQL Compatible)
-- Enforces referential integrity and ACID audit logging for microgrid telemetry and automated BESS dispatch.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS grid_nodes (
    node_id VARCHAR(32) PRIMARY KEY,
    node_name VARCHAR(120) NOT NULL,
    node_type VARCHAR(32) NOT NULL CHECK (node_type IN ('GENERATION', 'TRANSFORMER', 'STORAGE', 'LOAD_CRITICAL', 'LOAD_FLEXIBLE')),
    region VARCHAR(64) NOT NULL,
    rated_capacity_kw REAL NOT NULL CHECK (rated_capacity_kw > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telemetry_readings (
    reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id VARCHAR(32) NOT NULL,
    timestamp_utc VARCHAR(40) NOT NULL,
    voltage_v REAL NOT NULL,
    frequency_hz REAL NOT NULL,
    active_power_kw REAL NOT NULL,
    load_pct REAL NOT NULL,
    temperature_c REAL NOT NULL,
    node_status VARCHAR(32) NOT NULL,
    FOREIGN KEY (node_id) REFERENCES grid_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_node_time ON telemetry_readings(node_id, timestamp_utc);

CREATE TABLE IF NOT EXISTS storage_units (
    unit_id VARCHAR(32) PRIMARY KEY,
    node_id VARCHAR(32) NOT NULL,
    capacity_kwh REAL NOT NULL,
    max_dispatch_kw REAL NOT NULL,
    soc_pct REAL NOT NULL CHECK (soc_pct >= 0 AND soc_pct <= 100),
    mode VARCHAR(24) NOT NULL CHECK (mode IN ('IDLE', 'CHARGING', 'DISCHARGING', 'ISLAND_FORMING')),
    updated_at VARCHAR(40) NOT NULL,
    FOREIGN KEY (node_id) REFERENCES grid_nodes(node_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dispatch_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key VARCHAR(64) UNIQUE NOT NULL,
    timestamp_utc VARCHAR(40) NOT NULL,
    trigger_node_id VARCHAR(32) NOT NULL,
    previous_state VARCHAR(32) NOT NULL,
    new_state VARCHAR(32) NOT NULL,
    action_taken VARCHAR(255) NOT NULL,
    frequency_at_trigger_hz REAL NOT NULL,
    transformer_load_pct REAL NOT NULL,
    bess_dispatch_kw REAL NOT NULL,
    FOREIGN KEY (trigger_node_id) REFERENCES grid_nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_timestamp ON dispatch_events(timestamp_utc DESC);
