"""
GridPulse Core Engineering Subsystems
Implements graph-based power routing, hierarchical zone aggregation, pluggable BESS dispatch profiles,
thread-safe ring buffer synchronization, 64-bit RTU binary telemetry framing, and boolean breaker interlocks.
"""

import threading
from abc import ABC, abstractmethod
from typing import Dict, List, Tuple, Any, Optional


# ============================================================================
# 1. NETWORK GRAPH ROUTING (MinHeap Priority Queue, Shortest-Loss & Radial MST)
# ============================================================================

class MinHeap:
    """
    Array-backed binary Min-Heap priority queue for O(E log V) feeder path optimization.
    """

    def __init__(self) -> None:
        self._heap: List[Tuple[float, Any]] = []

    def is_empty(self) -> bool:
        return len(self._heap) == 0

    def push(self, priority: float, item: Any) -> None:
        self._heap.append((priority, item))
        self._sift_up(len(self._heap) - 1)

    def pop(self) -> Tuple[float, Any]:
        if not self._heap:
            raise IndexError("pop from empty MinHeap")
        top = self._heap[0]
        last = self._heap.pop()
        if self._heap:
            self._heap[0] = last
            self._sift_down(0)
        return top

    def _sift_up(self, idx: int) -> None:
        while idx > 0:
            parent = (idx - 1) // 2
            if self._heap[idx][0] < self._heap[parent][0]:
                self._heap[idx], self._heap[parent] = self._heap[parent], self._heap[idx]
                idx = parent
            else:
                break

    def _sift_down(self, idx: int) -> None:
        n = len(self._heap)
        while True:
            smallest = idx
            left = 2 * idx + 1
            right = 2 * idx + 2
            if left < n and self._heap[left][0] < self._heap[smallest][0]:
                smallest = left
            if right < n and self._heap[right][0] < self._heap[smallest][0]:
                smallest = right
            if smallest != idx:
                self._heap[idx], self._heap[smallest] = self._heap[smallest], self._heap[idx]
                idx = smallest
            else:
                break


class GridTopologyGraph:
    """
    Weighted undirected graph modeling 11kV/415V distribution feeders.
    Edge weights represent dynamic resistive line loss (I^2 * R) and impedance cost.
    """

    def __init__(self) -> None:
        self.vertices: List[str] = [
            "GEN-OLK-01",
            "GEN-SOL-02",
            "TR-NRB-04",
            "BESS-KSM-01",
            "LOAD-HOSP-01",
            "LOAD-COMM-02",
        ]
        self.base_edges: List[Tuple[str, str, float, str]] = [
            ("GEN-OLK-01", "TR-NRB-04", 2.4, "11kV Primary Trunk Line A"),
            ("GEN-OLK-01", "GEN-SOL-02", 3.1, "Rift Interconnector Tie"),
            ("GEN-SOL-02", "TR-NRB-04", 1.8, "Nakuru Solar Feeder B"),
            ("GEN-SOL-02", "BESS-KSM-01", 1.2, "DC-Coupled Storage Bus"),
            ("TR-NRB-04", "BESS-KSM-01", 0.9, "415V Secondary Bus Tie"),
            ("TR-NRB-04", "LOAD-HOSP-01", 1.5, "Dedicated Hospital Feeder"),
            ("BESS-KSM-01", "LOAD-HOSP-01", 0.7, "Emergency Island Micro-Bus"),
            ("TR-NRB-04", "LOAD-COMM-02", 2.1, "Commercial Market Feeder"),
            ("BESS-KSM-01", "LOAD-COMM-02", 2.8, "Auxiliary Storage Feeder"),
        ]

    def build_dynamic_adjacency(
        self, transformer_load_pct: float, upstream_online: bool
    ) -> Dict[str, List[Tuple[str, float, str]]]:
        adj: Dict[str, List[Tuple[str, float, str]]] = {v: [] for v in self.vertices}
        thermal_penalty = 1.0 + max(0.0, (transformer_load_pct - 70.0) / 50.0)

        for u, v, base_w, label in self.base_edges:
            if not upstream_online and (u == "GEN-OLK-01" or v == "GEN-OLK-01"):
                continue
            weight = base_w
            if "TR-NRB-04" in (u, v):
                weight = round(base_w * thermal_penalty, 2)
            adj[u].append((v, weight, label))
            adj[v].append((u, weight, label))
        return adj

    def shortest_loss_path(
        self, source: str, target: str, adj: Dict[str, List[Tuple[str, float, str]]]
    ) -> Dict[str, Any]:
        """
        Computes the minimum line-loss power delivery route from active generation/storage
        to the Priority-1 Referral Clinic.
        """
        dist: Dict[str, float] = {v: float("inf") for v in self.vertices}
        prev: Dict[str, Optional[str]] = {v: None for v in self.vertices}
        dist[source] = 0.0

        pq = MinHeap()
        pq.push(0.0, source)

        while not pq.is_empty():
            current_d, u = pq.pop()
            if current_d > dist[u]:
                continue
            if u == target:
                break
            for neighbor, weight, _ in adj.get(u, []):
                cand = current_d + weight
                if cand < dist[neighbor]:
                    dist[neighbor] = cand
                    prev[neighbor] = u
                    pq.push(cand, neighbor)

        path: List[str] = []
        curr: Optional[str] = target
        if dist[target] < float("inf"):
            while curr is not None:
                path.append(curr)
                curr = prev[curr]
            path.reverse()

        return {
            "source": source,
            "target": target,
            "path": path,
            "total_impedance_cost": round(dist[target], 2) if dist[target] < float("inf") else -1.0,
            "reachable": dist[target] < float("inf"),
        }

    def radial_spanning_tree(
        self, start_node: str, adj: Dict[str, List[Tuple[str, float, str]]]
    ) -> Dict[str, Any]:
        """
        Computes the minimum-impedance loop-free radial spanning tree across energized feeders.
        """
        visited = set([start_node])
        mst_edges: List[Dict[str, Any]] = []
        total_weight = 0.0
        pq = MinHeap()

        for neighbor, weight, label in adj.get(start_node, []):
            pq.push(weight, (start_node, neighbor, label))

        while not pq.is_empty():
            weight, (u, v, label) = pq.pop()
            if v in visited:
                continue
            visited.add(v)
            mst_edges.append({"from": u, "to": v, "weight": round(weight, 2), "line": label})
            total_weight += weight

            for next_v, next_w, next_label in adj.get(v, []):
                if next_v not in visited:
                    pq.push(next_w, (v, next_v, next_label))

        return {
            "root": start_node,
            "edges": mst_edges,
            "total_mst_impedance": round(total_weight, 2),
            "connected_nodes_count": len(visited),
        }


# ============================================================================
# 2. HIERARCHICAL ZONE MODELING & PLUGGABLE DISPATCH PROFILES
# ============================================================================

class GridComponent(ABC):
    """Base component for hierarchical grid power aggregation."""

    def __init__(self, component_id: str, name: str) -> None:
        self.component_id = component_id
        self.name = name

    @abstractmethod
    def get_net_power_kw(self) -> float:
        pass

    @abstractmethod
    def to_hierarchy_dict(self) -> Dict[str, Any]:
        pass


class LeafGridUnit(GridComponent):
    """Single physical generation, storage, or load asset."""

    def __init__(self, component_id: str, name: str, role: str, power_kw: float) -> None:
        super().__init__(component_id, name)
        self.role = role
        self.power_kw = power_kw

    def get_net_power_kw(self) -> float:
        return self.power_kw

    def to_hierarchy_dict(self) -> Dict[str, Any]:
        return {
            "id": self.component_id,
            "name": self.name,
            "type": "LEAF_ASSET",
            "role": self.role,
            "net_power_kw": round(self.power_kw, 1),
        }


class CompositeDistributionZone(GridComponent):
    """Distribution zone aggregating multiple sub-zones or leaf grid assets recursively."""

    def __init__(self, component_id: str, name: str) -> None:
        super().__init__(component_id, name)
        self.children: List[GridComponent] = []

    def add(self, component: GridComponent) -> None:
        self.children.append(component)

    def get_net_power_kw(self) -> float:
        return sum(child.get_net_power_kw() for child in self.children)

    def to_hierarchy_dict(self) -> Dict[str, Any]:
        return {
            "id": self.component_id,
            "name": self.name,
            "type": "DISTRIBUTION_ZONE",
            "net_power_kw": round(self.get_net_power_kw(), 1),
            "children": [c.to_hierarchy_dict() for c in self.children],
        }


class DispatchStrategy(ABC):
    """Pluggable BESS battery coordination profile."""

    @property
    @abstractmethod
    def strategy_name(self) -> str:
        pass

    @abstractmethod
    def compute_dispatch(
        self,
        unmitigated_demand_kw: float,
        available_gen_kw: float,
        transformer_rated_kva: float,
        bess_soc_pct: float,
        bess_max_kw: float,
    ) -> Tuple[float, float]:
        """Returns (bess_dispatch_kw, commercial_curtailment_factor)."""
        pass


class DroopControlStrategy(DispatchStrategy):
    """IEEE 1547 Proportional Frequency-Watt Droop Profile (Balanced)."""

    @property
    def strategy_name(self) -> str:
        return "PROPORTIONAL_DROOP"

    def compute_dispatch(
        self,
        unmitigated_demand_kw: float,
        available_gen_kw: float,
        transformer_rated_kva: float,
        bess_soc_pct: float,
        bess_max_kw: float,
    ) -> Tuple[float, float]:
        proj_load_pct = (unmitigated_demand_kw / transformer_rated_kva) * 100.0
        net_imbalance = available_gen_kw - unmitigated_demand_kw
        if proj_load_pct > 82.0 or net_imbalance < -15.0:
            if bess_soc_pct <= 15.0:
                return (0.0, 0.65)
            needed = max(unmitigated_demand_kw - (transformer_rated_kva * 0.76), -net_imbalance)
            dispatch = min(bess_max_kw, max(20.0, needed))
            residual_pct = ((unmitigated_demand_kw - dispatch) / transformer_rated_kva) * 100.0
            curtailment = 0.72 if residual_pct > 88.0 else 1.0
            return (dispatch, curtailment)
        if net_imbalance > 25.0 and bess_soc_pct < 95.0:
            return (-min(65.0, net_imbalance * 0.6), 1.0)
        return (0.0, 1.0)


class AggressivePeakShavingStrategy(DispatchStrategy):
    """Peak-Shaving Profile: strictly caps transformer load at 68% to minimize thermal aging."""

    @property
    def strategy_name(self) -> str:
        return "AGGRESSIVE_PEAK_SHAVING"

    def compute_dispatch(
        self,
        unmitigated_demand_kw: float,
        available_gen_kw: float,
        transformer_rated_kva: float,
        bess_soc_pct: float,
        bess_max_kw: float,
    ) -> Tuple[float, float]:
        target_cap_kw = transformer_rated_kva * 0.68
        if unmitigated_demand_kw > target_cap_kw and bess_soc_pct > 20.0:
            dispatch = min(bess_max_kw, unmitigated_demand_kw - target_cap_kw)
            return (dispatch, 1.0)
        if available_gen_kw > unmitigated_demand_kw and bess_soc_pct < 98.0:
            return (-min(80.0, available_gen_kw - unmitigated_demand_kw), 1.0)
        return (0.0, 1.0)


class ClinicReserveStrategy(DispatchStrategy):
    """Hospital Reserve Profile: preserves BESS charge for Priority-1 islanding, using Demand-Response first."""

    @property
    def strategy_name(self) -> str:
        return "CONSERVATIVE_CLINIC_RESERVE"

    def compute_dispatch(
        self,
        unmitigated_demand_kw: float,
        available_gen_kw: float,
        transformer_rated_kva: float,
        bess_soc_pct: float,
        bess_max_kw: float,
    ) -> Tuple[float, float]:
        proj_load_pct = (unmitigated_demand_kw / transformer_rated_kva) * 100.0
        if proj_load_pct > 80.0:
            curtailment = 0.68
            reduced_demand = unmitigated_demand_kw * 0.80
            if reduced_demand > transformer_rated_kva * 0.82 and bess_soc_pct > 40.0:
                return (min(bess_max_kw, reduced_demand - transformer_rated_kva * 0.78), curtailment)
            return (0.0, curtailment)
        if bess_soc_pct < 95.0:
            return (-45.0, 1.0)
        return (0.0, 1.0)


# ============================================================================
# 3. CONCURRENT TELEMETRY RING BUFFER & ATOMIC CAS SYNCHRONIZER
# ============================================================================

class SynchronizedTelemetryMonitor:
    """
    Thread-safe ring buffer and Compare-And-Swap (CAS) state synchronizer.
    Prevents race conditions between concurrent operator commands and background telemetry ingestion.
    """

    def __init__(self, capacity: int = 32) -> None:
        self._lock = threading.RLock()
        self._capacity = capacity
        self._ring_buffer: List[Dict[str, Any]] = [{} for _ in range(capacity)]
        self._write_seq = 0
        self._lock_acquisitions = 0
        self._cas_success_count = 0
        self._cas_conflict_prevented = 0
        self._state_version = 0

    def record_frame_threadsafe(self, frame_summary: Dict[str, Any]) -> None:
        with self._lock:
            self._lock_acquisitions += 1
            idx = self._write_seq % self._capacity
            self._ring_buffer[idx] = frame_summary
            self._write_seq += 1

    def atomic_state_transition(self, expected_version: int) -> Tuple[bool, int]:
        with self._lock:
            self._lock_acquisitions += 1
            if self._state_version == expected_version:
                self._state_version += 1
                self._cas_success_count += 1
                return (True, self._state_version)
            else:
                self._cas_conflict_prevented += 1
                return (False, self._state_version)

    @property
    def state_version(self) -> int:
        with self._lock:
            return self._state_version

    def get_diagnostics(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "synchronizer_type": "Reentrant Mutex (RLock) + Atomic CAS Version Guard",
                "ring_buffer_capacity": self._capacity,
                "frames_processed_seq": self._write_seq,
                "buffer_occupancy_pct": round(
                    (min(self._write_seq, self._capacity) / self._capacity) * 100.0, 1
                ),
                "lock_acquisitions": self._lock_acquisitions,
                "cas_transitions_committed": self._cas_success_count,
                "race_conditions_prevented": self._cas_conflict_prevented,
                "active_threads": threading.active_count(),
            }


# ============================================================================
# 4. 64-BIT RTU BINARY REGISTER CODEC & CRC-8 CHECKSUM VERIFIER
# ============================================================================

class RTUBinaryCodec:
    """
    Low-level 64-bit (8-byte) binary packet encoder and CRC-8 verifier for cellular RTU links:
      Byte 0: Sync Header (0xA5)
      Byte 1: [7:4] Node Index (4 bits) | [3:0] Status Bitflags (4 bits)
      Byte 2-3: Voltage in decivolts (uint16 big-endian, e.g. 240.2V -> 2402 -> 0x0962)
      Byte 4-5: Frequency in centihertz (uint16 big-endian, e.g. 50.00Hz -> 5000 -> 0x1388)
      Byte 6: Load Percentage (uint8, 0..255%)
      Byte 7: CRC-8 Checksum (polynomial 0x07 over bytes 0..6)
    """

    NODE_INDEX_MAP = {
        "GEN-OLK-01": 1,
        "GEN-SOL-02": 2,
        "TR-NRB-04": 3,
        "BESS-KSM-01": 4,
        "LOAD-HOSP-01": 5,
        "LOAD-COMM-02": 6,
    }

    @staticmethod
    def compute_crc8(data: List[int]) -> int:
        crc = 0x00
        for byte in data:
            crc ^= byte & 0xFF
            for _ in range(8):
                if crc & 0x80:
                    crc = ((crc << 1) ^ 0x07) & 0xFF
                else:
                    crc = (crc << 1) & 0xFF
        return crc

    @classmethod
    def encode_node_frame(cls, node: Dict[str, Any]) -> Dict[str, Any]:
        node_idx = cls.NODE_INDEX_MAP.get(node["node_id"], 0) & 0x0F
        status = node["status"]
        flag_online = 0 if "OFFLINE" in status else 1
        flag_fault = 1 if ("CRITICAL" in status or "OFFLINE" in status) else 0
        flag_bess = 1 if ("DISCHARGING" in status or "CHARGING" in status) else 0
        flag_prio = 1 if "PROTECTED" in status else 0
        status_nibble = ((flag_online << 3) | (flag_fault << 2) | (flag_bess << 1) | flag_prio) & 0x0F

        byte0 = 0xA5
        byte1 = ((node_idx << 4) | status_nibble) & 0xFF

        volt_dv = max(0, min(65535, int(round(node["voltage_v"] * 10))))
        byte2 = (volt_dv >> 8) & 0xFF
        byte3 = volt_dv & 0xFF

        freq_chz = max(0, min(65535, int(round(node["frequency_hz"] * 100))))
        byte4 = (freq_chz >> 8) & 0xFF
        byte5 = freq_chz & 0xFF

        byte6 = max(0, min(255, int(round(node["load_pct"]))))
        payload = [byte0, byte1, byte2, byte3, byte4, byte5, byte6]
        crc = cls.compute_crc8(payload)
        frame = payload + [crc]

        hex_str = " ".join(f"0x{b:02X}" for b in frame)
        bin_byte1 = f"{byte1:08b}"

        return {
            "node_id": node["node_id"],
            "hex_frame": hex_str,
            "register_breakdown": {
                "sync_byte": f"0x{byte0:02X}",
                "id_status_bits": f"0b{bin_byte1[:4]}_{bin_byte1[4:]}",
                "volt_fixed16": f"0x{volt_dv:04X} ({volt_dv} dV)",
                "freq_fixed16": f"0x{freq_chz:04X} ({freq_chz} cHz)",
                "load_uint8": f"0x{byte6:02X} ({byte6}%)",
                "crc8_checksum": f"0x{crc:02X} (VALID)",
            },
        }


# ============================================================================
# 5. FORMAL BOOLEAN BREAKER SAFETY INTERLOCK
# ============================================================================

class BreakerSafetyInterlock:
    """
    Evaluates formal boolean safety invariants before permitting automated breaker
    or inverter actuation.
    """

    @staticmethod
    def evaluate(
        upstream_online: bool,
        transformer_load_pct: float,
        frequency_hz: float,
        bess_soc_pct: float,
        bess_dispatch_kw: float,
        clinic_protected: bool,
    ) -> Dict[str, Any]:
        P = upstream_online
        Q = transformer_load_pct > 82.0
        R = frequency_hz < 49.65
        S = bess_soc_pct > 15.0
        D = bess_dispatch_kw > 0.0
        C = clinic_protected

        dispatch_trigger_condition = S and (Q or R or (not P))
        inv_dispatch_sound = (not D) or dispatch_trigger_condition
        inv_islanding_safe = P or C
        phi_safe = inv_dispatch_sound and inv_islanding_safe and C

        return {
            "formula": "Φ_safe ≡ (D → (S ∧ (Q ∨ R ∨ ¬P))) ∧ (¬P → C) ∧ C",
            "invariant_satisfied": phi_safe,
            "propositions": [
                {"symbol": "P", "label": "Upstream Feeder Energized", "value": P},
                {"symbol": "Q", "label": "Transformer Thermal Guard (>82%)", "value": Q},
                {"symbol": "R", "label": "Frequency Droop Trigger (<49.65Hz)", "value": R},
                {"symbol": "S", "label": "BESS Reserve Above Floor (>15%)", "value": S},
                {"symbol": "D", "label": "BESS Inverter Discharging", "value": D},
                {"symbol": "C", "label": "Priority-1 Clinic Energized", "value": C},
            ],
        }
