import { useEffect, useRef, useState } from 'react';
import {
  GridNode,
  TelemetrySnapshot,
  SubsystemsPayload,
  ZoneHierarchyNode,
} from './types/grid';

// ============================================================================
// CONSUMER MODE DATA (100% HUMAN-CENTRIC, ZERO JARGON)
// ============================================================================

interface ApplianceItem {
  id: string;
  name: string;
  watts: number;
  category: 'essential' | 'heavy';
  defaultOnFor: Array<'home' | 'clinic' | 'business'>;
}

const APPLIANCES: ApplianceItem[] = [
  // Essential (Keep running during blackout)
  { id: 'lights', name: 'LED lighting (8 rooms)', watts: 80, category: 'essential', defaultOnFor: ['home', 'clinic', 'business'] },
  { id: 'wifi', name: 'Wi-Fi router, phones & laptops', watts: 90, category: 'essential', defaultOnFor: ['home', 'clinic', 'business'] },
  { id: 'fridge', name: 'Household fridge / freezer', watts: 180, category: 'essential', defaultOnFor: ['home'] },
  { id: 'tv', name: 'TV & decoder', watts: 120, category: 'essential', defaultOnFor: ['home'] },
  { id: 'security', name: 'Security cameras & gate', watts: 70, category: 'essential', defaultOnFor: ['home', 'clinic', 'business'] },
  { id: 'vaccine', name: 'Medical vaccine refrigerator', watts: 320, category: 'essential', defaultOnFor: ['clinic'] },
  { id: 'oxygen', name: 'Oxygen concentrator & monitors', watts: 550, category: 'essential', defaultOnFor: ['clinic'] },
  { id: 'incubator', name: 'Maternity ward incubator & lights', watts: 480, category: 'essential', defaultOnFor: ['clinic'] },
  { id: 'coldroom', name: 'Commercial cold-room chiller', watts: 2200, category: 'essential', defaultOnFor: ['business'] },
  { id: 'pos', name: 'POS computers & digital scales', watts: 200, category: 'essential', defaultOnFor: ['business'] },

  // Heavy / Flexible (Automatically paused by GridPulse during blackouts)
  { id: 'kettle', name: 'Electric kettle', watts: 1800, category: 'heavy', defaultOnFor: ['home'] },
  { id: 'heater', name: 'Water heater / geyser', watts: 2500, category: 'heavy', defaultOnFor: ['home', 'clinic'] },
  { id: 'iron', name: 'Clothes iron / microwave', watts: 1200, category: 'heavy', defaultOnFor: ['home'] },
  { id: 'pump', name: 'Borehole / booster water pump', watts: 1500, category: 'heavy', defaultOnFor: ['home', 'clinic', 'business'] },
  { id: 'autoclave', name: 'Clinic sterilizer (autoclave)', watts: 2000, category: 'heavy', defaultOnFor: ['clinic'] },
  { id: 'ac', name: 'Air conditioning unit', watts: 1600, category: 'heavy', defaultOnFor: ['clinic', 'business'] },
  { id: 'mill', name: 'Grain / posho mill motor', watts: 3500, category: 'heavy', defaultOnFor: ['business'] },
  { id: 'welder', name: 'Workshop compressor / machinery', watts: 2400, category: 'heavy', defaultOnFor: ['business'] },
];

const PROFILE_DEFAULTS = {
  home: {
    label: 'Home',
    subtitle: 'Lights, fridge, Wi-Fi, water heater & kitchen appliances',
    batteryKwh: 5,
    solarKw: 3,
    inverterKw: 3.5,
    outageHours: 5,
  },
  clinic: {
    label: 'Health clinic',
    subtitle: 'Vaccine chiller, oxygen, maternity lights, pump & sterilizer',
    batteryKwh: 15,
    solarKw: 8,
    inverterKw: 8,
    outageHours: 6,
  },
  business: {
    label: 'Small business',
    subtitle: 'Cold storage, POS, borehole pump & processing machinery',
    batteryKwh: 30,
    solarKw: 15,
    inverterKw: 15,
    outageHours: 6,
  },
};

// ============================================================================
// OPERATOR CONSOLE DATA (ISOLATED IN ENGINEER WORKSPACE)
// ============================================================================

const SCENARIOS = [
  { id: 'NOMINAL', label: 'Nominal' },
  { id: 'EVENING_PEAK', label: 'Evening peak' },
  { id: 'CLOUD_TRANSIENT', label: 'Cloud cover' },
  { id: 'UPSTREAM_BLACKOUT', label: 'Grid outage' },
];

const STRATEGIES = [
  {
    id: 'PROPORTIONAL_DROOP',
    name: 'Proportional droop',
    summary: 'Balances battery peak shaving with commercial load curtailment above 88% transformer load.',
  },
  {
    id: 'AGGRESSIVE_PEAK_SHAVING',
    name: 'Aggressive peak shaving',
    summary: 'Caps transformer loading at 68% (340 kW) to minimize winding hot-spot thermal aging.',
  },
  {
    id: 'CONSERVATIVE_CLINIC_RESERVE',
    name: 'Clinic reserve',
    summary: 'Preserves battery charge for extended blackouts by curtailing flexible commercial load first.',
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
  const wTr = Number((0.8 + thermalPenalty).toFixed(2));

  const hospitalPath = !upstreamOnline
    ? ['GEN-SOL-02', 'BESS-KSM-01', 'LOAD-HOSP-01']
    : wTr > 2.2
    ? ['GEN-OLK-01', 'TR-NRB-04', 'BESS-KSM-01', 'LOAD-HOSP-01']
    : ['GEN-OLK-01', 'TR-NRB-04', 'LOAD-HOSP-01'];

  const hospitalCost = !upstreamOnline
    ? 1.6
    : Number((1.2 + Math.min(wTr + 0.7, 1.1 + thermalPenalty * 0.5)).toFixed(2));

  const mstEdges = upstreamOnline
    ? [
        { from: 'GEN-OLK-01', to: 'TR-NRB-04', weight: 1.2, line: '132kV Naivasha-Nairobi Trunk' },
        { from: 'TR-NRB-04', to: 'BESS-KSM-01', weight: wTr, line: '415V Secondary Bus' },
        { from: 'BESS-KSM-01', to: 'LOAD-HOSP-01', weight: 0.7, line: 'Priority-1 Clinic Feeder' },
        { from: 'BESS-KSM-01', to: 'GEN-SOL-02', weight: 0.9, line: 'DC-Coupled Solar Tie' },
        { from: 'BESS-KSM-01', to: 'LOAD-COMM-02', weight: 1.3, line: 'Commercial Feeder' },
      ]
    : [
        { from: 'GEN-SOL-02', to: 'BESS-KSM-01', weight: 0.9, line: 'DC-Coupled Solar Tie' },
        { from: 'BESS-KSM-01', to: 'LOAD-HOSP-01', weight: 0.7, line: 'Priority-1 Clinic Feeder' },
        { from: 'BESS-KSM-01', to: 'TR-NRB-04', weight: wTr, line: '415V Secondary Bus' },
        { from: 'BESS-KSM-01', to: 'LOAD-COMM-02', weight: 1.3, line: 'Commercial Feeder' },
      ];

  const geoKw = nodes.find((n) => n.node_id === 'GEN-OLK-01')?.active_power_kw ?? 0;
  const solKw = nodes.find((n) => n.node_id === 'GEN-SOL-02')?.active_power_kw ?? 0;
  const hospKw = nodes.find((n) => n.node_id === 'LOAD-HOSP-01')?.active_power_kw ?? 0;
  const commKw = nodes.find((n) => n.node_id === 'LOAD-COMM-02')?.active_power_kw ?? 0;

  const genNet = Number((geoKw + solKw).toFixed(1));
  const distNet = Number((bessDispatchKw - hospKw - commKw).toFixed(1));

  const zoneHierarchy: ZoneHierarchyNode = {
    id: 'ZONE-KE-CORRIDOR',
    name: 'Kenya Rift-Nairobi Corridor',
    type: 'DISTRIBUTION_ZONE',
    net_power_kw: Number((genNet + distNet).toFixed(1)),
    children: [
      {
        id: 'ZONE-RIFT-GEN',
        name: 'Rift Valley Generation',
        type: 'DISTRIBUTION_ZONE',
        net_power_kw: genNet,
        children: [
          { id: 'GEN-OLK-01', name: 'Olkaria Geothermal', type: 'LEAF_ASSET', role: 'Generation', net_power_kw: geoKw },
          { id: 'GEN-SOL-02', name: 'Nakuru Solar Array', type: 'LEAF_ASSET', role: 'Generation', net_power_kw: solKw },
        ],
      },
      {
        id: 'ZONE-NRB-NORTH',
        name: 'Nairobi North Microgrid',
        type: 'DISTRIBUTION_ZONE',
        net_power_kw: distNet,
        children: [
          { id: 'BESS-KSM-01', name: 'LFP Battery Storage', type: 'LEAF_ASSET', role: 'Storage', net_power_kw: bessDispatchKw },
          { id: 'LOAD-HOSP-01', name: 'Referral Clinic', type: 'LEAF_ASSET', role: 'Critical load', net_power_kw: -hospKw },
          { id: 'LOAD-COMM-02', name: 'Agro-Processing Hub', type: 'LEAF_ASSET', role: 'Flexible load', net_power_kw: -commKw },
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
        id_status_bits: `${bin1.slice(0, 4)}:${bin1.slice(4)}`,
        volt_fixed16: `${(vDv / 10).toFixed(1)} V`,
        freq_fixed16: `${(fChz / 100).toFixed(2)} Hz`,
        load_uint8: `${b6}%`,
        crc8_checksum: `0x${crc.toString(16).toUpperCase().padStart(2, '0')}`,
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
        total_mst_impedance: Number(mstEdges.reduce((a, b) => a + b.weight, 0).toFixed(2)),
        connected_nodes_count: upstreamOnline ? 6 : 5,
      },
    },
    dispatch_architecture: {
      active_strategy: activeStrategy,
      available_strategies: STRATEGIES.map((s) => s.id),
      zone_hierarchy: zoneHierarchy,
    },
    concurrency_engine: {
      synchronizer_type: 'Reentrant Mutex (RLock) + Compare-And-Swap',
      ring_buffer_capacity: 32,
      frames_processed_seq: tick,
      buffer_occupancy_pct: Number(((Math.min(tick, 32) / 32) * 100).toFixed(0)),
      lock_acquisitions: tick * 2 + 4,
      cas_transitions_committed: Math.max(1, Math.floor(tick / 4)),
      race_conditions_prevented: 0,
      active_threads: 4,
    },
    rtu_frames: rtuFrames,
    safety_interlock: {
      formula: '(D -> (S & (Q | R | ~P))) & (~P -> C) & C',
      invariant_satisfied: (!D || (S && (Q || R || !P))) && (P || C) && C,
      propositions: [
        { symbol: 'P', label: 'Upstream feeder energized', value: P },
        { symbol: 'Q', label: 'Transformer load > 82%', value: Q },
        { symbol: 'R', label: 'Bus frequency < 49.65 Hz', value: R },
        { symbol: 'S', label: 'Battery reserve > 15%', value: S },
        { symbol: 'D', label: 'Battery inverter discharging', value: D },
        { symbol: 'C', label: 'Referral clinic energized', value: C },
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
      node_name: 'Olkaria Geothermal',
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
      node_name: 'Nakuru Solar Array',
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
      node_name: 'Kasarani 500kVA Transformer',
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
      node_name: 'LFP Battery Bank (400kWh)',
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
      node_name: 'Agro-Processing Hub',
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
      bess_soc_pct: 78.0,
      bess_dispatch_kw: -25.0,
      clinic_uptime_pct: 100.0,
    },
    nodes,
    recent_events: [
      {
        event_id: 1,
        idempotency_key: 'EVT-0001',
        timestamp_utc: new Date().toISOString(),
        trigger_node_id: 'TR-NRB-04',
        previous_state: 'INIT',
        new_state: 'STABLE',
        action_taken:
          'Corridor synchronized at 50.00 Hz. Battery charging from surplus solar (-25.0 kW).',
        frequency_at_trigger_hz: 50.0,
        transformer_load_pct: 69.6,
        bess_dispatch_kw: -25.0,
      },
    ],
    subsystems: buildFallbackSubsystems(nodes, 1, 69.6, 50.0, 78.0, -25.0, 'PROPORTIONAL_DROOP'),
  };
}

function formatStateLabel(state: string): string {
  switch (state) {
    case 'STABLE':
      return 'Nominal';
    case 'BESS_DISPATCH_ACTIVE':
      return 'Battery dispatch';
    case 'DEMAND_RESPONSE_SHED':
      return 'Demand response';
    case 'FAULT_ISLANDING':
      return 'Islanded';
    default:
      return 'Unprotected overload';
  }
}

export default function App() {
  // STRICT SEPARATION OF MODES:
  // 'consumer' = Clean, self-contained everyday tool (zero engineering graphs or hex dumps)
  // 'operator' = Dedicated engineering & utility SCADA console
  const [workspaceMode, setWorkspaceMode] = useState<'consumer' | 'operator'>('consumer');

  // Consumer Workspace State
  const [profileKey, setProfileKey] = useState<'home' | 'clinic' | 'business'>('home');
  const [selectedAppliances, setSelectedAppliances] = useState<string[]>(
    APPLIANCES.filter((a) => a.defaultOnFor.includes('home')).map((a) => a.id)
  );
  const [batteryKwh, setBatteryKwh] = useState<number>(PROFILE_DEFAULTS.home.batteryKwh);
  const [solarKw, setSolarKw] = useState<number>(PROFILE_DEFAULTS.home.solarKw);
  const [inverterKw, setInverterKw] = useState<number>(PROFILE_DEFAULTS.home.inverterKw);
  const [outageHours, setOutageHours] = useState<number>(PROFILE_DEFAULTS.home.outageHours);
  const [outageCondition, setOutageCondition] = useState<'night' | 'cloudy' | 'sunny'>('night');

  const chooseConsumerProfile = (key: 'home' | 'clinic' | 'business') => {
    setProfileKey(key);
    const def = PROFILE_DEFAULTS[key];
    setBatteryKwh(def.batteryKwh);
    setSolarKw(def.solarKw);
    setInverterKw(def.inverterKw);
    setOutageHours(def.outageHours);
    setSelectedAppliances(
      APPLIANCES.filter((a) => a.defaultOnFor.includes(key)).map((a) => a.id)
    );
  };

  const toggleAppliance = (id: string) => {
    setSelectedAppliances((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // Operator Console State
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(createInitialSnapshot);
  const [backendConnected, setBackendConnected] = useState<boolean>(false);
  const [history, setHistory] = useState<Array<{ freq: number; load: number }>>([
    { freq: 50.0, load: 69.6 },
  ]);
  const [operatorTab, setOperatorTab] = useState<
    'overview' | 'topology' | 'dispatch' | 'protocol'
  >('overview');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('TR-NRB-04');

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
    const isLocalHost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalHost) {
      setBackendConnected(false);
      return;
    }

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket('ws://localhost:8000/ws');
      ws.onopen = () => setBackendConnected(true);
      ws.onmessage = (event) => {
        try {
          const data: TelemetrySnapshot = JSON.parse(event.data);
          setSnapshot(data);
          setHistory((prev) => [
            ...prev.slice(-29),
            { freq: data.metrics.frequency_hz, load: data.metrics.transformer_load_pct },
          ]);
        } catch {
          // ignore
        }
      };
      ws.onclose = () => setBackendConnected(false);
      ws.onerror = () => setBackendConnected(false);
    } catch {
      setBackendConnected(false);
    }
    return () => {
      if (ws) ws.close();
    };
  }, []);

  useEffect(() => {
    if (backendConnected || workspaceMode !== 'operator') return;

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

        const geo = baseGeo > 0 ? Math.max(0, baseGeo + (Math.random() * 4 - 2)) : 0;
        const sol = Math.max(0, baseSol + (Math.random() * 4 - 2));
        const clinic = baseClinic + (Math.random() * 2 - 1);
        const rawComm = baseComm + (Math.random() * 5 - 2.5);

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
              actionMsg = `Upstream grid lost. Islanded on solar + battery (${bessKw.toFixed(0)} kW); commercial load curtailed to 55%.`;
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
              actionMsg = `Peak shaving active: capping transformer load at 68% with ${bessKw.toFixed(0)} kW battery support.`;
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
              actionMsg = `Clinic reserve mode: commercial load curtailed to ${Math.round(curtailment * 100)}% to preserve battery.`;
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
                  actionMsg = `Dispatched ${bessKw.toFixed(0)} kW from battery and curtailed commercial demand by 28%.`;
                }
              } else {
                newState = 'BESS_DISPATCH_ACTIVE';
                if (sim.state !== 'BESS_DISPATCH_ACTIVE') {
                  actionMsg = `Battery injecting ${bessKw.toFixed(0)} kW to relieve transformer overload.`;
                }
              }
            } else {
              newState = 'STABLE';
              bessKw = sim.soc < 94 ? -25.0 : 0.0;
              if (sim.state !== 'STABLE') {
                actionMsg = 'Returned to nominal 50.00 Hz operation.';
              }
            }
          }
        } else {
          bessKw = 0.0;
          curtailment = 1.0;
          if (geo === 0 || (unmitigated / ratedKva) * 100.0 > 88.0) {
            newState = 'CRITICAL_OVERLOAD_UNPROTECTED';
            if (sim.state !== 'CRITICAL_OVERLOAD_UNPROTECTED') {
              actionMsg = 'Auto-protection disabled: transformer overloaded and frequency sagging.';
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

        let freq = 50.0;
        let volt = 240.0;
        if (newState === 'CRITICAL_OVERLOAD_UNPROTECTED') {
          freq = 49.12 + (Math.random() * 0.06 - 0.03);
          volt = 205.0 + (Math.random() * 2 - 1);
        } else if (newState === 'FAULT_ISLANDING') {
          freq = 49.89 + (Math.random() * 0.04 - 0.02);
          volt = 237.0 + (Math.random() * 1 - 0.5);
        } else {
          const bal = geo + sol + bessKw - totalDemand;
          freq = 50.0 + Math.max(-0.5, Math.min(0.25, (bal / 500.0) * 0.35));
          volt = 242.0 - Math.max(0, (trLoadPct - 50) * 0.16);
        }

        const updatedNodes: GridNode[] = [
          {
            node_id: 'GEN-OLK-01',
            node_name: 'Olkaria Geothermal',
            node_type: 'GENERATION',
            region: 'Rift Valley',
            rated_capacity_kw: 450.0,
            active_power_kw: Number(geo.toFixed(1)),
            load_pct: Number(((geo / 450.0) * 100).toFixed(1)),
            voltage_v: geo > 0 ? Number(volt.toFixed(1)) : 0.0,
            frequency_hz: geo > 0 ? Number(freq.toFixed(2)) : 0.0,
            temperature_c: 42.5,
            status: geo === 0 ? 'OFFLINE' : 'ONLINE',
          },
          {
            node_id: 'GEN-SOL-02',
            node_name: 'Nakuru Solar Array',
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
            node_name: 'Kasarani 500kVA Transformer',
            node_type: 'TRANSFORMER',
            region: 'Nairobi North',
            rated_capacity_kw: 500.0,
            active_power_kw: Number(trFlow.toFixed(1)),
            load_pct: Number(trLoadPct.toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: Number(sim.temp.toFixed(1)),
            status: trLoadPct > 90 ? 'OVERLOAD' : trLoadPct > 78 ? 'HIGH_LOAD' : 'NOMINAL',
          },
          {
            node_id: 'BESS-KSM-01',
            node_name: 'LFP Battery Bank (400kWh)',
            node_type: 'STORAGE',
            region: 'Nairobi North',
            rated_capacity_kw: 250.0,
            active_power_kw: Number(bessKw.toFixed(1)),
            load_pct: Number(((Math.abs(bessKw) / 250.0) * 100).toFixed(1)),
            voltage_v: Number(volt.toFixed(1)),
            frequency_hz: Number(freq.toFixed(2)),
            temperature_c: Number((29.5 + (Math.abs(bessKw) / 250.0) * 11.0).toFixed(1)),
            status: bessKw > 0 ? 'DISCHARGING' : bessKw < 0 ? 'CHARGING' : 'STANDBY',
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
            status: 'PROTECTED',
          },
          {
            node_id: 'LOAD-COMM-02',
            node_name: 'Agro-Processing Hub',
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
                ? `CURTAILED (-${Math.round((1 - curtailment) * 100)}%)`
                : 'NOMINAL',
          },
        ];

        const events = [...prev.recent_events];
        if (actionMsg) {
          events.unshift({
            event_id: events.length + 1,
            idempotency_key: `EVT-${String(sim.tick).padStart(4, '0')}`,
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

        setHistory((h) => [...h.slice(-29), { freq: nextFreq, load: nextLoad }]);

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
            bess_soc_pct: Number(sim.soc.toFixed(1)),
            bess_dispatch_kw: nextBess,
            clinic_uptime_pct: 100.0,
          },
          nodes: updatedNodes,
          recent_events: events.slice(0, 8),
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
  }, [backendConnected, workspaceMode]);

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
        // fallback
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

  // ============================================================================
  // CONSUMER MODE CALCULATIONS
  // ============================================================================
  const activeEssentialWatts = APPLIANCES.filter(
    (a) => a.category === 'essential' && selectedAppliances.includes(a.id)
  ).reduce((sum, a) => sum + a.watts, 0);

  const activeHeavyWatts = APPLIANCES.filter(
    (a) => a.category === 'heavy' && selectedAppliances.includes(a.id)
  ).reduce((sum, a) => sum + a.watts, 0);

  const essentialKw = Math.max(0.05, Number((activeEssentialWatts / 1000).toFixed(2)));
  const heavyKw = Number((activeHeavyWatts / 1000).toFixed(2));
  const totalUnprotectedKw = Number((essentialKw + heavyKw).toFixed(2));

  const usableBatteryKwh = batteryKwh * 0.85;
  const solarFactor =
    outageCondition === 'night' ? 0.0 : outageCondition === 'cloudy' ? 0.22 : 0.65;
  const availableSolarKw = Number((solarKw * solarFactor).toFixed(2));

  // Standard Inverter (No automatic load shedding)
  const stdOverloaded = totalUnprotectedKw > inverterKw;
  const stdNetDrainKw = Math.max(0.05, totalUnprotectedKw - availableSolarKw);
  const stdHours = stdOverloaded ? 0 : usableBatteryKwh / stdNetDrainKw;
  const stdSurvives = !stdOverloaded && stdHours >= outageHours;

  // With GridPulse Automatic Load Shedding (Pauses heavy appliances during blackout)
  const gpOverloaded = essentialKw > inverterKw;
  const gpNetDrainKw = Math.max(0.05, essentialKw - availableSolarKw);
  const gpHours = gpOverloaded
    ? 0
    : essentialKw <= availableSolarKw
    ? 24
    : usableBatteryKwh / gpNetDrainKw;
  const gpSurvives = !gpOverloaded && gpHours >= outageHours;

  const recommendedBatteryKwh = Math.max(
    1,
    Math.ceil((Math.max(0.05, essentialKw - availableSolarKw) * outageHours) / 0.85)
  );
  const recommendedInverterKw = Math.max(1, Math.ceil(essentialKw * 1.25));
  const dieselSavedLiters = Number((essentialKw * outageHours * 0.42).toFixed(1));
  const kesSaved = Math.round(dieselSavedLiters * 185);

  // ============================================================================
  // RENDER 1: CONSUMER EXPERIENCE (DEFAULT — ZERO TECHNICAL GRAPHS OR JARGON)
  // ============================================================================
  if (workspaceMode === 'consumer') {
    return (
      <div className="min-h-screen bg-[#09090b] text-zinc-100 antialiased flex flex-col justify-between">
        <div className="max-w-4xl w-full mx-auto px-6 py-10">
          {/* MINIMAL CONSUMER HEADER */}
          <header className="flex items-center justify-between pb-8 border-b border-zinc-800/80">
            <div>
              <span className="text-base font-medium tracking-tight text-zinc-100">
                GridPulse
              </span>
              <span className="mx-2.5 text-zinc-700">/</span>
              <span className="text-xs text-zinc-400">
                Blackout Survival &amp; Solar Backup Planner
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              {(
                [
                  ['home', 'Home'],
                  ['clinic', 'Health clinic'],
                  ['business', 'Small business'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => chooseConsumerProfile(key)}
                  className={`px-3 py-1.5 rounded transition-colors ${
                    profileKey === key
                      ? 'bg-zinc-100 text-zinc-950 font-medium'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </header>

          {/* OUTCOME BANNER (THE MAIN QUESTION ANSWERED IMMEDIATELY) */}
          <section className="py-8 border-b border-zinc-800/60">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* WITHOUT SMART PROTECTION */}
              <div className="p-6 rounded-md border border-zinc-800/90 bg-zinc-950/40 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Standard backup (everything stays on)</span>
                    <span
                      className={`font-mono text-[11px] ${
                        stdSurvives ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {stdOverloaded
                        ? 'Inverter trips off'
                        : stdSurvives
                        ? 'Lasts full blackout'
                        : 'Battery dies early'}
                    </span>
                  </div>

                  <div className="mt-4 text-3xl font-mono font-normal tracking-tight text-zinc-100 tabular-nums">
                    {stdOverloaded ? (
                      <span className="text-rose-400">0.0 hours</span>
                    ) : (
                      <>
                        {Math.min(24, stdHours).toFixed(1)}{' '}
                        <span className="text-base text-zinc-500">hours</span>
                      </>
                    )}
                  </div>

                  <p className="mt-3 text-xs text-zinc-400 leading-relaxed">
                    {stdOverloaded
                      ? `Your selected appliances draw ${totalUnprotectedKw} kW, which is higher than your ${inverterKw} kW inverter limit. The system shuts down immediately.`
                      : stdSurvives
                      ? `Your ${batteryKwh} kWh battery can run all ${totalUnprotectedKw} kW of appliances for the full ${outageHours}-hour outage.`
                      : `Running heavy appliances alongside essential ones (${totalUnprotectedKw} kW total) drains your battery in ${stdHours.toFixed(1)} hours, leaving you without power for ${(outageHours - stdHours).toFixed(1)} hours.`}
                  </p>
                </div>

                {/* Visual survival bar */}
                <div className="mt-5">
                  <div className="flex justify-between text-[11px] text-zinc-500 mb-1.5 font-mono">
                    <span>Coverage of {outageHours}-hour blackout</span>
                    <span>
                      {Math.min(100, Math.round((stdHours / outageHours) * 100))}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-900 rounded overflow-hidden">
                    <div
                      className={`h-full ${stdSurvives ? 'bg-zinc-300' : 'bg-rose-500'}`}
                      style={{
                        width: `${Math.min(100, Math.round((stdHours / outageHours) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* WITH GRIDPULSE SMART LOAD SHEDDING */}
              <div className="p-6 rounded-md border border-zinc-700 bg-zinc-900/30 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-100 font-medium">
                      With GridPulse smart load-shedding
                    </span>
                    <span
                      className={`font-mono text-[11px] ${
                        gpSurvives ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    >
                      {gpOverloaded
                        ? 'Inverter too small'
                        : gpSurvives
                        ? 'Survives 100%'
                        : 'Needs bigger battery'}
                    </span>
                  </div>

                  <div className="mt-4 text-3xl font-mono font-normal tracking-tight text-emerald-400 tabular-nums">
                    {gpOverloaded ? (
                      <span className="text-rose-400">0.0 hours</span>
                    ) : gpHours >= 24 ? (
                      <>
                        24+ <span className="text-base text-zinc-400">hours</span>
                      </>
                    ) : (
                      <>
                        {gpHours.toFixed(1)}{' '}
                        <span className="text-base text-zinc-400">hours</span>
                      </>
                    )}
                  </div>

                  <p className="mt-3 text-xs text-zinc-300 leading-relaxed">
                    {gpOverloaded
                      ? `Your essential equipment alone (${essentialKw} kW) exceeds your ${inverterKw} kW inverter. Use at least a ${recommendedInverterKw} kW inverter.`
                      : gpSurvives
                      ? `GridPulse automatically pauses ${heavyKw} kW of heavy appliances when the grid goes off, keeping your ${essentialKw} kW of essential equipment running for the entire ${outageHours}-hour blackout.`
                      : `Pausing heavy appliances stretches your battery from ${stdHours.toFixed(1)} hrs to ${gpHours.toFixed(1)} hrs. To cover all ${outageHours} hours, use at least a ${recommendedBatteryKwh} kWh battery.`}
                  </p>
                </div>

                {/* Visual survival bar */}
                <div className="mt-5">
                  <div className="flex justify-between text-[11px] text-zinc-400 mb-1.5 font-mono">
                    <span>Coverage of {outageHours}-hour blackout</span>
                    <span>
                      {Math.min(100, Math.round((gpHours / outageHours) * 100))}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-900 rounded overflow-hidden">
                    <div
                      className={`h-full ${gpSurvives ? 'bg-emerald-400' : 'bg-amber-400'}`}
                      style={{
                        width: `${Math.min(100, Math.round((gpHours / outageHours) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* STEP 1 & STEP 2: TAP YOUR APPLIANCES + ADJUST BATTERY/SOLAR */}
          <section className="py-8 grid grid-cols-1 lg:grid-cols-12 gap-10 border-b border-zinc-800/60">
            {/* LEFT 7 COLS: TAP APPLIANCES */}
            <div className="lg:col-span-7 space-y-6">
              <div>
                <h2 className="text-xs font-medium text-zinc-200">
                  1. Tap the appliances you use
                </h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  No need to calculate watts manually. Select what you have on site.
                </p>
              </div>

              {/* Essential Appliances */}
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-2.5">
                  <span>Essential (kept ON during blackouts)</span>
                  <span className="font-mono text-zinc-200">{essentialKw} kW total</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {APPLIANCES.filter((a) => a.category === 'essential').map((item) => {
                    const checked = selectedAppliances.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        onClick={() => toggleAppliance(item.id)}
                        className={`px-3 py-2.5 rounded border text-left text-xs flex items-center justify-between transition-colors ${
                          checked
                            ? 'border-zinc-300 bg-zinc-900 text-zinc-100'
                            : 'border-zinc-800/70 text-zinc-500 hover:border-zinc-700'
                        }`}
                      >
                        <span className="truncate pr-2">{item.name}</span>
                        <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                          {item.watts}W
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Heavy Appliances */}
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-2.5">
                  <span>Heavy appliances (paused automatically during blackouts)</span>
                  <span className="font-mono text-zinc-400">{heavyKw} kW total</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {APPLIANCES.filter((a) => a.category === 'heavy').map((item) => {
                    const checked = selectedAppliances.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        onClick={() => toggleAppliance(item.id)}
                        className={`px-3 py-2.5 rounded border text-left text-xs flex items-center justify-between transition-colors ${
                          checked
                            ? 'border-zinc-600 bg-zinc-900/50 text-zinc-200'
                            : 'border-zinc-800/70 text-zinc-500 hover:border-zinc-700'
                        }`}
                      >
                        <span className="truncate pr-2">{item.name}</span>
                        <span className="font-mono text-[11px] text-zinc-500 shrink-0">
                          {item.watts}W
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* RIGHT 5 COLS: BATTERY, SOLAR & OUTAGE SLIDERS */}
            <div className="lg:col-span-5 space-y-6">
              <div>
                <h2 className="text-xs font-medium text-zinc-200">
                  2. Your battery, solar &amp; outage length
                </h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  Test what you currently own or what you plan to buy.
                </p>
              </div>

              <div className="space-y-5">
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-300">Battery size</span>
                    <span className="font-mono text-zinc-100 tabular-nums">
                      {batteryKwh} kWh
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="60"
                    step="1"
                    value={batteryKwh}
                    onChange={(e) => setBatteryKwh(parseFloat(e.target.value))}
                    className="w-full accent-zinc-100 bg-zinc-800 h-1.5 rounded cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-300">Solar panels installed</span>
                    <span className="font-mono text-zinc-100 tabular-nums">{solarKw} kW</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="30"
                    step="0.5"
                    value={solarKw}
                    onChange={(e) => setSolarKw(parseFloat(e.target.value))}
                    className="w-full accent-zinc-100 bg-zinc-800 h-1.5 rounded cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-300">Inverter size</span>
                    <span className="font-mono text-zinc-100 tabular-nums">
                      {inverterKw} kW
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="30"
                    step="0.5"
                    value={inverterKw}
                    onChange={(e) => setInverterKw(parseFloat(e.target.value))}
                    className="w-full accent-zinc-100 bg-zinc-800 h-1.5 rounded cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-300">How long does the blackout last?</span>
                    <span className="font-mono text-zinc-100 tabular-nums">
                      {outageHours} hours
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="12"
                    step="1"
                    value={outageHours}
                    onChange={(e) => setOutageHours(parseInt(e.target.value, 10))}
                    className="w-full accent-zinc-100 bg-zinc-800 h-1.5 rounded cursor-pointer"
                  />
                </div>

                <div className="pt-1 space-y-2">
                  <div className="text-xs text-zinc-400">Time of blackout</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {(
                      [
                        ['night', 'Night'],
                        ['cloudy', 'Cloudy day'],
                        ['sunny', 'Sunny day'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        onClick={() => setOutageCondition(id)}
                        className={`py-1.5 rounded border transition-colors ${
                          outageCondition === id
                            ? 'border-zinc-200 bg-zinc-100 text-zinc-950 font-medium'
                            : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* CLEAR SHOPPING / SIZING RECOMMENDATION BOX */}
              <div className="p-4 rounded-md border border-zinc-800 bg-zinc-950/60 space-y-3 text-xs">
                <div className="font-medium text-zinc-200">
                  Recommended setup for your selected appliances
                </div>
                <div className="space-y-2 text-zinc-400">
                  <div className="flex justify-between">
                    <span>Minimum battery for {outageHours}h backup</span>
                    <span className="font-mono text-zinc-100">{recommendedBatteryKwh} kWh</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Minimum inverter size</span>
                    <span className="font-mono text-zinc-100">{recommendedInverterKw} kW</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Generator fuel saved per blackout</span>
                    <span className="font-mono text-emerald-400">
                      {dieselSavedLiters} L (~KES {kesSaved.toLocaleString()})
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* QUIET FOOTER WITH SEPARATE LINK TO OPERATOR / ENGINEER CONSOLE */}
        <footer className="max-w-4xl w-full mx-auto px-6 py-6 border-t border-zinc-900 flex items-center justify-between text-[11px] text-zinc-600">
          <span>GridPulse Open-Source Microgrid &amp; Backup Protection</span>
          <button
            onClick={() => setWorkspaceMode('operator')}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Grid operator &amp; engineering console →
          </button>
        </footer>
      </div>
    );
  }

  // ============================================================================
  // RENDER 2: DEDICATED OPERATOR & ENGINEERING CONSOLE (COMPLETELY SEPARATED)
  // ============================================================================
  const { metrics, system_state, active_scenario, auto_balancer_enabled, subsystems } = snapshot;
  const hospitalRoute = subsystems?.network_routing.hospital_route.path ?? [
    'GEN-OLK-01',
    'TR-NRB-04',
    'LOAD-HOSP-01',
  ];

  const isOnHospitalRoute = (a: string, b: string) => {
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

  const selectedNode =
    snapshot.nodes.find((n) => n.node_id === selectedNodeId) ?? snapshot.nodes[2];

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 antialiased">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* OPERATOR HEADER */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-zinc-800/80">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setWorkspaceMode('consumer')}
              className="text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded px-2.5 py-1 transition-colors"
            >
              ← Back to Backup Planner
            </button>
            <span className="text-sm font-medium text-zinc-200">
              Operator Console
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-zinc-500">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  backendConnected ? 'bg-emerald-500' : 'bg-zinc-500'
                }`}
              />
              {backendConnected ? 'Live' : 'Simulated'}
            </span>
          </div>

          <nav className="flex items-center gap-6 text-xs">
            {(
              [
                ['overview', 'Overview'],
                ['topology', 'Topology'],
                ['dispatch', 'Dispatch'],
                ['protocol', 'Protocol'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setOperatorTab(id)}
                className={`py-1 transition-colors ${
                  operatorTab === id
                    ? 'text-zinc-100 font-medium border-b border-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        {/* SCENARIO & PROTECTION BAR */}
        <section className="flex flex-wrap items-center justify-between gap-4 py-5 border-b border-zinc-800/60 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500 mr-2">Condition</span>
            {SCENARIOS.map((scn) => {
              const active = active_scenario === scn.id;
              return (
                <button
                  key={scn.id}
                  onClick={() => triggerScenario(scn.id)}
                  className={`px-3 py-1.5 rounded transition-colors ${
                    active
                      ? 'bg-zinc-100 text-zinc-950 font-medium'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                  }`}
                >
                  {scn.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={toggleAutoBalancer}
            className="flex items-center gap-2.5 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <span>Auto-protection</span>
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-mono ${
                auto_balancer_enabled
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-rose-500/10 text-rose-400'
              }`}
            >
              {auto_balancer_enabled ? 'On' : 'Off'}
            </span>
          </button>
        </section>

        {/* 4 KEY METRICS */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-8 py-8 border-b border-zinc-800/60">
          <div>
            <div className="text-xs text-zinc-500">Grid frequency</div>
            <div
              className={`mt-2 text-2xl font-mono font-normal tracking-tight tabular-nums ${
                metrics.frequency_hz < 49.5 ? 'text-rose-400' : 'text-zinc-100'
              }`}
            >
              {metrics.frequency_hz.toFixed(2)} <span className="text-sm text-zinc-500">Hz</span>
            </div>
            <div className="mt-1 text-xs font-mono text-zinc-500 tabular-nums">
              {metrics.bus_voltage_v.toFixed(1)} V bus
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-500">Transformer load</div>
            <div
              className={`mt-2 text-2xl font-mono font-normal tracking-tight tabular-nums ${
                metrics.transformer_load_pct > 88
                  ? 'text-rose-400'
                  : metrics.transformer_load_pct > 78
                  ? 'text-amber-400'
                  : 'text-zinc-100'
              }`}
            >
              {metrics.transformer_load_pct.toFixed(1)}
              <span className="text-sm text-zinc-500">%</span>
            </div>
            <div className="mt-1 text-xs font-mono text-zinc-500 tabular-nums">
              {metrics.transformer_temp_c.toFixed(1)} °C oil
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-500">Battery storage</div>
            <div className="mt-2 text-2xl font-mono font-normal tracking-tight text-zinc-100 tabular-nums">
              {metrics.bess_soc_pct.toFixed(1)}
              <span className="text-sm text-zinc-500">%</span>
            </div>
            <div className="mt-1 text-xs font-mono text-zinc-500 tabular-nums">
              {(metrics.bess_dispatch_kw > 0 ? '+' : '') + metrics.bess_dispatch_kw.toFixed(1)} kW
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-500">System state</div>
            <div className="mt-2 text-lg font-medium tracking-tight text-zinc-100">
              {formatStateLabel(system_state)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Clinic uptime {metrics.clinic_uptime_pct.toFixed(0)}%
            </div>
          </div>
        </section>

        {/* OPERATOR TAB 1: OVERVIEW */}
        {operatorTab === 'overview' && (
          <div className="py-8 space-y-12">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xs font-medium text-zinc-400">Corridor power flow</h2>
                <span className="text-xs font-mono text-zinc-500">
                  Priority route: {hospitalRoute.join(' → ')}
                </span>
              </div>

              <div className="border border-zinc-800/80 rounded-md p-6 bg-zinc-950/40">
                <svg viewBox="0 0 800 210" className="w-full h-auto font-mono">
                  <line
                    x1="170"
                    y1="52"
                    x2="310"
                    y2="52"
                    stroke={isOnHospitalRoute('GEN-OLK-01', 'TR-NRB-04') ? '#e4e4e7' : '#27272a'}
                    strokeWidth={isOnHospitalRoute('GEN-OLK-01', 'TR-NRB-04') ? '1.5' : '1'}
                  />
                  <line
                    x1="170"
                    y1="152"
                    x2="310"
                    y2="152"
                    stroke={isOnHospitalRoute('GEN-SOL-02', 'BESS-KSM-01') ? '#e4e4e7' : '#27272a'}
                    strokeWidth={isOnHospitalRoute('GEN-SOL-02', 'BESS-KSM-01') ? '1.5' : '1'}
                  />
                  <line
                    x1="395"
                    y1="82"
                    x2="395"
                    y2="122"
                    stroke={isOnHospitalRoute('TR-NRB-04', 'BESS-KSM-01') ? '#e4e4e7' : '#27272a'}
                    strokeWidth="1.2"
                  />
                  <line
                    x1="480"
                    y1="52"
                    x2="620"
                    y2="52"
                    stroke={isOnHospitalRoute('TR-NRB-04', 'LOAD-HOSP-01') ? '#e4e4e7' : '#27272a'}
                    strokeWidth={isOnHospitalRoute('TR-NRB-04', 'LOAD-HOSP-01') ? '1.5' : '1'}
                  />
                  <line
                    x1="480"
                    y1="145"
                    x2="620"
                    y2="62"
                    stroke={isOnHospitalRoute('BESS-KSM-01', 'LOAD-HOSP-01') ? '#e4e4e7' : '#27272a'}
                    strokeWidth={isOnHospitalRoute('BESS-KSM-01', 'LOAD-HOSP-01') ? '1.5' : '1'}
                  />
                  <line x1="480" y1="155" x2="620" y2="155" stroke="#27272a" strokeWidth="1" />

                  {[
                    { id: 'GEN-OLK-01', x: 10, y: 24 },
                    { id: 'GEN-SOL-02', x: 10, y: 124 },
                    { id: 'TR-NRB-04', x: 310, y: 24 },
                    { id: 'BESS-KSM-01', x: 310, y: 124 },
                    { id: 'LOAD-HOSP-01', x: 620, y: 24 },
                    { id: 'LOAD-COMM-02', x: 620, y: 124 },
                  ].map((pos) => {
                    const node = snapshot.nodes.find((n) => n.node_id === pos.id)!;
                    const selected = selectedNodeId === node.node_id;
                    return (
                      <g
                        key={node.node_id}
                        onClick={() => setSelectedNodeId(node.node_id)}
                        className="cursor-pointer"
                      >
                        <rect
                          x={pos.x}
                          y={pos.y}
                          width="165"
                          height="56"
                          rx="3"
                          fill="#09090b"
                          stroke={selected ? '#e4e4e7' : '#27272a'}
                          strokeWidth={selected ? '1.5' : '1'}
                        />
                        <text x={pos.x + 12} y={pos.y + 22} fill="#a1a1aa" fontSize="10">
                          {node.node_name}
                        </text>
                        <text
                          x={pos.x + 12}
                          y={pos.y + 42}
                          fill="#f4f4f5"
                          fontSize="12"
                          fontWeight="500"
                        >
                          {node.active_power_kw.toFixed(1)} kW
                        </text>
                        <text
                          x={pos.x + 153}
                          y={pos.y + 42}
                          fill="#71717a"
                          fontSize="10"
                          textAnchor="end"
                        >
                          {node.load_pct.toFixed(0)}%
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div>
                <div className="flex justify-between text-xs text-zinc-500 mb-3">
                  <span>Transformer load trend</span>
                  <span className="font-mono text-zinc-300 tabular-nums">
                    {metrics.transformer_load_pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-16 border-b border-zinc-800/80 flex items-end">
                  <svg viewBox="0 0 300 60" className="w-full h-full overflow-visible">
                    <polyline
                      fill="none"
                      stroke="#e4e4e7"
                      strokeWidth="1.25"
                      points={history
                        .map((pt, i) => {
                          const x = (i / Math.max(1, history.length - 1)) * 300;
                          const y = 60 - (Math.min(130, Math.max(0, pt.load)) / 130) * 55;
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        })
                        .join(' ')}
                    />
                  </svg>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-500 mb-3">
                  <span>Frequency stability (50.00 Hz nominal)</span>
                  <span className="font-mono text-zinc-300 tabular-nums">
                    {metrics.frequency_hz.toFixed(2)} Hz
                  </span>
                </div>
                <div className="h-16 border-b border-zinc-800/80 flex items-end">
                  <svg viewBox="0 0 300 60" className="w-full h-full overflow-visible">
                    <polyline
                      fill="none"
                      stroke="#a1a1aa"
                      strokeWidth="1.25"
                      points={history
                        .map((pt, i) => {
                          const x = (i / Math.max(1, history.length - 1)) * 300;
                          const clamped = Math.min(50.4, Math.max(48.8, pt.freq));
                          const y = 60 - ((clamped - 48.8) / 1.6) * 55;
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        })
                        .join(' ')}
                    />
                  </svg>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-zinc-400">Nodes</h2>
                <span className="text-xs font-mono text-zinc-500">
                  Selected: {selectedNode.node_id} ({selectedNode.temperature_c.toFixed(1)} °C)
                </span>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 font-normal">
                    <th className="py-2.5 font-normal">Node</th>
                    <th className="py-2.5 font-normal">ID</th>
                    <th className="py-2.5 font-normal text-right">Active power</th>
                    <th className="py-2.5 font-normal text-right">Capacity</th>
                    <th className="py-2.5 font-normal text-right">Load</th>
                    <th className="py-2.5 font-normal text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50 font-mono tabular-nums">
                  {snapshot.nodes.map((n) => (
                    <tr
                      key={n.node_id}
                      onClick={() => setSelectedNodeId(n.node_id)}
                      className={`cursor-pointer transition-colors ${
                        selectedNodeId === n.node_id ? 'bg-zinc-900/70' : 'hover:bg-zinc-900/30'
                      }`}
                    >
                      <td className="py-3 font-sans text-zinc-200">{n.node_name}</td>
                      <td className="py-3 text-zinc-500">{n.node_id}</td>
                      <td className="py-3 text-right text-zinc-200">
                        {n.active_power_kw.toFixed(1)} kW
                      </td>
                      <td className="py-3 text-right text-zinc-500">
                        {n.rated_capacity_kw.toFixed(0)} kW
                      </td>
                      <td className="py-3 text-right text-zinc-300">{n.load_pct.toFixed(1)}%</td>
                      <td className="py-3 text-right text-zinc-400">{n.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h2 className="text-xs font-medium text-zinc-400 mb-3">Recent dispatch log</h2>
              <div className="divide-y divide-zinc-800/50 border-t border-zinc-800/80 text-xs">
                {snapshot.recent_events.slice(0, 5).map((evt) => (
                  <div
                    key={evt.idempotency_key}
                    className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-zinc-500 tabular-nums">
                        {new Date(evt.timestamp_utc).toISOString().slice(11, 19)}
                      </span>
                      <span className="text-zinc-300">{evt.action_taken}</span>
                    </div>
                    <span className="font-mono text-zinc-500 tabular-nums shrink-0">
                      {evt.idempotency_key}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* OPERATOR TAB 2: TOPOLOGY */}
        {operatorTab === 'topology' && subsystems && (
          <div className="py-8 space-y-10">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-zinc-400">
                  Shortest-loss critical delivery path (Dijkstra)
                </h2>
                <span className="text-xs font-mono text-zinc-400 tabular-nums">
                  Impedance cost: {subsystems.network_routing.hospital_route.total_impedance_cost}
                </span>
              </div>
              <div className="py-4 px-5 border border-zinc-800/80 rounded-md font-mono text-xs text-zinc-200 flex items-center gap-3">
                {subsystems.network_routing.hospital_route.path.map((id, idx, arr) => (
                  <span key={id} className="flex items-center gap-3">
                    <span>{id}</span>
                    {idx < arr.length - 1 && <span className="text-zinc-600">→</span>}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-zinc-400">
                  Radial spanning tree (Prim MST)
                </h2>
                <span className="text-xs font-mono text-zinc-500 tabular-nums">
                  Total impedance: {subsystems.network_routing.radial_topology.total_mst_impedance}
                </span>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="py-2.5 font-normal">From</th>
                    <th className="py-2.5 font-normal">To</th>
                    <th className="py-2.5 font-normal">Feeder segment</th>
                    <th className="py-2.5 font-normal text-right">Impedance weight</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50 font-mono tabular-nums">
                  {subsystems.network_routing.radial_topology.edges.map((e) => (
                    <tr key={`${e.from}-${e.to}`}>
                      <td className="py-3 text-zinc-200">{e.from}</td>
                      <td className="py-3 text-zinc-300">{e.to}</td>
                      <td className="py-3 font-sans text-zinc-400">{e.line}</td>
                      <td className="py-3 text-right text-zinc-200">{e.weight.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* OPERATOR TAB 3: DISPATCH */}
        {operatorTab === 'dispatch' && subsystems && (
          <div className="py-8 space-y-10">
            <div>
              <h2 className="text-xs font-medium text-zinc-400 mb-3">Battery dispatch profile</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {STRATEGIES.map((s) => {
                  const active = subsystems.dispatch_architecture.active_strategy === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => changeStrategy(s.id)}
                      className={`p-4 text-left rounded-md border transition-colors ${
                        active
                          ? 'border-zinc-200 bg-zinc-900/60'
                          : 'border-zinc-800/80 hover:border-zinc-700'
                      }`}
                    >
                      <div className="text-xs font-medium text-zinc-100">{s.name}</div>
                      <div className="mt-1.5 text-xs text-zinc-500 leading-relaxed">
                        {s.summary}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-10">
              <div>
                <h2 className="text-xs font-medium text-zinc-400 mb-3">Zone power balance</h2>
                <div className="border-t border-zinc-800/80 divide-y divide-zinc-800/50 text-xs">
                  {subsystems.dispatch_architecture.zone_hierarchy.children?.map((zone) => (
                    <div key={zone.id} className="py-3">
                      <div className="flex justify-between font-medium text-zinc-200 mb-1.5">
                        <span>{zone.name}</span>
                        <span className="font-mono tabular-nums">
                          {zone.net_power_kw.toFixed(1)} kW
                        </span>
                      </div>
                      {zone.children?.map((leaf) => (
                        <div
                          key={leaf.id}
                          className="flex justify-between py-1 text-zinc-500 pl-3"
                        >
                          <span>{leaf.name}</span>
                          <span className="font-mono tabular-nums">
                            {(leaf.net_power_kw > 0 ? '+' : '') + leaf.net_power_kw.toFixed(1)} kW
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="text-xs font-medium text-zinc-400 mb-3">
                  Telemetry buffer synchronization
                </h2>
                <div className="border-t border-zinc-800/80 divide-y divide-zinc-800/50 text-xs font-mono tabular-nums">
                  <div className="py-2.5 flex justify-between">
                    <span className="font-sans text-zinc-500">Synchronizer</span>
                    <span className="text-zinc-300">RLock + Compare-And-Swap</span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="font-sans text-zinc-500">Ring buffer capacity</span>
                    <span className="text-zinc-300">
                      {subsystems.concurrency_engine.ring_buffer_capacity} frames
                    </span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="font-sans text-zinc-500">Frames processed</span>
                    <span className="text-zinc-300">
                      {subsystems.concurrency_engine.frames_processed_seq}
                    </span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="font-sans text-zinc-500">Mutex lock acquisitions</span>
                    <span className="text-zinc-300">
                      {subsystems.concurrency_engine.lock_acquisitions}
                    </span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="font-sans text-zinc-500">Atomic CAS transitions</span>
                    <span className="text-zinc-300">
                      {subsystems.concurrency_engine.cas_transitions_committed}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* OPERATOR TAB 4: PROTOCOL & SAFETY INTERLOCK */}
        {operatorTab === 'protocol' && subsystems && (
          <div className="py-8 space-y-10">
            <div>
              <h2 className="text-xs font-medium text-zinc-400 mb-3">
                64-bit RTU binary frames (CRC-8 polynomial 0x07)
              </h2>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="py-2.5 font-normal">Node</th>
                    <th className="py-2.5 font-normal">Wire frame (8 bytes)</th>
                    <th className="py-2.5 font-normal">ID:Flags</th>
                    <th className="py-2.5 font-normal text-right">Voltage</th>
                    <th className="py-2.5 font-normal text-right">Frequency</th>
                    <th className="py-2.5 font-normal text-right">CRC-8</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50 font-mono tabular-nums">
                  {subsystems.rtu_frames.map((f) => (
                    <tr key={f.node_id}>
                      <td className="py-3 text-zinc-300">{f.node_id}</td>
                      <td className="py-3 text-zinc-100">{f.hex_frame}</td>
                      <td className="py-3 text-zinc-500">{f.register_breakdown.id_status_bits}</td>
                      <td className="py-3 text-right text-zinc-400">
                        {f.register_breakdown.volt_fixed16}
                      </td>
                      <td className="py-3 text-right text-zinc-400">
                        {f.register_breakdown.freq_fixed16}
                      </td>
                      <td className="py-3 text-right text-emerald-400">
                        {f.register_breakdown.crc8_checksum}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-10">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-medium text-zinc-400">Breaker safety interlock</h2>
                  <span className="text-xs font-mono text-emerald-400">
                    {subsystems.safety_interlock.invariant_satisfied ? 'Satisfied' : 'Violated'}
                  </span>
                </div>
                <div className="border-t border-zinc-800/80 divide-y divide-zinc-800/50 text-xs">
                  {subsystems.safety_interlock.propositions.map((p) => (
                    <div key={p.symbol} className="py-2.5 flex justify-between">
                      <span className="text-zinc-400">
                        <strong className="font-mono text-zinc-200 mr-2">{p.symbol}</strong>
                        {p.label}
                      </span>
                      <span className="font-mono text-zinc-300">{p.value ? 'true' : 'false'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h2 className="text-xs font-medium text-zinc-400 mb-3">
                  SQLite relational aggregation (by asset class)
                </h2>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="py-2 font-normal">Class</th>
                      <th className="py-2 font-normal text-right">Mean power</th>
                      <th className="py-2 font-normal text-right">Peak load</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/50 font-mono tabular-nums">
                    {subsystems.telemetry_analytics.map((row) => (
                      <tr key={row.node_class}>
                        <td className="py-2.5 text-zinc-300">{row.node_class}</td>
                        <td className="py-2.5 text-right text-zinc-400">
                          {row.avg_power_kw.toFixed(1)} kW
                        </td>
                        <td className="py-2.5 text-right text-zinc-400">
                          {row.peak_load_pct.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
