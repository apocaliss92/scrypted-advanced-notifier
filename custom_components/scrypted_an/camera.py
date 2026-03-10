"""Camera platform for Scrypted Advanced Notifier (stream destinations)."""
from __future__ import annotations

import logging

from homeassistant.components.camera import Camera
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .base_entity import ScryptedBaseEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager = hass.data[DOMAIN][entry.entry_id]
    manager.register_platform("camera", async_add_entities)


class ScryptedCamera(ScryptedBaseEntity, Camera):
    """A camera entity exposing a Scrypted stream destination."""

    def __init__(self, *args, **kwargs) -> None:
        ScryptedBaseEntity.__init__(self, *args, **kwargs)
        Camera.__init__(self)

    @property
    def is_streaming(self) -> bool:
        return True

    async def stream_source(self) -> str | None:
        return self._cmp_config.get("rtsp_url") or self._cmp_config.get("stream_source")

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        """Fetch a snapshot from the plugin snapshot endpoint."""
        import aiohttp
        snapshot_url = self._cmp_config.get("still_image_url")
        if not snapshot_url:
            return None
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    snapshot_url, timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status == 200:
                        return await resp.read()
        except Exception as e:
            _LOGGER.warning("Failed to fetch camera snapshot: %s", e)
        return None
