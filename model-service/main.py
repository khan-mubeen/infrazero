from fastapi import FastAPI
from pydantic import BaseModel
import time
import os
import random
import asyncio

app = FastAPI()

REGION = os.getenv("REGION", "unknown")
ENGINE = os.getenv("ENGINE", "mock")


class InferRequest(BaseModel):
    prompt: str
    steps: int | None = 20


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "region": REGION,
        "engine": ENGINE,
        "model": "stable-diffusion-stub",
    }


async def generate_mock_image(req: InferRequest) -> str:
    # simple picsum stub
    return f"https://picsum.photos/seed/{REGION}-{random.randint(1, 10000)}/512/512"


@app.post("/infer")
async def infer(req: InferRequest):
    start = time.perf_counter()

    # for now we only use mock engine
    image_url = await generate_mock_image(req)

    duration_ms = int((time.perf_counter() - start) * 1000)
    return {
        "image_url": image_url,
        "region": REGION,
        "engine": ENGINE,
        "duration_ms": duration_ms,
    }
