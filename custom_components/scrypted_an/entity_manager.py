"""Dynamic entity manager for Scrypted Advanced Notifier."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


class EntityManager:
    """Manages the lifecycle of HA entities for a single config entry."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self.hass = hass
        self.entry_id = entry_id
        # device_id → { component_key → entity }
        self._entities: dict[str, dict[str, Any]] = {}
        # Platform add-entity callbacks registered by each platform
        self._platform_callbacks: dict[str, AddEntitiesCallback] = {}
        # State subscribers: topic → list[callback]
        self._state_subscribers: dict[str, list] = {}

    def register_platform(self, platform: str, add_entities: AddEntitiesCallback) -> None:
        self._platform_callbacks[platform] = add_entities

    def update_state(self, topic: str, value: str) -> None:
        """Apply a state_update message: find entities subscribed to this topic."""
        for cb in self._state_subscribers.get(topic, []):
            try:
                cb(value)
            except Exception as e:
                _LOGGER.warning("Error updating state for topic %s: %s", topic, e)

    def subscribe_topic(self, topic: str, callback) -> None:
        self._state_subscribers.setdefault(topic, []).append(callback)

    def apply_entity_diff(self, device_id: str, cmps: dict | None, dev: dict | None) -> None:
        """Apply an entity_change message: add/remove/update entities for device_id."""
        if cmps is None:
            cmps = {}

        current = self._entities.get(device_id, {})
        new_keys = set(cmps.keys())
        old_keys = set(current.keys())

        # Remove entities that disappeared
        for key in old_keys - new_keys:
            entity = current.pop(key, None)
            if entity is not None:
                self.hass.async_create_task(entity.async_remove())
                _LOGGER.debug("Removed entity %s / %s", device_id, key)

        # Add or update entities
        from . import build_entity  # avoid circular import
        for key in new_keys:
            cmp_config = cmps[key]
            if key in current:
                # Update existing entity
                entity = current[key]
                if hasattr(entity, "update_config"):
                    entity.update_config(cmp_config)
            else:
                # Create new entity
                platform = cmp_config.get("platform")
                add_cb = self._platform_callbacks.get(platform)
                if add_cb is None:
                    _LOGGER.debug("No platform callback for %s (device %s)", platform, device_id)
                    continue
                entity = build_entity(
                    hass=self.hass,
                    entry_id=self.entry_id,
                    device_id=device_id,
                    dev=dev or {},
                    component_key=key,
                    cmp_config=cmp_config,
                    entity_manager=self,
                )
                if entity is not None:
                    current[key] = entity
                    add_cb([entity])
                    _LOGGER.debug("Added entity %s / %s (%s)", device_id, key, platform)

        self._entities[device_id] = current

    async def async_unload(self) -> None:
        """Remove all entities managed by this manager."""
        for device_entities in self._entities.values():
            for entity in device_entities.values():
                try:
                    await entity.async_remove()
                except Exception:
                    pass
        self._entities.clear()
        self._state_subscribers.clear()
        self._platform_callbacks.clear()
