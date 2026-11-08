import { useEffect, useRef, useState } from 'react';
import {
  GridNode,
  TelemetrySnapshot,
  SubsystemsPayload,
  ZoneHierarchyNode,
} from './types/grid';

const SCENARIOS = [
  { id: 'NOMINAL', code: 'SCN-01', label: 'NOMINAL 50HZ' },
  { id: 'EVENING_PEAK', code: 'SCN-02', label: 'EVENING PEAK (+60%)' },
  { id: 'CLOUD_TRANSIENT', code: 'SCN-03', label: 'PV CLOUD DROP (-80%)' },
  { id: 'UPSTREAM_BLACKOUT', code: 'SCN-04', label: 'PCC OUTAGE (ISLAND)' },
];

const STRATEGIES = [
  {
    id: 'PROPORTIONAL_DROOP',
    code: 'LAW-01',
    name: 'Proportional Frequency-Watt Droop',
    threshold: 'Load > 82% or Imbalance < -15 kW',
    formula: 'P_bess = min(P_max, max(20, P_dem - 0.76 * S_rated))',
    description:
      'Balances transformer peak shaving with demand-response curtailment when residual load exceeds 88%.',
  },
  {
    id: 'AGGRESSIVE_PEAK_SHAVING',
    code: 'LAW-02',
    name: 'Aggressive Transformer Peak-Shaving',
    threshold: 'Load > 68% of 500 kVA (340 kW cap)',
    formula: 'P_bess = min(P_max, P_dem - 0.68 * S_rated)',
    description:
      'Strictly caps Kasarani 500 kVA loading at 68% to minimize IEC 60076-7 winding hot-spot thermal aging.',
  },
  {
    id: 'CONSERVATIVE_CLINIC_RESERVE',
    code: 'LAW-03',
    name: 'Conservative Clinic Islanding Reserve',
    threshold: 'Curtail SME first; discharge BESS only if Load > 82% & SoC > 40%',
    formula: 'Curtail = 0.68; P_bess = max(0, 0.80 * P_dem - 0.78 * S_rated)',
    description:
      'Prioritizes high battery State of Charge for extended upstream blackouts by shedding flexible commercial load first.',
  },
];

function computeCrc8(bytes: number[]): number {
  let crc = 0x00;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      if ((crc & 0x80) !== 0) {
        crc = ((crc << 1) ^ 0x07) & 0xff;
      } else {
        crc = (crc << 1) & 0xff;
      }
    }
  }
  return crc;
}

function buildFallbackSubsystems(
  nodes: GridNode[],
  tick: number,
  transformerLoadPct: number,
  frequencyHz: number,
  bessSocPct: number,
  bessDispatchKw: number,
  activeStrategy: string
): SubsystemsPayload {
  const upstreamOnline = (nodes.find((n) => n.node_id === 'GEN-OLK-01')?.active_power_kw ?? 0) > 0;
  const thermalPenalty = transformerLoadPct > 75 ? (transformerLoadPct - 75) * 0.12 : 0;
  const wTr = Number((0.8 + thermalPenalty).toFixed(3));

  const hospitalPath = !upstreamOnline
    ? ['GEN-SOL-02', 'BESS-KSM-01', 'LOAD-HOSP-01']
    : wTr > 2.2
    ? ['GEN-OLK-01', 'TR-NRB-04', 'BESS-KSM-01', 'LOAD-HOSP-01']
    : ['GEN-OLK-01', 'TR-NRB-04', 'LOAD-HOSP-01'];

  const hospitalCost = !upstreamOnline
    ? 1.6
    : Number((1.2 + Math.min(wTr + 0.7, 1.1 + thermalPenalty * 0.5)).toFixed(3));

  const mstEdges = upstreamOnline
    ? [
        { from: 'GEN-OLK-01', to: 'TR-NRB-04', weight: 1.2, line: '132kV Naivasha-Nairobi Trunk' },
        { from: 'TR-NRB-04', to: 'BESS-KSM-01', weight: wTr, line: '415V Secondary Bus A' },
        { from: 'BESS-KSM-01', to: 'LOAD-HOSP-01', weight: 0.7, line: 'Priority-1 Critical Microgrid Bus' },
        { from: 'BESS-KSM-01', to: 'GEN-SOL-02', weight: 0.9, line: 'DC-Coupled Inverter Tie' },
        { from: 'BESS-KSM-01', to: 'LOAD-COMM-02', weight: 1.3, line: 'Curtailable Commercial Feeder' },
      ]
    : [
        { from: 'GEN-SOL-02', to: 'BESS-KSM-01', weight: 0.9, line: 'DC-Coupled Inverter Tie' },
        { from: 'BESS-KSM-01', to: 'LOAD-HOSP-01', weight: 0.7, line: 'Priority-1 Critical Microgrid Bus' },
        { from: 'BESS-KSM-01', to: 'TR-NRB-04', weight: wTr, line: '415V Secondary Bus A' },
        { from: 'BESS-KSM-01', to: 'LOAD-COMM-02', weight: 1.3, line: 'Curtailable Commercial Feeder' },
      ];

  const geoKw = nodes.find((n) => n.node_id === 'GEN-OLK-01')?.active_power_kw ?? 0;
  const solKw = nodes.find((n) => n.node_id === 'GEN-SOL-02')?.active_power_kw ?? 0;
  const hospKw = nodes.find((n) => n.node_id === 'LOAD-HOSP-01')?.active_power_kw ?? 0;
  const commKw = nodes.find((n) => n.node_id === 'LOAD-COMM-02')?.active_power_kw ?? 0;

  const genNet = Number((geoKw + solKw).toFixed(2));
  const distNet = Number((bessDispatchKw - hospKw - commKw).toFixed(2));

  const zoneHierarchy: ZoneHierarchyNode = {
    id: 'ZONE-KE-CORRIDOR',
    name: 'Kenya Rift-Nairobi Grid Corridor',
    type: 'DISTRIBUTION_ZONE',
    net_power_kw: Number((genNet + distNet).toFixed(2)),
    children: [
      {
        id: 'ZONE-RIFT-GEN',
        name: 'Rift Valley Renewable Generation Zone',
        type: 'DISTRIBUTION_ZONE',
        net_power_kw: genNet,
        children: [
          { id: 'GEN-OLK-01', name: 'Olkaria Geothermal', type: 'LEAF_ASSET', role: 'GENERATION', net_power_kw: geoKw },
          { id: 'GEN-SOL-02', name: 'Nakuru Solar Array', type: 'LEAF_ASSET', role: 'GENERATION', net_power_kw: solKw },
        ],
      },
      {
        id: 'ZONE-NRB-NORTH',
        name: 'Nairobi North Secondary Microgrid',
        type: 'DISTRIBUTION_ZONE',
        net_power_kw: distNet,
        children: [
          { id: 'BESS-KSM-01', name: 'LFP Storage Inverter', type: 'LEAF_ASSET', role: 'STORAGE_INJECTION', net_power_kw: bessDispatchKw },
          { id: 'LOAD-HOSP-01', name: 'Referral Clinic', type: 'LEAF_ASSET', role: 'LOAD_DEMAND', net_power_kw: -hospKw },
          { id: 'LOAD-COMM-02', name: 'SME Market Hub', type: 'LEAF_ASSET', role: 'LOAD_DEMAND', net_power_kw: -commKw },
        ],
      },
    ],
  };

  const rtuFrames = nodes.map((n, i) => {
    const idx = (i + 1) & 0x0f;
    const online = n.status.includes('OFFLINE') ? 0 : 1;
    const fault = n.status.includes('CRITICAL') || n.status.includes('OFFLINE') ? 1 : 0;
    const bess = n.status.includes('DISCHARGING') || n.status.includes('CHARGING') ? 1 : 0;
    const prio = n.status.includes('PROTECTED') ? 1 : 0;
    const nibble = ((online << 3) | (fault << 2) | (bess << 1) | prio) & 0x0f;
    const b0 = 0xa5;
    const b1 = ((idx << 4) | nibble) & 0xff;
    const vDv = Math.max(0, Math.min(65535, Math.round(n.voltage_v * 10)));
    const b2 = (vDv >> 8) & 0xff;
    const b3 = vDv & 0xff;
    const fChz = Math.max(0, Math.min(65535, Math.round(n.frequency_hz * 100)));
    const b4 = (fChz >> 8) & 0xff;
    const b5 = fChz & 0xff;
    const b6 = Math.max(0, Math.min(255, Math.round(n.load_pct)));
    const crc = computeCrc8([b0, b1, b2, b3, b4, b5, b6]);
    const hex = [b0, b1, b2, b3, b4, b5, b6, crc]
      .map((x) => `0x${x.toString(16).toUpperCase().padStart(2, '0')}`)
      .join(' ');
    const bin1 = b1.toString(2).padStart(8, '0');
    return {
      node_id: n.node_id,
      hex_frame: hex,
      register_breakdown: {
        sync_byte: '0xA5',
        id_status_bits: `0b${bin1.slice(0, 4)}_${bin1.slice(4)}`,
        volt_fixed16: `0x${vDv.toString(16).toUpperCase().padStart(4, '0')} (${vDv} dV)`,
        freq_fixed16: `0x${fChz.toString(16).toUpperCase().padStart(4, '0')} (${fChz} cHz)`,
        load_uint8: `0x${b6.toString(16).toUpperCase().padStart(2, '0')} (${b6}%)`,
        crc8_checksum: `0x${crc.toString(16).toUpperCase().padStart(2, '0')} (VALID)`,
      },
    };
  });

  const P = upstreamOnline;
  const Q = transformerLoadPct > 82.0;
  const R = frequencyHz < 49.65;
  const S = bessSocPct > 15.0;
  const D = bessDispatchKw > 0.0;
  const C = true;

  return {
    network_routing: {
      hospital_route: {
        source: upstreamOnline ? 'GEN-OLK-01' : 'GEN-SOL-02',
        target: 'LOAD-HOSP-01',
        path: hospitalPath,
        total_impedance_cost: hospitalCost,
        reachable: true,
      },
      radial_topology: {
        root: upstreamOnline ? 'GEN-OLK-01' : 'GEN-SOL-02',
        edges: mstEdges,
        total_mst_impedance: Number(mstEdges.reduce((a, b) => a + b.weight, 0).toFixed(3)),
        connected_nodes_count: upstreamOnline ? 6 : 5,
      },
    },
    dispatch_architecture: {
      active_strategy: activeStrategy,
      available_strategies: STRATEGIES.map((s) => s.id),
      zone_hierarchy: zoneHierarchy,
    },
    concurrency_engine: {
      synchronizer_type: 'Reentrant Mutex (RLock) + Atomic CAS Version Guard',
      ring_buffer_capacity: 32,
      frames_processed_seq: tick,
      buffer_occupancy_pct: Number(((Math.min(tick, 32) / 32) * 100).toFixed(1)),
      lock_acquisitions: tick * 2 + 4,
      cas_transitions_committed: Math.max(1, Math.floor(tick / 4)),
      race_conditions_prevented: 0,
      active_threads: 4,
    },
    rtu_frames: rtuFrames,
    safety_interlock: {
      formula: 'Phi_safe = (D -> (S & (Q | R | ~P))) & (~P -> C) & C',
      invariant_satisfied: (!D || (S && (Q || R || !P))) && (P || C) && C,
      propositions: [
        { symbol: 'P', label: 'Upstream Feeder Energized (52-PCC Closed)', value: P },
        { symbol: 'Q', label: 'Transformer Thermal Guard (>82.0%)', value: Q },
        { symbol: 'R', label: 'Frequency Droop Trigger (<49.65 Hz)', value: R },
        { symbol: 'S', label: 'BESS Reserve Above Floor (>15.0%)', value: S },
        { symbol: 'D', label: 'BESS Inverter Discharging (>0.0 kW)', value: D },
        { symbol: 'C', label: 'Priority-1 Clinic Feeder Energized', value: C },
      ],
    },
    telemetry_analytics: nodes.map((n) => ({
      node_class: n.node_type,
      sample_count: tick * 2,
      avg_power_kw: n.active_power_kw,
      peak_load_pct: n.load_pct,
      avg_temp_c: n.temperature_c,
    })),
  };
}

function createInitialSnapshot(): TelemetrySnapshot {
  const nodes: GridNode[] = [
    {
      node_id: 'GEN-OLK-01',
      node_name: 'Olkaria Geothermal Feeder',
      node_type: 'GENERATION',
      region: 'Rift Valley',
      rated_capacity_kw: 450.0,
      active_power_kw: 310.0,
      load_pct: 68.9,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 42.5,
      status: 'ONLINE',
    },
    {
      node_id: 'GEN-SOL-02',
      node_name: 'Nakuru Solar PV Array',
      node_type: 'GENERATION',
      region: 'Rift Valley',
      rated_capacity_kw: 280.0,
      active_power_kw: 185.0,
      load_pct: 66.1,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 42.8,
      status: 'ONLINE',
    },
    {
      node_id: 'TR-NRB-04',
      node_name: 'Kasarani 500kVA Step-Down',
      node_type: 'TRANSFORMER',
      region: 'Nairobi North',
      rated_capacity_kw: 500.0,
      active_power_kw: 348.0,
      load_pct: 69.6,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 54.0,
      status: 'NOMINAL',
    },
    {
      node_id: 'BESS-KSM-01',
      node_name: 'GridPulse LFP Storage (400kWh)',
      node_type: 'STORAGE',
      region: 'Nairobi North',
      rated_capacity_kw: 250.0,
      active_power_kw: -25.0,
      load_pct: 10.0,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 30.7,
      status: 'CHARGING_SURPLUS',
    },
    {
      node_id: 'LOAD-HOSP-01',
      node_name: 'Sub-County Referral Clinic',
      node_type: 'LOAD_CRITICAL',
      region: 'Nairobi North',
      rated_capacity_kw: 140.0,
      active_power_kw: 108.0,
      load_pct: 77.1,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 26.0,
      status: 'PROTECTED_PRIORITY_1',
    },
    {
      node_id: 'LOAD-COMM-02',
      node_name: 'SME Cold-Storage & Agro Hub',
      node_type: 'LOAD_FLEXIBLE',
      region: 'Nairobi North',
      rated_capacity_kw: 320.0,
      active_power_kw: 240.0,
      load_pct: 75.0,
      voltage_v: 240.0,
      frequency_hz: 50.0,
      temperature_c: 28.0,
      status: 'NOMINAL',
    },
  ];

  return {
    timestamp_utc: new Date().toISOString(),
    tick: 1,
    system_state: 'STABLE',
    active_scenario: 'NOMINAL',
    auto_balancer_enabled: true,
    active_strategy: 'PROPORTIONAL_DROOP',
    metrics: {
      frequency_hz: 50.0,
      bus_voltage_v: 240.0,
      total_generation_kw: 495.0,
      total_demand_kw: 348.0,
      transformer_load_pct: 69.6,
      transformer_temp_c: 54.0,
      winding_hotspot_c: 66.4,
      thermal_aging_factor: 0.015,
      forecast_demand_kw: 348.0,
      forecast_error_pct: 0.0,
      corridor_losses_kw: 11.2,
      pcc_breaker_closed: true,
      bess_soc_pct: 78.0,
      bess_dispatch_kw: -25.0,
      clinic_uptime_pct: 100.0,
    },
    nodes,
    recent_events: [
      {
        event_id: 1,
        idempotency_key: 'EVT-INIT-0001A',
        timestamp_utc: new Date().toISOString(),
        trigger_node_id: 'TR-NRB-04',
        previous_state: 'BOOT',
        new_state: 'STABLE',
        action_taken:
          'SCADA telemetry synchronized (50.00 Hz). Kasarani 500kVA load at 69.6%; BESS trickle-charging (-25.0 kW).',
        frequency_at_trigger_hz: 50.0,
        transformer_load_pct: 69.6,
        bess_dispatch_kw: -25.0,
      },
    ],
    subsystems: buildFallbackSubsystems(nodes, 1, 69.6, 50.0, 78.0, -25.0, 'PROPORTIONAL_DROOP'),
  };
}

export default function App() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(createInitialSnapshot);
  const [backendConnected, setBackendConnected] = useState<boolean>(false);
  const [history, setHistory] = useState<
    Array<{ tick: number; freq: number; load: number; bess: number; hotspot: number }>
  >([{ tick: 1, freq: 50.0, load: 69.6, bess: -25.0, hotspot: 66.4 }]);
  const [activeTab, setActiveTab] = useState<
    'SLD_MATRIX' | 'TOPOLOGY' | 'DISPATCH_SYNC' | 'PROTOCOL_SQL'
  >('SLD_MATRIX');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('TR-NRB-04');

  const wsRef = useRef<WebSocket | null>(null);
  const localSimRef = useRef({
    scenario: 'NOMINAL',
    autoBalancer: true,
    strategy: 'PROPORTIONAL_DROOP',
    soc: 78.0,
    temp: 54.0,
    tick: 1,
    state: 'STABLE',
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket('ws://localhost:8000/ws');
      wsRef.current = ws;

      ws.onopen = () => {
        setBackendConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data: TelemetrySnapshot = JSON.parse(event.data);
          setSnapshot(data);
          const hs =
            data.metrics.winding_hotspot_c ??
            Number(
              (
                data.metrics.transformer_temp_c +
                22.0 * Math.pow(data.metrics.transformer_load_pct / 100.0, 1.6)
              ).toFixed(1)
            );
          setHistory((prev) => [
            ...prev.slice(-39),
            {
              tick: data.tick,
              freq: data.metrics.frequency_hz,
              load: data.metrics.transformer_load_pct,
              bess: data.metrics.bess_dispatch_kw,
              hotspot: hs,
            },
          ]);
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        setBackendConnected(false);
      };

      ws.onerror = () => {
        setBackendConnected(false);
      };
    } catch {
      setBackendConnected(false);
    }

    return () => {
      if (ws) ws.close();
    };
  }, []);

  useEffect(() => {
    if (backendConnected) return;

    const timer = setInterval(() => {
      setSnapshot((prev) => {
        const sim = localSimRef.current;
        sim.tick += 1;

        let baseGeo = 310.0;
        let baseSol = 185.0;
        const baseClinic = 108.0;
        let baseComm = 240.0;

        if (sim.scenario === 'EVENING_PEAK') {
          baseSol = 25.0;
          baseComm = 385.0;
          baseGeo = 315.0;
        } else if (sim.scenario === 'CLOUD_TRANSIENT') {
          baseSol = 35.0;
          baseComm = 290.0;
        } else if (sim.scenario === 'UPSTREAM_BLACKOUT') {
          baseGeo = 0.0;
          baseSol = 165.0;
          baseComm = 250.0;
        }

        const geo = baseGeo > 0 ? Math.max(0, baseGeo + (Math.random() * 5 - 2.5)) : 0;
        const sol = Math.max(0, baseSol + (Math.random() * 5 - 2.5));
        const clinic = baseClinic + (Math.random() * 2.4 - 1.2);
        const rawComm = baseComm + (Math.random() * 6 - 3);

        const unmitigated = clinic + rawComm;
        const availGen = geo + sol;
        const ratedKva = 500.0;

        let bessKw = 0.0;
        let curtailment = 1.0;
        let newState = sim.state;
        let actionMsg: string | null = null;

        if (sim.autoBalancer) {
          if (geo === 0) {
            newState = 'FAULT_ISLANDING';
            curtailment = 0.55;
            const effComm = rawComm * curtailment;
            bessKw = Math.min(250.0, Math.max(0, clinic + effComm - sol));
            if (sim.state !== 'FAULT_ISLANDING') {
              actionMsg = `52-PCC Breaker Opened: Islanded on Solar + BESS (${bessKw.toFixed(1)} kW). Clinic 100% protected; SME load curtailed to 55%.`;
            }
          } else if (sim.strategy === 'AGGRESSIVE_PEAK_SHAVING') {
            const cap = ratedKva * 0.68;
            if (unmitigated > cap && sim.soc > 20) {
              bessKw = Math.min(250.0, unmitigated - cap);
              newState = 'BESS_DISPATCH_ACTIVE';
            } else {
              bessKw = -35.0;
              newState = 'STABLE';
            }
            if (sim.state !== newState) {
              actionMsg = `[AGGRESSIVE_PEAK_SHAVING] Capping TR-NRB-04 at 68% rating via BESS (${bessKw.toFixed(1)} kW).`;
            }
          } else if (sim.strategy === 'CONSERVATIVE_CLINIC_RESERVE') {
            const projLoad = (unmitigated / ratedKva) * 100.0;
            if (projLoad > 80.0) {
              curtailment = 0.68;
              newState = 'DEMAND_RESPONSE_SHED';
              const red = unmitigated * 0.8;
              bessKw = red > ratedKva * 0.82 ? Math.min(250, red - ratedKva * 0.78) : 0.0;
            } else {
              bessKw = -40.0;
              newState = 'STABLE';
            }
            if (sim.state !== newState) {
              actionMsg = `[CONSERVATIVE_CLINIC_RESERVE] Preserving LFP reserve for clinic islanding; SME load factor=${Math.round(curtailment * 100)}%.`;
            }
          } else {
            const projLoad = (unmitigated / ratedKva) * 100.0;
            const netImb = availGen - unmitigated;
            if (projLoad > 82.0 || netImb < -15.0) {
              const needed = Math.max(unmitigated - ratedKva * 0.76, -netImb);
              bessKw = Math.min(250.0, Math.max(20.0, needed));
              const resLoad = ((unmitigated - bessKw) / ratedKva) * 100.0;
              if (resLoad > 88.0) {
                curtailment = 0.72;
                newState = 'DEMAND_RESPONSE_SHED';
                if (sim.state !== 'DEMAND_RESPONSE_SHED') {
                  actionMsg = `[PROPORTIONAL_DROOP] Dispatched BESS (${bessKw.toFixed(1)} kW) + Demand-Response: curtailed SME load by 28%.`;
                }
              } else {
                newState = 'BESS_DISPATCH_ACTIVE';
                if (sim.state !== 'BESS_DISPATCH_ACTIVE') {
                  actionMsg = `[PROPORTIONAL_DROOP] Automated Peak Shaving: BESS injecting ${bessKw.toFixed(1)} kW to relieve TR-NRB-04.`;
                }
              }
            } else {
              newState = 'STABLE';
              bessKw = sim.soc < 94 ? -25.0 : 0.0;
              if (sim.state !== 'STABLE') {
                actionMsg =
                  'Corridor telemetry returned to 50.00 Hz nominal band. Restored 100% SME feeder allocation.';
              }
            }
          }
        } else {
          bessKw = 0.0;
          curtailment = 1.0;
          if (geo === 0 || (unmitigated / ratedKva) * 100.0 > 88.0) {
            newState = 'CRITICAL_OVERLOAD_UNPROTECTED';
            if (sim.state !== 'CRITICAL_OVERLOAD_UNPROTECTED') {
              actionMsg =
                'PROTECTION BYPASSED: TR-NRB-04 exceeding thermal rating; bus frequency collapsing below 49.20 Hz trip limit.';
            }
          } else {
            newState = 'STABLE';
          }
        }

        sim.state = newState;
        const effComm = rawComm * curtailment;
        const totalDemand = clinic + effComm;
        let trFlow = Math.max(0, totalDemand - Math.max(0, bessKw));
        if (bessKw < 0) trFlow += Math.abs(bessKw);
        const trLoadPct = Math.min(132.0, (trFlow / ratedKva) * 100.0);

        sim.soc = Math.max(5.0, Math.min(100.0, sim.soc - (bessKw / 400.0) * 0.18));
        const targetTemp = 34.0 + Math.pow(trLoadPct / 100.0, 1.7) * 52.0;
        sim.temp = sim.temp * 0.82 + targetTemp * 0.18;

        const loadRatioK = trLoadPct / 100.0;
        const windingHotspotC = sim.temp + 22.0 * Math.pow(loadRatioK, 1.6);
        const thermalAgingFactor = Math.exp(15000.0 / 383.0 - 15000.0 / (windingHotspotC + 273.0));
        const baselineForecastKw = sim.scenario === 'NOMINAL' ? 348.0 : 365.0;
        const forecastErrorPct = ((unmitigated - baselineForecastKw) / baselineForecastKw) * 100.0;
        const corridorLossesKw = Number((4.2 + Math.pow(loadRatioK, 2) * 14.5).toFixed(1));

        let freq = 50.0;
        let volt = 240.0;
        if (newState === 'CRITICAL_OVERLOAD_UNPROTECTED') {
          freq = 49.12 + (Math.random() * 0.08 - 0.04);
          volt = 204.5 + (Math.random() * 3 - 1.5);
        } else if (newState === 'FAULT_ISLANDING') {
          freq = 49.89 + (Math.random() * 0.04 - 0.02);
          volt = 236.8 + (Math.random() * 1.4 - 0.7);
        } else {
          const bal = geo + sol + bessKw - totalDemand;
          freq = 50.0 + Math.max(-0.5, Math.min(0.25, (bal / 500.0) * 0.35));
          volt = 242.0 - Math.max(0, (trLoadPct - 50) * 0.16);
        }

        const updatedNodes: GridNode[] = [
          {
            node_id: 'GEN-OLK-01',
            node_name: 'Olkaria Geothermal Feeder',
            node_type: 'GENERATION',
            region: 'Rift Valley',
            rated_capacity_kw: 450.0,
            active_power_kw: Number(geo.toFixed(1)),
            load_pct: Number(((geo / 450.0) * 100).toFixed(1)),
            voltage_v: geo > 0 ? Number(volt.toFixed(1)) : 0.0,
            frequency_hz: geo > 0 ? Number(freq.toFixed(2)) : 0.0,
            temperature_c: 42.5,
            status: geo === 0 ? 'OFFLINE_FAULT' : 'ONLINE',
          },
          {
            node_id: 'GEN-SOL-02',
            node_name: 'Nakuru Solar PV Array',
            node_type: 'GENERATION',
            region: 'Rift Valley',
            rated_capacity_kw: 280.0,
            active_power_kw: Number(sol.toFixed(1)),
            load_pct: Number(((sol / 280.0) * 100).toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: Number((31.0 + (sol / 280.0) * 18.0).toFixed(1)),
            status: sol < 60 ? 'LOW_IRRADIANCE' : 'ONLINE',
          },
          {
            node_id: 'TR-NRB-04',
            node_name: 'Kasarani 500kVA Step-Down',
            node_type: 'TRANSFORMER',
            region: 'Nairobi North',
            rated_capacity_kw: 500.0,
            active_power_kw: Number(trFlow.toFixed(1)),
            load_pct: Number(trLoadPct.toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: Number(sim.temp.toFixed(1)),
            status:
              trLoadPct > 90
                ? 'CRITICAL_OVERLOAD'
                : trLoadPct > 78
                ? 'HIGH_LOAD_GUARD'
                : 'NOMINAL',
          },
          {
            node_id: 'BESS-KSM-01',
            node_name: 'GridPulse LFP Storage (400kWh)',
            node_type: 'STORAGE',
            region: 'Nairobi North',
            rated_capacity_kw: 250.0,
            active_power_kw: Number(bessKw.toFixed(1)),
            load_pct: Number(((Math.abs(bessKw) / 250.0) * 100).toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: Number((29.5 + (Math.abs(bessKw) / 250.0) * 11.0).toFixed(1)),
            status:
              bessKw > 0
                ? 'DISCHARGING_SUPPORT'
                : bessKw < 0
                ? 'CHARGING_SURPLUS'
                : 'STANDBY_IDLE',
          },
          {
            node_id: 'LOAD-HOSP-01',
            node_name: 'Sub-County Referral Clinic',
            node_type: 'LOAD_CRITICAL',
            region: 'Nairobi North',
            rated_capacity_kw: 140.0,
            active_power_kw: Number(clinic.toFixed(1)),
            load_pct: Number(((clinic / 140.0) * 100).toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: 26.0,
            status: 'PROTECTED_PRIORITY_1',
          },
          {
            node_id: 'LOAD-COMM-02',
            node_name: 'SME Cold-Storage & Agro Hub',
            node_type: 'LOAD_FLEXIBLE',
            region: 'Nairobi North',
            rated_capacity_kw: 320.0,
            active_power_kw: Number(effComm.toFixed(1)),
            load_pct: Number(((effComm / 320.0) * 100).toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: 28.0,
            status:
              curtailment < 1.0
                ? `CURTAILED_${Math.round((1 - curtailment) * 100)}PCT`
                : 'NOMINAL',
          },
        ];

        const events = [...prev.recent_events];
        if (actionMsg) {
          events.unshift({
            event_id: events.length + 1,
            idempotency_key: `EVT-${sim.tick}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
            timestamp_utc: new Date().toISOString(),
            trigger_node_id: geo === 0 ? 'GEN-OLK-01' : 'TR-NRB-04',
            previous_state: prev.system_state,
            new_state: newState,
            action_taken: actionMsg,
            frequency_at_trigger_hz: Number(freq.toFixed(2)),
            transformer_load_pct: Number(trLoadPct.toFixed(1)),
            bess_dispatch_kw: Number(bessKw.toFixed(1)),
          });
        }

        const nextFreq = Number(freq.toFixed(2));
        const nextLoad = Number(trLoadPct.toFixed(1));
        const nextBess = Number(bessKw.toFixed(1));
        const nextHotspot = Number(windingHotspotC.toFixed(1));

        setHistory((h) => [
          ...h.slice(-39),
          {
            tick: sim.tick,
            freq: nextFreq,
            load: nextLoad,
            bess: nextBess,
            hotspot: nextHotspot,
          },
        ]);

        return {
          timestamp_utc: new Date().toISOString(),
          tick: sim.tick,
          system_state: newState,
          active_scenario: sim.scenario,
          auto_balancer_enabled: sim.autoBalancer,
          active_strategy: sim.strategy,
          metrics: {
            frequency_hz: nextFreq,
            bus_voltage_v: Number(volt.toFixed(1)),
            total_generation_kw: Number((geo + sol).toFixed(1)),
            total_demand_kw: Number(totalDemand.toFixed(1)),
            transformer_load_pct: nextLoad,
            transformer_temp_c: Number(sim.temp.toFixed(1)),
            winding_hotspot_c: nextHotspot,
            thermal_aging_factor: Number(thermalAgingFactor.toFixed(3)),
            forecast_demand_kw: baselineForecastKw,
            forecast_error_pct: Number(forecastErrorPct.toFixed(1)),
            corridor_losses_kw: corridorLossesKw,
            pcc_breaker_closed: geo > 0,
            bess_soc_pct: Number(sim.soc.toFixed(1)),
            bess_dispatch_kw: nextBess,
            clinic_uptime_pct: 100.0,
          },
          nodes: updatedNodes,
          recent_events: events.slice(0, 12),
          subsystems: buildFallbackSubsystems(
            updatedNodes,
            sim.tick,
            nextLoad,
            nextFreq,
            Number(sim.soc.toFixed(1)),
            nextBess,
            sim.strategy
          ),
        };
      });
    }, 1500);

    return () => clearInterval(timer);
  }, [backendConnected]);

  const triggerScenario = async (scenarioId: string) => {
    localSimRef.current.scenario = scenarioId;
    if (backendConnected) {
      try {
        await fetch('http://localhost:8000/api/scenario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: scenarioId }),
        });
      } catch {
        // fallback handled locally
      }
    }
  };

  const toggleAutoBalancer = async () => {
    const nextVal = !snapshot.auto_balancer_enabled;
    localSimRef.current.autoBalancer = nextVal;
    if (backendConnected) {
      try {
        await fetch('http://localhost:8000/api/balancer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: nextVal }),
        });
      } catch {
        // fallback
      }
    }
  };

  const changeStrategy = async (strategyId: string) => {
    localSimRef.current.strategy = strategyId;
    if (backendConnected) {
      try {
        await fetch('http://localhost:8000/api/strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: strategyId }),
        });
      } catch {
        // fallback
      }
    }
  };

  const { metrics, system_state, active_scenario, auto_balancer_enabled, subsystems } = snapshot;

  const windingHotspot =
    metrics.winding_hotspot_c ??
    Number(
      (
        metrics.transformer_temp_c +
        22.0 * Math.pow(metrics.transformer_load_pct / 100.0, 1.6)
      ).toFixed(1)
    );
  const agingFactor =
    metrics.thermal_aging_factor ??
    Number(Math.exp(15000.0 / 383.0 - 15000.0 / (windingHotspot + 273.0)).toFixed(3));
  const forecastKw = metrics.forecast_demand_kw ?? 348.0;
  const forecastErr =
    metrics.forecast_error_pct ??
    Number((((metrics.total_demand_kw - forecastKw) / forecastKw) * 100).toFixed(1));
  const lossesKw =
    metrics.corridor_losses_kw ??
    Number((4.2 + Math.pow(metrics.transformer_load_pct / 100.0, 2) * 14.5).toFixed(1));
  const pccClosed =
    metrics.pcc_breaker_closed ??
    (snapshot.nodes.find((n) => n.node_id === 'GEN-OLK-01')?.active_power_kw ?? 0) > 0;

  const selectedNode =
    snapshot.nodes.find((n) => n.node_id === selectedNodeId) ?? snapshot.nodes[2];
  const selectedRtuFrame = subsystems?.rtu_frames.find(
    (f) => f.node_id === selectedNode.node_id
  );

  const hospitalRoute = subsystems?.network_routing.hospital_route.path ?? [
    'GEN-OLK-01',
    'TR-NRB-04',
    'LOAD-HOSP-01',
  ];

  const isEdgeOnRoute = (a: string, b: string) => {
    for (let i = 0; i < hospitalRoute.length - 1; i++) {
      if (
        (hospitalRoute[i] === a && hospitalRoute[i + 1] === b) ||
        (hospitalRoute[i] === b && hospitalRoute[i + 1] === a)
      ) {
        return true;
      }
    }
    return false;
  };

  const stateColorText = (state: string) => {
    if (state === 'STABLE') return 'text-[#3fb950]';
    if (state === 'BESS_DISPATCH_ACTIVE') return 'text-[#58a6ff]';
    if (state === 'DEMAND_RESPONSE_SHED') return 'text-[#d29922]';
    return 'text-[#f85149]';
  };

  const stateDotColor = (state: string) => {
    if (state === 'STABLE') return 'bg-[#3fb950]';
    if (state === 'BESS_DISPATCH_ACTIVE') return 'bg-[#58a6ff]';
    if (state === 'DEMAND_RESPONSE_SHED') return 'bg-[#d29922]';
    return 'bg-[#f85149]';
  };

  const nodeById = (id: string) => snapshot.nodes.find((n) => n.node_id === id);

  return (
    <div className="min-h-screen bg-[#0a0c10] text-[#e6edf3] flex flex-col select-none">
      {/* TOP SCADA COMMAND BAR */}
      <header className="h-11 border-b border-[#1e2430] bg-[#0d1017] px-4 flex items-center justify-between text-xs">
        <div className="flex items-center divide-x divide-[#1e2430]">
          <div className="pr-3 flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-[#3fb950]" />
            <span className="font-mono font-bold tracking-wider text-[#f0f6fc]">GRIDPULSE</span>
            <span className="font-mono text-[10px] text-[#8b949e]">v2.4</span>
          </div>
          <div className="px-3 font-mono text-[11px] text-[#8b949e] hidden sm:block">
            FEEDER: <span className="text-[#e6edf3]">KE-RIFT-NRB-04 (11kV/240V)</span>
          </div>
          <div className="px-3 font-mono text-[11px] text-[#8b949e] hidden md:block">
            LINK:{' '}
            <span className={backendConnected ? 'text-[#3fb950]' : 'text-[#d29922]'}>
              {backendConnected ? 'WS://127.0.0.1:8000 [SQLITE-WAL]' : 'LOCAL-TWIN-FALLBACK'}
            </span>
          </div>
          <div className="px-3 font-mono text-[11px] text-[#8b949e] hidden lg:block">
            CYCLE: <span className="text-[#e6edf3] tabular-nums">#{String(snapshot.tick).padStart(5, '0')}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center border border-[#1e2430] bg-[#0a0c10]">
            {SCENARIOS.map((scn) => {
              const active = active_scenario === scn.id;
              return (
                <button
                  key={scn.id}
                  onClick={() => triggerScenario(scn.id)}
                  className={`px-2.5 py-1 font-mono text-[10px] tracking-tight transition-colors border-r last:border-r-0 border-[#1e2430] ${
                    active
                      ? scn.id === 'UPSTREAM_BLACKOUT'
                        ? 'bg-[#f85149]/20 text-[#f85149] font-semibold'
                        : scn.id === 'NOMINAL'
                        ? 'bg-[#3fb950]/15 text-[#3fb950] font-semibold'
                        : 'bg-[#d29922]/20 text-[#d29922] font-semibold'
                      : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]'
                  }`}
                >
                  {scn.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={toggleAutoBalancer}
            className={`px-2.5 py-1 font-mono text-[10px] border transition-colors ${
              auto_balancer_enabled
                ? 'border-[#2ea043] bg-[#2ea043]/15 text-[#3fb950]'
                : 'border-[#f85149] bg-[#f85149]/15 text-[#f85149]'
            }`}
          >
            AUTO-PROTECT: {auto_balancer_enabled ? 'ARMED' : 'BYPASSED'}
          </button>
        </div>
      </header>

      {/* 8-CELL HAIRLINE TELEMETRY RIBBON */}
      <section className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 divide-x divide-y lg:divide-y-0 divide-[#1e2430] border-b border-[#1e2430] bg-[#0d1017]">
        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>BUS FREQUENCY</span>
            <span>NOM 50.00</span>
          </div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              metrics.frequency_hz < 49.5 ? 'text-[#f85149]' : 'text-[#f0f6fc]'
            }`}
          >
            {metrics.frequency_hz.toFixed(2)} <span className="text-xs font-normal text-[#8b949e]">Hz</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            DEV: {(metrics.frequency_hz - 50.0 >= 0 ? '+' : '') + (metrics.frequency_hz - 50.0).toFixed(2)} Hz
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>SECONDARY BUS</span>
            <span>52-PCC: {pccClosed ? 'CLSD' : 'OPEN'}</span>
          </div>
          <div className="mt-1 font-mono text-lg font-semibold text-[#f0f6fc] tabular-nums">
            {metrics.bus_voltage_v.toFixed(1)} <span className="text-xs font-normal text-[#8b949e]">V</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            PU: {(metrics.bus_voltage_v / 240.0).toFixed(3)} pu
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>GENERATION</span>
            <span>GEO + PV</span>
          </div>
          <div className="mt-1 font-mono text-lg font-semibold text-[#f0f6fc] tabular-nums">
            {metrics.total_generation_kw.toFixed(1)} <span className="text-xs font-normal text-[#8b949e]">kW</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            LOSS (I²R): {lossesKw.toFixed(1)} kW
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>CORRIDOR DEMAND</span>
            <span>FCST {forecastKw.toFixed(0)}</span>
          </div>
          <div className="mt-1 font-mono text-lg font-semibold text-[#f0f6fc] tabular-nums">
            {metrics.total_demand_kw.toFixed(1)} <span className="text-xs font-normal text-[#8b949e]">kW</span>
          </div>
          <div
            className={`mt-0.5 font-mono text-[10px] tabular-nums ${
              Math.abs(forecastErr) > 15 ? 'text-[#d29922]' : 'text-[#8b949e]'
            }`}
          >
            ERR: {(forecastErr >= 0 ? '+' : '') + forecastErr.toFixed(1)}%
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>TR-NRB-04 LOAD</span>
            <span>500 kVA</span>
          </div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              metrics.transformer_load_pct > 88
                ? 'text-[#f85149]'
                : metrics.transformer_load_pct > 78
                ? 'text-[#d29922]'
                : 'text-[#f0f6fc]'
            }`}
          >
            {metrics.transformer_load_pct.toFixed(1)} <span className="text-xs font-normal text-[#8b949e]">%</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            TOP OIL: {metrics.transformer_temp_c.toFixed(1)} °C
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>IEC 60076-7 HOTSPOT</span>
            <span>THERMAL</span>
          </div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              windingHotspot > 95 ? 'text-[#f85149]' : windingHotspot > 80 ? 'text-[#d29922]' : 'text-[#f0f6fc]'
            }`}
          >
            {windingHotspot.toFixed(1)} <span className="text-xs font-normal text-[#8b949e]">°C</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            AGING F_AA: {agingFactor.toFixed(3)}x
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>BESS-KSM-01 PCS</span>
            <span>SOC {metrics.bess_soc_pct.toFixed(1)}%</span>
          </div>
          <div
            className={`mt-1 font-mono text-lg font-semibold tabular-nums ${
              metrics.bess_dispatch_kw > 0
                ? 'text-[#58a6ff]'
                : metrics.bess_dispatch_kw < 0
                ? 'text-[#3fb950]'
                : 'text-[#f0f6fc]'
            }`}
          >
            {(metrics.bess_dispatch_kw > 0 ? '+' : '') + metrics.bess_dispatch_kw.toFixed(1)}{' '}
            <span className="text-xs font-normal text-[#8b949e]">kW</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#8b949e] tabular-nums">
            {metrics.bess_dispatch_kw > 0
              ? 'INJECTING PEAK SUPPORT'
              : metrics.bess_dispatch_kw < 0
              ? 'ABSORBING PV SURPLUS'
              : 'STANDBY'}
          </div>
        </div>

        <div className="p-2.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-[#8b949e]">
            <span>PROTECTION FSM</span>
            <span>CLINIC 100%</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 ${stateDotColor(system_state)}`} />
            <span className={`font-mono text-xs font-bold tracking-tight truncate ${stateColorText(system_state)}`}>
              {system_state}
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-[#8b949e]">
            INTERLOCK:{' '}
            <span
              className={
                subsystems?.safety_interlock.invariant_satisfied ? 'text-[#3fb950]' : 'text-[#f85149]'
              }
            >
              {subsystems?.safety_interlock.invariant_satisfied ? 'PHI_SAFE VALID' : 'TRIP REQ'}
            </span>
          </div>
        </div>
      </section>

      {/* SUB-VIEW NAVIGATION BAR */}
      <nav className="h-9 border-b border-[#1e2430] bg-[#0a0c10] px-4 flex items-center justify-between text-xs font-mono">
        <div className="flex items-center h-full">
          {[
            { id: 'SLD_MATRIX', label: '01 // SLD & ASSET MATRIX' },
            { id: 'TOPOLOGY', label: '02 // NETWORK TOPOLOGY & IMPEDANCE' },
            { id: 'DISPATCH_SYNC', label: '03 // DISPATCH LAWS & RING BUFFER' },
            { id: 'PROTOCOL_SQL', label: '04 // 64-BIT RTU FRAMES, INTERLOCK & SQL' },
          ].map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`h-full px-4 border-r border-[#1e2430] text-[11px] tracking-tight transition-colors ${
                  active
                    ? 'bg-[#161b22] text-[#f0f6fc] font-semibold border-b-2 border-b-[#58a6ff]'
                    : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#0d1017]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="hidden xl:flex items-center gap-4 text-[11px] text-[#8b949e]">
          <span>
            ACTIVE LAW:{' '}
            <strong className="text-[#e6edf3]">
              {subsystems?.dispatch_architecture.active_strategy ?? snapshot.active_strategy}
            </strong>
          </span>
          <span>
            HOSPITAL ROUTE:{' '}
            <strong className="text-[#3fb950]">{hospitalRoute.join(' -> ')}</strong>
          </span>
        </div>
      </nav>

      {/* MAIN WORKBENCH CONTENT */}
      <main className="flex-1 flex flex-col">
        {activeTab === 'SLD_MATRIX' && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[#1e2430]">
            {/* LEFT 8 COLUMNS: INTERACTIVE SINGLE-LINE DIAGRAM + ASSET TELEMETRY MATRIX */}
            <div className="lg:col-span-8 flex flex-col divide-y divide-[#1e2430]">
              {/* INTERACTIVE IEEE SINGLE-LINE DIAGRAM (SLD) */}
              <div className="p-3 bg-[#0a0c10]">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-[#8b949e] uppercase">
                      SINGLE-LINE SCHEMATIC // CLICK ANY ASSET NODE TO INSPECT REGISTERS
                    </span>
                  </div>
                  <div className="flex items-center gap-4 font-mono text-[10px] text-[#8b949e]">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-0.5 bg-[#3fb950]" /> DIJKSTRA HOSPITAL ROUTE
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-0.5 bg-[#30363d]" /> SECONDARY FEEDER
                    </span>
                  </div>
                </div>

                <div className="border border-[#1e2430] bg-[#07090d] p-2">
                  <svg viewBox="0 0 880 280" className="w-full h-auto font-mono">
                    {/* 11kV PRIMARY BUSBAR */}
                    <line x1="210" y1="30" x2="210" y2="250" stroke="#30363d" strokeWidth="3" />
                    <text x="210" y="18" fill="#8b949e" fontSize="9" textAnchor="middle">
                      11kV PRIMARY BUS
                    </text>

                    {/* 240V SECONDARY BUSBAR */}
                    <line x1="600" y1="30" x2="600" y2="250" stroke="#30363d" strokeWidth="3" />
                    <text x="600" y="18" fill="#8b949e" fontSize="9" textAnchor="middle">
                      240V MICROGRID BUS
                    </text>

                    {/* FEEDER LINES */}
                    {/* GEN-OLK-01 to TR-NRB-04 via 52-PCC */}
                    <line
                      x1="165"
                      y1="75"
                      x2="310"
                      y2="95"
                      stroke={
                        !pccClosed
                          ? '#f85149'
                          : isEdgeOnRoute('GEN-OLK-01', 'TR-NRB-04')
                          ? '#3fb950'
                          : '#484f58'
                      }
                      strokeWidth={isEdgeOnRoute('GEN-OLK-01', 'TR-NRB-04') ? '2.2' : '1.4'}
                      strokeDasharray={!pccClosed ? '4 3' : undefined}
                    />
                    {/* 52-PCC Breaker Symbol */}
                    <rect
                      x="228"
                      y="76"
                      width="14"
                      height="14"
                      fill={pccClosed ? '#2ea043' : '#0a0c10'}
                      stroke={pccClosed ? '#3fb950' : '#f85149'}
                      strokeWidth="1.5"
                    />
                    <text x="235" y="102" fill="#8b949e" fontSize="8" textAnchor="middle">
                      52-PCC
                    </text>

                    {/* GEN-SOL-02 to TR-NRB-04 */}
                    <line
                      x1="165"
                      y1="195"
                      x2="310"
                      y2="110"
                      stroke={isEdgeOnRoute('GEN-SOL-02', 'TR-NRB-04') ? '#3fb950' : '#30363d'}
                      strokeWidth="1.4"
                    />

                    {/* GEN-SOL-02 to BESS-KSM-01 DC-Coupled Tie */}
                    <line
                      x1="165"
                      y1="205"
                      x2="310"
                      y2="205"
                      stroke={isEdgeOnRoute('GEN-SOL-02', 'BESS-KSM-01') ? '#3fb950' : '#484f58'}
                      strokeWidth={isEdgeOnRoute('GEN-SOL-02', 'BESS-KSM-01') ? '2.2' : '1.4'}
                    />

                    {/* TR-NRB-04 to BESS-KSM-01 */}
                    <line
                      x1="395"
                      y1="130"
                      x2="395"
                      y2="170"
                      stroke={isEdgeOnRoute('TR-NRB-04', 'BESS-KSM-01') ? '#3fb950' : '#58a6ff'}
                      strokeWidth={isEdgeOnRoute('TR-NRB-04', 'BESS-KSM-01') ? '2.2' : '1.5'}
                    />

                    {/* TR-NRB-04 to LOAD-HOSP-01 */}
                    <line
                      x1="480"
                      y1="95"
                      x2="685"
                      y2="75"
                      stroke={isEdgeOnRoute('TR-NRB-04', 'LOAD-HOSP-01') ? '#3fb950' : '#484f58'}
                      strokeWidth={isEdgeOnRoute('TR-NRB-04', 'LOAD-HOSP-01') ? '2.4' : '1.4'}
                    />

                    {/* BESS-KSM-01 to LOAD-HOSP-01 */}
                    <line
                      x1="480"
                      y1="195"
                      x2="685"
                      y2="85"
                      stroke={isEdgeOnRoute('BESS-KSM-01', 'LOAD-HOSP-01') ? '#3fb950' : '#30363d'}
                      strokeWidth={isEdgeOnRoute('BESS-KSM-01', 'LOAD-HOSP-01') ? '2.4' : '1.4'}
                    />

                    {/* BESS-KSM-01 / Secondary Bus to LOAD-COMM-02 */}
                    <line
                      x1="480"
                      y1="205"
                      x2="685"
                      y2="205"
                      stroke="#484f58"
                      strokeWidth="1.4"
                    />

                    {/* NODE 1: GEN-OLK-01 */}
                    {(() => {
                      const n = nodeById('GEN-OLK-01')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="15"
                            y="42"
                            width="150"
                            height="66"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={
                              n.active_power_kw === 0
                                ? '#f85149'
                                : sel
                                ? '#f0f6fc'
                                : '#30363d'
                            }
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="25" y="58" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            GEN-OLK-01
                          </text>
                          <text x="25" y="72" fill="#8b949e" fontSize="9">
                            Olkaria Geothermal
                          </text>
                          <text
                            x="25"
                            y="96"
                            fill={n.active_power_kw === 0 ? '#f85149' : '#3fb950'}
                            fontSize="11"
                            fontWeight="700"
                          >
                            {n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="155" y="96" fill="#8b949e" fontSize="9" textAnchor="end">
                            {n.load_pct.toFixed(0)}%
                          </text>
                        </g>
                      );
                    })()}

                    {/* NODE 2: GEN-SOL-02 */}
                    {(() => {
                      const n = nodeById('GEN-SOL-02')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="15"
                            y="170"
                            width="150"
                            height="66"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={sel ? '#f0f6fc' : '#30363d'}
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="25" y="186" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            GEN-SOL-02
                          </text>
                          <text x="25" y="200" fill="#8b949e" fontSize="9">
                            Nakuru Solar Array
                          </text>
                          <text x="25" y="224" fill="#d29922" fontSize="11" fontWeight="700">
                            {n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="155" y="224" fill="#8b949e" fontSize="9" textAnchor="end">
                            {n.load_pct.toFixed(0)}%
                          </text>
                        </g>
                      );
                    })()}

                    {/* NODE 3: TR-NRB-04 */}
                    {(() => {
                      const n = nodeById('TR-NRB-04')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="310"
                            y="60"
                            width="170"
                            height="70"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={
                              n.load_pct > 88
                                ? '#f85149'
                                : n.load_pct > 78
                                ? '#d29922'
                                : sel
                                ? '#f0f6fc'
                                : '#30363d'
                            }
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="320" y="76" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            TR-NRB-04 (500kVA)
                          </text>
                          <text x="320" y="90" fill="#8b949e" fontSize="9">
                            Oil: {n.temperature_c.toFixed(1)}°C | HS: {windingHotspot.toFixed(1)}°C
                          </text>
                          <text
                            x="320"
                            y="116"
                            fill={n.load_pct > 85 ? '#f85149' : '#e6edf3'}
                            fontSize="11"
                            fontWeight="700"
                          >
                            {n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="470" y="116" fill="#8b949e" fontSize="9" textAnchor="end">
                            LOAD {n.load_pct.toFixed(1)}%
                          </text>
                        </g>
                      );
                    })()}

                    {/* NODE 4: BESS-KSM-01 */}
                    {(() => {
                      const n = nodeById('BESS-KSM-01')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="310"
                            y="170"
                            width="170"
                            height="70"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={
                              n.active_power_kw > 0
                                ? '#58a6ff'
                                : sel
                                ? '#f0f6fc'
                                : '#30363d'
                            }
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="320" y="186" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            BESS-KSM-01 (LFP)
                          </text>
                          <text x="320" y="200" fill="#8b949e" fontSize="9">
                            SoC: {metrics.bess_soc_pct.toFixed(1)}% | 400kWh
                          </text>
                          <text
                            x="320"
                            y="226"
                            fill={n.active_power_kw > 0 ? '#58a6ff' : '#3fb950'}
                            fontSize="11"
                            fontWeight="700"
                          >
                            {(n.active_power_kw > 0 ? '+' : '') + n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="470" y="226" fill="#8b949e" fontSize="9" textAnchor="end">
                            {n.active_power_kw > 0 ? 'DISCHG' : n.active_power_kw < 0 ? 'CHARGE' : 'IDLE'}
                          </text>
                        </g>
                      );
                    })()}

                    {/* NODE 5: LOAD-HOSP-01 */}
                    {(() => {
                      const n = nodeById('LOAD-HOSP-01')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="685"
                            y="42"
                            width="180"
                            height="66"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={sel ? '#f0f6fc' : '#2ea043'}
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="695" y="58" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            LOAD-HOSP-01 [PRIO-1]
                          </text>
                          <text x="695" y="72" fill="#8b949e" fontSize="9">
                            Referral Clinic &amp; Maternity
                          </text>
                          <text x="695" y="96" fill="#3fb950" fontSize="11" fontWeight="700">
                            {n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="855" y="96" fill="#3fb950" fontSize="9" textAnchor="end">
                            100% PROTECTED
                          </text>
                        </g>
                      );
                    })()}

                    {/* NODE 6: LOAD-COMM-02 */}
                    {(() => {
                      const n = nodeById('LOAD-COMM-02')!;
                      const sel = selectedNodeId === n.node_id;
                      return (
                        <g
                          onClick={() => setSelectedNodeId(n.node_id)}
                          className="cursor-pointer"
                        >
                          <rect
                            x="685"
                            y="170"
                            width="180"
                            height="66"
                            fill={sel ? '#161b22' : '#0d1017'}
                            stroke={
                              n.status.includes('CURTAILED')
                                ? '#d29922'
                                : sel
                                ? '#f0f6fc'
                                : '#30363d'
                            }
                            strokeWidth={sel ? '1.8' : '1.2'}
                          />
                          <text x="695" y="186" fill="#f0f6fc" fontSize="10" fontWeight="700">
                            LOAD-COMM-02 [FLEX]
                          </text>
                          <text x="695" y="200" fill="#8b949e" fontSize="9">
                            SME Cold-Storage &amp; Agro Hub
                          </text>
                          <text
                            x="695"
                            y="224"
                            fill={n.status.includes('CURTAILED') ? '#d29922' : '#e6edf3'}
                            fontSize="11"
                            fontWeight="700"
                          >
                            {n.active_power_kw.toFixed(1)} kW
                          </text>
                          <text x="855" y="224" fill="#8b949e" fontSize="9" textAnchor="end">
                            {n.status}
                          </text>
                        </g>
                      );
                    })()}
                  </svg>
                </div>
              </div>

              {/* DENSE ASSET TELEMETRY MATRIX TABLE */}
              <div className="p-3 bg-[#0a0c10]">
                <div className="flex items-center justify-between mb-2 font-mono text-[11px]">
                  <span className="text-[#8b949e]">
                    CORRIDOR ASSET TELEMETRY MATRIX (6 NODES // 1500 MS POLLING)
                  </span>
                  <span className="text-[#8b949e]">
                    SELECTED: <strong className="text-[#f0f6fc]">{selectedNode.node_id}</strong>
                  </span>
                </div>
                <div className="overflow-x-auto border border-[#1e2430]">
                  <table className="w-full text-left border-collapse font-mono text-xs">
                    <thead>
                      <tr className="border-b border-[#1e2430] bg-[#0d1017] text-[10px] text-[#8b949e]">
                        <th className="py-2 px-2.5">NODE_ID</th>
                        <th className="py-2 px-2.5">DESIGNATION</th>
                        <th className="py-2 px-2.5">CLASS</th>
                        <th className="py-2 px-2.5 text-right">ACTIVE_P</th>
                        <th className="py-2 px-2.5 text-right">RATED</th>
                        <th className="py-2 px-2.5 text-right">LOAD_%</th>
                        <th className="py-2 px-2.5 text-right">BUS_V</th>
                        <th className="py-2 px-2.5 text-right">TEMP</th>
                        <th className="py-2 px-2.5">STATUS</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2430] tabular-nums">
                      {snapshot.nodes.map((node) => {
                        const isSelected = node.node_id === selectedNode.node_id;
                        return (
                          <tr
                            key={node.node_id}
                            onClick={() => setSelectedNodeId(node.node_id)}
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-[#161b22] text-[#f0f6fc]'
                                : 'hover:bg-[#0d1017] text-[#c9d1d9]'
                            }`}
                          >
                            <td className="py-2 px-2.5 font-semibold text-[#58a6ff]">
                              {node.node_id}
                            </td>
                            <td className="py-2 px-2.5 font-sans text-xs">{node.node_name}</td>
                            <td className="py-2 px-2.5 text-[10px] text-[#8b949e]">
                              {node.node_type}
                            </td>
                            <td className="py-2 px-2.5 text-right font-semibold">
                              {node.active_power_kw.toFixed(1)} kW
                            </td>
                            <td className="py-2 px-2.5 text-right text-[#8b949e]">
                              {node.rated_capacity_kw.toFixed(0)} kW
                            </td>
                            <td className="py-2 px-2.5 text-right">
                              <span
                                className={
                                  node.load_pct > 88
                                    ? 'text-[#f85149] font-semibold'
                                    : node.load_pct > 78
                                    ? 'text-[#d29922]'
                                    : 'text-[#e6edf3]'
                                }
                              >
                                {node.load_pct.toFixed(1)}%
                              </span>
                            </td>
                            <td className="py-2 px-2.5 text-right">
                              {node.voltage_v.toFixed(1)} V
                            </td>
                            <td className="py-2 px-2.5 text-right">
                              {node.temperature_c.toFixed(1)} °C
                            </td>
                            <td className="py-2 px-2.5 text-[10px]">
                              <span
                                className={`inline-block px-1.5 py-0.5 border ${
                                  node.status.includes('CRITICAL') ||
                                  node.status.includes('OFFLINE')
                                    ? 'border-[#f85149]/50 bg-[#f85149]/10 text-[#f85149]'
                                    : node.status.includes('CURTAILED') ||
                                      node.status.includes('HIGH_LOAD') ||
                                      node.status.includes('LOW_IRRADIANCE')
                                    ? 'border-[#d29922]/50 bg-[#d29922]/10 text-[#d29922]'
                                    : node.status.includes('DISCHARGING')
                                    ? 'border-[#58a6ff]/50 bg-[#58a6ff]/10 text-[#58a6ff]'
                                    : 'border-[#2ea043]/40 bg-[#2ea043]/10 text-[#3fb950]'
                                }`}
                              >
                                {node.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SQLITE WAL ACID DISPATCH AUDIT LEDGER */}
              <div className="p-3 bg-[#0a0c10] flex-1">
                <div className="flex items-center justify-between mb-2 font-mono text-[11px]">
                  <span className="text-[#8b949e]">
                    ACID STATE TRANSITION &amp; PROTECTION LEDGER (SQLITE WAL // IDEMPOTENT KEYS)
                  </span>
                  <span className="text-[#8b949e]">
                    RECORDS: {snapshot.recent_events.length}
                  </span>
                </div>
                <div className="overflow-x-auto border border-[#1e2430]">
                  <table className="w-full text-left border-collapse font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-[#1e2430] bg-[#0d1017] text-[10px] text-[#8b949e]">
                        <th className="py-1.5 px-2.5">IDEMPOTENCY_KEY</th>
                        <th className="py-1.5 px-2.5">UTC_TIME</th>
                        <th className="py-1.5 px-2.5">TRANSITION</th>
                        <th className="py-1.5 px-2.5 text-right">FREQ</th>
                        <th className="py-1.5 px-2.5 text-right">TR_LOAD</th>
                        <th className="py-1.5 px-2.5 text-right">BESS_P</th>
                        <th className="py-1.5 px-2.5">DISPATCH_ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2430] tabular-nums">
                      {snapshot.recent_events.slice(0, 6).map((evt) => (
                        <tr key={evt.idempotency_key} className="hover:bg-[#0d1017]">
                          <td className="py-1.5 px-2.5 text-[#58a6ff] whitespace-nowrap">
                            {evt.idempotency_key}
                          </td>
                          <td className="py-1.5 px-2.5 text-[#8b949e] whitespace-nowrap">
                            {new Date(evt.timestamp_utc).toISOString().slice(11, 19)}
                          </td>
                          <td className="py-1.5 px-2.5 whitespace-nowrap">
                            <span className="text-[#8b949e]">{evt.previous_state}</span>
                            <span className="mx-1 text-[#484f58]">-&gt;</span>
                            <span className={`font-semibold ${stateColorText(evt.new_state)}`}>
                              {evt.new_state}
                            </span>
                          </td>
                          <td className="py-1.5 px-2.5 text-right whitespace-nowrap">
                            {evt.frequency_at_trigger_hz.toFixed(2)} Hz
                          </td>
                          <td className="py-1.5 px-2.5 text-right whitespace-nowrap">
                            {evt.transformer_load_pct.toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2.5 text-right whitespace-nowrap">
                            {evt.bess_dispatch_kw.toFixed(1)} kW
                          </td>
                          <td className="py-1.5 px-2.5 font-sans text-xs text-[#c9d1d9]">
                            {evt.action_taken}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* RIGHT 4 COLUMNS: NODE REGISTER INSPECTOR + MULTI-TRACE STRIP CHART */}
            <div className="lg:col-span-4 flex flex-col divide-y divide-[#1e2430] bg-[#0d1017]">
              {/* SELECTED ASSET & 64-BIT RTU REGISTER INSPECTOR */}
              <div className="p-3">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#1e2430] font-mono text-[11px]">
                  <span className="text-[#8b949e]">ASSET &amp; RTU REGISTER INSPECTOR</span>
                  <span className="text-[#58a6ff] font-semibold">{selectedNode.node_id}</span>
                </div>

                <div className="grid grid-cols-2 gap-px bg-[#1e2430] border border-[#1e2430] font-mono text-xs mb-3">
                  <div className="bg-[#0a0c10] p-2">
                    <div className="text-[10px] text-[#8b949e]">DESIGNATION</div>
                    <div className="text-[#f0f6fc] font-sans font-medium truncate mt-0.5">
                      {selectedNode.node_name}
                    </div>
                  </div>
                  <div className="bg-[#0a0c10] p-2">
                    <div className="text-[10px] text-[#8b949e]">REGION / ZONE</div>
                    <div className="text-[#f0f6fc] mt-0.5">{selectedNode.region}</div>
                  </div>
                  <div className="bg-[#0a0c10] p-2">
                    <div className="text-[10px] text-[#8b949e]">ACTIVE POWER</div>
                    <div className="text-[#f0f6fc] font-semibold tabular-nums mt-0.5">
                      {selectedNode.active_power_kw.toFixed(1)} / {selectedNode.rated_capacity_kw.toFixed(0)} kW
                    </div>
                  </div>
                  <div className="bg-[#0a0c10] p-2">
                    <div className="text-[10px] text-[#8b949e]">UTILIZATION / TEMP</div>
                    <div className="text-[#f0f6fc] font-semibold tabular-nums mt-0.5">
                      {selectedNode.load_pct.toFixed(1)}% | {selectedNode.temperature_c.toFixed(1)} °C
                    </div>
                  </div>
                </div>

                {selectedRtuFrame && (
                  <div className="border border-[#1e2430] bg-[#0a0c10] p-2.5 font-mono text-[11px]">
                    <div className="flex items-center justify-between text-[10px] text-[#8b949e] mb-1.5">
                      <span>64-BIT RTU WIRE FRAME (BIG-ENDIAN)</span>
                      <span className="text-[#3fb950]">CRC-8 0x07 OK</span>
                    </div>
                    <div className="p-1.5 bg-[#07090d] border border-[#1e2430] text-[#58a6ff] text-xs tracking-wider mb-2">
                      {selectedRtuFrame.hex_frame}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">SYNC [B0]:</span>
                        <span className="text-[#e6edf3]">
                          {selectedRtuFrame.register_breakdown.sync_byte}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">ID|FLG [B1]:</span>
                        <span className="text-[#e6edf3]">
                          {selectedRtuFrame.register_breakdown.id_status_bits}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">VOLT [B2..3]:</span>
                        <span className="text-[#e6edf3]">
                          {selectedRtuFrame.register_breakdown.volt_fixed16}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">FREQ [B4..5]:</span>
                        <span className="text-[#e6edf3]">
                          {selectedRtuFrame.register_breakdown.freq_fixed16}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">LOAD [B6]:</span>
                        <span className="text-[#e6edf3]">
                          {selectedRtuFrame.register_breakdown.load_uint8}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#8b949e]">CRC8 [B7]:</span>
                        <span className="text-[#3fb950]">
                          {selectedRtuFrame.register_breakdown.crc8_checksum}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* MULTI-CHANNEL STRIP CHART RECORDER */}
              <div className="p-3 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#1e2430] font-mono text-[11px]">
                    <span className="text-[#8b949e]">REAL-TIME TELEMETRY STRIP RECORDER</span>
                    <span className="text-[#8b949e]">WINDOW: 40 CYCLES</span>
                  </div>

                  {/* TRACE 1: TRANSFORMER LOAD & HOTSPOT */}
                  <div className="mb-3">
                    <div className="flex justify-between font-mono text-[10px] text-[#8b949e] mb-1">
                      <span>CH1: TR-NRB-04 LOAD (%) &amp; HOTSPOT (°C)</span>
                      <span className="text-[#e6edf3] tabular-nums">
                        {metrics.transformer_load_pct.toFixed(1)}% / {windingHotspot.toFixed(1)}°C
                      </span>
                    </div>
                    <div className="border border-[#1e2430] bg-[#07090d] p-1.5">
                      <svg viewBox="0 0 360 90" className="w-full h-24 overflow-visible">
                        {/* 82% Thermal Guard Line */}
                        <line
                          x1="0"
                          y1={90 - (82 / 140) * 90}
                          x2="360"
                          y2={90 - (82 / 140) * 90}
                          stroke="#d29922"
                          strokeWidth="0.8"
                          strokeDasharray="3 3"
                        />
                        <polyline
                          fill="none"
                          stroke="#58a6ff"
                          strokeWidth="1.6"
                          points={history
                            .map((pt, idx) => {
                              const x = (idx / Math.max(1, history.length - 1)) * 360;
                              const y = 90 - (Math.min(140, Math.max(0, pt.load)) / 140) * 90;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        />
                        <polyline
                          fill="none"
                          stroke="#f85149"
                          strokeWidth="1.2"
                          strokeDasharray="2 2"
                          points={history
                            .map((pt, idx) => {
                              const x = (idx / Math.max(1, history.length - 1)) * 360;
                              const y = 90 - (Math.min(140, Math.max(0, pt.hotspot)) / 140) * 90;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        />
                      </svg>
                    </div>
                  </div>

                  {/* TRACE 2: BUS FREQUENCY */}
                  <div>
                    <div className="flex justify-between font-mono text-[10px] text-[#8b949e] mb-1">
                      <span>CH2: SECONDARY BUS FREQUENCY (48.80..50.40 Hz)</span>
                      <span className="text-[#3fb950] tabular-nums">
                        {metrics.frequency_hz.toFixed(2)} Hz
                      </span>
                    </div>
                    <div className="border border-[#1e2430] bg-[#07090d] p-1.5">
                      <svg viewBox="0 0 360 75" className="w-full h-20 overflow-visible">
                        {/* 50.00 Hz Nominal Line */}
                        <line
                          x1="0"
                          y1={75 - ((50.0 - 48.8) / 1.6) * 75}
                          x2="360"
                          y2={75 - ((50.0 - 48.8) / 1.6) * 75}
                          stroke="#30363d"
                          strokeWidth="0.8"
                        />
                        {/* 49.20 Hz Under-Frequency Relay Trip Line */}
                        <line
                          x1="0"
                          y1={75 - ((49.2 - 48.8) / 1.6) * 75}
                          x2="360"
                          y2={75 - ((49.2 - 48.8) / 1.6) * 75}
                          stroke="#f85149"
                          strokeWidth="0.8"
                          strokeDasharray="3 3"
                        />
                        <polyline
                          fill="none"
                          stroke="#3fb950"
                          strokeWidth="1.6"
                          points={history
                            .map((pt, idx) => {
                              const x = (idx / Math.max(1, history.length - 1)) * 360;
                              const clamped = Math.min(50.4, Math.max(48.8, pt.freq));
                              const y = 75 - ((clamped - 48.8) / 1.6) * 75;
                              return `${x.toFixed(1)},${y.toFixed(1)}`;
                            })
                            .join(' ')}
                        />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* QUICK STRATEGY SWITCHER IN SIDEBAR */}
                <div className="pt-3 border-t border-[#1e2430]">
                  <div className="font-mono text-[10px] text-[#8b949e] mb-1.5">
                    ACTIVE BESS INVERTER CONTROL LAW
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    {STRATEGIES.map((strat) => {
                      const active =
                        (subsystems?.dispatch_architecture.active_strategy ??
                          snapshot.active_strategy) === strat.id;
                      return (
                        <button
                          key={strat.id}
                          onClick={() => changeStrategy(strat.id)}
                          className={`px-2.5 py-1.5 text-left font-mono text-[10px] border flex items-center justify-between transition-colors ${
                            active
                              ? 'border-[#58a6ff] bg-[#58a6ff]/10 text-[#f0f6fc] font-semibold'
                              : 'border-[#1e2430] bg-[#0a0c10] text-[#8b949e] hover:text-[#e6edf3]'
                          }`}
                        >
                          <span>
                            {strat.code} // {strat.id}
                          </span>
                          <span>{active ? '[ACTIVE]' : 'SELECT'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'TOPOLOGY' && subsystems && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[#1e2430]">
            {/* DIJKSTRA SHORTEST-LOSS HOSPITAL ROUTING */}
            <div className="lg:col-span-6 p-4 bg-[#0a0c10]">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs">
                <span className="text-[#f0f6fc] font-semibold">
                  SHORTEST-LOSS CRITICAL LOAD ROUTER (DIJKSTRA MIN-HEAP SOLVER)
                </span>
                <span className="text-[#3fb950]">
                  COST: {subsystems.network_routing.hospital_route.total_impedance_cost.toFixed(3)} Ω_eq
                </span>
              </div>

              <div className="border border-[#1e2430] bg-[#0d1017] p-3 font-mono text-xs mb-4">
                <div className="text-[10px] text-[#8b949e] mb-2">
                  ACTIVE MINIMUM-IMPEDANCE DELIVERY VECTOR (SOURCE -&gt; LOAD-HOSP-01)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {subsystems.network_routing.hospital_route.path.map((nodeId, idx, arr) => (
                    <div key={nodeId} className="flex items-center gap-2">
                      <span className="px-2.5 py-1 border border-[#2ea043] bg-[#2ea043]/10 text-[#3fb950] font-semibold">
                        {idx + 1}. {nodeId}
                      </span>
                      {idx < arr.length - 1 && <span className="text-[#8b949e]">===&gt;</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="font-mono text-[11px] text-[#8b949e] mb-2">
                DYNAMIC THERMAL IMPEDANCE FORMULATION
              </div>
              <div className="border border-[#1e2430] bg-[#0d1017] p-3 font-mono text-xs text-[#c9d1d9] space-y-1.5">
                <div>w_eff(u, v) = w_base(u, v) + max(0, (Load_TR - 75.0) * 0.12)</div>
                <div className="text-[11px] text-[#8b949e]">
                  When Kasarani 500kVA Transformer load exceeds 75%, winding copper losses increase
                  effective feeder impedance and shift priority hospital routing toward BESS-KSM-01.
                </div>
              </div>
            </div>

            {/* PRIM RADIAL MINIMUM SPANNING TREE */}
            <div className="lg:col-span-6 p-4 bg-[#0a0c10]">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs">
                <span className="text-[#f0f6fc] font-semibold">
                  LOOP-FREE RADIAL FEEDER TOPOLOGY (PRIM MINIMUM SPANNING TREE)
                </span>
                <span className="text-[#58a6ff]">
                  TOTAL MST IMPEDANCE: {subsystems.network_routing.radial_topology.total_mst_impedance.toFixed(3)}
                </span>
              </div>

              <div className="border border-[#1e2430]">
                <table className="w-full text-left border-collapse font-mono text-xs">
                  <thead>
                    <tr className="border-b border-[#1e2430] bg-[#0d1017] text-[10px] text-[#8b949e]">
                      <th className="py-2 px-3">EDGE_INDEX</th>
                      <th className="py-2 px-3">UPSTREAM_BUS</th>
                      <th className="py-2 px-3">DOWNSTREAM_BUS</th>
                      <th className="py-2 px-3">PHYSICAL_FEEDER_LINE</th>
                      <th className="py-2 px-3 text-right">IMPEDANCE_W</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e2430] tabular-nums">
                    {subsystems.network_routing.radial_topology.edges.map((edge, i) => (
                      <tr key={`${edge.from}-${edge.to}`} className="hover:bg-[#0d1017]">
                        <td className="py-2 px-3 text-[#8b949e]">#0{i + 1}</td>
                        <td className="py-2 px-3 text-[#f0f6fc] font-semibold">{edge.from}</td>
                        <td className="py-2 px-3 text-[#58a6ff] font-semibold">{edge.to}</td>
                        <td className="py-2 px-3 font-sans text-xs text-[#c9d1d9]">{edge.line}</td>
                        <td className="py-2 px-3 text-right text-[#3fb950] font-semibold">
                          {edge.weight.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'DISPATCH_SYNC' && subsystems && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[#1e2430]">
            {/* PLUGGABLE BESS DISPATCH STRATEGIES & COMPOSITE ZONE TREE */}
            <div className="lg:col-span-7 p-4 bg-[#0a0c10] space-y-4">
              <div>
                <div className="pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs font-semibold text-[#f0f6fc]">
                  RUNTIME-SWAPPABLE BESS INVERTER DISPATCH LAWS
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {STRATEGIES.map((s) => {
                    const isCurrent =
                      subsystems.dispatch_architecture.active_strategy === s.id;
                    return (
                      <div
                        key={s.id}
                        onClick={() => changeStrategy(s.id)}
                        className={`p-3 border cursor-pointer transition-colors ${
                          isCurrent
                            ? 'border-[#58a6ff] bg-[#161b22]'
                            : 'border-[#1e2430] bg-[#0d1017] hover:border-[#30363d]'
                        }`}
                      >
                        <div className="flex items-center justify-between font-mono text-xs">
                          <span className="font-bold text-[#f0f6fc]">
                            {s.code} // {s.name} ({s.id})
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] border ${
                              isCurrent
                                ? 'border-[#3fb950] text-[#3fb950] bg-[#2ea043]/10'
                                : 'border-[#30363d] text-[#8b949e]'
                            }`}
                          >
                            {isCurrent ? 'ACTIVE LAW' : 'CLICK TO ACTIVATE'}
                          </span>
                        </div>
                        <div className="mt-1.5 font-mono text-[11px] text-[#58a6ff]">
                          {s.formula}
                        </div>
                        <div className="mt-1 text-xs text-[#8b949e]">{s.description}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* HIERARCHICAL COMPOSITE ZONE POWER AGGREGATION */}
              <div>
                <div className="pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs font-semibold text-[#f0f6fc]">
                  RECURSIVE COMPOSITE ZONE POWER AGGREGATION TREE
                </div>
                <div className="border border-[#1e2430] bg-[#0d1017] p-3 font-mono text-xs">
                  <div className="flex justify-between py-1.5 border-b border-[#1e2430] font-bold text-[#f0f6fc]">
                    <span>
                      ROOT: {subsystems.dispatch_architecture.zone_hierarchy.id} (
                      {subsystems.dispatch_architecture.zone_hierarchy.name})
                    </span>
                    <span className="text-[#58a6ff] tabular-nums">
                      NET: {subsystems.dispatch_architecture.zone_hierarchy.net_power_kw.toFixed(1)} kW
                    </span>
                  </div>
                  <div className="divide-y divide-[#1e2430] mt-1">
                    {subsystems.dispatch_architecture.zone_hierarchy.children?.map((zone) => (
                      <div key={zone.id} className="py-2 pl-4">
                        <div className="flex justify-between font-semibold text-[#c9d1d9]">
                          <span>
                            +-- {zone.id} ({zone.name})
                          </span>
                          <span className="tabular-nums">{zone.net_power_kw.toFixed(1)} kW</span>
                        </div>
                        <div className="mt-1 space-y-1 pl-6 text-[11px] text-[#8b949e]">
                          {zone.children?.map((leaf) => (
                            <div key={leaf.id} className="flex justify-between">
                              <span>
                                |-- {leaf.id}: {leaf.name} [{leaf.role}]
                              </span>
                              <span
                                className={`tabular-nums ${
                                  leaf.net_power_kw >= 0 ? 'text-[#3fb950]' : 'text-[#d29922]'
                                }`}
                              >
                                {(leaf.net_power_kw >= 0 ? '+' : '') +
                                  leaf.net_power_kw.toFixed(1)}{' '}
                                kW
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* CONCURRENCY ENGINE: REENTRANT MUTEX & CAS RING BUFFER */}
            <div className="lg:col-span-5 p-4 bg-[#0a0c10]">
              <div className="pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs font-semibold text-[#f0f6fc]">
                CONCURRENCY GUARD // REENTRANT MUTEX &amp; ATOMIC CAS RING BUFFER
              </div>

              <div className="grid grid-cols-2 gap-px bg-[#1e2430] border border-[#1e2430] font-mono mb-4">
                <div className="bg-[#0d1017] p-3">
                  <div className="text-[10px] text-[#8b949e]">LOCK ACQUISITIONS (RLOCK)</div>
                  <div className="text-xl font-bold text-[#f0f6fc] tabular-nums mt-1">
                    {subsystems.concurrency_engine.lock_acquisitions}
                  </div>
                </div>
                <div className="bg-[#0d1017] p-3">
                  <div className="text-[10px] text-[#8b949e]">CAS COMMITS VERIFIED</div>
                  <div className="text-xl font-bold text-[#3fb950] tabular-nums mt-1">
                    {subsystems.concurrency_engine.cas_transitions_committed}
                  </div>
                </div>
                <div className="bg-[#0d1017] p-3">
                  <div className="text-[10px] text-[#8b949e]">RING BUFFER OCCUPANCY</div>
                  <div className="text-xl font-bold text-[#58a6ff] tabular-nums mt-1">
                    {subsystems.concurrency_engine.buffer_occupancy_pct}% (32 SLOTS)
                  </div>
                </div>
                <div className="bg-[#0d1017] p-3">
                  <div className="text-[10px] text-[#8b949e]">RACE CONFLICTS PREVENTED</div>
                  <div className="text-xl font-bold text-[#3fb950] tabular-nums mt-1">
                    {subsystems.concurrency_engine.race_conditions_prevented}
                  </div>
                </div>
              </div>

              <div className="border border-[#1e2430] bg-[#0d1017] p-3 font-mono text-xs">
                <div className="flex justify-between text-[10px] text-[#8b949e] mb-2">
                  <span>32-SLOT CIRCULAR TELEMETRY BUFFER (WRITE CURSOR)</span>
                  <span>
                    HEAD SEQ #{subsystems.concurrency_engine.frames_processed_seq} (SLOT{' '}
                    {subsystems.concurrency_engine.frames_processed_seq % 32})
                  </span>
                </div>
                <div className="grid grid-cols-8 gap-1">
                  {Array.from({ length: 32 }).map((_, idx) => {
                    const activeHead =
                      subsystems.concurrency_engine.frames_processed_seq % 32 === idx;
                    const populated = idx < subsystems.concurrency_engine.frames_processed_seq;
                    return (
                      <div
                        key={idx}
                        className={`h-7 border flex items-center justify-center text-[10px] tabular-nums ${
                          activeHead
                            ? 'border-[#3fb950] bg-[#2ea043]/25 text-[#f0f6fc] font-bold'
                            : populated
                            ? 'border-[#1e2430] bg-[#0a0c10] text-[#8b949e]'
                            : 'border-[#1e2430] bg-[#07090d] text-[#30363d]'
                        }`}
                      >
                        {String(idx).padStart(2, '0')}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'PROTOCOL_SQL' && subsystems && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[#1e2430]">
            {/* 64-BIT RTU BINARY FRAMES */}
            <div className="lg:col-span-7 p-4 bg-[#0a0c10] space-y-4">
              <div>
                <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs">
                  <span className="font-semibold text-[#f0f6fc]">
                    64-BIT (8-BYTE) RTU BINARY TELEMETRY REGISTER STREAM
                  </span>
                  <span className="text-[#3fb950]">CRC-8 POLYNOMIAL 0x07 VERIFIED</span>
                </div>
                <div className="overflow-x-auto border border-[#1e2430]">
                  <table className="w-full text-left border-collapse font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-[#1e2430] bg-[#0d1017] text-[10px] text-[#8b949e]">
                        <th className="py-2 px-2.5">NODE_ID</th>
                        <th className="py-2 px-2.5">RAW_64BIT_HEX_FRAME</th>
                        <th className="py-2 px-2.5">ID_STATUS_BITS</th>
                        <th className="py-2 px-2.5">VOLT_UINT16</th>
                        <th className="py-2 px-2.5">FREQ_UINT16</th>
                        <th className="py-2 px-2.5">CRC8</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2430] tabular-nums">
                      {subsystems.rtu_frames.map((frame) => (
                        <tr key={frame.node_id} className="hover:bg-[#0d1017]">
                          <td className="py-2 px-2.5 font-semibold text-[#58a6ff]">
                            {frame.node_id}
                          </td>
                          <td className="py-2 px-2.5 text-[#f0f6fc]">{frame.hex_frame}</td>
                          <td className="py-2 px-2.5 text-[#d29922]">
                            {frame.register_breakdown.id_status_bits}
                          </td>
                          <td className="py-2 px-2.5 text-[#8b949e]">
                            {frame.register_breakdown.volt_fixed16}
                          </td>
                          <td className="py-2 px-2.5 text-[#8b949e]">
                            {frame.register_breakdown.freq_fixed16}
                          </td>
                          <td className="py-2 px-2.5 text-[#3fb950]">
                            {frame.register_breakdown.crc8_checksum}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SQLITE WAL RELATIONAL AGGREGATION */}
              <div>
                <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs">
                  <span className="font-semibold text-[#f0f6fc]">
                    SQLITE 3NF RELATIONAL ROLLUP (LEFT JOIN + GROUP BY NODE_TYPE)
                  </span>
                  <span className="text-[#8b949e]">PRAGMA journal_mode = WAL</span>
                </div>
                <div className="overflow-x-auto border border-[#1e2430]">
                  <table className="w-full text-left border-collapse font-mono text-xs">
                    <thead>
                      <tr className="border-b border-[#1e2430] bg-[#0d1017] text-[10px] text-[#8b949e]">
                        <th className="py-2 px-3">NODE_CLASS</th>
                        <th className="py-2 px-3 text-right">SAMPLES_N</th>
                        <th className="py-2 px-3 text-right">MEAN_ACTIVE_P</th>
                        <th className="py-2 px-3 text-right">PEAK_LOAD_PCT</th>
                        <th className="py-2 px-3 text-right">MEAN_TEMP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2430] tabular-nums">
                      {subsystems.telemetry_analytics.map((row) => (
                        <tr key={row.node_class} className="hover:bg-[#0d1017]">
                          <td className="py-2 px-3 font-semibold text-[#f0f6fc]">
                            {row.node_class}
                          </td>
                          <td className="py-2 px-3 text-right text-[#8b949e]">
                            {row.sample_count}
                          </td>
                          <td className="py-2 px-3 text-right text-[#58a6ff]">
                            {row.avg_power_kw.toFixed(1)} kW
                          </td>
                          <td className="py-2 px-3 text-right text-[#e6edf3]">
                            {row.peak_load_pct.toFixed(1)}%
                          </td>
                          <td className="py-2 px-3 text-right text-[#8b949e]">
                            {row.avg_temp_c.toFixed(1)} °C
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* PROPOSITIONAL BREAKER SAFETY INTERLOCK */}
            <div className="lg:col-span-5 p-4 bg-[#0a0c10]">
              <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#1e2430] font-mono text-xs">
                <span className="font-semibold text-[#f0f6fc]">
                  PROPOSITIONAL BREAKER SAFETY INTERLOCK GATE
                </span>
                <span
                  className={`px-2 py-0.5 text-[10px] border ${
                    subsystems.safety_interlock.invariant_satisfied
                      ? 'border-[#2ea043] bg-[#2ea043]/15 text-[#3fb950]'
                      : 'border-[#f85149] bg-[#f85149]/15 text-[#f85149]'
                  }`}
                >
                  {subsystems.safety_interlock.invariant_satisfied
                    ? 'INVARIANT SATISFIED (TRUE)'
                    : 'INTERLOCK VIOLATED (FALSE)'}
                </span>
              </div>

              <div className="border border-[#1e2430] bg-[#0d1017] p-3 font-mono text-xs text-[#58a6ff] mb-3">
                {subsystems.safety_interlock.formula}
              </div>

              <div className="border border-[#1e2430] divide-y divide-[#1e2430] font-mono text-xs">
                {subsystems.safety_interlock.propositions.map((prop) => (
                  <div
                    key={prop.symbol}
                    className="p-2.5 bg-[#0d1017] flex items-center justify-between"
                  >
                    <div>
                      <span className="inline-block w-6 font-bold text-[#f0f6fc]">
                        [{prop.symbol}]
                      </span>
                      <span className="font-sans text-xs text-[#c9d1d9]">{prop.label}</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-[10px] font-bold border ${
                        prop.value
                          ? 'border-[#2ea043]/50 bg-[#2ea043]/10 text-[#3fb950]'
                          : 'border-[#30363d] bg-[#0a0c10] text-[#8b949e]'
                      }`}
                    >
                      {prop.value ? '1 (TRUE)' : '0 (FALSE)'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
