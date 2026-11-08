export type NodeType =
  | 'GENERATION'
  | 'TRANSFORMER'
  | 'STORAGE'
  | 'LOAD_CRITICAL'
  | 'LOAD_FLEXIBLE';

export interface GridNode {
  node_id: string;
  node_name: string;
  node_type: NodeType;
  region: string;
  rated_capacity_kw: number;
  active_power_kw: number;
  load_pct: number;
  voltage_v: number;
  frequency_hz: number;
  temperature_c: number;
  status: string;
}

export interface DispatchEvent {
  event_id: number;
  idempotency_key: string;
  timestamp_utc: string;
  trigger_node_id: string;
  previous_state: string;
  new_state: string;
  action_taken: string;
  frequency_at_trigger_hz: number;
  transformer_load_pct: number;
  bess_dispatch_kw: number;
}

export interface GridMetrics {
  frequency_hz: number;
  bus_voltage_v: number;
  total_generation_kw: number;
  total_demand_kw: number;
  transformer_load_pct: number;
  transformer_temp_c: number;
  winding_hotspot_c?: number;
  thermal_aging_factor?: number;
  forecast_demand_kw?: number;
  forecast_error_pct?: number;
  corridor_losses_kw?: number;
  pcc_breaker_closed?: boolean;
  bess_soc_pct: number;
  bess_dispatch_kw: number;
  clinic_uptime_pct: number;
}

export interface ShortestLossRoute {
  source: string;
  target: string;
  path: string[];
  total_impedance_cost: number;
  reachable: boolean;
}

export interface RadialSpanningEdge {
  from: string;
  to: string;
  weight: number;
  line: string;
}

export interface RadialTopologyResult {
  root: string;
  edges: RadialSpanningEdge[];
  total_mst_impedance: number;
  connected_nodes_count: number;
}

export interface ZoneHierarchyNode {
  id: string;
  name: string;
  type: 'DISTRIBUTION_ZONE' | 'LEAF_ASSET';
  role?: string;
  net_power_kw: number;
  children?: ZoneHierarchyNode[];
}

export interface ConcurrencyDiagnostics {
  synchronizer_type: string;
  ring_buffer_capacity: number;
  frames_processed_seq: number;
  buffer_occupancy_pct: number;
  lock_acquisitions: number;
  cas_transitions_committed: number;
  race_conditions_prevented: number;
  active_threads: number;
}

export interface RTUBinaryFrame {
  node_id: string;
  hex_frame: string;
  register_breakdown: {
    sync_byte: string;
    id_status_bits: string;
    volt_fixed16: string;
    freq_fixed16: string;
    load_uint8: string;
    crc8_checksum: string;
  };
}

export interface LogicProposition {
  symbol: string;
  label: string;
  value: boolean;
}

export interface SafetyInterlockStatus {
  formula: string;
  invariant_satisfied: boolean;
  propositions: LogicProposition[];
}

export interface TelemetryNodeAnalytics {
  node_class: string;
  sample_count: number;
  avg_power_kw: number;
  peak_load_pct: number;
  avg_temp_c: number;
}

export interface SubsystemsPayload {
  network_routing: {
    hospital_route: ShortestLossRoute;
    radial_topology: RadialTopologyResult;
  };
  dispatch_architecture: {
    active_strategy: string;
    available_strategies: string[];
    zone_hierarchy: ZoneHierarchyNode;
  };
  concurrency_engine: ConcurrencyDiagnostics;
  rtu_frames: RTUBinaryFrame[];
  safety_interlock: SafetyInterlockStatus;
  telemetry_analytics: TelemetryNodeAnalytics[];
}

export interface TelemetrySnapshot {
  timestamp_utc: string;
  tick: number;
  system_state: string;
  active_scenario: string;
  auto_balancer_enabled: boolean;
  active_strategy?: string;
  metrics: GridMetrics;
  nodes: GridNode[];
  recent_events: DispatchEvent[];
  subsystems?: SubsystemsPayload;
}
