"""Constants for Scrypted Advanced Notifier integration."""

DOMAIN = "scrypted_an"

CONF_SCRYPTED_URL = "scrypted_url"
CONF_HA_SECRET = "ha_secret"
CONF_SELECTED_DEVICE_IDS = "selected_device_ids"

# HA bus event names (fired by Scrypted plugin via fire_event)
HA_EVENT_STATE_UPDATE = "scrypted_an_state_update"
HA_EVENT_ENTITY_CHANGE = "scrypted_an_entity_change"

# HTTP endpoints (relative to scrypted_url + /endpoint/@apocaliss92/scrypted-advanced-notifier)
ENDPOINT_BASE = "/endpoint/@apocaliss92/scrypted-advanced-notifier"
ENDPOINT_HA_DEVICES = f"{ENDPOINT_BASE}/public/ha/devices"
ENDPOINT_HA_ENTITIES = f"{ENDPOINT_BASE}/public/ha/entities"
ENDPOINT_HA_COMMAND = f"{ENDPOINT_BASE}/public/ha/command"
