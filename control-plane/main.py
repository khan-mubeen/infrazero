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

# Environment-based worker IPs (for mock / live CPU workers)
REGION_EWR_IP = os.getenv("REGION_EWR_IP", "localhost:8001")
REGION_AMS_IP = os.getenv("REGION_AMS_IP", "localhost:8002")
REGION_SGP_IP = os.getenv("REGION_SGP_IP", "localhost:8003")


def seed_mock_regions():
    regions = [
        Region(
            id="ewr",
            slug="ewr",
            display_name="US-East (New Jersey)",
            ip=REGION_EWR_IP,
            status="healthy",
            disabled=False,
        ),
        Region(
            id="ams",
            slug="ams",
            display_name="EU (Amsterdam)",
            ip=REGION_AMS_IP,
            status="healthy",
            disabled=False,
        ),
        Region(
            id="sgp",
            slug="sgp",
            display_name="Asia (Singapore)",
            ip=REGION_SGP_IP,
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
        # In mock / CPU mode we just seed regions from env IPs
        seed_mock_regions()
        return {
            "deployment_id": "mock-deployment",
            "regions": [r.model_dump() for r in registry.list_regions()],
        }

    # Vultr mode – keep this logic for future, not used right now
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
    # Use ALL healthy regions in parallel
    regions = [
        r for r in registry.list_regions()
        if r.status == "healthy" and not getattr(r, "disabled", False)
    ]
    if not regions:
        return JSONResponse(
            status_code=200,
            content={"error": "no healthy regions"},
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        async def call_region(region: Region):
            start = time.perf_counter()
            try:
                resp = await client.post(
                    f"http://{region.ip}/infer",
                    json={"prompt": req.prompt},
                )
                resp.raise_for_status()
                data = resp.json()
                latency_ms = (time.perf_counter() - start) * 1000.0

                registry.update_region(
                    region.id,
                    status="healthy",
                    latency_ms=latency_ms,
                    last_checked_at=datetime.utcnow(),
                )

                return {
                    "region_id": region.id,
                    "region_slug": region.slug,
                    "region_name": region.display_name,
                    "latency_ms": latency_ms,
                    "image_url": data.get("image_url"),
                    "engine": data.get("engine"),
                    "effect": data.get("effect"),
                    "error": None,
                }
            except Exception as e:
                registry.update_region(
                    region.id,
                    status="down",
                    latency_ms=None,
                    last_checked_at=datetime.utcnow(),
                )
                return {
                    "region_id": region.id,
                    "region_slug": region.slug,
                    "region_name": region.display_name,
                    "latency_ms": None,
                    "image_url": None,
                    "engine": None,
                    "effect": None,
                    "error": str(e),
                }

        results = await asyncio.gather(*(call_region(r) for r in regions))

    # Pick best region among successful ones
    successful = [
        r for r in results
        if r["image_url"] is not None and r["latency_ms"] is not None and r["error"] is None
    ]
    best = min(successful, key=lambda r: r["latency_ms"]) if successful else None

    return {
        "prompt": req.prompt,
        "image_url": best["image_url"] if best else None,
        "region_id": best["region_id"] if best else None,
        "region_slug": best["region_slug"] if best else None,
        "region_name": best["region_name"] if best else None,
        "latency_ms": best["latency_ms"] if best else None,
        "results": results,
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
