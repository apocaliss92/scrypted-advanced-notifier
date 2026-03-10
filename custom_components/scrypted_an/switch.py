"""Switch platform for Scrypted Advanced Notifier."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .base_entity import ScryptedBaseEntity
from . import send_command


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager = hass.data[DOMAIN][entry.entry_id]
    manager.register_platform("switch", async_add_entities)


class ScryptedSwitch(ScryptedBaseEntity, SwitchEntity):
    """A switch entity from Scrypted."""

    @property
    def is_on(self) -> bool | None:
        if self._state_value is None:
            return None
        return self._state_value.lower() in ("true", "on", "1", "yes")

    async def async_turn_on(self, **kwargs) -> None:
        cmd_topic = self._cmp_config.get("cmd_t") or self._cmp_config.get("command_topic", "")
        send_command(self.hass, self._entry_id, cmd_topic, "true")

    async def async_turn_off(self, **kwargs) -> None:
        cmd_topic = self._cmp_config.get("cmd_t") or self._cmp_config.get("command_topic", "")
        send_command(self.hass, self._entry_id, cmd_topic, "false")
