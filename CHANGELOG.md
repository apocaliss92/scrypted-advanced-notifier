<details>
<summary>Changelog</summary>

### 4.4.30
- Add setting to override the decoder stream

### 4.4.29
- Add support for homeassistant channels

### 4.4.28
- Add camera setting to resize decoder frames (advanced section)
- Change `serveAssetsFromLocal` with `assetsOriginSource` 

### 4.4.22
- Images name setting removed. Only latest images will be persisted
- Added `serveAssetsFromLocal` under Plugin General -> advanced, will serve all the assets links through local IP and not cloud. Useful if cloud plugin is not available or preferred local connections 

### 4.4.5
- Add videoclip GIF support, this adds clips support to Pushover, NTFY and Telegram, besides the already supported Homeassistant

### 4.3.65
- Add clear action to HA actions

### 4.3.61
- Add snoozes customization (Plugin => Rules section)

### 4.3.60
- Add rule configuration to snoose any notifier of the rule, instead only the single one

### 4.3.56
- Add AI filter to detection rules

### 4.3.55
- Enable FS/Webhook images for post-processed images

### 4.3.45
- StoreEvents flag default to false

### 4.3.44
- Add customizations for post-processing actions
- Quick notifications implemented, delay should be reduced on notifications

### 4.3.41
- Publish per-zone detection entities to MQTT

### 4.3.27
- Publish audio entities to MQTT

### 4.3.25
- Add setting for homeassistant notifiers to open notifications on the homeassistant's scrypted component

### 4.3.20
- Add support to onboarded audio detections (YAMnet plugin)

### 4.3.19
- Add prompt customization for the occupancy confirmation flow

### 4.3.13
- Add setting to confirm occupancy rules with AI to avoid false positives even more

### 4.3.11
- Added support (RawDetections only) to Boundaries marking and Image cropping for notifications. NVR detections will be later on extended with this too

### 4.3.3
- Clip support added. Extend a detection rule setting a contextual description to filter even more a rule result
- LLM tools support added

### 4.2.5
- Changes prepared to use LLMPlugin. Manual is the current working way

### 4.2.4
- Secret protection added for all public endpoints. A secret is auto-generated under the section General -> Advanced, this must be used as search parameter for all webhook to avoid resources to be easily available to 3th parties. The token is now also used to serve videoclips and thumbnails with limited available tokens (3 hours)

### 4.2.0
- Events app released. It is available as dashboard link as well as PWA app. It has events and videoclips views across all the possible source (NVR, Frigate, ...). Live view is still on initial stages
- Telegram notifier supported
- Audio rules improved a lot! They will now take into account analyzed sampling values and not only peaks
- Fixed many issues when MQTT was not available initially and would crash the plugin
- Plugin will not store relevant events to make them available in the web APP

### 3.7.21
- Add detection clips to the camera clips

### 3.7.16
- Add setting to set the post event duration for videoclips

### 3.7.15
- Add MQTT data source setting per camera
- Do not wake up sleeping cameras for a snapshot

### 3.7.3
- Add configurations for videoclip speed, default to 2x (Fast)

### 3.7.0
- Add full support to Frigate detections, in combination with `Scrypted Frigate Bridge` will be possible to import frigate events into scrypted and use this plugin fully with them. Particularly interesting audio classifications and bird classification (untested, will need some test data). Snapshots are as well imported from Frigate, videoclips for accelerated GIFs will be coming soon
- Motion reporting to MQTT reduced drastically to 5 seconds
- Restructure of FS folders, old timelapses will be lost due to technical reasons
- Decoder usage changed, if any rule requires a videoclip will be permanent. If enabled on the camera for snapshots will be run only when motion is triggered
- Fix annoying MQTT bug where switch/buttons were persisted on the broker and would change state of entities randomly. Plugin will remove automatically those messages
- Add setting to alarm system for critical notifications on trigger

### 3.6.15

- Short GIF recording on detection/occupancy rules. Activate the `Notify with a clip` check to try it out. It will work very well with homeassistant notifiers

### 3.6.14

- Add notification sound customization for Pushover

### 3.6.13

- Add notification sound customization (currently only for HA notifiers) 

### 3.6.12

- Decoder usage checkbox changed with a selection, Off, OnMotion (previous default), Always 

### 3.6.11

- Quick actions added to alarm notifications
- Allow using active rules notfiers for alarm notifications

### 3.6.9

- [BREAKING CHANGE] Homeassistant data fetching removed. OnActive devices won't support entity IDs anymore. Use instead device id or name

### 3.6.8

- Advanced Security System released, an onboard security system mechanism linked to detection rules

### 3.6.7

- [BREAKING CHANGE] Check occupancy (in seconds) changed with a boolean flag

### 3.6.1

- Add support to camera AI generated

### 3.6.0

- Add support to NVR notifications to translations and AI messages

### 3.5.13

- Add scheduler for notifiers, can be used also for NVR notifications

### 3.5.11

- Add default actions on camera

### 3.5.10

- [BREAKING CHANGE] HaActions and priority have been removed in favour of specific settings for every notifier utilized on a rule
- Add fully support to Ntfy, Pushover, HA, Scrypted NVR for: priority (critical too), actions, snoozing

### 3.5.9

- Add full support to native NVR notifiers

### 3.5.7

- [BREAKING CHANGE] Doorbell sensors won't be used anymore, a detection class Doorbell is now available on doorbell cameras

### 3.5.6

- Add last faces detected on MQTT People tracker device

### 3.5.5

- Add POST notification webhook on notifier level

### 3.5.4

- Add main notifications switch on the plugin level

### 3.5.0

- [BREAKING CHANGE] Sensors classes have been changed, any plugin rule using lock or contact labels, shoul be changed to new ones
- Added support for Entry and Flooding sensors

### 3.4.12

- Texts building reworked. There is now only one object detection label and several object types to make it better scalable in future. Check Texts section 

### 3.4.11

- Add labels (people and plates) filtering for detection rules

### 3.4.9

- Add audio detection and decoder snapshots entities to MQTT
- Enable decoder only during motion events

### 3.4.8

- Add support for NVR notifiers to enable/disable notifications globally or per camera, if the camera flag is off. This allows to script NVR notifications without implementing any rule
- Notifiers device discovered on MQTT

### 3.4.1

- Add setting to enable snoozing actions on a notifier (Pushover and homeassistant)

### 3.4.0

- Latest snapshots webhook changed, add a Webhook section to the README with all the possible snapshots available
- Added POST webhook for detections, set multiple URL and preferred cameras to send images to external services

### 3.3.7

- Add setting to disable notifications for a specific camera, on MQTT as well
- Implement snooze actions on Homeassistant notifiers

### 3.3.6

- Any object entities added on MQTT and file system, will be triggered for any object detection (animal, vehicle, person)

### 3.3.1

- Occupancy data persisting improved. Current status and detected objects added to settings. 
Should fix false resetting on startup

### 3.2.0

- Update images for rule in the same asynqueue to make sure an image is always available

### 3.1.23

- Link plugin rule entities on devices and vice-versa, plugin triggers will activate the plugin entity as well

### 3.1.17

- Fix retained button messages not cleaned up

### 3.1.15

- Only update motion in case of non-NVR detections when NVR detections is enabled

### 3.1.10

- Move MQTT enabled setting on camera level, enabled by default
- Move Notifier enabled setting on notifier level, enabled by default

### 3.1.9

- Added option to fetch frames from prebuffer. Unsuggested for use, use it only if snapshot crashes continuously

### 3.0.31

- Automatic cleanup of HA entities when not available anymore

### 3.0.30

- `Minimum MQTT publish delay` setting adding on the camera, allowing to defer detection updates

### 3.0.28

- NVR images will be stored on system as well, with a -NVR suffix, along with the non-cropped ones

### 3.0.27

- Add camera level configuration to enable regular occupancy check

### 3.0.23

- Add rule configuration to delay MQTT image update

### 3.0.21

- Cleanup detection rules discovery not supported per camera

### 3.0.20

- Fix NVR detections parsing

### 3.0.19

- Performance noticeably improved splitting images update on MQTT in batches

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