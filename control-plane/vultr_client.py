import os
import httpx

VULTR_API_BASE = "https://api.vultr.com/v2"
VULTR_API_KEY = os.getenv("VULTR_API_KEY", "")

VULTR_PLAN = os.getenv("VULTR_PLAN", "vc2-1c-1gb")
VULTR_OS_ID = int(os.getenv("VULTR_OS_ID", "387"))

HEADERS = {
    "Authorization": f"Bearer {VULTR_API_KEY}",
    "Content-Type": "application/json",
}

REGION_NAMES = {
    "ewr": "US-East (EWR)",
    "ams": "EU (Amsterdam)",
    "sgp": "Asia (Singapore)",
}


async def create_instance(region_slug: str, label: str):
    async with httpx.AsyncClient(base_url=VULTR_API_BASE, headers=HEADERS, timeout=120) as client:
        resp = await client.post(
            "/instances",
            json={
                "region": region_slug,
                "plan": VULTR_PLAN,
                "os_id": VULTR_OS_ID,
                "label": label,
            },
        )
        resp.raise_for_status()
        data = resp.json()["instance"]
        return {
            "id": data["id"],
            "region": region_slug,
            "label": data["label"],
            "main_ip": data["main_ip"],
        }


async def delete_instance(instance_id: str):
    async with httpx.AsyncClient(base_url=VULTR_API_BASE, headers=HEADERS, timeout=60) as client:
        resp = await client.delete(f"/instances/{instance_id}")
        resp.raise_for_status()
