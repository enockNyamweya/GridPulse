# GridPulse

**Smart grid digital telemetry, transformer overload protection, and automated Battery Energy Storage System (BESS) coordination engine for distribution microgrids.**

**Live deployment:** [https://gridpulse-ea.netlify.app](https://gridpulse-ea.netlify.app)

![Deployment](https://img.shields.io/badge/Netlify-Live_Production-10b981?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.11%2B-0284c7?style=flat-square)
![FastAPI](https://img.shields.io/badge/FastAPI-WebSocket_%2B_REST-059669?style=flat-square)
![SQLite](https://img.shields.io/badge/SQLite-WAL_ACID_Ledger-2563eb?style=flat-square)
![React](https://img.shields.io/badge/React-18.3_%2B_TypeScript_5-52525b?style=flat-square)
![Grid Standard](https://img.shields.io/badge/Nominal_Grid-50.00_Hz_%7C_240.0_V-10b981?style=flat-square)
![Protocol](https://img.shields.io/badge/RTU_Telemetry-64_Bit_CRC8-7c3aed?style=flat-square)

---

## Executive summary and problem context

Kenya generates over 90% of its electricity from renewable sources, led by geothermal baseload plants in the Olkaria Rift Valley, hydroelectric stations along the Tana River, and utility-scale wind and solar installations. Despite abundant clean power at the transmission level, peri-urban communities, healthcare clinics, and agro-processing enterprises experience frequent localized brownouts, voltage sag, and distribution transformer failures.

The structural bottleneck lies in secondary distribution visibility and automated flexibility. Most 11 kV / 240 V step-down transformers operate without sub-second thermal telemetry or coordinated distributed storage. When evening commercial demand surges or rapid cloud transients reduce local solar photovoltaic output, transformers exceed their thermal ratings, frequency sags below the 49.20 Hz protection threshold, and feeder breakers trip.

**GridPulse** addresses this distribution coordination gap by combining a physics-grounded microgrid digital twin, IEC 60076-7 transformer thermal modeling, graph-theoretic feeder routing, runtime-swappable BESS dispatch strategies, thread-safe ring buffer telemetry, 64-bit fixed-point Remote Terminal Unit (RTU) binary framing, formal propositional breaker interlocks, and an ACID-compliant SQLite Write-Ahead Logging (WAL) audit ledger.

---

## System architecture

![GridPulse End-to-End Architecture](docs/system-architecture.svg)

GridPulse is structured across three decoupled operational tiers:

1. **Field telemetry and physics simulation layer ([`backend/simulator.py`](backend/simulator.py)):** Computes real-time 50.00 Hz frequency droop, secondary bus voltage regulation, IEC 60076-7 transformer top-oil ($\Theta_{\text{oil}}$) and winding hot-spot ($\Theta_{\text{hs}}$) temperatures, Arrhenius relative thermal aging acceleration ($F_{\text{AA}}$), $I^2R$ corridor copper losses, short-horizon demand forecast deviation, and Lithium Iron Phosphate (LFP) battery Coulomb counting across a 6-node Kenyan distribution corridor at 1.5-second intervals.
2. **Core control and algorithmic subsystems ([`backend/core_subsystems.py`](backend/core_subsystems.py) & [`backend/database.py`](backend/database.py)):** Executes graph-based power routing, hierarchical zone rollups, pluggable inverter dispatch strategies, mutex-synchronized circular frame buffering, 64-bit bitwise telemetry encoding with CRC-8 verification, propositional breaker safety checks, and transactional SQL persistence.
3. **Accessible operator and consumer interface ([`frontend/src/App.tsx`](frontend/src/App.tsx)):** Provides a calm, minimalist monochrome interface organized into five views:
   * **`Backup planner` (For homeowners, clinics, and small businesses):** An interactive blackout survival calculator where everyday users can select presets (*Home or Apartment*, *Health Clinic*, *Small Business / Cold Room*) or enter their own essential loads, heavy equipment, solar panel wattage, battery capacity, and blackout duration to compare survival hours with and without smart load-shedding, minimum required battery sizing, and diesel generator fuel savings (`KES` / `Liters`).
   * **`Live corridor`, `Topology`, `Dispatch`, and `Protocol`:** Full-corridor microgrid telemetry with plain-English state explanations, Dijkstra shortest-loss clinic routing, Prim radial spanning tree tables, BESS control profiles, and 64-bit RTU binary frame inspection.

---

## Microgrid single-line diagram and protection state machine

![Microgrid Single-Line Diagram and State Machine](docs/microgrid-single-line-diagram.svg)

### Modeled Kenyan distribution corridor (6 nodes)

| Node ID | Asset name | Node class | Region | Rated capacity | Priority & operational role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GEN-OLK-01` | Olkaria Geothermal Feeder | `GENERATION` | Rift Valley | `450.0 kW` | Primary synchronous baseload supply across the Point of Common Coupling (PCC) |
| `GEN-SOL-02` | Nakuru Community Solar Array | `GENERATION` | Rift Valley | `280.0 kW` | Grid-tied photovoltaic array subject to cloud irradiance transients |
| `TR-NRB-04` | Kasarani Step-Down Transformer | `TRANSFORMER` | Nairobi North | `500.0 kVA` | Primary 11 kV / 240 V secondary bottleneck monitored for oil thermal overload |
| `BESS-KSM-01` | GridPulse LFP Battery Bank | `STORAGE` | Nairobi North | `400 kWh / 250 kW` | Four-quadrant bi-directional inverter for peak shaving and island formation |
| `LOAD-HOSP-01` | Sub-County Referral Clinic | `LOAD_CRITICAL` | Nairobi North | `140.0 kW` | Priority-1 protected medical facility requiring 100% uninterrupted power |
| `LOAD-COMM-02` | SME Cold-Storage & Agro Hub | `LOAD_FLEXIBLE` | Nairobi North | `320.0 kW` | Curtailable commercial load participating in automated demand-response |

### Deterministic protection state machine

| System state | UI status label | Trigger condition | Automated control response |
| :--- | :--- | :--- | :--- |
| `STABLE` | `Nominal` | Upstream feeder energized and transformer load $\le 78\%$ | Maintains nominal 50.00 Hz bus; trickle-charges `BESS-KSM-01` using surplus solar PV |
| `BESS_DISPATCH_ACTIVE` | `Battery dispatch` | Net generation deficit $> 15\text{ kW}$ or transformer load $> 82\%$ | Commands the active BESS strategy to inject real power (up to $250\text{ kW}$) at the secondary bus |
| `DEMAND_RESPONSE_SHED` | `Demand response` | Residual transformer load $> 88\%$ after battery support | Throttles flexible commercial load (`LOAD-COMM-02`) by 28% while preserving 100% power to `LOAD-HOSP-01` |
| `FAULT_ISLANDING` | `Islanded` | Upstream grid outage (`GEN-OLK-01` drops to $0\text{ kW}$) | Opens PCC breaker, forms a standalone Solar + BESS island, and curtails commercial load to 55% |

---

## Core engineering subsystems

### 1. IEC 60076-7 transformer thermal and aging model

Implemented in [`MicrogridSimulator.step()`](backend/simulator.py). In addition to tracking real power flow across the 500 kVA Kasarani transformer (`TR-NRB-04`), the physics solver models top-oil thermal inertia, winding hot-spot temperature ($\Theta_{\text{hs}}$), and relative insulation aging acceleration ($F_{\text{AA}}$) as functions of the load ratio $K = L_{\text{TR}} / 100$:

$$\Theta_{\text{hs}} = \Theta_{\text{oil}} + 22.0 \cdot K^{1.6}, \qquad F_{\text{AA}} = \exp\left(\frac{15000}{383} - \frac{15000}{\Theta_{\text{hs}} + 273}\right)$$

### 2. Feeder graph routing and radial spanning topology

Implemented in [`GridTopologyGraph`](backend/core_subsystems.py) using a custom array-backed binary priority queue ([`MinHeap`](backend/core_subsystems.py)):

* **Dynamic thermal impedance weighting:** Each feeder line $(u, v)$ has a base resistance weight $w_0(u, v)$. As load on `TR-NRB-04` exceeds $75\%$, winding copper losses increase non-linearly:
  $$w_{\text{eff}}(u, v) = w_0(u, v) + \max\bigl(0,\; (L_{\text{TR}} - 75.0) \times 0.12\bigr)$$
* **Shortest-loss hospital delivery (`shortest_loss_path`):** Runs Dijkstra's algorithm ($O((V + E)\log V)$) from the active bulk source to `LOAD-HOSP-01`. Under nominal loading, power routes directly through `TR-NRB-04`. Under thermal stress, elevated transformer impedance causes the router to shift hospital delivery through the local battery bus (`BESS-KSM-01`).
* **Loop-free radial network enforcement (`radial_spanning_tree`):** Runs Prim's Minimum Spanning Tree algorithm across all energized nodes so secondary distribution feeders remain strictly radial without circulating fault currents.

### 3. Hierarchical zone aggregation and pluggable BESS dispatch profiles

Implemented via [`GridComponent`](backend/core_subsystems.py), [`CompositeDistributionZone`](backend/core_subsystems.py), and [`DispatchStrategy`](backend/core_subsystems.py):

* **Recursive zone power tree:** Models the corridor as a hierarchical tree (`ZONE-KE-CORRIDOR` $\rightarrow$ `ZONE-RIFT-GEN` + `ZONE-NRB-NORTH` $\rightarrow$ Leaf Units) where `compute_net_power_kw()` recursively aggregates generation, storage injection, and load demand.
* **Runtime-swappable inverter dispatch profiles:** Operators can switch the active BESS control law in the `Dispatch` tab (`POST /api/strategy`) without restarting the simulation loop:

| Strategy key | Control objective | Mathematical dispatch law |
| :--- | :--- | :--- |
| `PROPORTIONAL_DROOP` | Balanced frequency-watt droop and peak shaving | $P_{\text{BESS}} = \min\bigl(P_{\max},\; \max(20,\; P_{\text{dem}} - 0.76 \cdot S_{\text{rated}})\bigr)$; curtails commercial load to $72\%$ if residual load $> 88\%$ |
| `AGGRESSIVE_PEAK_SHAVING` | Strictly cap transformer utilization at 68% ($340\text{ kW}$) | $P_{\text{BESS}} = \min\bigl(P_{\max},\; P_{\text{dem}} - 0.68 \cdot S_{\text{rated}}\bigr)$ when $\text{SoC} > 20\%$ to minimize thermal aging |
| `CONSERVATIVE_CLINIC_RESERVE` | Preserve battery State of Charge for extended blackouts | Curtails flexible commercial load to $68\%$ first when load $> 80\%$; discharges BESS only if reduced load exceeds $82\%$ and $\text{SoC} > 40\%$ |

### 4. Thread-safe telemetry ring buffer and atomic state transitions

Implemented in [`SynchronizedTelemetryMonitor`](backend/core_subsystems.py):

* **Reentrant mutex (`threading.RLock`):** Serializes concurrent access between the background 1.5-second physics loop, asynchronous WebSocket broadcast coroutines, and incoming HTTP fault-injection mutations.
* **Bounded 32-slot circular ring buffer:** Writes telemetry frames at index `write_seq % 32` in $O(1)$ constant memory without heap growth or dropped frames.
* **Compare-And-Swap (CAS) state version guard:** Every state transition verifies `expected_version == self.state_version` inside the critical section before incrementing the monotonic state counter.

### 5. 64-bit RTU binary frame codec and CRC-8 verification

![64-Bit RTU Binary Packet Layout](docs/rtu-frame-bit-layout.svg)

Implemented in [`RTUBinaryCodec`](backend/core_subsystems.py) to mirror industrial SCADA serial/TCP framing over constrained cellular links:

| Byte / bit offset | Field identifier | Encoding format | Scaling & engineering range |
| :--- | :--- | :--- | :--- |
| `Byte 0 [63:56]` | `SYNC_HEADER` | 8-bit constant | Fixed `0xA5` frame alignment marker |
| `Byte 1 [55:48]` | `NODE_ID \| FLAGS` | Two 4-bit nibbles | `[7:4]` Node index (`1..6`); `[3:0]` Flags (`Online`, `Fault`, `BESS`, `Priority-1`) |
| `Bytes 2..3 [47:32]` | `VOLTAGE_UINT16` | 16-bit unsigned big-endian | Decivolts ($V \times 10$, e.g., $240.0\text{ V} \rightarrow 2400 \rightarrow \text{0x0960}$) |
| `Bytes 4..5 [31:16]` | `FREQUENCY_UINT16` | 16-bit unsigned big-endian | Centihertz ($f_{\text{Hz}} \times 100$, e.g., $50.00\text{ Hz} \rightarrow 5000 \rightarrow \text{0x1388}$) |
| `Byte 6 [15:8]` | `LOAD_UINT8` | 8-bit unsigned integer | Asset load utilization percentage (`0..255%`) |
| `Byte 7 [7:0]` | `CRC8_CHECKSUM` | 8-bit polynomial checksum | Generator polynomial $G(x) = x^8 + x^2 + x + 1$ (`0x07`) computed over Bytes `0..6` |

### 6. Formal propositional breaker safety interlock

Implemented in [`BreakerSafetyInterlock`](backend/core_subsystems.py). Before any automated feeder reconfiguration or inverter dispatch command is committed, the controller evaluates six atomic boolean propositions:

$$\Phi_{\text{safe}} \equiv \bigl(D \rightarrow (S \land (Q \lor R \lor \neg P))\bigr) \land (\neg P \rightarrow C) \land C$$

* $P$: Upstream national grid feeder is energized (`GEN-OLK-01 > 0 kW`)
* $Q$: Kasarani transformer thermal guard threshold is exceeded ($\text{Load} > 82.0\%$)
* $R$: Secondary bus frequency droop trigger is active ($f < 49.65\text{ Hz}$)
* $S$: LFP storage reserve exceeds minimum safety floor ($\text{SoC} > 15.0\%$)
* $D$: BESS inverter is actively discharging real power ($P_{\text{BESS}} > 0\text{ kW}$)
* $C$: Priority-1 Referral Clinic feeder continuity is verified

---

## Relational database schema and analytical SQL rollups

Implemented in [`schema.sql`](backend/schema.sql) and [`database.py`](backend/database.py) using SQLite in **Write-Ahead Logging (`WAL`)** mode (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`).

| Table name | Primary key | Foreign key & constraints | Purpose |
| :--- | :--- | :--- | :--- |
| `grid_nodes` | `node_id TEXT` | `CHECK (node_type IN (...))` | Master catalog of all 6 generation, transformer, storage, and load assets |
| `storage_units` | `unit_id TEXT` | `FOREIGN KEY (node_id) REFERENCES grid_nodes(node_id)` | Tracks BESS capacity ($400\text{ kWh}$), max inverter rating ($250\text{ kW}$), SoC, and operating mode |
| `telemetry_readings` | `reading_id INTEGER` | `FOREIGN KEY (node_id) REFERENCES grid_nodes(node_id)` | Append-only time-series log of active power, voltage, frequency, and temperature |
| `dispatch_events` | `event_id INTEGER` | `idempotency_key TEXT NOT NULL UNIQUE` | Immutable ACID audit ledger preventing duplicate switching actions during retries |

On every telemetry cycle, [`fetch_sql_analytics()`](backend/database.py) executes a live relational aggregation (`LEFT JOIN` + `GROUP BY n.node_type`) across `grid_nodes` and `telemetry_readings` to report real-time mean power, peak utilization, and average thermal stress per asset class.

---

## API specification

| Method | Endpoint | Description | Request payload / parameters |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Returns backend service health, SQLite WAL status, and current simulation state | None |
| `GET` | `/api/telemetry` | Returns a complete point-in-time snapshot including all 6 nodes, metrics, events, and subsystem diagnostics | None |
| `GET` | `/api/events` | Fetches recent ACID-logged state transitions from `dispatch_events` | `?limit=15` (optional query integer) |
| `POST` | `/api/scenario` | Atomically injects an operational scenario or grid disturbance | `{"scenario": "NOMINAL" \| "EVENING_PEAK" \| "CLOUD_TRANSIENT" \| "UPSTREAM_BLACKOUT"}` |
| `POST` | `/api/balancer` | Enables or disables autonomous BESS protection and demand-response | `{"enabled": true \| false}` |
| `POST` | `/api/strategy` | Hot-swaps the active BESS inverter dispatch algorithm at runtime | `{"strategy": "PROPORTIONAL_DROOP" \| "AGGRESSIVE_PEAK_SHAVING" \| "CONSERVATIVE_CLINIC_RESERVE"}` |
| `WS` | `/ws` | Streams full-duplex JSON telemetry snapshots every 1500 ms and accepts live JSON commands | Accepts `{"action": "scenario" \| "balancer" \| "strategy", ...}` |

---

## Repository structure

```text
gridpulse/
├── README.md
├── LICENSE
├── netlify.toml                # Netlify continuous deployment configuration (frontend/dist)
├── .gitignore
├── docs/
│   ├── system-architecture.svg
│   ├── microgrid-single-line-diagram.svg
│   └── rtu-frame-bit-layout.svg
├── backend/
│   ├── main.py                 # FastAPI server, REST endpoints, and /ws WebSocket broadcaster
│   ├── simulator.py            # 6-node Kenyan microgrid physics engine and IEC 60076-7 thermal model
│   ├── core_subsystems.py      # Graph routing, Strategy/Composite, Mutex/CAS, 64-bit RTU, Interlock
│   ├── database.py             # SQLite WAL connection manager, ACID event logger, SQL analytics
│   ├── schema.sql              # Normalized 3NF relational schema and seed definitions
│   └── requirements.txt        # Python dependencies (fastapi, uvicorn, pydantic, websockets)
└── frontend/
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx            # React 18 root mount
        ├── App.tsx             # Minimalist 4-view operator interface + client-side simulation engine
        ├── index.css           # Typography (Inter + JetBrains Mono) and tabular-num rules
        └── types/
            └── grid.ts         # TypeScript interfaces for telemetry, nodes, and subsystems
```

---

## Getting started

### Prerequisites

* **Python:** `3.11+`
* **Node.js:** `18.0+` and `npm`

### 1. Start the FastAPI + SQLite WAL backend

```bash
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

When started, the backend automatically initializes `backend/gridpulse.db` in SQLite WAL mode, seeds the 6 Kenyan grid assets, and begins streaming 1.5-second telemetry ticks at `ws://localhost:8000/ws`.

### 2. Start the React operator interface

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser:

* When the FastAPI backend is running locally on port `8000`, the header indicator displays `Live` (connected via WebSocket to FastAPI and SQLite WAL).
* When deployed statically (such as on [https://gridpulse-ea.netlify.app](https://gridpulse-ea.netlify.app)), the header indicator displays `Simulated`, executing the full physics, graph routing, bitwise RTU framing, and safety interlock algorithms directly in the browser.
