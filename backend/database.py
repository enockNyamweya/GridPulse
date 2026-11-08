import sqlite3
import os
from datetime import datetime, timezone
from typing import List, Dict, Any

DB_PATH = os.path.join(os.path.dirname(__file__), "gridpulse.db")
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    conn = get_connection()
    with conn:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            conn.executescript(f.read())

        initial_nodes = [
            ("GEN-OLK-01", "Olkaria Geothermal Feeder", "GENERATION", "Nakuru / Rift Valley", 450.0),
            ("GEN-SOL-02", "Nakuru Community Solar Array", "GENERATION", "Nakuru / Rift Valley", 280.0),
            ("TR-NRB-04", "Kasarani 500kVA Step-Down Transformer", "TRANSFORMER", "Nairobi North", 500.0),
            ("BESS-KSM-01", "GridPulse LFP Battery Bank (400kWh)", "STORAGE", "Nairobi North", 250.0),
            ("LOAD-HOSP-01", "Sub-County Referral Clinic & Maternity", "LOAD_CRITICAL", "Nairobi North", 140.0),
            ("LOAD-COMM-02", "SME Cold-Storage & Agro-Processing Hub", "LOAD_FLEXIBLE", "Nairobi North", 320.0),
        ]
        conn.executemany(
            """
            INSERT OR IGNORE INTO grid_nodes (node_id, node_name, node_type, region, rated_capacity_kw)
            VALUES (?, ?, ?, ?, ?)
            """,
            initial_nodes,
        )

        now_iso = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT OR IGNORE INTO storage_units (unit_id, node_id, capacity_kwh, max_dispatch_kw, soc_pct, mode, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("BESS-UNIT-01", "BESS-KSM-01", 400.0, 250.0, 78.0, "IDLE", now_iso),
        )
    conn.close()


def record_dispatch_event(
    idempotency_key: str,
    trigger_node_id: str,
    previous_state: str,
    new_state: str,
    action_taken: str,
    frequency_hz: float,
    transformer_load_pct: float,
    bess_dispatch_kw: float,
) -> bool:
    """
    Executes an ACID transaction to log an automated state transition or battery dispatch event.
    Uses idempotency_key to prevent duplicate dispatch records on network retry.
    """
    conn = get_connection()
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        with conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO dispatch_events (
                    idempotency_key, timestamp_utc, trigger_node_id,
                    previous_state, new_state, action_taken,
                    frequency_at_trigger_hz, transformer_load_pct, bess_dispatch_kw
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    idempotency_key,
                    now_iso,
                    trigger_node_id,
                    previous_state,
                    new_state,
                    action_taken,
                    round(frequency_hz, 3),
                    round(transformer_load_pct, 2),
                    round(bess_dispatch_kw, 2),
                ),
            )
            conn.execute(
                """
                UPDATE storage_units
                SET mode = ?, updated_at = ?
                WHERE node_id = 'BESS-KSM-01'
                """,
                (
                    "ISLAND_FORMING"
                    if new_state == "FAULT_ISLANDING"
                    else ("DISCHARGING" if bess_dispatch_kw > 0 else ("CHARGING" if bess_dispatch_kw < 0 else "IDLE")),
                    now_iso,
                ),
            )
        return True
    finally:
        conn.close()


def log_telemetry_snapshot(nodes: List[Dict[str, Any]], soc_pct: float) -> None:
    conn = get_connection()
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        with conn:
            rows = [
                (
                    n["node_id"],
                    now_iso,
                    round(n["voltage_v"], 2),
                    round(n["frequency_hz"], 3),
                    round(n["active_power_kw"], 2),
                    round(n["load_pct"], 2),
                    round(n["temperature_c"], 2),
                    n["status"],
                )
                for n in nodes
            ]
            conn.executemany(
                """
                INSERT INTO telemetry_readings (
                    node_id, timestamp_utc, voltage_v, frequency_hz,
                    active_power_kw, load_pct, temperature_c, node_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
            conn.execute(
                "UPDATE storage_units SET soc_pct = ?, updated_at = ? WHERE unit_id = 'BESS-UNIT-01'",
                (round(soc_pct, 2), now_iso),
            )
            # Keep telemetry table bounded for fast local performance
            conn.execute(
                """
                DELETE FROM telemetry_readings
                WHERE reading_id NOT IN (
                    SELECT reading_id FROM telemetry_readings ORDER BY reading_id DESC LIMIT 600
                )
                """
            )
    finally:
        conn.close()


def fetch_recent_events(limit: int = 15) -> List[Dict[str, Any]]:
    conn = get_connection()
    try:
        cur = conn.execute(
            """
            SELECT event_id, idempotency_key, timestamp_utc, trigger_node_id,
                   previous_state, new_state, action_taken,
                   frequency_at_trigger_hz, transformer_load_pct, bess_dispatch_kw
            FROM dispatch_events
            ORDER BY event_id DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def fetch_sql_analytics() -> List[Dict[str, Any]]:
    """
    Executes a 3NF Relational JOIN & GROUP BY aggregation query (COS 221)
    across grid_nodes and telemetry_readings to compute historical performance per node class.
    """
    conn = get_connection()
    try:
        cur = conn.execute(
            """
            SELECT
                n.node_type AS node_class,
                COUNT(t.reading_id) AS sample_count,
                ROUND(AVG(t.active_power_kw), 1) AS avg_power_kw,
                ROUND(MAX(t.load_pct), 1) AS peak_load_pct,
                ROUND(AVG(t.temperature_c), 1) AS avg_temp_c
            FROM grid_nodes n
            LEFT JOIN telemetry_readings t ON n.node_id = t.node_id
            GROUP BY n.node_type
            ORDER BY peak_load_pct DESC
            """
        )
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()

