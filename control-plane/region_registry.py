from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

class Region(BaseModel):
    id: str
    slug: str
    display_name: str
    ip: str
    status: str
    latency_ms: Optional[float] = None
    last_checked_at: Optional[datetime] = None
    disabled: bool = False

class RegionRegistry:
    def __init__(self):
        self._regions: dict[str, Region] = {}

    def set_regions(self, regions: List[Region]):
        for r in regions:
            self._regions[r.id] = r

    def list_regions(self) -> List[Region]:
        return list(self._regions.values())

    def update_region(self, region_id: str, **kwargs):
        if region_id in self._regions:
            data = self._regions[region_id].model_dump()
            data.update(kwargs)
            self._regions[region_id] = Region(**data)

    def get_healthy_sorted(self) -> List[Region]:
        regions = [
            r for r in self._regions.values()
            if r.status == "healthy" and r.latency_ms is not None
        ]
        return sorted(regions, key=lambda r: r.latency_ms or 9999)
