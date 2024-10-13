# Active streams info plugin

Scrypted plugin that provides some usefull information over MQTT about the connections currently active to scrypted. The configuration allows to specify which cameras to track and which people. 
For each people a set of IPs can be provided to identify the person

The MQTT entities will be auto discovered by homeassistant and will be the following:
- Total streams active (Active streams) - number sensor
- 1 entity for each camera tracked (Active streams for {Camera name}) - number sensor
- 1 entity for each person tracked (Active streams for {Person name}) - number sensor
- 1 entity for each combination of camera/person tracked (Active stream for {Camera name} {Person name}) - binary sensor (shows if the camera is active for the specific person)

All the entities will have as attribute the relevant streams information