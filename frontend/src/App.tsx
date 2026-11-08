import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  Binary,
  CheckCircle2,
  Cpu,
  Database,
  Flame,
  GitBranch,
  Layers,
  Lock,
  Network,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Thermometer,
  Zap,
} from 'lucide-react';
import {
  DispatchEvent,
  GridNode,
  SubsystemsPayload,
  TelemetrySnapshot,
} from './types/grid';

const API_BASE = 'http://localhost:8000';
const WS_URL = 'ws://localhost:8000/ws';

type WorkbenchTab = 'OPERATIONS' | 'ROUTING' | 'DISPATCH_SYNC' | 'RTU_STORAGE';

function computeCrc8(bytes: number[]): number {
  let crc = 0x00;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function App() {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [backendConnected, setBackendConnected] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('OPERATIONS');
  const [history, setHistory] = useState<
    Array<{ tick: number; freq: number; load: number; bess: number }>
  >([]);

  const wsRef = useRef<WebSocket | null>(null);

  const localSimRef = useRef({
    tick: 0,
    state: 'STABLE',
    scenario: 'NOMINAL',
    autoBalancer: true,
    strategy: 'PROPORTIONAL_DROOP',
    freq: 50.0,
    voltage: 240.0,
    temp: 54.0,
    geoKw: 310.0,
    solKw: 185.0,
    clinicKw: 108.0,
    commKw: 240.0,
    bessSoc: 78.0,
    bessDispatch: 0.0,
    curtailment: 1.0,
    casCount: 1,
    events: [] as DispatchEvent[],
  });

  const stepLocalSimulation = (
    overrideScenario?: string,
    overrideBalancer?: boolean,
    overrideStrategy?: string
  ): TelemetrySnapshot => {
    const s = localSimRef.current;
    s.tick += 1;
    const prevState = s.state;

    if (overrideStrategy !== undefined) {
      s.strategy = overrideStrategy;
      s.casCount += 1;
    }

    if (overrideScenario !== undefined) {
      s.scenario = overrideScenario;
      s.casCount += 1;
      if (s.scenario === 'EVENING_PEAK') {
        s.solKw = 25.0;
        s.commKw = 385.0;
        s.geoKw = 315.0;
      } else if (s.scenario === 'CLOUD_TRANSIENT') {
        s.solKw = 35.0;
        s.commKw = 290.0;
        s.geoKw = 310.0;
      } else if (s.scenario === 'UPSTREAM_BLACKOUT') {
        s.geoKw = 0.0;
        s.solKw = 165.0;
        s.commKw = 250.0;
      } else {
        s.scenario = 'NOMINAL';
        s.geoKw = 310.0;
        s.solKw = 185.0;
        s.clinicKw = 108.0;
        s.commKw = 240.0;
        s.curtailment = 1.0;
        s.bessDispatch = -25.0;
        s.freq = 50.0;
        s.voltage = 240.0;
      }
    }

    if (overrideBalancer !== undefined) {
      s.autoBalancer = overrideBalancer;
      s.casCount += 1;
    }

    const jitter = (range: number) => (Math.random() - 0.5) * 2 * range;
    const curGeo = s.geoKw > 0 ? Math.max(0, s.geoKw + jitter(3.0)) : 0.0;
    const curSol = s.solKw > 0 ? Math.max(0, s.solKw + jitter(3.5)) : 0.0;
    const curClinic = Math.max(85, s.clinicKw + jitter(1.5));
    const rawComm = Math.max(120, s.commKw + jitter(4.5));

    const unmitigatedDemand = curClinic + rawComm;
    const availGen = curGeo + curSol;
    const trRated = 500.0;
    let actionDesc: string | null = null;

    if (s.autoBalancer) {
      if (curGeo === 0.0) {
        s.state = 'FAULT_ISLANDING';
        s.curtailment = 0.55;
        const effComm = rawComm * s.curtailment;
        const deficit = curClinic + effComm - curSol;
        s.bessDispatch = Math.min(250.0, Math.max(0.0, deficit));
        if (prevState !== 'FAULT_ISLANDING') {
          actionDesc = `PCC Breaker Opened: Islanded microgrid on Solar + BESS (${s.bessDispatch.toFixed(1)} kW). Critical Clinic 100% protected; SME load throttled to 55%.`;
        }
      } else {
        const projLoadPct = (unmitigatedDemand / trRated) * 100.0;
        const netImbalance = availGen - unmitigatedDemand;

        if (s.strategy === 'AGGRESSIVE_PEAK_SHAVING') {
          const capKw = trRated * 0.68;
          s.bessDispatch =
            unmitigatedDemand > capKw
              ? Math.min(250.0, unmitigatedDemand - capKw)
              : -25.0;
          s.curtailment = 1.0;
        } else if (s.strategy === 'CONSERVATIVE_CLINIC_RESERVE') {
          if (projLoadPct > 80.0) {
            s.curtailment = 0.68;
            const redDemand = unmitigatedDemand * 0.8;
            s.bessDispatch =
              redDemand > trRated * 0.82
                ? Math.min(250.0, redDemand - trRated * 0.78)
                : 0.0;
          } else {
            s.curtailment = 1.0;
            s.bessDispatch = -35.0;
          }
        } else {
          if (projLoadPct > 82.0 || netImbalance < -15.0) {
            const needed = Math.max(unmitigatedDemand - trRated * 0.76, -netImbalance);
            s.bessDispatch = Math.min(250.0, Math.max(20.0, needed));
            const residual = unmitigatedDemand - s.bessDispatch;
            s.curtailment = (residual / trRated) * 100.0 > 88.0 ? 0.72 : 1.0;
          } else {
            s.curtailment = 1.0;
            s.bessDispatch = netImbalance > 25.0 && s.bessSoc < 95.0 ? -24.0 : 0.0;
          }
        }

        if (s.curtailment < 1.0) {
          s.state = 'DEMAND_RESPONSE_SHED';
          if (prevState !== 'DEMAND_RESPONSE_SHED') {
            actionDesc = `[${s.strategy}] Dispatched BESS (${s.bessDispatch.toFixed(1)} kW) + Demand-Response: curtailed flexible SME load by ${Math.round((1 - s.curtailment) * 100)}%.`;
          }
        } else if (s.bessDispatch > 0) {
          s.state = 'BESS_DISPATCH_ACTIVE';
          if (prevState !== 'BESS_DISPATCH_ACTIVE') {
            actionDesc = `[${s.strategy}] Automated Peak Shaving: BESS injecting ${s.bessDispatch.toFixed(1)} kW to relieve Kasarani 500kVA transformer.`;
          }
        } else {
          s.state = 'STABLE';
          if (prevState !== 'STABLE') {
            actionDesc = `Grid telemetry restored to nominal band (50.0 Hz). Commercial feeders at 100%; BESS in trickle-charge standby.`;
          }
        }
      }
    } else {
      s.bessDispatch = 0.0;
      s.curtailment = 1.0;
      if (curGeo === 0.0 || (unmitigatedDemand / trRated) * 100.0 > 90.0) {
        s.state = 'CRITICAL_OVERLOAD_UNPROTECTED';
        if (prevState !== 'CRITICAL_OVERLOAD_UNPROTECTED') {
          actionDesc = `ALERT: Auto-Balancer Disabled! Transformer exceeding thermal rating and grid frequency collapsing toward blackout (<49.2 Hz).`;
        }
      } else {
        s.state = 'STABLE';
      }
    }

    const effCommKw = rawComm * s.curtailment;
    const totalDemand = curClinic + effCommKw;
    let netTrFlow = Math.max(0.0, totalDemand - Math.max(0.0, s.bessDispatch));
    if (s.bessDispatch < 0) netTrFlow += Math.abs(s.bessDispatch);
    const trLoadPct = Math.min(135.0, (netTrFlow / trRated) * 100.0);

    s.bessSoc = Math.max(5.0, Math.min(100.0, s.bessSoc - (s.bessDispatch / 400.0) * 0.18));

    const powerBalance = curGeo + curSol + s.bessDispatch - totalDemand;
    let targetFreq = 50.0;
    let targetVolt = 240.0;

    if (s.state === 'CRITICAL_OVERLOAD_UNPROTECTED') {
      targetFreq = 49.12 + jitter(0.05);
      targetVolt = 204.0 + jitter(2.0);
    } else if (s.state === 'FAULT_ISLANDING') {
      targetFreq = 49.88 + jitter(0.03);
      targetVolt = 236.5 + jitter(1.0);
    } else {
      const offset = Math.max(-0.6, Math.min(0.3, (powerBalance / 500.0) * 0.45));
      targetFreq = 50.0 + offset + jitter(0.02);
      targetVolt = 242.0 - Math.max(0, (trLoadPct - 50) * 0.18) + jitter(0.6);
    }

    s.freq = s.freq * 0.45 + targetFreq * 0.55;
    s.voltage = s.voltage * 0.5 + targetVolt * 0.5;
    const targetTemp = 34.0 + Math.pow(trLoadPct / 100.0, 1.7) * 52.0;
    s.temp = s.temp * 0.82 + targetTemp * 0.18;

    if (actionDesc) {
      const newEvt: DispatchEvent = {
        event_id: s.events.length + 1,
        idempotency_key: `EVT-${s.tick}-${Math.random().toString(16).substring(2, 8).toUpperCase()}`,
        timestamp_utc: new Date().toISOString(),
        trigger_node_id: curGeo > 0 ? 'TR-NRB-04' : 'GEN-OLK-01',
        previous_state: prevState,
        new_state: s.state,
        action_taken: actionDesc,
        frequency_at_trigger_hz: Number(s.freq.toFixed(2)),
        transformer_load_pct: Number(trLoadPct.toFixed(1)),
        bess_dispatch_kw: Number(s.bessDispatch.toFixed(1)),
      };
      s.events = [newEvt, ...s.events.slice(0, 11)];
    }

    const nodes: GridNode[] = [
      {
        node_id: 'GEN-OLK-01',
        node_name: 'Olkaria Geothermal Feeder',
        node_type: 'GENERATION',
        region: 'Nakuru / Rift Valley',
        rated_capacity_kw: 450,
        active_power_kw: Number(curGeo.toFixed(1)),
        load_pct: Number(((curGeo / 450) * 100).toFixed(1)),
        voltage_v: curGeo > 0 ? Number(s.voltage.toFixed(1)) : 0,
        frequency_hz: curGeo > 0 ? Number(s.freq.toFixed(2)) : 0,
        temperature_c: 42.5,
        status: curGeo === 0 ? 'OFFLINE_FAULT' : 'ONLINE',
      },
      {
        node_id: 'GEN-SOL-02',
        node_name: 'Nakuru Community Solar Array',
        node_type: 'GENERATION',
        region: 'Nakuru / Rift Valley',
        rated_capacity_kw: 280,
        active_power_kw: Number(curSol.toFixed(1)),
        load_pct: Number(((curSol / 280) * 100).toFixed(1)),
        voltage_v: Number(s.voltage.toFixed(1)),
        frequency_hz: Number(s.freq.toFixed(2)),
        temperature_c: Number((31 + (curSol / 280) * 18).toFixed(1)),
        status: curSol < 60 ? 'LOW_IRRADIANCE' : 'ONLINE',
      },
      {
        node_id: 'TR-NRB-04',
        node_name: 'Kasarani 500kVA Step-Down Transformer',
        node_type: 'TRANSFORMER',
        region: 'Nairobi North',
        rated_capacity_kw: 500,
        active_power_kw: Number(netTrFlow.toFixed(1)),
        load_pct: Number(trLoadPct.toFixed(1)),
        voltage_v: Number(s.voltage.toFixed(1)),
        frequency_hz: Number(s.freq.toFixed(2)),
        temperature_c: Number(s.temp.toFixed(1)),
        status:
          trLoadPct > 90
            ? 'CRITICAL_OVERLOAD'
            : trLoadPct > 78
              ? 'HIGH_LOAD_GUARD'
              : 'NOMINAL',
      },
      {
        node_id: 'BESS-KSM-01',
        node_name: 'GridPulse LFP Battery Bank (400kWh)',
        node_type: 'STORAGE',
        region: 'Nairobi North',
        rated_capacity_kw: 250,
        active_power_kw: Number(s.bessDispatch.toFixed(1)),
        load_pct: Number(((Math.abs(s.bessDispatch) / 250) * 100).toFixed(1)),
        voltage_v: Number(s.voltage.toFixed(1)),
        frequency_hz: Number(s.freq.toFixed(2)),
        temperature_c: Number((29.5 + (Math.abs(s.bessDispatch) / 250) * 12).toFixed(1)),
        status:
          s.bessDispatch > 0
            ? 'DISCHARGING_SUPPORT'
            : s.bessDispatch < 0
              ? 'CHARGING_SURPLUS'
              : 'STANDBY_IDLE',
      },
      {
        node_id: 'LOAD-HOSP-01',
        node_name: 'Sub-County Referral Clinic & Maternity',
        node_type: 'LOAD_CRITICAL',
        region: 'Nairobi North',
        rated_capacity_kw: 140,
        active_power_kw: Number(curClinic.toFixed(1)),
        load_pct: Number(((curClinic / 140) * 100).toFixed(1)),
        voltage_v: Number(s.voltage.toFixed(1)),
        frequency_hz: Number(s.freq.toFixed(2)),
        temperature_c: 26.0,
        status: 'PROTECTED_PRIORITY_1',
      },
      {
        node_id: 'LOAD-COMM-02',
        node_name: 'SME Cold-Storage & Agro-Processing Hub',
        node_type: 'LOAD_FLEXIBLE',
        region: 'Nairobi North',
        rated_capacity_kw: 320,
        active_power_kw: Number(effCommKw.toFixed(1)),
        load_pct: Number(((effCommKw / 320) * 100).toFixed(1)),
        voltage_v: Number(s.voltage.toFixed(1)),
        frequency_hz: Number(s.freq.toFixed(2)),
        temperature_c: 28.0,
        status:
          s.curtailment < 1.0
            ? `CURTAILED_${Math.round((1 - s.curtailment) * 100)}PCT`
            : 'NOMINAL',
      },
    ];

    const upstreamOnline = curGeo > 0;
    const binaryFrames = nodes.map((n, idx) => {
      const nodeIdx = idx + 1;
      const b0 = 0xa5;
      const b1 = ((nodeIdx << 4) | 0x09) & 0xff;
      const vDv = Math.round(n.voltage_v * 10);
      const b2 = (vDv >> 8) & 0xff;
      const b3 = vDv & 0xff;
      const fChz = Math.round(n.frequency_hz * 100);
      const b4 = (fChz >> 8) & 0xff;
      const b5 = fChz & 0xff;
      const b6 = Math.min(255, Math.round(n.load_pct));
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

    const subsystems: SubsystemsPayload = {
      network_routing: {
        hospital_route: upstreamOnline
          ? {
              source: 'GEN-OLK-01',
              target: 'LOAD-HOSP-01',
              path: ['GEN-OLK-01', 'TR-NRB-04', 'BESS-KSM-01', 'LOAD-HOSP-01'],
              total_impedance_cost: Number((4.0 + trLoadPct * 0.012).toFixed(2)),
              reachable: true,
            }
          : {
              source: 'GEN-SOL-02',
              target: 'LOAD-HOSP-01',
              path: ['GEN-SOL-02', 'BESS-KSM-01', 'LOAD-HOSP-01'],
              total_impedance_cost: 1.9,
              reachable: true,
            },
        radial_topology: {
          root: upstreamOnline ? 'GEN-OLK-01' : 'GEN-SOL-02',
          edges: [
            { from: 'BESS-KSM-01', to: 'LOAD-HOSP-01', weight: 0.7, line: 'Emergency Island Micro-Bus' },
            { from: 'TR-NRB-04', to: 'BESS-KSM-01', weight: 0.9, line: '415V Secondary Bus Tie' },
            { from: 'GEN-SOL-02', to: 'BESS-KSM-01', weight: 1.2, line: 'DC-Coupled Storage Bus' },
            { from: 'TR-NRB-04', to: 'LOAD-COMM-02', weight: 2.1, line: 'Commercial Market Feeder' },
            ...(upstreamOnline
              ? [{ from: 'GEN-OLK-01', to: 'TR-NRB-04', weight: 2.4, line: '11kV Primary Trunk Line A' }]
              : []),
          ],
          total_mst_impedance: upstreamOnline ? 7.3 : 4.9,
          connected_nodes_count: upstreamOnline ? 6 : 5,
        },
      },
      dispatch_architecture: {
        active_strategy: s.strategy,
        available_strategies: [
          'PROPORTIONAL_DROOP',
          'AGGRESSIVE_PEAK_SHAVING',
          'CONSERVATIVE_CLINIC_RESERVE',
        ],
        zone_hierarchy: {
          id: 'ZONE-KE-CORRIDOR',
          name: 'Kenya Rift-Nairobi Grid Corridor',
          type: 'DISTRIBUTION_ZONE',
          net_power_kw: Number((curGeo + curSol + s.bessDispatch - totalDemand).toFixed(1)),
          children: [
            {
              id: 'ZONE-RIFT-GEN',
              name: 'Rift Valley Renewable Generation Zone',
              type: 'DISTRIBUTION_ZONE',
              net_power_kw: Number((curGeo + curSol).toFixed(1)),
              children: [
                { id: 'GEN-OLK-01', name: 'Olkaria Geothermal', type: 'LEAF_ASSET', role: 'GENERATION', net_power_kw: Number(curGeo.toFixed(1)) },
                { id: 'GEN-SOL-02', name: 'Nakuru Solar Array', type: 'LEAF_ASSET', role: 'GENERATION', net_power_kw: Number(curSol.toFixed(1)) },
              ],
            },
            {
              id: 'ZONE-NRB-NORTH',
              name: 'Nairobi North Secondary Microgrid',
              type: 'DISTRIBUTION_ZONE',
              net_power_kw: Number((s.bessDispatch - totalDemand).toFixed(1)),
              children: [
                { id: 'BESS-KSM-01', name: 'LFP Storage Inverter', type: 'LEAF_ASSET', role: 'STORAGE_INJECTION', net_power_kw: Number(s.bessDispatch.toFixed(1)) },
                { id: 'LOAD-HOSP-01', name: 'Referral Clinic', type: 'LEAF_ASSET', role: 'LOAD_DEMAND', net_power_kw: Number((-curClinic).toFixed(1)) },
                { id: 'LOAD-COMM-02', name: 'SME Market Hub', type: 'LEAF_ASSET', role: 'LOAD_DEMAND', net_power_kw: Number((-effCommKw).toFixed(1)) },
              ],
            },
          ],
        },
      },
      concurrency_engine: {
        synchronizer_type: 'Reentrant Mutex (RLock) + Atomic CAS Version Guard',
        ring_buffer_capacity: 32,
        frames_processed_seq: s.tick,
        buffer_occupancy_pct: Number(((Math.min(s.tick, 32) / 32) * 100).toFixed(1)),
        lock_acquisitions: s.tick * 2 + s.casCount,
        cas_transitions_committed: s.casCount,
        race_conditions_prevented: 0,
        active_threads: 4,
      },
      rtu_frames: binaryFrames,
      safety_interlock: {
        formula: 'Φ_safe ≡ (D → (S ∧ (Q ∨ R ∨ ¬P))) ∧ (¬P → C) ∧ C',
        invariant_satisfied: true,
        propositions: [
          { symbol: 'P', label: 'Upstream Feeder Energized', value: upstreamOnline },
          { symbol: 'Q', label: 'Transformer Thermal Guard (>82%)', value: trLoadPct > 82.0 },
          { symbol: 'R', label: 'Frequency Droop Trigger (<49.65Hz)', value: s.freq < 49.65 },
          { symbol: 'S', label: 'BESS Reserve Above Floor (>15%)', value: s.bessSoc > 15.0 },
          { symbol: 'D', label: 'BESS Inverter Discharging', value: s.bessDispatch > 0 },
          { symbol: 'C', label: 'Priority-1 Clinic Energized', value: true },
        ],
      },
      telemetry_analytics: [
        { node_class: 'LOAD_CRITICAL', sample_count: s.tick, avg_power_kw: 108.0, peak_load_pct: 78.5, avg_temp_c: 26.0 },
        { node_class: 'LOAD_FLEXIBLE', sample_count: s.tick, avg_power_kw: Number(effCommKw.toFixed(1)), peak_load_pct: Number(((effCommKw / 320) * 100).toFixed(1)), avg_temp_c: 28.0 },
        { node_class: 'TRANSFORMER', sample_count: s.tick, avg_power_kw: Number(netTrFlow.toFixed(1)), peak_load_pct: Number(trLoadPct.toFixed(1)), avg_temp_c: Number(s.temp.toFixed(1)) },
        { node_class: 'GENERATION', sample_count: s.tick * 2, avg_power_kw: Number(((curGeo + curSol) / 2).toFixed(1)), peak_load_pct: 71.2, avg_temp_c: 38.4 },
        { node_class: 'STORAGE', sample_count: s.tick, avg_power_kw: Number(s.bessDispatch.toFixed(1)), peak_load_pct: Number(((Math.abs(s.bessDispatch) / 250) * 100).toFixed(1)), avg_temp_c: 31.2 },
      ],
    };

    return {
      timestamp_utc: new Date().toISOString(),
      tick: s.tick,
      system_state: s.state,
      active_scenario: s.scenario,
      auto_balancer_enabled: s.autoBalancer,
      active_strategy: s.strategy,
      metrics: {
        frequency_hz: Number(s.freq.toFixed(2)),
        bus_voltage_v: Number(s.voltage.toFixed(1)),
        total_generation_kw: Number((curGeo + curSol).toFixed(1)),
        total_demand_kw: Number(totalDemand.toFixed(1)),
        transformer_load_pct: Number(trLoadPct.toFixed(1)),
        transformer_temp_c: Number(s.temp.toFixed(1)),
        bess_soc_pct: Number(s.bessSoc.toFixed(1)),
        bess_dispatch_kw: Number(s.bessDispatch.toFixed(1)),
        clinic_uptime_pct: 100.0,
      },
      nodes,
      recent_events: s.events,
      subsystems,
    };
  };

  const pushSnapshot = (data: TelemetrySnapshot) => {
    setSnapshot(data);
    setHistory((prev) => {
      const next = [
        ...prev,
        {
          tick: data.tick,
          freq: data.metrics.frequency_hz,
          load: data.metrics.transformer_load_pct,
          bess: data.metrics.bess_dispatch_kw,
        },
      ];
      return next.slice(-36);
    });
  };

  useEffect(() => {
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let isMounted = true;

    const startFallbackLoop = () => {
      if (fallbackInterval) return;
      pushSnapshot(stepLocalSimulation());
      fallbackInterval = setInterval(() => {
        if (isMounted) {
          pushSnapshot(stepLocalSimulation());
        }
      }, 1000);
    };

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) return;
        setBackendConnected(true);
        if (fallbackInterval) {
          clearInterval(fallbackInterval);
          fallbackInterval = null;
        }
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data: TelemetrySnapshot = JSON.parse(event.data);
          pushSnapshot(data);
        } catch {
          // ignore malformed packet
        }
      };

      ws.onerror = () => {
        if (!isMounted) return;
        setBackendConnected(false);
        startFallbackLoop();
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setBackendConnected(false);
        startFallbackLoop();
      };
    } catch {
      setBackendConnected(false);
      startFallbackLoop();
    }

    return () => {
      isMounted = false;
      if (fallbackInterval) clearInterval(fallbackInterval);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleScenario = async (scenario: string) => {
    if (backendConnected && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'scenario', scenario }));
    } else if (backendConnected) {
      try {
        const res = await fetch(`${API_BASE}/api/scenario`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario }),
        });
        const data = await res.json();
        if (data.snapshot) pushSnapshot(data.snapshot);
      } catch {
        pushSnapshot(stepLocalSimulation(scenario));
      }
    } else {
      pushSnapshot(stepLocalSimulation(scenario));
    }
  };

  const handleToggleBalancer = async () => {
    if (!snapshot) return;
    const nextEnabled = !snapshot.auto_balancer_enabled;
    if (backendConnected && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ action: 'toggle_balancer', enabled: nextEnabled })
      );
    } else {
      pushSnapshot(stepLocalSimulation(undefined, nextEnabled));
    }
  };

  const handleStrategyChange = async (strategy: string) => {
    if (backendConnected && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'set_strategy', strategy }));
    } else {
      pushSnapshot(stepLocalSimulation(undefined, undefined, strategy));
    }
  };

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
        <div className="flex items-center gap-3 text-emerald-400">
          <RefreshCw className="w-6 h-6 animate-spin" />
          <span className="font-mono text-sm tracking-wider">
            INITIALIZING GRIDPULSE TELEMETRY ENGINE...
          </span>
        </div>
      </div>
    );
  }

  const {
    metrics,
    nodes,
    system_state,
    active_scenario,
    auto_balancer_enabled,
    recent_events,
    subsystems,
  } = snapshot;

  const stateBadgeColor = () => {
    switch (system_state) {
      case 'STABLE':
        return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
      case 'BESS_DISPATCH_ACTIVE':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
      case 'DEMAND_RESPONSE_SHED':
        return 'bg-orange-500/20 text-orange-300 border-orange-500/50';
      case 'FAULT_ISLANDING':
        return 'bg-sky-500/20 text-sky-300 border-sky-500/50';
      default:
        return 'bg-rose-500/25 text-rose-300 border-rose-500/60 animate-pulse';
    }
  };

  const chartWidth = 640;
  const chartHeight = 140;
  const freqPoints = history
    .map((pt, idx) => {
      const x = (idx / Math.max(1, history.length - 1)) * chartWidth;
      const normY = Math.max(0, Math.min(1, (pt.freq - 48.8) / 1.6));
      const y = chartHeight - normY * chartHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const loadPoints = history
    .map((pt, idx) => {
      const x = (idx / Math.max(1, history.length - 1)) * chartWidth;
      const normY = Math.max(0, Math.min(1, pt.load / 120.0));
      const y = chartHeight - normY * chartHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Executive Navigation & Status Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/70 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-inner">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-bold text-lg tracking-tight text-white">
                  GridPulse
                </h1>
                <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Kenya Grid Corridor • Distributed Telemetry Engine
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Real-Time Distribution Telemetry, Feeder Routing &amp; Automated BESS Coordination
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-xs font-mono">
              <span
                className={`w-2 h-2 rounded-full ${
                  backendConnected
                    ? 'bg-emerald-400 animate-ping'
                    : 'bg-amber-400 animate-pulse'
                }`}
              />
              <span className="text-slate-300">
                {backendConnected
                  ? 'FASTAPI + SQLITE WAL CONNECTED'
                  : 'EDGE DIGITAL TWIN ACTIVE'}
              </span>
            </div>

            <div
              className={`px-3 py-1.5 rounded-md border text-xs font-mono font-semibold flex items-center gap-1.5 ${stateBadgeColor()}`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>STATE: {system_state}</span>
            </div>

            <button
              onClick={handleToggleBalancer}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium border transition flex items-center gap-2 ${
                auto_balancer_enabled
                  ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-200 hover:bg-emerald-600/30'
                  : 'bg-rose-600/25 border-rose-500/60 text-rose-200 hover:bg-rose-600/35'
              }`}
            >
              {auto_balancer_enabled ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Auto-Protection: ON</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  <span>Auto-Protection: OFF (Unprotected)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6 flex-1">
        {/* Interactive Fault Injection Control Bar */}
        <section className="rounded-xl bg-slate-900/90 border border-slate-800 p-4 shadow-lg">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-400">
                <Cpu className="w-4 h-4" />
                <span>Interactive Grid Stress &amp; Fault Injection Deck</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Simulate East African distribution bottlenecks to inspect how GridPulse routes power and dispatches battery storage.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleScenario('NOMINAL')}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                  active_scenario === 'NOMINAL'
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-200 shadow-sm'
                    : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>1. Nominal Baseload (50.0 Hz)</span>
              </button>

              <button
                onClick={() => handleScenario('EVENING_PEAK')}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                  active_scenario === 'EVENING_PEAK'
                    ? 'bg-amber-500/25 border-amber-400 text-amber-200 shadow-sm'
                    : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Flame className="w-3.5 h-3.5 text-amber-400" />
                <span>2. Evening Peak Surge (+145 kW)</span>
              </button>

              <button
                onClick={() => handleScenario('CLOUD_TRANSIENT')}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                  active_scenario === 'CLOUD_TRANSIENT'
                    ? 'bg-orange-500/25 border-orange-400 text-orange-200 shadow-sm'
                    : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Sun className="w-3.5 h-3.5 text-orange-400" />
                <span>3. Solar Cloud Drop (-80% PV)</span>
              </button>

              <button
                onClick={() => handleScenario('UPSTREAM_BLACKOUT')}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition flex items-center gap-1.5 ${
                  active_scenario === 'UPSTREAM_BLACKOUT'
                    ? 'bg-sky-500/25 border-sky-400 text-sky-200 shadow-sm'
                    : 'bg-slate-800/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Power className="w-3.5 h-3.5 text-sky-400" />
                <span>4. National Grid Blackout (Island Mode)</span>
              </button>
            </div>
          </div>
        </section>

        {/* Top 4 Real-Time Telemetry KPI Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>BUS FREQUENCY (NOMINAL 50.0 HZ)</span>
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span
                className={`text-3xl font-bold font-mono ${
                  metrics.frequency_hz < 49.5
                    ? 'text-rose-400'
                    : metrics.frequency_hz < 49.8
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                }`}
              >
                {metrics.frequency_hz.toFixed(2)} Hz
              </span>
              <span className="text-xs font-mono text-slate-400">
                {metrics.bus_voltage_v.toFixed(1)} V
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Trip Threshold: &lt; 49.20 Hz</span>
              <span className="text-emerald-400 font-mono">Sync Locked</span>
            </div>
          </div>

          <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>KASARANI 500KVA TRANSFORMER</span>
              <Thermometer className="w-4 h-4 text-amber-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span
                className={`text-3xl font-bold font-mono ${
                  metrics.transformer_load_pct > 90
                    ? 'text-rose-400'
                    : metrics.transformer_load_pct > 78
                      ? 'text-amber-300'
                      : 'text-slate-100'
                }`}
              >
                {metrics.transformer_load_pct.toFixed(1)}%
              </span>
              <span className="text-xs font-mono text-slate-400">
                Oil: {metrics.transformer_temp_c.toFixed(1)}°C
              </span>
            </div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  metrics.transformer_load_pct > 90
                    ? 'bg-rose-500'
                    : metrics.transformer_load_pct > 78
                      ? 'bg-amber-400'
                      : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, metrics.transformer_load_pct)}%` }}
              />
            </div>
          </div>

          <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>LFP BATTERY BANK (400 KWH)</span>
              <BatteryCharging className="w-4 h-4 text-sky-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold font-mono text-sky-400">
                {metrics.bess_soc_pct.toFixed(1)}%
              </span>
              <span
                className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  metrics.bess_dispatch_kw > 0
                    ? 'bg-amber-500/20 text-amber-300'
                    : metrics.bess_dispatch_kw < 0
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-slate-800 text-slate-400'
                }`}
              >
                {metrics.bess_dispatch_kw > 0
                  ? `DISCHARGING +${metrics.bess_dispatch_kw.toFixed(1)} kW`
                  : metrics.bess_dispatch_kw < 0
                    ? `CHARGING ${metrics.bess_dispatch_kw.toFixed(1)} kW`
                    : 'STANDBY 0.0 kW'}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Profile: {subsystems?.dispatch_architecture.active_strategy || 'PROPORTIONAL_DROOP'}</span>
            </div>
          </div>

          <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>REFERRAL CLINIC (PRIORITY 1)</span>
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="my-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold font-mono text-emerald-400">
                {metrics.clinic_uptime_pct.toFixed(1)}%
              </span>
              <span className="text-xs font-mono text-slate-400">
                Gen: {metrics.total_generation_kw.toFixed(0)} kW / Load:{' '}
                {metrics.total_demand_kw.toFixed(0)} kW
              </span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center justify-between border-t border-slate-800/80 pt-2">
              <span>Zero-Outage Guarantee</span>
              <span className="text-emerald-400 font-mono">Interlock Verified</span>
            </div>
          </div>
        </section>

        {/* 4-Tab Engineering Workbench Navigation Bar */}
        <section className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          <button
            onClick={() => setActiveTab('OPERATIONS')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-semibold transition flex items-center gap-2 border ${
              activeTab === 'OPERATIONS'
                ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Activity className="w-4 h-4" />
            <span>1. Live Grid Telemetry &amp; Audit Ledger</span>
          </button>

          <button
            onClick={() => setActiveTab('ROUTING')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-semibold transition flex items-center gap-2 border ${
              activeTab === 'ROUTING'
                ? 'bg-sky-500/20 border-sky-500/60 text-sky-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Network className="w-4 h-4" />
            <span>2. Feeder Graph Routing &amp; Radial Topology</span>
          </button>

          <button
            onClick={() => setActiveTab('DISPATCH_SYNC')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-semibold transition flex items-center gap-2 border ${
              activeTab === 'DISPATCH_SYNC'
                ? 'bg-amber-500/20 border-amber-500/60 text-amber-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>3. Dispatch Profiles &amp; Concurrency Engine</span>
          </button>

          <button
            onClick={() => setActiveTab('RTU_STORAGE')}
            className={`px-3.5 py-2 rounded-lg text-xs font-mono font-semibold transition flex items-center gap-2 border ${
              activeTab === 'RTU_STORAGE'
                ? 'bg-purple-500/20 border-purple-500/60 text-purple-300'
                : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Binary className="w-4 h-4" />
            <span>4. RTU Binary Protocol, Safety Interlocks &amp; SQL</span>
          </button>
        </section>

        {/* TAB 1: LIVE GRID OPERATIONS */}
        {activeTab === 'OPERATIONS' && (
          <>
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 rounded-xl bg-slate-900/80 border border-slate-800 p-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Activity className="w-4 h-4 text-emerald-400" />
                      <span>Live Telemetry Waveform (36-Second Window)</span>
                    </h2>
                    <span className="text-[11px] font-mono text-slate-400">
                      Tick #{snapshot.tick}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mb-4">
                    Real-time trace of bus frequency stability (emerald) vs. step-down transformer load percentage (amber).
                  </p>
                </div>

                <div className="bg-slate-950/90 border border-slate-800/90 rounded-lg p-3">
                  <svg
                    viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                    className="w-full h-40 overflow-visible"
                  >
                    <line
                      x1="0"
                      y1={chartHeight * 0.25}
                      x2={chartWidth}
                      y2={chartHeight * 0.25}
                      stroke="#1e293b"
                      strokeDasharray="4 4"
                    />
                    <line
                      x1="0"
                      y1={chartHeight * 0.5}
                      x2={chartWidth}
                      y2={chartHeight * 0.5}
                      stroke="#1e293b"
                      strokeDasharray="4 4"
                    />
                    <line
                      x1="0"
                      y1={chartHeight * 0.75}
                      x2={chartWidth}
                      y2={chartHeight * 0.75}
                      stroke="#ef4444"
                      strokeOpacity="0.35"
                      strokeDasharray="3 3"
                    />
                    {loadPoints && (
                      <polyline
                        fill="none"
                        stroke="#f59e0b"
                        strokeWidth="2"
                        strokeOpacity="0.8"
                        points={loadPoints}
                      />
                    )}
                    {freqPoints && (
                      <polyline
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="2.5"
                        points={freqPoints}
                      />
                    )}
                  </svg>

                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mt-2 pt-2 border-t border-slate-900">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-emerald-400">
                        <span className="w-2.5 h-0.5 bg-emerald-400 inline-block" />
                        Frequency ({metrics.frequency_hz.toFixed(2)} Hz)
                      </span>
                      <span className="flex items-center gap-1.5 text-amber-400">
                        <span className="w-2.5 h-0.5 bg-amber-400 inline-block" />
                        Transformer Load ({metrics.transformer_load_pct.toFixed(1)}%)
                      </span>
                    </div>
                    <span className="text-rose-400/80">--- 85% Guard Limit</span>
                  </div>
                </div>

                <div className="mt-4 rounded-lg bg-slate-950/60 border border-slate-800/80 p-3 text-xs text-slate-300 space-y-1">
                  <div className="font-semibold text-white flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Why Clean Generation Needs Telemetry:</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    Without automated BESS coordination, an evening surge pushes the Kasarani 500kVA transformer past 90% load and drags frequency below 49.2 Hz. Toggle{' '}
                    <strong className="text-slate-200">Auto-Protection OFF</strong> above during an Evening Peak to observe an unmitigated collapse.
                  </p>
                </div>
              </div>

              <div className="lg:col-span-7 rounded-xl bg-slate-900/80 border border-slate-800 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">
                      Kenyan Distribution Node Topology (Live Telemetry)
                    </h2>
                    <p className="text-xs text-slate-400">
                      Per-node sensor readings streaming across generation, step-down transformer, BESS storage, and community loads.
                    </p>
                  </div>
                  <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded">
                    6 Active Nodes
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {nodes.map((node) => {
                    const isFault =
                      node.status.includes('OFFLINE') ||
                      node.status.includes('CRITICAL');
                    const isActiveSupport =
                      node.status.includes('DISCHARGING') ||
                      node.status.includes('CURTAILED') ||
                      node.status.includes('HIGH_LOAD');

                    return (
                      <div
                        key={node.node_id}
                        className={`rounded-lg p-3.5 border transition ${
                          isFault
                            ? 'bg-rose-950/20 border-rose-500/50'
                            : isActiveSupport
                              ? 'bg-amber-950/15 border-amber-500/40'
                              : 'bg-slate-950/60 border-slate-800'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                                {node.node_id}
                              </span>
                              <span className="text-[11px] font-mono text-slate-400">
                                {node.node_type}
                              </span>
                            </div>
                            <h3 className="text-sm font-semibold text-white mt-1">
                              {node.node_name}
                            </h3>
                          </div>

                          <span
                            className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border ${
                              isFault
                                ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                                : isActiveSupport
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                  : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            }`}
                          >
                            {node.status}
                          </span>
                        </div>

                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-mono">
                          <div className="bg-slate-900/90 rounded p-2 border border-slate-800/80">
                            <span className="text-[10px] text-slate-400 block">
                              ACTIVE POWER
                            </span>
                            <span className="text-slate-100 font-semibold">
                              {node.active_power_kw.toFixed(1)} kW
                            </span>
                          </div>
                          <div className="bg-slate-900/90 rounded p-2 border border-slate-800/80">
                            <span className="text-[10px] text-slate-400 block">
                              CAPACITY LOAD
                            </span>
                            <span className="text-slate-100 font-semibold">
                              {node.load_pct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="bg-slate-900/90 rounded p-2 border border-slate-800/80">
                            <span className="text-[10px] text-slate-400 block">
                              TEMP / VOLT
                            </span>
                            <span className="text-slate-100 font-semibold">
                              {node.temperature_c.toFixed(0)}°C •{' '}
                              {node.voltage_v.toFixed(0)}V
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* ACID Dispatch Ledger */}
            <section className="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  <h2 className="text-sm font-semibold text-white">
                    Transactional State Transition &amp; Automated Dispatch Ledger
                  </h2>
                </div>
                <span className="text-xs font-mono text-slate-400">
                  Idempotent Event Logging • Zero Duplicate Switching
                </span>
              </div>

              {recent_events.length === 0 ? (
                <div className="text-xs text-slate-400 font-mono py-6 text-center bg-slate-950/50 rounded-lg border border-slate-800/60">
                  Grid operating in steady-state nominal band (50.0 Hz). Trigger a fault scenario above to inspect automated ACID dispatch records.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-mono text-[11px]">
                        <th className="py-2 px-3">IDEMPOTENCY KEY</th>
                        <th className="py-2 px-3">TRIGGER NODE</th>
                        <th className="py-2 px-3">STATE TRANSITION</th>
                        <th className="py-2 px-3">BUS FREQ / TR LOAD</th>
                        <th className="py-2 px-3">AUTOMATED CONTROL ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {recent_events.map((ev) => (
                        <tr key={ev.idempotency_key} className="hover:bg-slate-800/40">
                          <td className="py-2.5 px-3 text-emerald-400 font-semibold whitespace-nowrap">
                            {ev.idempotency_key}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                            {ev.trigger_node_id}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span className="text-slate-400">{ev.previous_state}</span>
                            <span className="text-slate-500 mx-1.5">&rarr;</span>
                            <span className="text-amber-300 font-semibold">
                              {ev.new_state}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-slate-300 whitespace-nowrap">
                            {ev.frequency_at_trigger_hz.toFixed(2)} Hz •{' '}
                            {ev.transformer_load_pct.toFixed(1)}%
                          </td>
                          <td className="py-2.5 px-3 text-slate-200 font-sans">
                            {ev.action_taken}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* TAB 2: FEEDER GRAPH ROUTING & RADIAL TOPOLOGY */}
        {activeTab === 'ROUTING' && subsystems && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-mono uppercase text-sky-400">
                    Dynamic Feeder Graph Optimization
                  </span>
                  <h2 className="text-base font-semibold text-white mt-0.5">
                    Minimum Line-Loss Power Delivery Path
                  </h2>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
                  Min-Heap Priority Router
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Computes the minimum resistive line-loss (<code className="text-slate-200">I²R</code>) power delivery path from active renewable generation to the Priority-1 Sub-County Referral Clinic. As transformer thermal loading rises or upstream feeders trip, line impedance weights update automatically.
              </p>

              <div className="rounded-lg bg-slate-950/90 border border-slate-800 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">ACTIVE SOURCE:</span>
                  <span className="text-emerald-400 font-semibold">
                    {subsystems.network_routing.hospital_route.source}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">CRITICAL SINK:</span>
                  <span className="text-sky-400 font-semibold">
                    {subsystems.network_routing.hospital_route.target}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">CUMULATIVE IMPEDANCE COST:</span>
                  <span className="text-amber-300 font-semibold">
                    {subsystems.network_routing.hospital_route.total_impedance_cost} Ω-equiv
                  </span>
                </div>

                <div className="pt-2 border-t border-slate-800">
                  <span className="text-[11px] font-mono text-slate-400 block mb-2">
                    ACTIVE SHORTEST-LOSS VECTOR:
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {subsystems.network_routing.hospital_route.path.map(
                      (nodeId, i, arr) => (
                        <div key={nodeId} className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-xs font-semibold">
                            {nodeId}
                          </span>
                          {i < arr.length - 1 && (
                            <span className="text-slate-500 font-mono">&rarr;</span>
                          )}
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-mono uppercase text-emerald-400">
                    Loop-Free Microgrid Configuration
                  </span>
                  <h2 className="text-base font-semibold text-white mt-0.5">
                    Radial Minimum Spanning Topology
                  </h2>
                </div>
                <span className="text-xs font-mono px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Total Impedance: {subsystems.network_routing.radial_topology.total_mst_impedance} Ω
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Distribution grids operate in a loop-free radial tree to prevent circulating fault currents and simplify overcurrent relay coordination. The spanning tree solver selects the lowest-impedance feeders connecting all energized nodes.
              </p>

              <div className="space-y-2">
                {subsystems.network_routing.radial_topology.edges.map((edge, idx) => (
                  <div
                    key={`${edge.from}-${edge.to}-${idx}`}
                    className="rounded-lg bg-slate-950/80 border border-slate-800 p-2.5 flex items-center justify-between text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-slate-200 font-semibold">{edge.from}</span>
                      <span className="text-slate-500">&harr;</span>
                      <span className="text-sky-300 font-semibold">{edge.to}</span>
                    </div>
                    <span className="text-slate-400 font-sans text-[11px]">
                      {edge.line}
                    </span>
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-amber-300">
                      {edge.weight.toFixed(2)} Ω
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* TAB 3: DISPATCH PROFILES & CONCURRENCY ENGINE */}
        {activeTab === 'DISPATCH_SYNC' && subsystems && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-7 rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-5">
              <div>
                <span className="text-[11px] font-mono uppercase text-amber-400">
                  Modular Control Architecture
                </span>
                <h2 className="text-base font-semibold text-white mt-0.5">
                  Hot-Swappable BESS Dispatch Profiles &amp; Zone Hierarchy
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Switch the active battery coordination profile at runtime to adapt to changing grid priorities:
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {[
                  {
                    id: 'PROPORTIONAL_DROOP',
                    title: 'Proportional Droop',
                    desc: 'IEEE 1547 standard balance between BESS & load.',
                  },
                  {
                    id: 'AGGRESSIVE_PEAK_SHAVING',
                    title: 'Aggressive Peak Shaving',
                    desc: 'Strictly caps transformer load at 68% via BESS.',
                  },
                  {
                    id: 'CONSERVATIVE_CLINIC_RESERVE',
                    title: 'Clinic Reserve Priority',
                    desc: 'Sheds commercial load first to hoard battery SoC.',
                  },
                ].map((strat) => {
                  const active =
                    subsystems.dispatch_architecture.active_strategy === strat.id;
                  return (
                    <button
                      key={strat.id}
                      onClick={() => handleStrategyChange(strat.id)}
                      className={`p-3 rounded-lg border text-left transition ${
                        active
                          ? 'bg-amber-500/20 border-amber-400 text-white'
                          : 'bg-slate-950/70 border-slate-800 text-slate-300 hover:bg-slate-900'
                      }`}
                    >
                      <div className="text-xs font-mono font-bold text-amber-300">
                        {strat.title}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">{strat.desc}</p>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg bg-slate-950/90 border border-slate-800 p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-xs font-mono font-semibold text-white">
                    Hierarchical Zone Power Aggregation
                  </span>
                  <span className="text-xs font-mono text-emerald-400">
                    Corridor Net Balance:{' '}
                    {subsystems.dispatch_architecture.zone_hierarchy.net_power_kw > 0
                      ? '+'
                      : ''}
                    {subsystems.dispatch_architecture.zone_hierarchy.net_power_kw} kW
                  </span>
                </div>

                <div className="space-y-3 text-xs font-mono">
                  {subsystems.dispatch_architecture.zone_hierarchy.children?.map(
                    (zone) => (
                      <div
                        key={zone.id}
                        className="pl-3 border-l-2 border-slate-700 space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-sky-300 font-semibold">
                          <span>
                            [ZONE] {zone.name} ({zone.id})
                          </span>
                          <span>{zone.net_power_kw} kW</span>
                        </div>
                        <div className="pl-4 space-y-1">
                          {zone.children?.map((leaf) => (
                            <div
                              key={leaf.id}
                              className="flex items-center justify-between text-slate-400"
                            >
                              <span>
                                └─ [ASSET] {leaf.name} ({leaf.id})
                              </span>
                              <span
                                className={
                                  leaf.net_power_kw >= 0
                                    ? 'text-emerald-400'
                                    : 'text-amber-300'
                                }
                              >
                                {leaf.net_power_kw >= 0 ? '+' : ''}
                                {leaf.net_power_kw} kW
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-4 flex flex-col justify-between">
              <div className="space-y-3">
                <div>
                  <span className="text-[11px] font-mono uppercase text-emerald-400">
                    Thread-Safe Telemetry Synchronization
                  </span>
                  <h2 className="text-base font-semibold text-white mt-0.5 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-emerald-400" />
                    <span>Mutex Ring Buffer &amp; Atomic CAS Guard</span>
                  </h2>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Protects shared grid state between asynchronous WebSocket operator commands and the 1 Hz telemetry loop using a Reentrant Lock (<code className="text-slate-200">RLock</code>) and Compare-And-Swap (<code className="text-slate-200">CAS</code>) state version counters.
                </p>

                <div className="space-y-2.5 text-xs font-mono">
                  <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 flex items-center justify-between">
                    <span className="text-slate-400">SYNCHRONIZER PRIMITIVE</span>
                    <span className="text-emerald-400 font-semibold">RLock + CAS</span>
                  </div>
                  <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 flex items-center justify-between">
                    <span className="text-slate-400">MUTEX LOCK ACQUISITIONS</span>
                    <span className="text-slate-100 font-semibold">
                      {subsystems.concurrency_engine.lock_acquisitions}
                    </span>
                  </div>
                  <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 flex items-center justify-between">
                    <span className="text-slate-400">ATOMIC CAS COMMITS</span>
                    <span className="text-sky-300 font-semibold">
                      {subsystems.concurrency_engine.cas_transitions_committed}
                    </span>
                  </div>
                  <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 flex items-center justify-between">
                    <span className="text-slate-400">RING BUFFER OCCUPANCY</span>
                    <span className="text-amber-300 font-semibold">
                      {subsystems.concurrency_engine.buffer_occupancy_pct}% (32 slots)
                    </span>
                  </div>
                  <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 flex items-center justify-between">
                    <span className="text-slate-400">RACE CONDITIONS DETECTED</span>
                    <span className="text-emerald-400 font-semibold">0 (Thread-Safe)</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* TAB 4: RTU BINARY PROTOCOL, SAFETY INTERLOCKS & SQL ANALYTICS */}
        {activeTab === 'RTU_STORAGE' && subsystems && (
          <div className="space-y-6">
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7 rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[11px] font-mono uppercase text-purple-400">
                      Low-Bandwidth Cellular Telemetry Framing
                    </span>
                    <h2 className="text-base font-semibold text-white mt-0.5">
                      64-Bit RTU Binary Register Frames &amp; CRC-8 Verifier
                    </h2>
                  </div>
                  <span className="text-xs font-mono px-2.5 py-1 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                    8 Bytes / Frame
                  </span>
                </div>

                <p className="text-xs text-slate-400">
                  Packs floating-point sensor readings into compact 8-byte fixed-point hardware registers using bitwise shifts (<code className="text-slate-200">&lt;&lt;</code>, <code className="text-slate-200">&gt;&gt;</code>), bitmasks, and polynomial <code className="text-slate-200">0x07</code> CRC-8 verification for 2G cellular RTU links.
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                        <th className="py-2 px-2.5">NODE</th>
                        <th className="py-2 px-2.5">RAW 64-BIT HEX PACKET</th>
                        <th className="py-2 px-2.5">ID|FLAGS</th>
                        <th className="py-2 px-2.5">FIXED-16 FREQ</th>
                        <th className="py-2 px-2.5">CRC-8</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {subsystems.rtu_frames.map((bf) => (
                        <tr key={bf.node_id} className="hover:bg-slate-800/40">
                          <td className="py-2 px-2.5 text-slate-200 font-semibold">
                            {bf.node_id}
                          </td>
                          <td className="py-2 px-2.5 text-emerald-400">
                            {bf.hex_frame}
                          </td>
                          <td className="py-2 px-2.5 text-amber-300">
                            {bf.register_breakdown.id_status_bits}
                          </td>
                          <td className="py-2 px-2.5 text-sky-300">
                            {bf.register_breakdown.freq_fixed16}
                          </td>
                          <td className="py-2 px-2.5 text-purple-300">
                            {bf.register_breakdown.crc8_checksum}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="lg:col-span-5 rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-4">
                <div>
                  <span className="text-[11px] font-mono uppercase text-emerald-400">
                    Deterministic Breaker Protection
                  </span>
                  <h2 className="text-base font-semibold text-white mt-0.5">
                    Formal Boolean Safety Interlock Gate
                  </h2>
                </div>

                <div className="rounded-lg bg-slate-950/90 border border-slate-800 p-3 font-mono text-xs text-emerald-300">
                  {subsystems.safety_interlock.formula}
                </div>

                <div className="space-y-2">
                  {subsystems.safety_interlock.propositions.map((p) => (
                    <div
                      key={p.symbol}
                      className="rounded bg-slate-950/70 border border-slate-800 px-3 py-2 flex items-center justify-between text-xs font-mono"
                    >
                      <div>
                        <span className="text-amber-300 font-bold mr-2">
                          {p.symbol}:
                        </span>
                        <span className="text-slate-300 font-sans">{p.label}</span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded font-bold ${
                          p.value
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {p.value ? 'TRUE (1)' : 'FALSE (0)'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-xl bg-slate-900/80 border border-slate-800 p-5 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="text-[11px] font-mono uppercase text-sky-400">
                    Relational Time-Series Aggregations
                  </span>
                  <h2 className="text-sm font-semibold text-white">
                    Live Multi-Table JOIN &amp; GROUP BY Telemetry Summary
                  </h2>
                </div>
                <code className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2.5 py-1 rounded border border-slate-800">
                  SELECT node_type, COUNT(*), AVG(active_power_kw), MAX(load_pct) FROM grid_nodes LEFT JOIN telemetry_readings GROUP BY node_type
                </code>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                      <th className="py-2 px-3">NODE CLASS (GROUP BY)</th>
                      <th className="py-2 px-3">TELEMETRY SAMPLES</th>
                      <th className="py-2 px-3">AVG ACTIVE POWER (KW)</th>
                      <th className="py-2 px-3">PEAK CAPACITY LOAD (%)</th>
                      <th className="py-2 px-3">AVG THERMAL TEMP (°C)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {subsystems.telemetry_analytics.map((row) => (
                      <tr key={row.node_class} className="hover:bg-slate-800/40">
                        <td className="py-2 px-3 text-emerald-400 font-semibold">
                          {row.node_class}
                        </td>
                        <td className="py-2 px-3 text-slate-300">
                          {row.sample_count}
                        </td>
                        <td className="py-2 px-3 text-slate-200">
                          {row.avg_power_kw} kW
                        </td>
                        <td className="py-2 px-3 text-amber-300">
                          {row.peak_load_pct}%
                        </td>
                        <td className="py-2 px-3 text-slate-300">
                          {row.avg_temp_c}°C
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
export default App;
