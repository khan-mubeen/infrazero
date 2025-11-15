import os
import httpx
from typing import Dict, Any
from .bootstrap import build_user_data

VULTR_API_BASE = "https://api.vultr.com/v2"
VULTR_API_KEY = os.getenv("VULTR_API_KEY", "")

VULTR_PLAN = os.getenv("VULTR_PLAN", "vc2-1c-1gb")
VULTR_OS_ID = int(os.getenv("VULTR_OS_ID", "387")) 
SSH_KEY_ID = os.getenv("VULTR_SSH_KEY_ID", "")

HEADERS = {
    "Authorization": f"Bearer {VULTR_API_KEY}",
    "Content-Type": "application/json",
}

REGION_NAMES: Dict[str, str] = {
    "ewr": "US-East (EWR)",
    "ams": "EU (Amsterdam)",
    "sgp": "Asia (Singapore)",
}


async def create_instance(region_slug: str, label: str) -> Dict[str, Any]:
    user_data = build_user_data(region_slug)

    payload: Dict[str, Any] = {
        "region": region_slug,
        "plan": VULTR_PLAN,
        "os_id": VULTR_OS_ID,
        "label": label,
        "user_data": user_data,
    }

    if SSH_KEY_ID:
        payload["sshkey_id"] = [SSH_KEY_ID]

    async with httpx.AsyncClient(base_url=VULTR_API_BASE, headers=HEADERS, timeout=180) as client:
        resp = await client.post("/instances", json=payload)
        resp.raise_for_status()
        data = resp.json()["instance"]
        return {
            "id": data["id"],
            "region": region_slug,
            "label": data["label"],
            "main_ip": data["main_ip"],
        }


async def delete_instance(instance_id: str) -> None:
    async with httpx.AsyncClient(base_url=VULTR_API_BASE, headers=HEADERS, timeout=60) as client:
        resp = await client.delete(f"/instances/{instance_id}")
        resp.raise_for_status()
