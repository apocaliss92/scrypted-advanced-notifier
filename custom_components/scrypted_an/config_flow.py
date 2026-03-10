"""Config flow for Scrypted Advanced Notifier."""
from __future__ import annotations

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_HA_SECRET,
    CONF_SCRYPTED_URL,
    CONF_SELECTED_DEVICE_IDS,
    DOMAIN,
    ENDPOINT_HA_DEVICES,
)


class ScryptedAnConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Scrypted Advanced Notifier."""

    VERSION = 1

    def __init__(self) -> None:
        self._scrypted_url: str = ""
        self._ha_secret: str = ""
        self._available_devices: list[dict] = []

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Step 1: collect Scrypted URL + secret, validate connection."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._scrypted_url = user_input[CONF_SCRYPTED_URL].rstrip("/")
            self._ha_secret = user_input[CONF_HA_SECRET]

            devices, err = await self._fetch_devices()
            if err:
                errors["base"] = err
            else:
                self._available_devices = devices
                return await self.async_step_select_devices()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_SCRYPTED_URL): str,
                    vol.Required(CONF_HA_SECRET): str,
                }
            ),
            errors=errors,
        )

    async def async_step_select_devices(
        self, user_input: dict | None = None
    ) -> FlowResult:
        """Step 2: let the user pick which devices to import."""
        errors: dict[str, str] = {}

        if user_input is not None:
            selected = user_input.get(CONF_SELECTED_DEVICE_IDS, [])
            if not selected:
                errors[CONF_SELECTED_DEVICE_IDS] = "no_devices_selected"
            else:
                return self.async_create_entry(
                    title="Scrypted Advanced Notifier",
                    data={
                        CONF_SCRYPTED_URL: self._scrypted_url,
                        CONF_HA_SECRET: self._ha_secret,
                        CONF_SELECTED_DEVICE_IDS: selected,
                    },
                )

        device_choices = {
            d["device_id"]: d["device_name"] for d in self._available_devices
        }

        return self.async_show_form(
            step_id="select_devices",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_SELECTED_DEVICE_IDS): vol.In(
                        list(device_choices.keys())
                    ),
                }
            ),
            description_placeholders={
                "device_count": str(len(self._available_devices))
            },
            errors=errors,
        )

    async def _fetch_devices(self) -> tuple[list[dict], str | None]:
        """Fetch available devices from the plugin and return (devices, error_key)."""
        url = f"{self._scrypted_url}{ENDPOINT_HA_DEVICES}"
        headers = {
            "Authorization": f"Bearer {self._ha_secret}",
            "Origin": str(self.hass.config.external_url or self.hass.config.internal_url or ""),
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)
                ) as resp:
                    if resp.status == 401:
                        return [], "invalid_secret"
                    if resp.status == 403:
                        return [], "origin_not_allowed"
                    if resp.status != 200:
                        return [], "cannot_connect"
                    data = await resp.json()
                    return data.get("devices", []), None
        except aiohttp.ClientConnectorError:
            return [], "cannot_connect"
        except Exception:
            return [], "cannot_connect"
