from dotenv import load_dotenv
load_dotenv()

import os
import asyncio
import time
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from vultr_client import create_instance, delete_instance, REGION_NAMES
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


def seed_mock_regions():
    regions = [
        Region(
            id="ewr",
            slug="ewr",
            display_name="US-East (EWR)",
            ip="localhost:8001",
            status="healthy",
            disabled=False,
        ),
        Region(
            id="ams",
            slug="ams",
            display_name="EU (Amsterdam)",
            ip="localhost:8002",
            status="healthy",
            disabled=False,
        ),
        Region(
            id="sgp",
            slug="sgp",
            display_name="Asia (Singapore)",
            ip="localhost:8003",
            status="healthy",
            disabled=False,
        ),
    ]
    registry.set_regions(regions)


def choose_best_region() -> Optional[Region]:
    regions = registry.list_regions()
    healthy = [
        r for r in regions
        if r.status == "healthy" and not getattr(r, "disabled", False)
    ]
    if not healthy:
        return None

    return min(
        healthy,
        key=lambda r: r.latency_ms if r.latency_ms is not None else 999999.0,
    )


class DeployRequest(BaseModel):
    regions: list[str] = ["ewr", "ams", "sgp"]
    model: str = "stable-diffusion-stub"


class InferRequest(BaseModel):
    deployment_id: str | None = None
    prompt: str
    params: dict | None = None


@app.on_event("startup")
async def startup_event():
    if MODE == "mock":
        seed_mock_regions()

    asyncio.create_task(health_check_loop())


@app.get("/health")
async def health():
    return {"status": "ok", "service": "control-plane", "mode": MODE}


@app.post("/deploy/global")
async def deploy_global(req: DeployRequest):
    if MODE == "mock":
        seed_mock_regions()
        return {
            "deployment_id": "mock-deployment",
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
        "regions": [r.model_dump() for r in registry.list_regions()],
    }


@app.post("/infer")
async def infer_endpoint(req: InferRequest):
    region = choose_best_region()
    if region is None:
        return JSONResponse(
            status_code=200,
            content={"error": "no healthy regions"},
        )

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"http://{region.ip}/infer",
                json={"prompt": req.prompt},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError:
        registry.update_region(region.id, status="down", latency_ms=None)
        return JSONResponse(
            status_code=200,
            content={"error": "region unavailable"},
        )

    latency_ms = (time.perf_counter() - start) * 1000.0
    registry.update_region(region.id, status="healthy", latency_ms=latency_ms)

    return {
        "prompt": req.prompt,
        "image_url": data.get("image_url"),
        "region_id": region.id,
        "region_slug": region.slug,
        "latency_ms": latency_ms,
    }


@app.post("/kill/{region_id}")
async def kill_region(region_id: str):
    if MODE == "mock":
        registry.update_region(region_id, status="down", latency_ms=None, disabled=True)
        return {"region_id": region_id, "status": "down (mock)"}

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
                        last_checked_at=datetime.utcnow(),
                    )
                except Exception:
                    registry.update_region(
                        r.id,
                        status="down",
                        latency_ms=None,
                        last_checked_at=datetime.utcnow(),
                    )
        await asyncio.sleep(3)
