"""Binary sensor platform for Scrypted Advanced Notifier."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .base_entity import ScryptedBaseEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager = hass.data[DOMAIN][entry.entry_id]
    manager.register_platform("binary_sensor", async_add_entities)


class ScryptedBinarySensor(ScryptedBaseEntity, BinarySensorEntity):
    """A binary sensor entity from Scrypted."""

    @property
    def is_on(self) -> bool | None:
        if self._state_value is None:
            return None
        return self._state_value.lower() in ("true", "on", "1", "yes", "detected")

    @property
    def device_class(self) -> str | None:
        return self._cmp_config.get("dev_cla") or self._cmp_config.get("device_class")
