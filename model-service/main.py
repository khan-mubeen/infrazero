from fastapi import FastAPI
from pydantic import BaseModel
import time
import os
import random
import asyncio

app = FastAPI()

REGION = os.getenv("REGION", "unknown")

class InferRequest(BaseModel):
    prompt: str
    steps: int | None = 20

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "region": REGION,
        "model": "stable-diffusion-stub"
    }

@app.post("/infer")
async def infer(req: InferRequest):
    start = time.perf_counter()
    await asyncio.sleep(1.0)
    duration_ms = int((time.perf_counter() - start) * 1000)
    return {
        "image_url": f"https://picsum.photos/seed/{REGION}-{random.randint(1, 10000)}/512/512",
        "region": REGION,
        "duration_ms": duration_ms
    }
