from fastapi import FastAPI
from pydantic import BaseModel
import time
import os
import hashlib
from io import BytesIO
import base64

import httpx
from PIL import Image, ImageFilter

app = FastAPI()

REGION = os.getenv("REGION", "unknown")
ENGINE = os.getenv("ENGINE", "mock")  # blur / edge / sharpen / mock


class InferRequest(BaseModel):
    prompt: str
    steps: int | None = 20


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "region": REGION,
        "engine": ENGINE,
        "model": "multi-region-image-pipeline",
    }


async def fetch_base_image(prompt: str) -> Image.Image:
    seed = hashlib.md5(prompt.encode()).hexdigest()
    url = f"https://picsum.photos/seed/{seed}/512/512"

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        img = Image.open(BytesIO(resp.content)).convert("RGB")
        return img


def apply_effect(img: Image.Image, engine: str) -> tuple[Image.Image, str]:
    engine = (engine or "").lower()

    if engine == "blur":
        return img.filter(ImageFilter.GaussianBlur(radius=3)), "blur"

    elif engine == "edge":
        gray = img.convert("L").filter(ImageFilter.FIND_EDGES)
        edges_rgb = Image.merge("RGB", (gray, gray, gray))
        blended = Image.blend(img, edges_rgb, alpha=0.6)
        return blended, "edge-detect"

    elif engine == "sharpen":
        return img.filter(ImageFilter.SHARPEN), "sharpen"

    return img, "original"


def image_to_data_url(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


@app.post("/infer")
async def infer(req: InferRequest):
    start_total = time.perf_counter()

    base_img = await fetch_base_image(req.prompt)
    processed_img, effect = apply_effect(base_img, ENGINE)
    _ = processed_img.resize((512, 512))

    latency_ms = int(round((time.perf_counter() - start_total) * 1000))
    image_url = image_to_data_url(processed_img)

    return {
        "prompt": req.prompt,
        "image_url": image_url,
        "region_id": REGION,
        "region_slug": REGION,
        "region_name": REGION,
        "latency_ms": latency_ms,
        "effect": effect,
        "error": None,
    }
