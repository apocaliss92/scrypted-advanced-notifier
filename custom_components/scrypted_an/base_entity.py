"""Base entity class for Scrypted Advanced Notifier entities."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN


class ScryptedBaseEntity(Entity):
    """Base class for all Scrypted Advanced Notifier entities."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        entry_id: str,
        device_id: str,
        dev: dict,
        component_key: str,
        cmp_config: dict,
        entity_manager,
    ) -> None:
        self._entry_id = entry_id
        self._device_id = device_id
        self._dev = dev
        self._component_key = component_key
        self._cmp_config = cmp_config
        self._entity_manager = entity_manager
        self._state_value: str | None = None

        # Unique ID: device_id + component_key
        self._attr_unique_id = f"{device_id}_{component_key}"
        self._attr_name = cmp_config.get("name") or component_key

        # Subscribe to state topic if defined
        state_topic: str | None = cmp_config.get("stat_t") or cmp_config.get("state_topic")
        if state_topic:
            entity_manager.subscribe_topic(state_topic, self._on_state_update)

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=self._dev.get("name", self._device_id),
            manufacturer=self._dev.get("mf", "Scrypted"),
            model=self._dev.get("mdl", "Advanced Notifier"),
        )

    def _on_state_update(self, value: str) -> None:
        self._state_value = value
        self.schedule_update_ha_state()

    def update_config(self, new_config: dict) -> None:
        """Called when the entity config changes (e.g. select options change)."""
        self._cmp_config = new_config
        self.schedule_update_ha_state()
