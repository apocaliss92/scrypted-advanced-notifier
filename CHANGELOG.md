<details>
<summary>Changelog</summary>

### 3.0.17

- MQTT client split per device to reduce overhead for weak brokers
- Utilize images from object detectors when available
- Optimize image usage 

### 3.0.8

Added support to Groq

### 3.0.7

Added support to Anthropic AI

### 3.0.6

Added support to Google AI, thanks @sfn!

### 3.0.0

MQTT rework. Most of the IDs have changed. Remove all the homeassistant devices and let the plugin to recreate them.
This was required to allow me to extend the plugin in an easier and scalable way. Some improvements happened along the way

### 2.2.30

Add MQTT flag for each rule currently running

### 2.2.28

Enable reporting of occupancy data for every camera enabled to MQTT

### 2.2.27

Audio deteciton rules implemented

### 2.2.26

Add PTZ controls to MQTT/HA

### 2.2.25

Add Reboot button to MQTT/HA

</details>