import random
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, List
from database import (
    record_dispatch_event,
    log_telemetry_snapshot,
    fetch_recent_events,
    fetch_sql_analytics,
)
from core_subsystems import (
    GridTopologyGraph,
    CompositeDistributionZone,
    LeafGridUnit,
    DispatchStrategy,
    DroopControlStrategy,
    AggressivePeakShavingStrategy,
    ClinicReserveStrategy,
    SynchronizedTelemetryMonitor,
    RTUBinaryCodec,
    BreakerSafetyInterlock,
)


class MicrogridSimulator:
    """
    Deterministic State Machine & Physics-Grounded Digital Twin for a Kenyan Distribution Microgrid.
    Models 50.0 Hz frequency stability, transformer thermal loading, graph-based power routing,
    pluggable BESS dispatch profiles, thread-safe state synchronization, and 64-bit RTU binary framing.
    """

    def __init__(self) -> None:
        self.tick_count = 0
        self.state = "STABLE"
        self.active_scenario = "NOMINAL"
        self.auto_balancer_enabled = True

        self.graph = GridTopologyGraph()

        self.strategies: Dict[str, DispatchStrategy] = {
            "PROPORTIONAL_DROOP": DroopControlStrategy(),
            "AGGRESSIVE_PEAK_SHAVING": AggressivePeakShavingStrategy(),
            "CONSERVATIVE_CLINIC_RESERVE": ClinicReserveStrategy(),
        }
        self.active_strategy: DispatchStrategy = self.strategies["PROPORTIONAL_DROOP"]

        self.sync_monitor = SynchronizedTelemetryMonitor(capacity=32)

        self.frequency_hz = 50.00
        self.bus_voltage_v = 240.0
        self.transformer_temp_c = 54.0

        self.geothermal_kw = 310.0
        self.solar_kw = 185.0
        self.clinic_load_kw = 108.0
        self.commercial_load_kw = 240.0

        self.bess_capacity_kwh = 400.0
        self.bess_max_kw = 250.0
        self.bess_soc_pct = 78.0
        self.bess_dispatch_kw = 0.0

        self.commercial_curtailment = 1.0

    def set_strategy(self, strategy_key: str) -> Dict[str, Any]:
        key = strategy_key.upper()
        if key in self.strategies:
            self.active_strategy = self.strategies[key]
        return {"active_strategy": self.active_strategy.strategy_name}

    def inject_scenario(self, scenario: str) -> Dict[str, Any]:
        prev_state = self.state
        expected_ver = self.sync_monitor.state_version
        self.sync_monitor.atomic_state_transition(expected_ver)

        self.active_scenario = scenario.upper()

        if self.active_scenario == "EVENING_PEAK":
            self.solar_kw = 25.0
            self.commercial_load_kw = 385.0
            self.geothermal_kw = 315.0
        elif self.active_scenario == "CLOUD_TRANSIENT":
            self.solar_kw = 35.0
            self.commercial_load_kw = 290.0
        elif self.active_scenario == "UPSTREAM_BLACKOUT":
            self.geothermal_kw = 0.0
            self.solar_kw = 165.0
            self.commercial_load_kw = 250.0
        else:
            self.active_scenario = "NOMINAL"
            self.geothermal_kw = 310.0
            self.solar_kw = 185.0
            self.clinic_load_kw = 108.0
            self.commercial_load_kw = 240.0
            self.commercial_curtailment = 1.0
            self.bess_dispatch_kw = -25.0
            self.frequency_hz = 50.00
            self.bus_voltage_v = 240.0

        snapshot = self.step()
        return {
            "status": "ok",
            "scenario": self.active_scenario,
            "previous_state": prev_state,
            "current_state": self.state,
            "snapshot": snapshot,
        }

    def toggle_auto_balancer(self, enabled: bool) -> Dict[str, Any]:
        expected_ver = self.sync_monitor.state_version
        self.sync_monitor.atomic_state_transition(expected_ver)
        self.auto_balancer_enabled = enabled
        if not enabled:
            self.bess_dispatch_kw = 0.0
            self.commercial_curtailment = 1.0
        return {"auto_balancer_enabled": self.auto_balancer_enabled}

    def step(self) -> Dict[str, Any]:
        self.tick_count += 1
        prev_state = self.state

        jitter_geo = random.uniform(-3.5, 3.5) if self.geothermal_kw > 0 else 0.0
        jitter_sol = random.uniform(-4.0, 4.0) if self.solar_kw > 0 else 0.0
        jitter_clinic = random.uniform(-2.0, 2.0)
        jitter_comm = random.uniform(-5.0, 5.0)

        current_geo = max(0.0, self.geothermal_kw + jitter_geo)
        current_sol = max(0.0, self.solar_kw + jitter_sol)
        current_clinic = max(85.0, self.clinic_load_kw + jitter_clinic)
        raw_comm_load = max(120.0, self.commercial_load_kw + jitter_comm)

        unmitigated_demand = current_clinic + raw_comm_load
        available_gen = current_geo + current_sol
        transformer_rated_kva = 500.0

        action_description = None

        if self.auto_balancer_enabled:
            if current_geo == 0.0:
                self.state = "FAULT_ISLANDING"
                self.commercial_curtailment = 0.55
                effective_comm = raw_comm_load * self.commercial_curtailment
                island_deficit = (current_clinic + effective_comm) - current_sol
                self.bess_dispatch_kw = min(self.bess_max_kw, max(0.0, island_deficit))
                if prev_state != "FAULT_ISLANDING":
                    action_description = (
                        f"PCC Breaker Opened: Islanded microgrid on Solar + BESS ({self.bess_dispatch_kw:.1f} kW). "
                        f"Critical Clinic load 100% protected; SME load throttled to 55%."
                    )
            else:
                dispatch_kw, curtailment = self.active_strategy.compute_dispatch(
                    unmitigated_demand_kw=unmitigated_demand,
                    available_gen_kw=available_gen,
                    transformer_rated_kva=transformer_rated_kva,
                    bess_soc_pct=self.bess_soc_pct,
                    bess_max_kw=self.bess_max_kw,
                )
                self.bess_dispatch_kw = dispatch_kw
                self.commercial_curtailment = curtailment

                if curtailment < 1.0:
                    self.state = "DEMAND_RESPONSE_SHED"
                    if prev_state != "DEMAND_RESPONSE_SHED":
                        action_description = (
                            f"[{self.active_strategy.strategy_name}] Dispatched BESS ({self.bess_dispatch_kw:.1f} kW) "
                            f"+ Demand-Response: curtailed non-essential SME load by {int((1.0 - curtailment) * 100)}%."
                        )
                elif dispatch_kw > 0.0:
                    self.state = "BESS_DISPATCH_ACTIVE"
                    if prev_state != "BESS_DISPATCH_ACTIVE":
                        action_description = (
                            f"[{self.active_strategy.strategy_name}] Automated Peak Shaving: BESS injecting "
                            f"{self.bess_dispatch_kw:.1f} kW to relieve Kasarani 500kVA transformer."
                        )
                else:
                    self.state = "STABLE"
                    if prev_state != "STABLE":
                        action_description = (
                            "Grid telemetry returned to nominal band (50.0 Hz). "
                            "Restored 100% commercial feeder allocation; BESS in trickle-charge standby."
                        )
        else:
            self.bess_dispatch_kw = 0.0
            self.commercial_curtailment = 1.0
            if current_geo == 0.0 or (unmitigated_demand / transformer_rated_kva) * 100.0 > 90.0:
                self.state = "CRITICAL_OVERLOAD_UNPROTECTED"
                if prev_state != "CRITICAL_OVERLOAD_UNPROTECTED":
                    action_description = (
                        "ALERT: Auto-Balancer Disabled! Transformer exceeding thermal rating "
                        "and grid frequency collapsing toward under-frequency trip (<49.2 Hz)."
                    )
            else:
                self.state = "STABLE"

        effective_comm_kw = raw_comm_load * self.commercial_curtailment
        total_demand_kw = current_clinic + effective_comm_kw

        net_transformer_flow_kw = max(0.0, total_demand_kw - max(0.0, self.bess_dispatch_kw))
        if self.bess_dispatch_kw < 0:
            net_transformer_flow_kw += abs(self.bess_dispatch_kw)

        transformer_load_pct = min(135.0, (net_transformer_flow_kw / transformer_rated_kva) * 100.0)

        soc_delta = -(self.bess_dispatch_kw / self.bess_capacity_kwh) * 0.18
        self.bess_soc_pct = max(5.0, min(100.0, self.bess_soc_pct + soc_delta))

        total_supply_with_bess = current_geo + current_sol + self.bess_dispatch_kw
        power_balance_kw = total_supply_with_bess - total_demand_kw

        if self.state == "CRITICAL_OVERLOAD_UNPROTECTED":
            target_freq = 49.12 + random.uniform(-0.08, 0.05)
            target_volt = 204.0 + random.uniform(-3.0, 2.0)
        elif self.state == "FAULT_ISLANDING":
            target_freq = 49.88 + random.uniform(-0.04, 0.04)
            target_volt = 236.5 + random.uniform(-1.2, 1.2)
        else:
            freq_offset = max(-0.65, min(0.35, (power_balance_kw / 500.0) * 0.45))
            target_freq = 50.00 + freq_offset + random.uniform(-0.02, 0.02)
            volt_drop = max(0.0, (transformer_load_pct - 50.0) * 0.18)
            target_volt = 242.0 - volt_drop + random.uniform(-0.8, 0.8)

        self.frequency_hz = (self.frequency_hz * 0.45) + (target_freq * 0.55)
        self.bus_voltage_v = (self.bus_voltage_v * 0.5) + (target_volt * 0.5)

        target_temp = 34.0 + ((transformer_load_pct / 100.0) ** 1.7) * 52.0
        self.transformer_temp_c = (self.transformer_temp_c * 0.82) + (target_temp * 0.18)

        load_ratio_k = transformer_load_pct / 100.0
        winding_gradient_c = 22.0 * (load_ratio_k ** 1.6)
        winding_hotspot_c = self.transformer_temp_c + winding_gradient_c
        import math
        thermal_aging_factor = math.exp((15000.0 / 383.0) - (15000.0 / (winding_hotspot_c + 273.0)))

        baseline_forecast_kw = 348.0 if self.active_scenario == "NOMINAL" else 365.0
        forecast_error_pct = ((unmitigated_demand - baseline_forecast_kw) / baseline_forecast_kw) * 100.0
        corridor_losses_kw = round(4.2 + (load_ratio_k ** 2) * 14.5, 1)

        nodes: List[Dict[str, Any]] = [
            {
                "node_id": "GEN-OLK-01",
                "node_name": "Olkaria Geothermal Feeder",
                "node_type": "GENERATION",
                "region": "Nakuru / Rift Valley",
                "rated_capacity_kw": 450.0,
                "active_power_kw": round(current_geo, 1),
                "load_pct": round((current_geo / 450.0) * 100.0, 1),
                "voltage_v": round(self.bus_voltage_v if current_geo > 0 else 0.0, 1),
                "frequency_hz": round(self.frequency_hz if current_geo > 0 else 0.0, 2),
                "temperature_c": 42.5,
                "status": "OFFLINE_FAULT" if current_geo == 0 else "ONLINE",
            },
            {
                "node_id": "GEN-SOL-02",
                "node_name": "Nakuru Community Solar Array",
                "node_type": "GENERATION",
                "region": "Nakuru / Rift Valley",
                "rated_capacity_kw": 280.0,
                "active_power_kw": round(current_sol, 1),
                "load_pct": round((current_sol / 280.0) * 100.0, 1),
                "voltage_v": round(self.bus_voltage_v, 1),
                "frequency_hz": round(self.frequency_hz, 2),
                "temperature_c": round(31.0 + (current_sol / 280.0) * 18.0, 1),
                "status": "LOW_IRRADIANCE" if current_sol < 60.0 else "ONLINE",
            },
            {
                "node_id": "TR-NRB-04",
                "node_name": "Kasarani 500kVA Step-Down Transformer",
                "node_type": "TRANSFORMER",
                "region": "Nairobi North",
                "rated_capacity_kw": 500.0,
                "active_power_kw": round(net_transformer_flow_kw, 1),
                "load_pct": round(transformer_load_pct, 1),
                "voltage_v": round(self.bus_voltage_v, 1),
                "frequency_hz": round(self.frequency_hz, 2),
                "temperature_c": round(self.transformer_temp_c, 1),
                "status": (
                    "CRITICAL_OVERLOAD"
                    if transformer_load_pct > 90.0
                    else ("HIGH_LOAD_GUARD" if transformer_load_pct > 78.0 else "NOMINAL")
                ),
            },
            {
                "node_id": "BESS-KSM-01",
                "node_name": "GridPulse LFP Battery Bank (400kWh)",
                "node_type": "STORAGE",
                "region": "Nairobi North",
                "rated_capacity_kw": 250.0,
                "active_power_kw": round(self.bess_dispatch_kw, 1),
                "load_pct": round((abs(self.bess_dispatch_kw) / 250.0) * 100.0, 1),
                "voltage_v": round(self.bus_voltage_v, 1),
                "frequency_hz": round(self.frequency_hz, 2),
                "temperature_c": round(29.5 + (abs(self.bess_dispatch_kw) / 250.0) * 12.0, 1),
                "status": (
                    "DISCHARGING_SUPPORT"
                    if self.bess_dispatch_kw > 0
                    else ("CHARGING_SURPLUS" if self.bess_dispatch_kw < 0 else "STANDBY_IDLE")
                ),
            },
            {
                "node_id": "LOAD-HOSP-01",
                "node_name": "Sub-County Referral Clinic & Maternity",
                "node_type": "LOAD_CRITICAL",
                "region": "Nairobi North",
                "rated_capacity_kw": 140.0,
                "active_power_kw": round(current_clinic, 1),
                "load_pct": round((current_clinic / 140.0) * 100.0, 1),
                "voltage_v": round(self.bus_voltage_v, 1),
                "frequency_hz": round(self.frequency_hz, 2),
                "temperature_c": 26.0,
                "status": "PROTECTED_PRIORITY_1",
            },
            {
                "node_id": "LOAD-COMM-02",
                "node_name": "SME Cold-Storage & Agro-Processing Hub",
                "node_type": "LOAD_FLEXIBLE",
                "region": "Nairobi North",
                "rated_capacity_kw": 320.0,
                "active_power_kw": round(effective_comm_kw, 1),
                "load_pct": round((effective_comm_kw / 320.0) * 100.0, 1),
                "voltage_v": round(self.bus_voltage_v, 1),
                "frequency_hz": round(self.frequency_hz, 2),
                "temperature_c": 28.0,
                "status": (
                    f"CURTAILED_{int((1.0 - self.commercial_curtailment) * 100)}PCT"
                    if self.commercial_curtailment < 1.0
                    else "NOMINAL"
                ),
            },
        ]

        if action_description:
            expected_ver = self.sync_monitor.state_version
            self.sync_monitor.atomic_state_transition(expected_ver)
            idem_key = f"EVT-{self.tick_count}-{uuid.uuid4().hex[:8].upper()}"
            record_dispatch_event(
                idempotency_key=idem_key,
                trigger_node_id="TR-NRB-04" if current_geo > 0 else "GEN-OLK-01",
                previous_state=prev_state,
                new_state=self.state,
                action_taken=action_description,
                frequency_hz=self.frequency_hz,
                transformer_load_pct=transformer_load_pct,
                bess_dispatch_kw=self.bess_dispatch_kw,
            )

        if self.tick_count % 3 == 0:
            log_telemetry_snapshot(nodes, self.bess_soc_pct)

        upstream_online = current_geo > 0.0

        adj = self.graph.build_dynamic_adjacency(transformer_load_pct, upstream_online)
        primary_source = "GEN-OLK-01" if upstream_online else "GEN-SOL-02"
        shortest_route = self.graph.shortest_loss_path(
            source=primary_source, target="LOAD-HOSP-01", adj=adj
        )
        radial_tree = self.graph.radial_spanning_tree(
            start_node=primary_source, adj=adj
        )

        root_zone = CompositeDistributionZone("ZONE-KE-CORRIDOR", "Kenya Rift-Nairobi Grid Corridor")
        gen_zone = CompositeDistributionZone("ZONE-RIFT-GEN", "Rift Valley Renewable Generation Zone")
        gen_zone.add(LeafGridUnit("GEN-OLK-01", "Olkaria Geothermal", "GENERATION", current_geo))
        gen_zone.add(LeafGridUnit("GEN-SOL-02", "Nakuru Solar Array", "GENERATION", current_sol))

        dist_zone = CompositeDistributionZone("ZONE-NRB-NORTH", "Nairobi North Secondary Microgrid")
        dist_zone.add(LeafGridUnit("BESS-KSM-01", "LFP Storage Inverter", "STORAGE_INJECTION", self.bess_dispatch_kw))
        dist_zone.add(LeafGridUnit("LOAD-HOSP-01", "Referral Clinic", "LOAD_DEMAND", -current_clinic))
        dist_zone.add(LeafGridUnit("LOAD-COMM-02", "SME Market Hub", "LOAD_DEMAND", -effective_comm_kw))

        root_zone.add(gen_zone)
        root_zone.add(dist_zone)

        self.sync_monitor.record_frame_threadsafe(
            {"tick": self.tick_count, "freq": round(self.frequency_hz, 2), "state": self.state}
        )
        concurrency_stats = self.sync_monitor.get_diagnostics()
        binary_frames = [RTUBinaryCodec.encode_node_frame(n) for n in nodes]
        safety_interlock = BreakerSafetyInterlock.evaluate(
            upstream_online=upstream_online,
            transformer_load_pct=transformer_load_pct,
            frequency_hz=self.frequency_hz,
            bess_soc_pct=self.bess_soc_pct,
            bess_dispatch_kw=self.bess_dispatch_kw,
            clinic_protected=True,
        )

        return {
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "tick": self.tick_count,
            "system_state": self.state,
            "active_scenario": self.active_scenario,
            "auto_balancer_enabled": self.auto_balancer_enabled,
            "active_strategy": self.active_strategy.strategy_name,
            "metrics": {
                "frequency_hz": round(self.frequency_hz, 2),
                "bus_voltage_v": round(self.bus_voltage_v, 1),
                "total_generation_kw": round(current_geo + current_sol, 1),
                "total_demand_kw": round(total_demand_kw, 1),
                "transformer_load_pct": round(transformer_load_pct, 1),
                "transformer_temp_c": round(self.transformer_temp_c, 1),
                "winding_hotspot_c": round(winding_hotspot_c, 1),
                "thermal_aging_factor": round(thermal_aging_factor, 3),
                "forecast_demand_kw": round(baseline_forecast_kw, 1),
                "forecast_error_pct": round(forecast_error_pct, 1),
                "corridor_losses_kw": corridor_losses_kw,
                "pcc_breaker_closed": upstream_online,
                "bess_soc_pct": round(self.bess_soc_pct, 1),
                "bess_dispatch_kw": round(self.bess_dispatch_kw, 1),
                "clinic_uptime_pct": 100.0,
            },
            "nodes": nodes,
            "recent_events": fetch_recent_events(limit=10),
            "subsystems": {
                "network_routing": {
                    "hospital_route": shortest_route,
                    "radial_topology": radial_tree,
                },
                "dispatch_architecture": {
                    "active_strategy": self.active_strategy.strategy_name,
                    "available_strategies": list(self.strategies.keys()),
                    "zone_hierarchy": root_zone.to_hierarchy_dict(),
                },
                "concurrency_engine": concurrency_stats,
                "rtu_frames": binary_frames,
                "safety_interlock": safety_interlock,
                "telemetry_analytics": fetch_sql_analytics(),
            },
        }
