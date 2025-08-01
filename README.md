# Scrypted advanced notifier

☕️ If this extension works well for you, consider buying me a coffee. Thanks!
[Buy me a coffee!](https://buymeacoffee.com/apocaliss92)

[For requests and bugs](https://github.com/apocaliss92/scrypted-advanced-notifier)

# Getting started

## MQTT

To enable MQTT exporting:

- enable `MQTT enabled` in the general -> general tab
- setup the authentication parameters in the tab general -> MQTT, check the `Use MQTT plugin credentials` to use the credentials set on the MQTT plugin
- Check `Use NVR detections` if you want the images stored on MQTT to be the clipped ones from NVR.
- Check `Audio pressure (dB) detection` if you want a continuous reporting of the audio kept by the camera (dBs)
- Check `Check objects occupancy regularly` if you want regular occupancy data checks on the camera
- Cameras enabled to the plugin will be automatically enabled to MQTT. Can be disabled in the camera's section Advanced notifier -> Report to MQTT

The plugin will export to MQTT the following entities:

- PTZ controls
- Restart control
- Notifications enabled
- Basic detection information (motion, animal, person, vehicle, face, plate, generic object). Same information will be available for every rule associated to a camera
  - Latest image
  - Triggered
  - Last trigger time (disabled by default)
  - Amount of objects (if enabled)
- Online status
- Sleeping status
- Battery status
- Recording switch (NVR privacy mode)
- Current dBs (if enabled)

## Notifications

The plugin provides customized way to deliver notifications. It is based on rules. Each rule can be activated based on several factors, i.e. active sensors, time ranges, security system status. Any notifier can be used but the only fully supported currently are (can be extended for any other):

- Native Scrypted notifiers (i.e. Scrypted iPhone app...)
- Ntfy
- Homeassistant push notifications
- Pushover
- Telegram

  It's useful to use Pushover or NTFY as notifiers storage, in combination with a homeassistant or NVR one, setting its priority to the lowest. This will allow to have a rich notification and also to store it on another notifier. This because notifiers such as pushover, ntfy or telegram do not have a nice support to actions. Following parameters are required to successfully send notifications

- `Scrypted token`: Token stored on the scrypted entity on homeassistant
- `NVR url`: Url pointing to the NVR instance, should be accessible from outside

Each notifier will be fully configurable on every rule, with possibility to set: actions, addSnoozeActions or priority.
Default actions can be set on every camera, will be added to each notification

All notifiers currently support critical notifications.

Notifications can be disabled for a specific camera on the camera page, Advanced notifier => Notifier => `Notifications enabled` (available on MQTT as well)
Notifications can be disabled globally on the general tab of the plugin

### Scrypted NVR notifiers

Plugins supports scripting of the NVR buitin notifiers, following features are available:

- discover to MQTT
- Notifier notifications disabled: completely disable notifications for a specific notifier
- Camera notifications disabled: disable notifications for a specific camera
- Schedule notifications on both cameras and notifiers
- Translate notifications with the plugin `Texts` section (enabled by default)
- Enable AI to generate descriptions. To make this to work, each camera and notifier should be extended with the Advanced notifier pluign and activate the AI flag on both. Reason is that ai calls can be expensive and needs to be explicitely enabled on both entities

**NVR notifiers can be used both as plugin notifiers, then with rules and everything, or just to enhance the NVR notifications.**

- If you want to use it as plugin notifier, you should keep the notifier enabled (at the very bottom of the page) BUT disable all the detection classes (on the device page of the device, i.e. `Scrypted iPhone App (user)`)
- If you want the plugin to just enhance the NVR notifications, there is nothing to change to make it work with the plugin. Just extend the notifier with this plugin and use the features you like to use

## Rules

Rules can be of following types: Detection, Occupancy, Audio, Timelapse. These properties are in common with all, some are hidden until the `Show more configurations` gets activated

- `Activation type`: when the rule shoul be active
  - Always
  - Schedule, defined in a time range during the day
  - OnActive, will be active only if the camera will be listed in the `"OnActive" devices` selector (plugin => rules => general). This selector can be driven by MQTT with a topic specified in `Active entities topic` under General => MQTT. The message to this topic can contain either a list of device IDs, names or homeassistant entityId (check homeassistant section)
- `Notifiers`: notifiers to notify, additional properties will be applied depending on the selected ones
  - `Pushover priority` priority to use on pushover
  - `Homeassistant Actions` actions to show on the homessistant push notifications, of type `{"action":"open_door","title":"Open door","icon":"sfsymbols:door"}`, check homeassistant documentation for further info
- `Open sensors` which sensors should be open to enable the rule
- `Closed sensors` which sensors should be closed to enable the rule
- `Alarm modes` which alarm states should enable the rule. The alarm system device can be defined in the plugin page under Rules => `Security system`
- `Notify with a clip` available only for detection and occupancy rules, the plugin will activate a decoder to save the last frames of the camera. On the trigger of a rule, a short clip will be generated and sent instead of a simple snapshot. It supports 2 types:
  - MP4: supported only by homeassistant and partially the others
  - GIF: supported by homeassistant, pushover

### Detection

These rules can be created for multiple cameras (on the plugin page) or per single camera. They allow to specify which object detections should trigger a notification:

- Create a new rule adding a new text in the `Detection rules` selector and hit save. A new tab will appear
- Set the activation type
- Set the notifiers to notify on the detection
- Check `Use NVR detections` to trigger the rule only as effect of detections from NVR plugin. This will include cropped images stored on MQTT and will be in sync with the NVR app events reel
- Set the detection classes and the minimum score to trigger the notification
- Set `Minimum notification delay` to debounce further notifications (overrides the camera settings)
- Set `Minimum MQTT publish delay` to debounce the image update on MQTT for this rule
- Set `Whitelisted zones` to use only detections on these zones
- Set `Blacklisted zones` to ignore detections coming from these zones
- Set `Disable recording in seconds` to enable NVR recording for some seconds and disable it afterwords
- Set a `Custom text` if a specific text should be applied. By default detection rules will use the texts defined in the plugin tab `Texts`, many placeholder are available to enrich the content
- Check `Enable AI to generate descriptions` if you want to let AI generate a description text out of the image. AI settings are available on the plugin page under the AI, currently supported: GoogleAi, OpenAi, Claude, Groq
- Set `CLIP Description` to use semantic search and filter out even more detections. It will be applied at the very end of the chain, when all the filters already had effect. Set `CLIP confidence level` to finetune the confidence level of the search
- Set `AI filter` to send the image to the choosen AI tool to confirm the input prompt
- Set `Image post processing` to process notification images:
  - MarkBoundaries will drawn a coloured rectangle around the detected object
  - Crop will crop the image around the detected object

### Occupancy (only on camera)

These rules will monitor a specific area to mark it as occupied or not

- Make sure to set an object detector on the plugin page under Rules => `Object Detector`
- Create a new rule adding a new text in the `Occupancy rules` selector and hit save. A new tab will appear
- Set the activation type
- Set the notifiers to notify on the occupancy change
- Set the detection class to monitor
- Set the camera zone to monitor, must be an `Observe` type zone defined in the `Object detection` section of the camera
- (Optional) set a capture zone to reduce the frame used for the detection, may increase success rate
- Set `Zone type`
  - `Intersect` if the objects can be considered detected if falling in any portion of the zone
  - `Contain` if the objects should be completely included in the detection zone
- Set a `Score threshold`, in case of static detections should be pretty low (default 0.3)
- Set `Occupancy confirmation`, it's a confirmation period in seconds to avoid false results. Set it depending on your specific case
- Set `Force update in seconds` to force an occupancy check if no detection happens. Any detection running on the camera will anyways check all the occupancy rules
- Set the `Max objects` the zone can contain. The zone will be marked as occupied if the detected objects are >= of the number set here
- Set a text in both `Zone occupied text` and `Zone not occupied text` for the notification texts
- Activate `Confirm occupancy with AI` to confirm occupancy results to reduce even more false positives. Under the plugin AI section is possible to customize the prompt. Results may vary depending on the model used

### Timelapse (only on camera)

Define a timeframe, the plugin will collect frames from the camera and generate a clip out of it at the end of the defined range. All the generated timelapses will be available as videoclip on the NVR app, only if the `Enable Camera` on the plugin page will be enabled.

- Create a new rule adding a new text in the `Timelapse rules` selector and hit save. A new tab will appear
- Define the week days and the start/end times. i.e. start at 11pm and end at 8am
- Set the notifiers to notify the generated clip
  - If an homeassistant notifier is used and the final clip will be <50bm, the clip will be shown as preview of the push notification!
- Set a `Notification text` for the notification message
- Set a `Frames acquisition delay`, a frame will be generated according to this. Each non-motion detection will always add a frame
  - In future will be possible to add frames based on specific detection classes and even small clips
- Set a `Timelapse framerate`, this will depend on the timespan you will chose and how long you want the final clip to be
- Use the `Generate now` button to reuse the frames collected the previous session. They will be stored until the following session starts

### Audio (only on camera)

**Audio rules will activate only if a source of audio measurement is active. These are currently probided by Basic object detector (Audio detector mixin) and Frigate Bridge (Frigate audio detector).**
Audio rules will monitor the audio received by the camera

- Create a new rule adding a new text in the `Audio rules` selector and hit save. A new tab will appear
- Set the notifiers to notify the event
- Set a `Notification text` for the notification message
- Set a `Decibel threshold` for the audio level to alert
- Set `Duration in seconds` if the audio should last at least these seconds to trigger a notification. Leave blank to notify right away

## Stored images

The plugin will store on filesystem, if configured, images for every basic detection and rule. Set the following configurations on the plugin page under the Storage tab

- `Storage path`: If set, the images used to populate MQTT topic will be also stored on the drive path

## Additional camera settings

- `Minimum snapshot acquisition delay`, minimum seconds to wait until a new snapshot can be taken from a camera, keep it around 5 seconds for cameras with weak hardware
- `Off motion duration`, amount of seconds to consider motion as ended for rules/detections affecting the camera. It will override the motion off events
- `Snapshot from Decoder`, take snapshots from the camera decoded stream. If set to `Always` it will be active only if any detection rule with videoclips, timelapse or occupancy rule is running. If set `OnMotion` it will run only during motion sessions, usefull if your camera gives many snapshot timeout errors. `Auto` will be the default and regulate it when required
- Set `Minimum notification delay` to debounce further notifications
- Set `Minimum MQTT publish delay` to debounce the image update on MQTT for this basic detections

## Webhooks

Some basic webhooks are available

### Latest snapshot

Will provide the latest registered image for each type, on the camera settings will be provided the basic url, {IMAGE_NAME} should be replaced with one of the following:

- `object-detection-{ motion | any_object | animal | person | vehicle }`
- `object-detection-{ motion | any_object | animal | person | vehicle }-{ Crop | MarkBoundaries}`
- `object-detection-{ motion | any_object | animal | person | vehicle }-{ NVR | Frigate }`
- `object-detection-face-{ known person label }`
- `object-detection-face-{ known person label }-{ NVR | Frigate }`
- `rule-{ ruleName }`
- `rule-{ ruleName }-{ motion | any_object | animal | person | vehicle }`
- `rule-{ ruleName }-{ Crop | MarkBoundaries}`
- `rule-{ ruleName }-{ Crop | MarkBoundaries}-{ motion | any_object | animal | person | vehicle }`

### POST detection images

Provide multiple urls, for each detection, POST a b64 image with some additional metadata. Filter
on some classes and define a minimum delay.

## Adanced Alarm System

The plugin provides a security system hooked into the plugin detection rules. To use it this will be required:

- Create 1 or more detection rule on the plugin page with activation type `AdvancedSecuritySystem` and set 1 or more modes to activate the rule
- Setup the provided `Advanced security system` device with preferred preferences, such as texts or devices that can be bypassed during the activation

The device is discovered on MQTT and completely compatible with Homekit.
