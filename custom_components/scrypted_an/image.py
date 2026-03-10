"""Image platform for Scrypted Advanced Notifier."""
from __future__ import annotations

from datetime import datetime
import logging

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
import homeassistant.util.dt as dt_util

from .const import DOMAIN
from .base_entity import ScryptedBaseEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager = hass.data[DOMAIN][entry.entry_id]
    manager.register_platform("image", async_add_entities)


class ScryptedImage(ScryptedBaseEntity, ImageEntity):
    """An image entity from Scrypted (shows last detection snapshot)."""

    _attr_content_type = "image/jpeg"

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._image_url: str | None = None
        self._image_last_updated: datetime | None = None

    @property
    def image_url(self) -> str | None:
        return self._image_url

    @property
    def image_last_updated(self) -> datetime | None:
        return self._image_last_updated

    def _on_state_update(self, value: str) -> None:
        """State update carries the image URL."""
        self._image_url = value if value else None
        self._image_last_updated = dt_util.utcnow()
        self.schedule_update_ha_state()
