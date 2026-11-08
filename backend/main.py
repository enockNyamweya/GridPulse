import asyncio
from contextlib import asynccontextmanager
from typing import List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from database import init_db, fetch_recent_events
from simulator import MicrogridSimulator

simulator = MicrogridSimulator()
connected_clients: List[WebSocket] = []


async def broadcast_telemetry_loop() -> None:
    while True:
        await asyncio.sleep(1.0)
        if connected_clients:
            snapshot = simulator.step()
            stale_clients: List[WebSocket] = []
            for ws in connected_clients:
                try:
                    await ws.send_json(snapshot)
                except Exception:
                    stale_clients.append(ws)
            for ws in stale_clients:
                if ws in connected_clients:
                    connected_clients.remove(ws)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Record initial startup event
    simulator.step()
    loop_task = asyncio.create_task(broadcast_telemetry_loop())
    yield
    loop_task.cancel()


app = FastAPI(
    title="GridPulse Telemetry & Battery Coordination Engine",
    description="Real-time digital telemetry, transformer overload protection, and automated BESS dispatch for Sub-Saharan distribution microgrids.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ScenarioRequest(BaseModel):
    scenario: str


class BalancerToggleRequest(BaseModel):
    enabled: bool


class StrategyChangeRequest(BaseModel):
    strategy: str


@app.get("/api/health")
def health_check():
    return {
        "status": "online",
        "service": "GridPulse Core Engine",
        "system_state": simulator.state,
        "active_scenario": simulator.active_scenario,
        "active_strategy": simulator.active_strategy.strategy_name,
    }


@app.get("/api/telemetry")
def get_telemetry():
    return simulator.step()


@app.post("/api/scenario")
def trigger_scenario(req: ScenarioRequest):
    return simulator.inject_scenario(req.scenario)


@app.post("/api/balancer")
def set_auto_balancer(req: BalancerToggleRequest):
    return simulator.toggle_auto_balancer(req.enabled)


@app.post("/api/strategy")
def set_dispatch_strategy(req: StrategyChangeRequest):
    simulator.set_strategy(req.strategy)
    return simulator.step()



@app.get("/api/events")
def get_audit_events(limit: int = 15):
    return {"events": fetch_recent_events(limit=limit)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        # Send immediate initial state
        await websocket.send_json(simulator.step())
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            if action == "scenario":
                res = simulator.inject_scenario(data.get("scenario", "NOMINAL"))
                await websocket.send_json(res["snapshot"])
            elif action == "toggle_balancer":
                simulator.toggle_auto_balancer(bool(data.get("enabled", True)))
                await websocket.send_json(simulator.step())
            elif action == "set_strategy":
                simulator.set_strategy(str(data.get("strategy", "PROPORTIONAL_DROOP")))
                await websocket.send_json(simulator.step())
    except WebSocketDisconnect:
        if websocket in connected_clients:
            connected_clients.remove(websocket)
    except Exception:
        if websocket in connected_clients:
            connected_clients.remove(websocket)
