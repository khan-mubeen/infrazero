from typing import List, Dict
from datetime import datetime
from pydantic import BaseModel

class Region(BaseModel):
    id: str
    slug: str
    display_name: str
    ip: str
    status: str = "starting"
    latency_ms: float | None = None
    last_checked_at: datetime | None = None
    disabled: bool = False


class RegionRegistry:
    def __init__(self):
        self._regions: Dict[str, Region] = {}

    def set_regions(self, regions: List[Region]):
        self._regions = {r.id: r for r in regions}

    def list_regions(self) -> List[Region]:
        return list(self._regions.values())

    def update_region(self, region_id: str, **kwargs):
        region = self._regions.get(region_id)
        if not region:
            return
        updated = region.model_copy(update=kwargs)
        self._regions[region_id] = updated
