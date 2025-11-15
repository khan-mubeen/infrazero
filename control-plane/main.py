from dotenv import load_dotenv
load_dotenv()

import os
from vultr_client import create_instance, delete_instance, REGION_NAMES
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import asyncio
import time
import httpx

from region_registry import RegionRegistry, Region

app = FastAPI()
MODE = os.getenv("INFRAZERO_MODE", "mock")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = RegionRegistry()

class DeployRequest(BaseModel):
    regions: list[str] = ["ewr", "ams", "sgp"]
    model: str = "stable-diffusion-stub"

class InferRequest(BaseModel):
    deployment_id: str | None = None
    prompt: str
    params: dict | None = None

@app.on_event("startup")
async def startup_event():
    regions = [
        Region(
            id="ewr-1",
            slug="ewr",
            display_name="US-East (EWR)",
            ip="127.0.0.1:8001",
            status="starting"
        ),
        Region(
            id="ams-1",
            slug="ams",
            display_name="EU (Amsterdam)",
            ip="127.0.0.1:8002",
            status="starting"
        ),
        Region(
            id="sgp-1",
            slug="sgp",
            display_name="Asia (Singapore)",
            ip="127.0.0.1:8003",
            status="starting"
        )
    ]
    registry.set_regions(regions)
    asyncio.create_task(health_check_loop())

@app.get("/health")
async def health():
    return {"status": "ok", "service": "control-plane"}

@app.post("/deploy/global")
async def deploy_global(req: DeployRequest):
    if MODE == "mock":
        return {
            "deployment_id": "demo-deployment",
            "regions": [r.model_dump() for r in registry.list_regions()],
        }

    regions_models: list[Region] = []

    for slug in req.regions:
        label = f"infrazero-{slug}"
        inst = await create_instance(slug, label)
        ip_with_port = f"{inst['main_ip']}:8000"

        r = Region(
            id=inst["id"],
            slug=slug,
            display_name=REGION_NAMES.get(slug, slug),
            ip=ip_with_port,
            status="starting",
        )
        regions_models.append(r)

    registry.set_regions(regions_models)

    return {
        "deployment_id": "vultr-deployment",
        "regions": [r.model_dump() for r in regions_models],
    }


@app.get("/regions")
async def list_regions():
    return {
        "deployment_id": "demo-deployment",
        "regions": [r.model_dump() for r in registry.list_regions()]
    }

@app.post("/infer")
async def infer(req: InferRequest):
    regions = registry.get_healthy_sorted()
    if not regions:
        return {"error": "no healthy regions"}
    target = regions[0]
    url = f"http://{target.ip}/infer"

    payload = {
        "prompt": req.prompt,
        "steps": (req.params or {}).get("steps", 20)
    }

    async with httpx.AsyncClient(timeout=10) as client:
        start = time.perf_counter()
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
        latency_ms = int((time.perf_counter() - start) * 1000)

    return {
        "region_id": target.id,
        "region_slug": target.slug,
        "latency_ms": latency_ms,
        "image_url": data.get("image_url")
    }

@app.post("/kill/{region_id}")
async def kill_region(region_id: str):
    if MODE == "mock":
        registry.update_region(region_id, status="down", latency_ms=None, disabled=True)
        return {"region_id": region_id, "status": "down (mock)"}
    else:
        await delete_instance(region_id)
        registry.update_region(region_id, status="down", latency_ms=None, disabled=True)
        return {"region_id": region_id, "status": "terminating"}

async def health_check_loop():
    while True:
        regions = registry.list_regions()
        async with httpx.AsyncClient(timeout=3) as client:
            for r in regions:
                if getattr(r, "disabled", False):
                    continue

                try:
                    start = time.perf_counter()
                    resp = await client.get(f"http://{r.ip}/health")
                    resp.raise_for_status()
                    _ = resp.json()
                    latency_ms = int((time.perf_counter() - start) * 1000)
                    registry.update_region(
                        r.id,
                        status="healthy",
                        latency_ms=latency_ms,
                        last_checked_at=datetime.utcnow()
                    )
                except Exception:
                    registry.update_region(
                        r.id,
                        status="down",
                        latency_ms=None,
                        last_checked_at=datetime.utcnow()
                    )
        await asyncio.sleep(3)

