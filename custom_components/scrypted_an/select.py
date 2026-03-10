"""Select platform for Scrypted Advanced Notifier."""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
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
    manager.register_platform("select", async_add_entities)


class ScryptedSelect(ScryptedBaseEntity, SelectEntity):
    """A select entity from Scrypted."""

    @property
    def options(self) -> list[str]:
        opts = self._cmp_config.get("options") or []
        return [str(o) for o in opts]

    @property
    def current_option(self) -> str | None:
        return self._state_value

    async def async_select_option(self, option: str) -> None:
        cmd_topic = self._cmp_config.get("cmd_t") or self._cmp_config.get("command_topic", "")
        send_command(self.hass, self._entry_id, cmd_topic, option)
