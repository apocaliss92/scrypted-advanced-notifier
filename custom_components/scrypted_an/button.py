"""Button platform for Scrypted Advanced Notifier."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
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
    manager.register_platform("button", async_add_entities)


class ScryptedButton(ScryptedBaseEntity, ButtonEntity):
    """A button entity from Scrypted."""

    async def async_press(self) -> None:
        cmd_topic = self._cmp_config.get("cmd_t") or self._cmp_config.get("command_topic", "")
        send_command(self.hass, self._entry_id, cmd_topic, "PRESS")
