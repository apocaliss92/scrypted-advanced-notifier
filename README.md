# Scrypted advanced notifier

from 0.4.0 the plugin was rewritten from scratch, this file could not be very accurate.

https://github.com/apocaliss92/scrypted-homeassistant-utilities - For requests and bugs

This plugin was createdy for the necessity to hook some homeassistant mechanisms with Scrypted. The use case is the component Alarmo (https://github.com/nielsfaber/alarmo) running on homeassistant to handle an alarm system. It would push over MQTT the currently active devices to monitor my home (cameras, proximity sensors, door/window sensors, lock sensors...) and take action when any of them would be triggered. The only complicated part of this was to send screenshots to my devices when this would happen. Scrypted helps exactly on this part.
<br/>
<br/>

This plugin offers the following parts:
- A mixin to configure the scrypted devices to work with the plugin
- Customizable notifications
- MQTT autodiscovered devices

# Plugin configuration
 After install the plugin a few configurations should be done on the plugin interface
 ## General
 - Plugin enabled: simple switch to enable/disable the plugin
 - Log debug messages: verbose logging in console
 - Scrypted token: can be found on homeassistant in the sensor created by the scrypted integration
 - NVR url: URL externally accessible to the NVR interface, default ot `https://nvr.scrypted.app`

 TODO