import sdk, {
  EventDetails,
  EventListenerRegister,
  Image,
  MediaObject,
  Notifier,
  OnOff,
  ObjectDetection,
  ObjectDetectionResult,
  ObjectsDetected,
  PanTiltZoomCommand,
  ResponseMediaStreamOptions,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  SettingValue,
  Settings,
  VideoClip,
  VideoClipOptions,
  VideoClipThumbnailOptions,
  VideoClips,
  VideoFrame,
  VideoFrameGenerator,
} from "@scrypted/sdk";
import {
  SettingsMixinDeviceBase,
  SettingsMixinDeviceOptions,
} from "@scrypted/sdk/settings-mixin";
import {
  StorageSetting,
  StorageSettingsDict,
} from "@scrypted/sdk/storage-settings";
import fs from "fs";
import { cloneDeep, keyBy, sortBy, uniq, uniqBy } from "lodash";
import moment from "moment";
import { getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import { filterOverlappedDetections } from "../../scrypted-basic-object-detector/src/util";
import {
  audioDetectorNativeId,
  buildOccupancyZoneId,
  getFrigateMixinSettings,
  objectDetectorNativeId,
} from "../../scrypted-frigate-bridge/src/utils";
import { Deferred } from "../../scrypted/server/src/deferred";
import { checkObjectsOccupancy, confirmDetection } from "./aiUtils";
import {
  AudioAnalyzerSource,
  AudioChunkData,
  AudioRtspFfmpegStream,
  AudioSensitivity,
  executeAudioClassification,
  sensitivityDbThresholds,
} from "./audioAnalyzerUtils";
import {
  DetectionClass,
  defaultDetectionClasses,
  detectionClassesDefaultMap,
  isAudioClassname,
  isFaceClassname,
  isMotionClassname,
  isObjectClassname,
  isPlateClassname,
  levenshteinDistance,
} from "./detectionClasses";
import {
  addBoundingBoxesToImage,
  addZoneClipPathToImage,
  cropImageToDetection,
} from "./drawingUtils";
import AdvancedNotifierPlugin from "./main";
import {
  ClassOccupancy,
  ClassZoneOccupancy,
  detectionClassForObjectsReporting,
  idPrefix,
  InitialCameraState,
  publishBasicDetectionData,
  publishCameraValues,
  publishClassnameImages,
  publishOccupancy,
  publishPeopleData,
  publishResetDetectionsEntities,
  publishResetRuleEntities,
  publishRuleData,
  publishRuleEnabled,
  rediscoverCameraMqttDevice,
  setupCameraAutodiscovery,
  subscribeToCameraMqttTopics,
} from "./mqtt-utils";
import {
  normalizeBox,
  polygonContainsBoundingBox,
  polygonIntersectsBoundingBox,
} from "./polygon";
import {
  CameraMixinState,
  CurrentOccupancyState,
  OccupancyRuleData,
  getInitOccupancyState,
} from "./states";
import {
  CameraNativeIdAccessoryKind,
  findCameraAccessorySwitchesByNativeId,
} from "./accessoryUtils";
import {
  ADVANCED_NOTIFIER_INTERFACE,
  BaseRule,
  DecoderType,
  DelayType,
  DetectionRule,
  DetectionsPerZone,
  DeviceInterface,
  FRIGATE_BRIDGE_PLUGIN_ID,
  GetImageReason,
  ImagePostProcessing,
  ImageSource,
  IsDelayPassedProps,
  MatchRule,
  MixinBaseSettingKey,
  NVR_PLUGIN_ID,
  NotifyDetectionProps,
  NotifyRuleSource,
  ObserveZoneData,
  OccupancySource,
  PatrolRule,
  RecordingRule,
  RuleSource,
  RuleType,
  SNAPSHOT_WIDTH,
  ScryptedEventSource,
  TimelapseRule,
  VIDEO_ANALYSIS_PLUGIN_ID,
  ZoneMatchType,
  ZoneWithPath,
  ZonesSource,
  b64ToMo,
  cachedReaddir,
  convertSettingsToStorageSettings,
  filterAndSortValidDetections,
  getActiveRules,
  getAllDevices,
  getAudioRulesSettings,
  getB64ImageLog,
  getDetectionEventKey,
  getDetectionKey,
  getDetectionRulesSettings,
  getDetectionsLog,
  getDetectionsPerZone,
  getEmbeddingSimilarityScore,
  getMixinBaseSettings,
  getOccupancyRulesSettings,
  getPatrolRulesSettings,
  getRecordingRulesSettings,
  getRuleKeys,
  getRulesLog,
  getTimelapseRulesSettings,
  getUrlLog,
  getWebHookUrls,
  moToB64,
  similarityConcidenceThresholdMap,
  splitRules,
} from "./utils";
import {
  VideoRtspFfmpegRecorder,
  getVideoClipName,
  parseVideoFileName,
} from "./videoRecorderUtils";

const { systemManager } = sdk;

type CameraSettingKey =
  | "ignoreCameraDetections"
  | "notificationsEnabled"
  | "aiEnabled"
  | "schedulerEnabled"
  | "startTime"
  | "endTime"
  | "notifierActions"
  | "minSnapshotDelay"
  | "detectionSourceForMqtt"
  | "facesSourceForMqtt"
  | "zonesSourceForMqtt"
  | "motionDuration"
  | "decoderFrequency"
  | "decoderStreamDestination"
  | "resizeDecoderFrames"
  | "occupancySourceForMqtt"
  | "mqttRediscoverDevice"
  | "decoderType"
  | "audioAnalyzerEnabled"
  | "audioClassifierSource"
  | "audioAnalyzerStreamName"
  | "audioAnalyzerCustomStreamUrl"
  | "audioAnalyzerSensitivity"
  | "audioAnalyzerProcessPid"
  | "videoRecorderProcessPid"
  | "videoRecorderStreamName"
  | "videoRecorderCustomStreamUrl"
  | "videoRecorderH264"
  | "showVideoclips"
  | "lastSnapshotWebhook"
  | "lastSnapshotWebhookCloudUrl"
  | "lastSnapshotWebhookLocalUrl"
  | "postDetectionImageWebhook"
  | "postDetectionImageUrls"
  | "postDetectionImageClasses"
  | "postDetectionImageMinDelay"
  | "decoderProcessId"
  | "snoozedData"
  | "delayPassedData"
  | "maxSpaceInGb"
  | "storageRetentionDays"
  | "storageEventsRetentionDays"
  | "occupiedSpaceInGb"
  | MixinBaseSettingKey;

export class AdvancedNotifierCameraMixin
  extends SettingsMixinDeviceBase<any>
  implements Settings, VideoClips {
  initStorage: StorageSettingsDict<CameraSettingKey> = {
    ...getMixinBaseSettings({
      plugin: this.plugin,
      mixin: this,
      refreshSettings: this.refreshSettings.bind(this),
    }),
    storageRetentionDays: {
      title: "Clips/Rules retention days",
      description: "Number of days to keep rules artifacts and videoclips",
      type: "number",
      defaultValue: 30,
      subgroup: "Storage",
    },
    storageEventsRetentionDays: {
      title: "Events retention days",
      description: "How many days to keep the generated event images",
      type: "number",
      defaultValue: 14,
      subgroup: "Storage",
    },
    maxSpaceInGb: {
      title: "Dedicated memory in GB",
      type: "number",
      defaultValue: 20,
      subgroup: "Storage",
      onPut: async () => await this.refreshSettings(),
    },
    occupiedSpaceInGb: {
      title: "Memory occupancy in GB",
      type: "number",
      range: [0, 20],
      readonly: true,
      placeholder: "GB",
      subgroup: "Storage",
    },
    ignoreCameraDetections: {
      title: "Ignore camera detections",
      description:
        "If checked, the detections reported by the camera will be ignored. Make sure to have an object detector mixin enabled",
      type: "boolean",
      immediate: true,
      defaultValue: true,
      subgroup: "Advanced",
    },
    notificationsEnabled: {
      title: "Notifications enabled",
      description: "Enable notifications related to this camera",
      type: "boolean",
      subgroup: "MQTT",
      immediate: true,
      defaultValue: true,
    },
    aiEnabled: {
      title: "AI descriptions",
      description: "Use configured AI to generate descriptions",
      type: "boolean",
      subgroup: "Notifier",
      immediate: true,
      defaultValue: false,
    },
    schedulerEnabled: {
      type: "boolean",
      subgroup: "Notifier",
      title: "Scheduler",
      immediate: true,
      onPut: async () => await this.refreshSettings(),
    },
    startTime: {
      title: "Start time",
      subgroup: "Notifier",
      type: "time",
      immediate: true,
    },
    endTime: {
      title: "End time",
      subgroup: "Notifier",
      type: "time",
      immediate: true,
    },
    notifierActions: {
      title: "Default actions",
      description:
        'Actions to show on every notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door", "url": "url"}',
      subgroup: "Notifier",
      type: "string",
      multiple: true,
      defaultValue: [],
    },
    minSnapshotDelay: {
      title: "Minimum snapshot acquisition delay",
      description:
        "Minimum amount of seconds to wait until a new snapshot is taken from the camera",
      type: "number",
      defaultValue: 5,
      subgroup: "Advanced",
    },
    detectionSourceForMqtt: {
      title: "Detections source",
      description:
        "Which source should be used to update MQTT. Default will use the plugin setting",
      type: "string",
      subgroup: "MQTT",
      immediate: true,
      combobox: true,
      defaultValue: ScryptedEventSource.Default,
      choices: [],
    },
    facesSourceForMqtt: {
      title: "Faces source",
      description:
        "Which source should be used to update the people tracker. Default will use the plugin setting",
      type: "string",
      immediate: true,
      combobox: true,
      subgroup: "MQTT",
      defaultValue: ScryptedEventSource.Default,
      choices: [],
    },
    zonesSourceForMqtt: {
      title: "Zones source",
      description:
        "Which zone list should be used for MQTT zone entities. Default will use the plugin setting. Scrypted uses Observe zones; Frigate uses zones defined in the Frigate interface.",
      type: "string",
      immediate: true,
      subgroup: "MQTT",
      combobox: true,
      defaultValue: ZonesSource.Default,
      choices: [],
    },
    occupancySourceForMqtt: {
      title: "Source for objects occupancy data",
      description:
        "Select the source of the frame occupancy check, i.e. how many cars are on a camera",
      type: "string",
      immediate: true,
      subgroup: "MQTT",
      choices: [],
      defaultValue: OccupancySource.Off,
    },
    mqttRediscoverDevice: {
      title: "Rediscover MQTT device",
      subgroup: "MQTT",
      type: "button",
      description:
        "Removes this camera from Home Assistant (if HA API URL and token are set in plugin settings), clears all MQTT topics for this camera, then republishes discovery. Use if entities are missing, duplicated or out of sync.",
      onPut: async () => {
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();
        const { allAvailableRules } = await getActiveRules({
          device: this.cameraDevice,
          deviceStorage: this.mixinState.storageSettings,
          plugin: this.plugin,
          console: logger,
        });
        const zones = await this.getMqttZones();
        let haApiUrl: string | undefined;
        let haApiToken: string | undefined;
        try {
          const ha = await this.plugin.getHaApiUrl();
          if (ha?.url && ha?.accessToken) {
            haApiUrl = ha.url;
            haApiToken = ha.accessToken;
          }
        } catch (_e) {
          // HA URL/token not configured or getHaApiUrl failed; rediscover will only clear topics and republish
        }
        const initialCameraState = await this.getCameraMqttCurrentState();
        const result = await rediscoverCameraMqttDevice({
          mqttClient,
          device: this.cameraDevice,
          console: logger,
          rules: allAvailableRules ?? [],
          zones,
          accessorySwitchKinds: this.cameraAccessorySwitchKinds,
          haApiUrl,
          haApiToken,
          initialCameraState,
        });
        if (result.haError) {
          logger.warn("Rediscover completed with HA warning:", result.haError);
        } else if (result.haDeviceDeleted) {
          logger.log("Device removed from Home Assistant, topics cleared, discovery republished.");
        } else {
          logger.log("Topics cleared, discovery republished.");
        }
      },
    },
    motionDuration: {
      title: "Off motion duration",
      type: "number",
      defaultValue: 10,
      subgroup: "Advanced",
    },
    decoderFrequency: {
      title: "Decoder frames frequency",
      description:
        "How frequent to store frames (used for clips/GIFs) in milliseconds. Increase this in case of errors on notifiers",
      type: "number",
      defaultValue: 100,
      subgroup: "Advanced",
    },
    decoderStreamDestination: {
      title: "Decoder stream destination",
      description:
        "Select the stream to use to decode. Default will use the best one for dimensions",
      type: "string",
      defaultValue: "Default",
      choices: [
        "Default",
        "local",
        "remote",
        "medium-resolution",
        "low-resolution",
        "local-recorder",
        "remote-recorder",
      ],
      combobox: true,
      subgroup: "Advanced",
    },
    resizeDecoderFrames: {
      title: "Resize decoder frames",
      description:
        "Check this if you get GIFs/clips too big to be shipped on notifiers",
      type: "boolean",
      defaultValue: false,
      immediate: true,
      subgroup: "Advanced",
      hide: true,
    },
    decoderType: {
      title: "Snapshot from Decoder",
      description:
        "Define when to run a decoder to get more frequent snapshots. It will be enabled only if there is any running timelapse rule, occupancy rule or detection rule with videoclips",
      type: "string",
      immediate: true,
      defaultValue: DecoderType.Auto,
      choices: [
        DecoderType.Auto,
        DecoderType.OnMotion,
        DecoderType.Always,
        DecoderType.Off,
      ],
    },
    audioAnalyzerEnabled: {
      title: "Audio analyzer enabled",
      description: "Enable or disable onboarded audio analysis",
      type: "boolean",
      immediate: true,
      subgroup: "Audio Analysis",
      defaultValue: true,
      onPut: async () => {
        await this.restartAudioAnalysis();
        await this.refreshSettings();
      },
    },
    audioClassifierSource: {
      title: "Audio classifier source",
      description:
        "Select the source for audio classification. Disabled will turn off onboarded audio classification",
      type: "string",
      immediate: true,
      subgroup: "Audio Analysis",
      defaultValue: AudioAnalyzerSource.YAMNET,
      choices: Object.values(AudioAnalyzerSource),
      onPut: async () => {
        await this.restartAudioAnalysis();
        await this.refreshSettings();
      },
    },
    audioAnalyzerStreamName: {
      title: "Stream",
      description: "Select a stream which provides audio",
      type: "string",
      subgroup: "Audio Analysis",
      immediate: true,
      choices: [],
      onPut: async () => {
        await this.restartAudioAnalysis();
        await this.refreshSettings();
      },
    },
    audioAnalyzerCustomStreamUrl: {
      title: "Manual stream",
      description:
        'Copy the stream from the "RTSP rebroadcast URL" field if you have unsual cameras',
      placeholder: "rtsp://localhost:12345/1231251351astwea",
      subgroup: "Audio Analysis",
      onPut: async () => {
        await this.restartAudioAnalysis();
        await this.refreshSettings();
      },
    },
    audioAnalyzerSensitivity: {
      title: "Audio sensitivity",
      description: "Specify how often to classify based on the audio levels",
      type: "string",
      immediate: true,
      subgroup: "Audio Analysis",
      defaultValue: AudioSensitivity.Medium,
      choices: Object.values(AudioSensitivity),
      onPut: async () => {
        await this.refreshSettings();
      },
    },
    audioAnalyzerProcessPid: {
      type: "string",
      subgroup: "Audio Analysis",
      hide: true,
    },
    videoRecorderProcessPid: {
      type: "string",
      subgroup: "Advanced",
      hide: true,
    },
    videoRecorderStreamName: {
      title: "Stream",
      description: "Select a stream which provides video for recording",
      type: "string",
      subgroup: "Video recorder",
      immediate: true,
      choices: [],
      onPut: async () => {
        await this.refreshSettings();
      },
    },
    videoRecorderCustomStreamUrl: {
      title: "Manual stream",
      description:
        'Copy the stream from the "RTSP rebroadcast URL" field if you have unsual cameras',
      placeholder: "rtsp://localhost:12345/1231251351astwea",
      subgroup: "Video recorder",
      onPut: async () => {
        await this.refreshSettings();
      },
    },
    videoRecorderH264: {
      title: "Convert to H264",
      description:
        "Convert the recorded video to H264. Useful if the source stream is H265 and you want to view it in browsers that do not support it.",
      type: "boolean",
      subgroup: "Video recorder",
      defaultValue: false,
      immediate: true,
    },
    showVideoclips: {
      title: "Show videoclips",
      description: "Show recorded videoclips",
      type: "boolean",
      subgroup: "Video recorder",
      defaultValue: true,
      immediate: true,
    },
    // WEBHOOKS
    lastSnapshotWebhook: {
      subgroup: "Webhooks",
      title: "Last snapshot",
      description: "Check README for possible IMAGE_NAME to use",
      type: "boolean",
      immediate: true,
      onPut: async () => await this.refreshSettings(),
    },
    lastSnapshotWebhookCloudUrl: {
      subgroup: "Webhooks",
      type: "html",
      title: "Cloud URL",
      readonly: true,
    },
    lastSnapshotWebhookLocalUrl: {
      subgroup: "Webhooks",
      type: "html",
      title: "Local URL",
      readonly: true,
    },
    postDetectionImageWebhook: {
      subgroup: "Webhooks",
      title: "Post detection image",
      description:
        "Execute a POST call to multiple URLs with the selected detection classes",
      type: "boolean",
      immediate: true,
      onPut: async () => await this.refreshSettings(),
    },
    postDetectionImageUrls: {
      subgroup: "Webhooks",
      title: "URLs",
      type: "string",
      multiple: true,
      defaultValue: [],
    },
    postDetectionImageClasses: {
      subgroup: "Webhooks",
      title: "Detection classes",
      multiple: true,
      combobox: true,
      type: "string",
      choices: defaultDetectionClasses,
      defaultValue: [],
    },
    postDetectionImageMinDelay: {
      subgroup: "Webhooks",
      title: "Minimum posting delay",
      type: "number",
      defaultValue: 15,
    },
    // UTILITY
    decoderProcessId: {
      hide: true,
      type: "string",
    },
    snoozedData: {
      hide: true,
      json: true,
    },
    delayPassedData: {
      hide: true,
      json: true,
    },
  };
  cameraDevice: DeviceInterface;
  detectionListener: EventListenerRegister;
  motionListener: EventListenerRegister;
  binaryListener: EventListenerRegister;
  audioVolumesListener: EventListenerRegister;
  audioSensorListener: EventListenerRegister;
  killed: boolean;
  processingAccumulatedDetections = false;
  mainLoopListener: NodeJS.Timeout;
  processDetectionsInterval: NodeJS.Timeout;
  isActiveForMqttReporting: boolean;
  isActiveForNvrNotifications: boolean;
  isActiveForDoorbelDetections: boolean;
  isActiveForAudioVolumeControls: boolean;
  framesGeneratorSignal = new Deferred<void>().resolve();
  frameGenerationStartTime: number;
  mainLoopRunning = false;
  currentFrameGenerator: AsyncGenerator<VideoFrame, any, unknown>;

  private patrolAbort?: AbortController;
  private patrolTask?: Promise<void>;
  private patrolSignature?: string;

  shouldClassifyAudio: boolean;
  isActiveForAudioAnalysis: boolean;
  audioRtspFfmpegStream: AudioRtspFfmpegStream;
  videoRecorder: VideoRtspFfmpegRecorder;
  audioClassificationLabels: string[];
  audioClassifier: ObjectDetection;

  streams: Setting[] = [];
  hasFrigateObjectDetectorMixin: boolean;
  hasNvr: boolean;

  private cameraAccessorySwitchDevices: Partial<
    Record<CameraNativeIdAccessoryKind, ScryptedDeviceBase & OnOff>
  > = {};
  private cameraAccessorySwitchKinds: CameraNativeIdAccessoryKind[] = [];
  private cameraAccessorySwitchesInitialized = false;

  private initCameraAccessorySwitches(logger: Console) {
    if (this.cameraAccessorySwitchesInitialized) {
      return;
    }
    this.cameraAccessorySwitchesInitialized = true;

    const result = findCameraAccessorySwitchesByNativeId({
      device: this.cameraDevice,
      console: logger,
    });

    const foundSwitches = result.switches.filter((s) => !!s.device);

    for (const sw of foundSwitches) {
      if (!this.cameraAccessorySwitchDevices[sw.kind]) {
        this.cameraAccessorySwitchDevices[sw.kind] = sw.device;
        this.cameraAccessorySwitchKinds.push(sw.kind);
      }
    }

    if (foundSwitches.length) {
      const foundLog = foundSwitches.map((s) => s.kind).join(", ");
      logger.log(`Camera accessory devices found: ${foundLog}`);
    }
  }

  constructor(
    options: SettingsMixinDeviceOptions<any>,
    public plugin: AdvancedNotifierPlugin,
  ) {
    super(options);

    this.plugin.currentCameraMixinsMap[this.id] = this;

    this.cameraDevice = systemManager.getDeviceById<DeviceInterface>(this.id);

    if (!this.plugin.cameraStates[this.id]) {
      this.plugin.cameraStates[this.id] = new CameraMixinState({
        clientId: `scrypted_an_camera_${this.id}`,
        cameraMixin: this,
      });
    }
    const logger = this.getLogger();

    this.initCameraAccessorySwitches(logger);

    this.initValues().catch(logger.log);

    this.startStop(
      this.plugin.storageSettings.values.pluginEnabled,
      "mixin_init",
    ).catch(logger.log);
  }

  get mixinState() {
    return this.plugin.cameraStates[this.id];
  }

  async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
    const videoClips: VideoClip[] = [];
    const { showVideoclips } = this.mixinState.storageSettings.values;

    try {
      const deviceClips = await this.mixinDevice.getVideoClips(options);
      for (const clip of deviceClips) {
        videoClips.push({
          ...clip,
          videoId: clip.videoId ?? clip.id,
        });
      }
    } catch { }

    if (showVideoclips) {
      const internalClips = await this.getVideoClipsInternal(options);
      videoClips.push(...internalClips);
    }

    return sortBy(videoClips, "startTime");
  }

  async getVideoClipsInternal(
    options?: VideoClipOptions,
  ): Promise<VideoClip[]> {
    const videoClips: VideoClip[] = [];
    const logger = this.getLogger();
    const cameraFolder = this.id;

    const cameraDevice =
      sdk.systemManager.getDeviceById<ScryptedDeviceBase>(cameraFolder);
    const { rulesPath } = this.plugin.getRulePaths({ cameraId: cameraFolder });

    try {
      const rulesFolder = await cachedReaddir(rulesPath);

      for (const ruleFolder of rulesFolder) {
        const { generatedPath } = this.plugin.getRulePaths({
          cameraId: cameraFolder,
          ruleName: ruleFolder,
        });

        const files = await cachedReaddir(generatedPath);

        for (const file of files) {
          const [fileName, extension] = file.split(".");
          if (extension === "mp4") {
            const timestamp = Number(fileName);

            if (timestamp > options.startTime && timestamp < options.endTime) {
              const { videoRuleUrl, imageRuleUrl } = await getWebHookUrls({
                fileId: fileName,
                ruleName: ruleFolder,
                plugin: this.plugin,
                device: cameraDevice,
              });
              const { fileId } = this.plugin.getRulePaths({
                cameraId: cameraFolder,
                ruleName: ruleFolder,
                triggerTime: timestamp,
              });

              videoClips.push({
                id: fileName,
                startTime: timestamp,
                duration: 30000,
                event: "motion",
                description: ADVANCED_NOTIFIER_INTERFACE,
                thumbnailId: fileId,
                videoId: fileId,
                detectionClasses: ["motion"],
                resources: {
                  thumbnail: {
                    href: imageRuleUrl,
                  },
                  video: {
                    href: videoRuleUrl,
                  },
                },
              });
            }
          }
        }
      }
    } catch (e) {
      logger.error(
        `Error fetching videoclips for camera ${cameraDevice.name}`,
        e,
      );
    }

    const { recordedEventsPath } = this.plugin.getRecordedEventPath({
      cameraId: cameraFolder,
    });

    try {
      const files = await cachedReaddir(recordedEventsPath);

      for (const file of files) {
        try {
          const [fileName, extension] = file.split(".");
          if (extension === "mp4") {
            const {
              startTime,
              endTime,
              detectionClasses,
              eventName,
              duration,
            } = parseVideoFileName(fileName);

            if (startTime > options.startTime && endTime < options.endTime) {
              const { recordedClipVideoPath, recordedClipThumbnailPath } =
                await getWebHookUrls({
                  fileId: fileName,
                  plugin: this.plugin,
                  device: cameraDevice,
                });
              const { fileId } = this.plugin.getRecordedEventPath({
                cameraId: cameraFolder,
                fileName,
              });

              videoClips.push({
                id: fileName,
                startTime,
                duration,
                event: eventName,
                description: ADVANCED_NOTIFIER_INTERFACE,
                thumbnailId: fileId,
                videoId: fileId,
                detectionClasses,
                resources: {
                  thumbnail: {
                    href: recordedClipThumbnailPath,
                  },
                  video: {
                    href: recordedClipVideoPath,
                  },
                },
              });
            }
          }
        } catch { }
      }
    } catch (e) {
      logger.error(
        `Error fetching videoclips for camera ${cameraDevice.name}`,
        e,
      );
    }

    const result = sortBy(videoClips, "startTime");

    logger.info(
      `Fetched ${result.length} videoclips: ${JSON.stringify({ options, videoClips })}`,
    );
    return result;
  }

  async getVideoClip(videoId: string): Promise<MediaObject> {
    const logger = this.getLogger();

    try {
      const { videoUrl } = await this.plugin.decodeFileId({ fileId: videoId });

      let videoclipMo: MediaObject;

      if (videoUrl) {
        logger.info("Fetching videoclip ", videoId, getUrlLog(videoUrl));

        videoclipMo = await sdk.mediaManager.createMediaObject(
          Buffer.from(videoUrl),
          ScryptedMimeTypes.LocalUrl,
          {
            sourceId: this.plugin.id,
          },
        );

        if (videoclipMo) {
          return videoclipMo;
        }
      }
    } catch {
      return this.mixinDevice.getVideoClip(videoId);
    }

    return this.mixinDevice.getVideoClip(videoId);
  }

  async getVideoClipThumbnail(
    thumbnailId: string,
    options?: VideoClipThumbnailOptions,
  ): Promise<MediaObject> {
    const logger = this.getLogger();

    try {
      const { imageUrl } = await this.plugin.decodeFileId({
        fileId: thumbnailId,
      });

      let thumbnailMo: MediaObject;

      if (imageUrl) {
        logger.info("Fetching thumbnail ", thumbnailId, getUrlLog(imageUrl));

        const imageBuf = await fs.promises.readFile(imageUrl);
        thumbnailMo = await sdk.mediaManager.createMediaObject(
          imageBuf,
          "image/jpeg",
        );
      }

      if (thumbnailMo) {
        return thumbnailMo;
      }
    } catch {
      return this.mixinDevice.getVideoClipThumbnail(thumbnailId, options);
    }

    return this.mixinDevice.getVideoClipThumbnail(thumbnailId, options);
  }

  removeVideoClips(...videoClipIds: string[]): Promise<void> {
    return this.mixinDevice.removeVideoClips(...videoClipIds);
  }

  ensureMixinsOrder() {
    const logger = this.getLogger();
    const nvrObjectDetector = systemManager.getDeviceById(
      "@scrypted/nvr",
      "detection",
    )?.id;
    const basicObjectDetector = systemManager.getDeviceById(
      "@apocaliss92/scrypted-basic-object-detector",
    )?.id;
    const frigateObjectDetector = systemManager.getDeviceById(
      FRIGATE_BRIDGE_PLUGIN_ID,
      objectDetectorNativeId,
    )?.id;
    const frigateAudioDetector = systemManager.getDeviceById(
      FRIGATE_BRIDGE_PLUGIN_ID,
      audioDetectorNativeId,
    )?.id;
    const nvrId = systemManager.getDeviceById("@scrypted/nvr")?.id;
    let shouldBeMoved = false;
    const thisMixinOrder = this.mixins.indexOf(this.plugin.id);

    const frigateObjectDetectorMixinOrder = this.mixins.indexOf(
      frigateObjectDetector,
    );
    const nvrObjectDetectorMixinOrder = nvrObjectDetector
      ? this.mixins.indexOf(nvrObjectDetector)
      : -1;
    this.hasFrigateObjectDetectorMixin = frigateObjectDetectorMixinOrder >= 0;
    this.hasNvr = nvrObjectDetectorMixinOrder >= 0;

    if (
      nvrObjectDetector &&
      this.mixins.indexOf(nvrObjectDetector) > thisMixinOrder
    ) {
      shouldBeMoved = true;
    }
    if (
      basicObjectDetector &&
      this.mixins.indexOf(basicObjectDetector) > thisMixinOrder
    ) {
      shouldBeMoved = true;
    }
    if (
      frigateObjectDetector &&
      frigateObjectDetectorMixinOrder > thisMixinOrder
    ) {
      shouldBeMoved = true;
    }
    if (
      frigateAudioDetector &&
      this.mixins.indexOf(frigateAudioDetector) > thisMixinOrder
    ) {
      shouldBeMoved = true;
    }
    if (nvrId && this.mixins.indexOf(nvrId) > thisMixinOrder) {
      shouldBeMoved = true;
    }

    if (shouldBeMoved) {
      logger.log(
        "This plugin needs object detection and NVR plugins to come before, fixing",
      );
      setTimeout(() => {
        const currentMixins = this.mixins.filter(
          (mixin) => mixin !== this.plugin.id,
        );
        currentMixins.push(this.plugin.id);
        this.cameraDevice.setMixins(currentMixins);
      }, 1000);
    }
  }

  async getMqttClient() {
    if (!this.mixinState.mqttClient && !this.mixinState.initializingMqtt) {
      const {
        mqttEnabled,
        useMqttPluginCredentials,
        pluginEnabled,
        mqttHost,
        mqttUsename,
        mqttPassword,
      } = this.plugin.storageSettings.values;
      if (mqttEnabled && pluginEnabled) {
        this.mixinState.initializingMqtt = true;
        const logger = this.getLogger();

        try {
          this.mixinState.mqttClient = await getMqttBasicClient({
            logger,
            useMqttPluginCredentials,
            mqttHost,
            mqttUsename,
            mqttPassword,
            clientId: this.mixinState.clientId,
            cache: this.plugin.storageSettings.values.mqttMemoryCacheEnabled,
            configTopicPattern: `homeassistant/+/${idPrefix}-${this.id}/+/config`,
          });
          await this.mixinState.mqttClient?.getMqttClient();
        } catch (e) {
          logger.error("Error setting up MQTT client", e);
        } finally {
          this.mixinState.initializingMqtt = false;
        }
      }
    }

    return this.mixinState.mqttClient;
  }

  public async startStop(enabled: boolean, reason: string) {
    const logger = this.getLogger();
    if (enabled) {
      await this.startCheckInterval();
      this.ensureMixinsOrder();
    } else {
      logger.log(`Stopping mixin for reason ${reason}`);
      await this.release();
    }
  }

  async toggleRecording(device: Settings, enabled: boolean) {
    if (enabled && !this.cameraDevice.interfaces?.includes(ScryptedInterface.VideoRecorder)) {
      return;
    }
    await device.putSetting(`recording:privacyMode`, !enabled);
  }

  async toggleSnapshotsEnabled(device: Settings, enabled: boolean) {
    await device.putSetting(`snapshot:privacyMode`, !enabled);
  }

  async toggleRebroadcastEnabled(device: Settings, enabled: boolean) {
    await device.putSetting(`prebuffer:privacyMode`, !enabled);
  }

  get decoderType() {
    const { enableDecoder } = this.plugin.storageSettings.values;
    const { decoderType: decoderTypeParent } =
      this.mixinState.storageSettings.values;
    let decoderType = decoderTypeParent;

    if (!decoderType) {
      decoderType = DecoderType.Auto;
    }

    let finalType: DecoderType;

    if (!enableDecoder || decoderType === DecoderType.Off) {
      finalType = DecoderType.Off;
    }

    if ([DecoderType.Always, DecoderType.OnMotion].includes(decoderType)) {
      finalType = decoderType;
    }

    if (decoderType === DecoderType.Auto) {
      if (this.cameraDevice.interfaces.includes(ScryptedInterface.Battery)) {
        finalType = DecoderType.OnMotion;
      }

      const hasRunningTimelapseRules =
        !!this.mixinState.runningTimelapseRules.length;
      const hasRunningOccupancyRules =
        !!this.mixinState.runningOccupancyRules.length;
      const hasVideoclipRules = [
        ...this.mixinState.runningDetectionRules,
        ...this.mixinState.runningOccupancyRules,
      ].some((rule) => rule?.generateClip);

      if (hasRunningTimelapseRules || hasVideoclipRules) {
        finalType = DecoderType.Always;
      } else if (hasRunningOccupancyRules) {
        finalType = DecoderType.OnMotion;
      } else {
        finalType = DecoderType.Off;
      }
    }

    if (!this.mixinState.decoderEnablementLogged) {
      this.getLogger().log(
        `Decoder settings: ${JSON.stringify({
          enabledOnPlugin: enableDecoder,
          typeOnCamera: decoderTypeParent,
          inputType: decoderType,
          typeToUse: finalType,
        })}`,
      );

      this.mixinState.decoderEnablementLogged = true;
    }

    return finalType;
  }

  async startCheckInterval() {
    const logger = this.getLogger();

    const funct = async () => {
      if (this.mainLoopRunning) {
        return;
      }
      this.mainLoopRunning = true;
      try {
        const { enabledToMqtt } = this.mixinState.storageSettings.values;
        if (enabledToMqtt) {
          await this.getMqttClient();
        }

        const {
          allAllowedRules,
          allAvailableRules,
          allowedAudioRules,
          allowedDetectionRules,
          allowedOccupancyRules,
          allowedRecordingRules,
          allowedTimelapseRules,
          allowedPatrolRules,
          availableTimelapseRules,
          shouldListenDetections: shouldListenDetectionsParent,
          isActiveForMqttReporting,
          anyAllowedNvrDetectionRule,
          shouldListenDoorbell: shouldListenDoorbellFromRules,
          shouldListenAudio,
          shouldCheckAudioDetections,
          shouldClassifyAudio,
          enabledAudioLabels,
        } = await getActiveRules({
          device: this.cameraDevice,
          console: logger,
          plugin: this.plugin,
          deviceStorage: this.mixinState.storageSettings,
        });
        const shouldListenDoorbell =
          shouldListenDoorbellFromRules ||
          this.cameraDevice.type === ScryptedDeviceType.Doorbell;
        const shouldListenDetections =
          shouldListenDetectionsParent ||
          shouldCheckAudioDetections ||
          this.plugin.storageSettings.values.storeEvents;

        const currentlyRunningRules = [
          ...this.mixinState.runningDetectionRules,
          ...this.mixinState.runningAudioRules,
          ...this.mixinState.runningOccupancyRules,
          ...this.mixinState.runningTimelapseRules,
          ...this.mixinState.runningRecordingRules,
          ...this.mixinState.runningPatrolRules,
        ];

        const [rulesToEnable, rulesToDisable] = splitRules({
          allRules: allAvailableRules,
          currentlyRunningRules: currentlyRunningRules,
          rulesToActivate: allAllowedRules,
          device: this.cameraDevice,
        });

        const now = Date.now();
        logger.debug(
          `Detected rules: ${JSON.stringify({
            rulesToEnable,
            rulesToDisable,
            allAvailableRules,
            currentlyRunningRules,
            allAllowedRules,
          })}`,
        );

        for (const rule of rulesToEnable) {
          const { ruleType, name } = rule;
          logger.log(`${ruleType} rule started: ${name}`);

          if (!rule.currentlyActive) {
            if (ruleType === RuleType.Timelapse) {
              await this.plugin.clearTimelapseFrames({
                rule,
                device: this.cameraDevice,
                logger,
              });
            }

            const {
              common: { currentlyActiveKey },
            } = getRuleKeys({ ruleName: name, ruleType });
            await this.putMixinSetting(currentlyActiveKey, "true");

            this.plugin
              .triggerRuleSequences({
                sequences: rule.onActivationSequences,
                postFix: "activate",
                rule,
                deviceId: this.cameraDevice.id,
              })
              .catch(logger.error);
          }
        }

        for (const rule of rulesToDisable) {
          const { ruleType, name } = rule;
          logger.log(`${ruleType} rule stopped: ${name}`);

          if (rule.currentlyActive) {
            if (ruleType === RuleType.Timelapse) {
              const {
                timelapse: { lastGeneratedKey },
              } = getRuleKeys({
                ruleType,
                ruleName: rule.name,
              });
              const now = Date.now();
              const lastGeneratedBkp =
                this.mixinState.timelapseLastGenerated[rule.name];
              let lastGenerated = (rule as TimelapseRule).lastGenerated;

              if (
                !lastGenerated ||
                (lastGeneratedBkp && lastGeneratedBkp > lastGenerated)
              ) {
                lastGenerated = lastGeneratedBkp;
              }
              const isTimePassed =
                !lastGenerated || now - lastGenerated >= 1000 * 60 * 60 * 1;
              if (isTimePassed) {
                await this.mixinState.storageSettings.putSetting(
                  lastGeneratedKey,
                  now,
                );
                this.mixinState.timelapseLastGenerated[rule.name] = now;

                this.plugin.queueTimelapseGeneration({
                  rule,
                  device: this.cameraDevice,
                  logger,
                });
              }
            }

            const {
              common: { currentlyActiveKey },
            } = getRuleKeys({ ruleName: name, ruleType });
            await this.putMixinSetting(currentlyActiveKey, "false");

            this.plugin
              .triggerRuleSequences({
                sequences: rule.onDeactivationSequences,
                postFix: "deactivate",
                rule,
                deviceId: this.cameraDevice.id,
              })
              .catch(logger.error);
          }
        }

        this.mixinState.runningDetectionRules = cloneDeep(
          allowedDetectionRules || [],
        );
        this.mixinState.runningOccupancyRules = cloneDeep(
          allowedOccupancyRules || [],
        );
        this.mixinState.runningTimelapseRules = cloneDeep(
          allowedTimelapseRules || [],
        );
        this.mixinState.runningRecordingRules = cloneDeep(
          allowedRecordingRules || [],
        );
        this.mixinState.runningAudioRules = cloneDeep(allowedAudioRules || []);
        this.mixinState.runningPatrolRules = cloneDeep(
          allowedPatrolRules || [],
        );
        this.mixinState.availableTimelapseRules = cloneDeep(
          availableTimelapseRules || [],
        );
        this.mixinState.allAvailableRules = cloneDeep(allAvailableRules || []);

        this.isActiveForMqttReporting = isActiveForMqttReporting;

        await this.ensurePatrolRunning();

        const isDetectionListenerRunning =
          !!this.detectionListener || !!this.motionListener;

        const { notificationsEnabled } = this.mixinState.storageSettings.values;
        const decoderType = this.decoderType;

        // Cleanup decoder frames
        if (decoderType && decoderType !== DecoderType.Off) {
          const maxPrePostSeconds = Math.max(
            0,
            ...currentlyRunningRules
              .filter((r) => !!r?.generateClip)
              .map(
                (r) =>
                  Number(r.generateClipPreSeconds ?? 0) +
                  Number(r.generateClipPostSeconds ?? 0),
              ),
          );
          const defaultDecoderFramesRetentionMs = 1000 * 60 * 2;
          const computedRetentionMs = Math.ceil(maxPrePostSeconds * 1.5) * 1000;
          const decoderFramesRetentionMs =
            computedRetentionMs > 0
              ? computedRetentionMs
              : defaultDecoderFramesRetentionMs;
          const framesThreshold = now - decoderFramesRetentionMs;

          // Cleanup interval is decoupled from retention to avoid running filesystem scans too frequently
          // when rules generate very short clips.
          const cleanupIntervalMs = Math.max(
            30_000,
            Math.min(120_000, decoderFramesRetentionMs * 5),
          );
          if (
            !this.mixinState.lastDecoderFramesCleanup ||
            this.mixinState.lastDecoderFramesCleanup < now - cleanupIntervalMs
          ) {
            this.mixinState.lastDecoderFramesCleanup = now;
            this.plugin
              .clearDecoderFrames({
                device: this.cameraDevice,
                logger,
                framesThreshold,
              })
              .catch(logger.log);
          }
        }

        // Cleanup FS every 10 minutes
        if (
          !this.mixinState.lastFsCleanup ||
          this.mixinState.lastFsCleanup < now - 1000 * 60 * 10
        ) {
          this.mixinState.lastFsCleanup = now;
          this.plugin
            .clearVideoclipsData({
              device: this.cameraDevice,
              logger,
            })
            .catch(logger.log);
        }

        // MQTT report
        if (isActiveForMqttReporting) {
          const { occupancySourceForMqtt } =
            this.mixinState.storageSettings.values;
          const mqttClient = await this.getMqttClient();
          if (mqttClient) {
            const lastGlobal = this.plugin.lastCameraAutodiscoveryMap[this.id];
            if (!lastGlobal || now - lastGlobal > 1000 * 60 * 60) {
              this.plugin.enqueueCameraAutodiscovery(this.id, async () => {
                const zones = await this.getMqttZones();
                logger.log("Starting MQTT autodiscovery (queued)");
                const initialCameraState = await this.getCameraMqttCurrentState();
                await setupCameraAutodiscovery({
                  mqttClient,
                  device: this.cameraDevice,
                  console: logger,
                  rules: allAvailableRules,
                  zones,
                  accessorySwitchKinds: this.cameraAccessorySwitchKinds,
                  initialCameraState,
                });

                logger.debug(`Subscribing to mqtt topics`);
                await subscribeToCameraMqttTopics({
                  mqttClient,
                  rules: allAvailableRules,
                  device: this.cameraDevice,
                  console: logger,
                  accessorySwitchKinds: this.cameraAccessorySwitchKinds,
                  accessorySwitchCb: async ({ kind, active }) => {
                    const accessoryDevice =
                      this.cameraAccessorySwitchDevices[kind];
                    if (!accessoryDevice) {
                      logger.warn(
                        `Accessory switch command received but device missing: ${kind}`,
                      );
                      return;
                    }
                    if (active) {
                      await accessoryDevice.turnOn();
                    } else {
                      await accessoryDevice.turnOff();
                    }
                  },
                  activationRuleCb: async ({ active, ruleName, ruleType }) => {
                    const {
                      common: { enabledKey },
                    } = getRuleKeys({ ruleName, ruleType });
                    logger.log(
                      `Setting ${ruleType} rule ${ruleName} to ${active}`,
                    );
                    await this.mixinState.storageSettings.putSetting(
                      `${enabledKey}`,
                      active,
                    );
                  },
                  switchNotificationsEnabledCb: async (active) => {
                    logger.log(`Setting notifications active to ${active}`);
                    await this.mixinState.storageSettings.putSetting(
                      `notificationsEnabled`,
                      active,
                    );
                  },
                  switchRecordingCb: this.cameraDevice.interfaces.includes(
                    ScryptedInterface.VideoRecorder,
                  )
                    ? async (active) => {
                      logger.log(`Setting NVR privacy mode to ${!active}`);
                      await this.toggleRecording(this.cameraDevice, active);
                    }
                    : undefined,
                  switchRebroadcastCb: async (active) => {
                    logger.log(
                      `Setting Rebroadcast privacy mode to ${!active}`,
                    );
                    await this.toggleRebroadcastEnabled(
                      this.cameraDevice,
                      active,
                    );
                  },
                  switchSnapshotsCb: async (active) => {
                    logger.log(`Setting Snapshots privacy mode to ${!active}`);
                    await this.toggleSnapshotsEnabled(
                      this.cameraDevice,
                      active,
                    );
                  },
                  rebootCb: this.cameraDevice.interfaces.includes(
                    ScryptedInterface.Reboot,
                  )
                    ? async () => {
                      logger.log(`Rebooting camera`);
                      await this.cameraDevice.reboot();
                    }
                    : undefined,
                  ptzCommandCb: this.cameraDevice.interfaces.includes(
                    ScryptedInterface.PanTiltZoom,
                  )
                    ? async (ptzCommand: PanTiltZoomCommand) => {
                      logger.log(
                        `Executing ptz command: ${JSON.stringify(ptzCommand)}`,
                      );
                      if (ptzCommand.preset) {
                        const presetId = Object.entries(
                          this.cameraDevice.ptzCapabilities?.presets ?? {},
                        ).find(
                          ([id, name]) => name === ptzCommand.preset,
                        )?.[0];
                        if (presetId) {
                          await this.cameraDevice.ptzCommand({
                            preset: presetId,
                          });
                        }
                      } else {
                        await this.cameraDevice.ptzCommand(ptzCommand);
                      }
                    }
                    : undefined,
                });
                this.ensureMixinsOrder();
                await this.refreshSettings();

                logger.log("MQTT autodiscovery completed");
              });
            }

            if (this.plugin.storageSettings.values.mqttEnabled) {
              const cameraState = await this.getCameraMqttCurrentState();
              publishCameraValues({
                ...cameraState,
                console: logger,
                device: this.cameraDevice,
                mqttClient,
                rulesToEnable,
                rulesToDisable,
              }).catch(logger.error);
            }
          }
        }

        if (isDetectionListenerRunning && !shouldListenDetections) {
          logger.log("Stopping and cleaning Object listeners.");
          this.resetListeners();
        } else if (!isDetectionListenerRunning && shouldListenDetections) {
          logger.log(
            `Starting detection listeners: ${JSON.stringify({
              Detections: shouldListenDetections,
              AudioDetections: shouldCheckAudioDetections,
              MQTT: isActiveForMqttReporting,
              Doorbell: shouldListenDoorbell,
              NotificationRules: allAllowedRules.length
                ? allAllowedRules.map((rule) => rule.name).join(", ")
                : "None",
            })}`,
          );
          await this.startObjectDetectionListeners();
        }

        if (shouldListenDoorbell && !this.isActiveForDoorbelDetections) {
          logger.log(`Starting Doorbell listener`);
          await this.startDoorbellListener();
        } else if (!shouldListenDoorbell && this.isActiveForDoorbelDetections) {
          logger.log(`Stopping Doorbell listener`);
          await this.stopDoorbellListener();
        }
        this.isActiveForDoorbelDetections = shouldListenDoorbell;

        // Audio analyzer should start if classification is needed
        let shouldStartAudioAnalyzer = shouldClassifyAudio;
        let shouldListenToVolumeControls = false;
        if (!shouldStartAudioAnalyzer && shouldListenAudio) {
          // It should also start if Frigate audio is not enabled
          if (
            this.interfaces.includes(ScryptedInterface.AudioVolumeControl) &&
            !!this.audioVolumes?.dBFS
          ) {
            shouldListenToVolumeControls = true;
          } else {
            shouldStartAudioAnalyzer = true;
          }
        }

        this.shouldClassifyAudio = shouldClassifyAudio;
        this.audioClassificationLabels = enabledAudioLabels;

        if (shouldStartAudioAnalyzer && !this.isActiveForAudioAnalysis) {
          logger.log(
            `Starting audio analyzer: ${JSON.stringify({
              shouldStartAudioAnalyzer,
              shouldClassifyAudio,
              enabledAudioLabels,
            })}`,
          );
          await this.startAudioAnalyzer();
        } else if (!shouldStartAudioAnalyzer && this.isActiveForAudioAnalysis) {
          logger.log(`Stopping audio analyzer`);
          await this.stopAudioAnalysis();
        }
        this.isActiveForAudioAnalysis = shouldStartAudioAnalyzer;

        if (
          shouldListenToVolumeControls &&
          !this.isActiveForAudioVolumeControls
        ) {
          logger.log(`Starting Audio Volume Controls listener`);
          await this.startAudioVolumeControlsListener();
        } else if (
          !shouldListenToVolumeControls &&
          this.isActiveForAudioVolumeControls
        ) {
          logger.log(`Stopping Audio Volume Controls listener`);
          await this.stopAudioVolumeControlsListener();
        }
        this.isActiveForAudioVolumeControls = shouldListenToVolumeControls;

        if (anyAllowedNvrDetectionRule && !this.isActiveForNvrNotifications) {
          logger.log(`Starting NVR events listener`);
        } else if (
          !anyAllowedNvrDetectionRule &&
          this.isActiveForNvrNotifications
        ) {
          logger.log(`Stopping NVR events listener`);
        }
        this.isActiveForNvrNotifications = anyAllowedNvrDetectionRule;

        if (
          decoderType === DecoderType.Always &&
          this.framesGeneratorSignal.finished
        ) {
          this.startDecoder("Permanent").catch(logger.error);
        } else if (
          decoderType === DecoderType.Off &&
          !this.framesGeneratorSignal.finished
        ) {
          this.stopDecoder("EndClipRules");
        }

        // Restart decoder every 1 minute
        if (
          decoderType === DecoderType.Always &&
          this.frameGenerationStartTime &&
          now - this.frameGenerationStartTime >= 1000 * 60 * 1
        ) {
          logger.log(`Restarting decoder`);
          this.stopDecoder("Restart");
        }

        if (!this.processDetectionsInterval) {
          logger.log("Starting processing of accumulated detections");
          this.startAccumulatedDetectionsInterval().catch(logger.error);
        }

        await this.checkOutdatedRules();
      } catch (e) {
        logger.log("Error in startCheckInterval funct", e);
      } finally {
        this.mainLoopRunning = false;
      }
    };

    this.mainLoopListener && clearInterval(this.mainLoopListener);
    this.mainLoopListener = setInterval(async () => {
      try {
        if (this.killed) {
          logger.log(`Mixin killed`);
          await this.release();
        } else {
          await funct();
        }
      } catch (e) {
        logger.log("Error in mainLoopListener", e);
      }
    }, 1000 * 2);
  }

  private stopPatrol(reason: string) {
    const logger = this.getLogger();
    if (this.patrolAbort && !this.patrolAbort.signal.aborted) {
      logger.log(`Stopping patrol: ${reason}`);
      this.patrolAbort.abort();
    }
    this.patrolAbort = undefined;
    this.patrolTask = undefined;
    this.patrolSignature = undefined;

    if (this.mixinState?.patrolState) {
      this.mixinState.patrolState = {
        active: false,
      };
    }
  }

  private async ensurePatrolRunning() {
    const logger = this.getLogger();
    const rule = this.mixinState.runningPatrolRules?.[0];

    if (!rule) {
      this.stopPatrol("No active patrol rules");
      return;
    }

    if (!this.cameraDevice.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
      this.stopPatrol("Camera does not support PTZ");
      return;
    }

    const signature = JSON.stringify({
      name: rule.name,
      presets: rule.presets,
      min: rule.minPresetSeconds,
      max: rule.maxPresetSeconds,
      blocks: rule.blockingDetectionClasses,
    });

    const isRunning =
      !!this.patrolTask &&
      !!this.patrolAbort &&
      !this.patrolAbort.signal.aborted;
    if (isRunning && this.patrolSignature === signature) {
      return;
    }

    if (isRunning) {
      this.stopPatrol("Patrol config changed");
    }

    this.patrolSignature = signature;
    this.patrolAbort = new AbortController();

    if (!this.mixinState.patrolState) {
      this.mixinState.patrolState = { active: false };
    }

    logger.log(`Starting patrol rule: ${rule.name}`);
    this.patrolTask = this.patrolLoop(rule, this.patrolAbort.signal).catch(
      (e) => {
        logger.log("Error in patrol loop", e);
        this.stopPatrol("Patrol loop crashed");
      },
    );
  }

  private async patrolLoop(rule: PatrolRule, signal: AbortSignal) {
    const logger = this.getLogger();

    const presets = (rule.presets || []).filter(Boolean);
    if (!presets.length) {
      logger.log(`Patrol ${rule.name}: no presets configured`);
      return;
    }

    const minMs = Math.max(1, (rule.minPresetSeconds ?? 10) * 1000);
    const maxMs = Math.max(minMs, (rule.maxPresetSeconds ?? 30) * 1000);

    let idx = 0;
    while (!signal.aborted) {
      const presetName = presets[idx % presets.length];
      idx++;

      await this.gotoPresetByName(presetName);

      const enteredAt = Date.now();
      this.mixinState.patrolState = {
        active: true,
        ruleName: rule.name,
        presetName,
        enteredAt,
        blocked: false,
      };

      await this.sleepWithAbort(minMs, signal);
      if (signal.aborted) {
        break;
      }

      const shouldHoldToMax = !!this.mixinState.patrolState?.blocked;
      if (shouldHoldToMax) {
        const elapsed = Date.now() - enteredAt;
        const remaining = maxMs - elapsed;
        if (remaining > 0) {
          await this.sleepWithAbort(remaining, signal);
        }
      }
    }
  }

  private async gotoPresetByName(presetName: string) {
    const logger = this.getLogger();
    if (!presetName) {
      return;
    }

    const presetsMap = this.cameraDevice.ptzCapabilities?.presets ?? {};
    const presetId = Object.entries(presetsMap).find(
      ([, name]) => name === presetName,
    )?.[0];
    if (!presetId) {
      logger.log(`Patrol: preset not found: ${presetName}`);
      return;
    }

    logger.log(`Patrol: moving to preset '${presetName}' (${presetId})`);
    await this.cameraDevice.ptzCommand({ preset: presetId });
  }

  private async sleepWithAbort(ms: number, signal: AbortSignal) {
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      signal.addEventListener("abort", onAbort);
    });
  }

  private processPatrolBlockingDetections(candidates: ObjectDetectionResult[]) {
    if (!this.patrolAbort || this.patrolAbort.signal.aborted) {
      return;
    }

    const rule = this.mixinState.runningPatrolRules?.[0];
    const state = this.mixinState.patrolState;
    if (!rule || !state?.active) {
      return;
    }

    const classesDetected = candidates
      .map((c) => detectionClassesDefaultMap[c.className])
      .filter(Boolean) as DetectionClass[];

    if (!classesDetected.length) {
      return;
    }

    const blocking = rule.blockingDetectionClasses || [];
    const isBlockingMatch = classesDetected.some((dc) => blocking.includes(dc));

    if (isBlockingMatch) {
      this.mixinState.patrolState = {
        ...state,
        blocked: true,
        lastBlockTime: Date.now(),
      };
    }
  }

  async initDecoderStream() {
    if (this.mixinState.decoderStream) {
      return;
    }

    const logger = this.getLogger();

    const { decoderStreamDestination } = this.mixinState.storageSettings.values;
    if (decoderStreamDestination !== "Default") {
      this.mixinState.decoderStream = decoderStreamDestination;
      this.mixinState.decoderResize = false;
    } else {
      const streams = await this.cameraDevice.getVideoStreamOptions();
      let closestStream: ResponseMediaStreamOptions;
      for (const stream of streams) {
        logger.info(
          `Stream ${stream.name} ${JSON.stringify(stream.video)} ${stream.destinations}`,
        );
        const streamWidth = stream.video?.width;

        if (streamWidth) {
          const diff = SNAPSHOT_WIDTH - streamWidth;
          if (
            !closestStream ||
            diff < Math.abs(SNAPSHOT_WIDTH - closestStream.video.width)
          ) {
            closestStream = stream;
          }
        }
      }

      const closestDestination = closestStream?.destinations?.[0];
      if (closestDestination) {
        this.mixinState.decoderStream = closestStream.destinations[0];
        this.mixinState.decoderResize =
          (closestStream.video.width ?? 0) - SNAPSHOT_WIDTH > 200;
        const streamName = closestStream?.name;
        const rebroadcastConfig = this.streams.find(
          (setting) => setting.subgroup === `Stream: ${streamName}`,
        );
        this.mixinState.rtspUrl = rebroadcastConfig?.value as string;
        logger.log(
          `Stream found ${this.mixinState.decoderStream} (${getUrlLog(this.mixinState.rtspUrl)}), requires resize ${this.mixinState.decoderResize}`,
        );
        logger.info(`${JSON.stringify(closestStream)}`);
      } else {
        logger.log(`Stream not found, falling back to remote-recorder`);
        this.mixinState.decoderStream = "remote-recorder";
        this.mixinState.decoderResize = false;
      }
    }
  }

  async startDecoder(reason: "Permanent" | "StartMotion") {
    await this.initDecoderStream();

    const logger = this.getLogger();

    if (!this.framesGeneratorSignal || this.framesGeneratorSignal.finished) {
      logger.log(`Starting decoder (${reason})`);
      this.frameGenerationStartTime = Date.now();
      this.framesGeneratorSignal = new Deferred();

      const exec = async (frame: VideoFrame) => {
        if (
          this.decoderType !== DecoderType.Off &&
          this.isDelayPassed({
            type: DelayType.DecoderFrameOnStorage,
            eventSource: ScryptedEventSource.RawDetection,
            timestamp: frame.timestamp,
          })?.timePassed
        ) {
          const now = Date.now();

          const convertedImage =
            await sdk.mediaManager.convertMediaObject<Image>(
              frame.image,
              ScryptedMimeTypes.Image,
            );
          const image = await convertedImage.toImage({
            format: "jpeg",
          });

          this.mixinState.lastFrame = await image.toBuffer({
            format: "jpg",
          });
          this.mixinState.lastFrameAcquired = now;

          this.plugin
            .storeDecoderFrame({
              device: this.cameraDevice,
              imageBuffer: this.mixinState.lastFrame,
              timestamp: frame.timestamp,
            })
            .catch(logger.log);
        }
      };

      try {
        for await (const frame of await sdk.connectRPCObject(
          await this.createFrameGenerator(),
        )) {
          if (this.framesGeneratorSignal.finished) {
            break;
          }
          await exec(frame);
        }
      } catch (e) {
        try {
          for await (const frame of await sdk.connectRPCObject(
            await this.createFrameGenerator(true),
          )) {
            if (this.framesGeneratorSignal.finished) {
              break;
            }
            await exec(frame);
          }
        } catch (e) {
          logger.log("Decoder starting failed", e);
        }
      }
    } else {
      logger.info("Streams generator not yet released");
    }
  }

  stopDecoder(reason: "Restart" | "EndMotion" | "EndClipRules" | "Release") {
    const logger = this.getLogger();
    if (!this.framesGeneratorSignal?.finished) {
      logger.log(`Stopping decoder (${reason})`);
      this.frameGenerationStartTime = undefined;
      this.framesGeneratorSignal.resolve();
    }
  }

  async startAccumulatedDetectionsInterval() {
    const logger = this.getLogger();
    this.stopAccumulatedDetectionsInterval();
    this.processDetectionsInterval = setInterval(async () => {
      try {
        if (this.killed) {
          this.stopAccumulatedDetectionsInterval();
        } else if (!this.processingAccumulatedDetections) {
          this.processingAccumulatedDetections = true;

          try {
            await this.processAccumulatedDetections();
          } catch (e) {
            logger.log(`Error in startAccumulatedDetectionsInterval`, e);
          } finally {
            this.processingAccumulatedDetections = false;
          }
        }
      } catch (e) {
        logger.log("Error in processDetectionsInterval", e);
      }
    }, 500);
  }

  resetAudioRule(ruleName: string) {
    this.mixinState.audioRuleSamples[ruleName] = undefined;
    this.mixinState.audioRuleSamples[ruleName] = [];
  }

  stopAccumulatedDetectionsInterval() {
    this.processDetectionsInterval &&
      clearInterval(this.processDetectionsInterval);
    this.processDetectionsInterval = undefined;
  }

  async stopDoorbellListener() {
    this.binaryListener?.removeListener && this.binaryListener.removeListener();
    this.binaryListener = undefined;
  }

  async stopAudioVolumeControlsListener() {
    this.audioVolumesListener?.removeListener &&
      this.audioVolumesListener.removeListener();
    this.audioVolumesListener = undefined;
  }

  resetListeners() {
    const logger = this.getLogger();
    if (
      this.detectionListener ||
      this.motionListener ||
      this.binaryListener ||
      this.audioVolumesListener
    ) {
      logger.log("Resetting listeners.");
    }

    this.detectionListener?.removeListener &&
      this.detectionListener.removeListener();
    this.detectionListener = undefined;
    this.motionListener?.removeListener && this.motionListener.removeListener();
    this.motionListener = undefined;
    this.stopDoorbellListener();
    this.stopAudioAnalysis();
    this.stopRecording();
    this.resetMqttMotionTimeout();

    Object.keys(this.mixinState.detectionRuleListeners).forEach((ruleName) => {
      const { disableNvrRecordingTimeout, turnOffTimeout } =
        this.mixinState.detectionRuleListeners[ruleName];
      disableNvrRecordingTimeout && clearTimeout(disableNvrRecordingTimeout);
      turnOffTimeout && clearTimeout(turnOffTimeout);
    });
  }

  async initValues() {
    const logger = this.getLogger();
    try {
      if (this.plugin.hasCloudPlugin) {
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } =
          await getWebHookUrls({
            cameraIdOrAction: this.id,
            console: logger,
            device: this.cameraDevice,
            plugin: this.plugin,
          });

        this.mixinState.storageSettings.values.lastSnapshotWebhookCloudUrl =
          lastSnapshotCloudUrl;
        this.mixinState.storageSettings.values.lastSnapshotWebhookLocalUrl =
          lastSnapshotLocalUrl;
      }

      const deviceSettings = await this.cameraDevice.getSettings();
      this.streams = deviceSettings.filter(
        (setting) => setting.title === "RTSP Rebroadcast Url",
      );

      const { rulesPath } = this.plugin.getRulePaths({
        cameraId: this.cameraDevice.id,
      });
      try {
        await fs.promises.access(rulesPath);
      } catch {
        await fs.promises.mkdir(rulesPath, { recursive: true });
      }
      const { decoderpath } = this.plugin.getFsPaths({
        cameraId: this.cameraDevice.id,
      });
      try {
        await fs.promises.access(decoderpath);
      } catch {
        await fs.promises.mkdir(decoderpath, { recursive: true });
      }
      const { eventsPath } = this.plugin.getEventPaths({
        cameraId: this.cameraDevice.id,
      });
      try {
        await fs.promises.access(eventsPath);
      } catch {
        await fs.promises.mkdir(eventsPath, { recursive: true });
      }
      const { recordedEventsPath } = this.plugin.getRecordedEventPath({
        cameraId: this.cameraDevice.id,
      });
      try {
        await fs.promises.access(recordedEventsPath);
      } catch {
        await fs.promises.mkdir(recordedEventsPath, { recursive: true });
      }
    } catch { }

    await this.refreshSettings();
    await this.refreshSettings();
  }

  async snoozeNotification(props: { snoozeId: string; snoozeTime: number }) {
    const { snoozeId, snoozeTime } = props;
    const logger = this.getLogger();

    const res = `Snoozing ${snoozeId} for ${snoozeTime} minutes`;
    logger.log(res);

    const snoozedUntil = moment().add(snoozeTime, "minutes").toDate().getTime();
    this.mixinState.snoozeUntilDic[snoozeId] = snoozedUntil;
    this.mixinState.storageSettings.values.snoozedData = JSON.stringify(
      this.mixinState.snoozeUntilDic,
    );

    return res;
  }

  async toggleRule(ruleName: string, ruleType: RuleType, enabled: boolean) {
    const logger = this.getLogger();
    const mqttClient = await this.getMqttClient();

    if (!mqttClient) {
      return;
    }

    const rule = this.mixinState.allAvailableRules.find(
      (rule) => rule.ruleType === ruleType && rule.name === ruleName,
    );

    logger.log(`Setting ${ruleType} rule ${ruleName} enabled to ${enabled}`);

    if (rule) {
      await publishRuleEnabled({
        console: logger,
        rule,
        device: this.cameraDevice,
        enabled,
        mqttClient,
      });
    }
  }

  async refreshSettings() {
    const logger = this.getLogger();
    const dynamicSettings: StorageSetting[] = [];

    const detectionRulesSettings = await getDetectionRulesSettings({
      storage: this.mixinState.storageSettings,
      device: this,
      logger,
      ruleSource: RuleSource.Device,
      refreshSettings: this.refreshSettings.bind(this),
      plugin: this.plugin,
    });
    dynamicSettings.push(...detectionRulesSettings);

    const occupancyRulesSettings = await getOccupancyRulesSettings({
      storage: this.mixinState.storageSettings,
      ruleSource: RuleSource.Device,
      logger,
      refreshSettings: this.refreshSettings.bind(this),
      onManualCheck: async (ruleName: string) =>
        await this.manualCheckOccupancyRule(ruleName),
      device: this,
      plugin: this.plugin,
    });
    dynamicSettings.push(...occupancyRulesSettings);

    const timelapseRulesSettings = await getTimelapseRulesSettings({
      storage: this.mixinState.storageSettings,
      ruleSource: RuleSource.Device,
      logger,
      device: this,
      plugin: this.plugin,
      refreshSettings: this.refreshSettings.bind(this),
      onCleanDataTimelapse: async (ruleName) => {
        const rule = this.mixinState.availableTimelapseRules?.find(
          (rule) => rule.name === ruleName,
        );

        if (rule) {
          this.plugin
            .clearTimelapseFrames({
              rule,
              device: this.cameraDevice,
              logger,
            })
            .catch(logger.log);
        }
      },
      onGenerateTimelapse: async (ruleName) => {
        const logger = this.getLogger();
        const rule = this.mixinState.availableTimelapseRules?.find(
          (rule) => rule.name === ruleName,
        );

        if (rule) {
          this.plugin.queueTimelapseGeneration({
            rule,
            device: this.cameraDevice,
            logger,
          });
        }
      },
    });
    dynamicSettings.push(...timelapseRulesSettings);

    const audioRulesSettings = await getAudioRulesSettings({
      storage: this.mixinState.storageSettings,
      ruleSource: RuleSource.Device,
      logger,
      device: this,
      plugin: this.plugin,
      refreshSettings: this.refreshSettings.bind(this),
    });
    dynamicSettings.push(...audioRulesSettings);

    const recordingRulesSettings = await getRecordingRulesSettings({
      storage: this.mixinState.storageSettings,
      ruleSource: RuleSource.Device,
      logger,
      refreshSettings: this.refreshSettings.bind(this),
      device: this,
      plugin: this.plugin,
    });
    dynamicSettings.push(...recordingRulesSettings);

    if (this.cameraDevice.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
      const patrolRulesSettings = await getPatrolRulesSettings({
        storage: this.mixinState.storageSettings,
        ruleSource: RuleSource.Device,
        logger,
        refreshSettings: this.refreshSettings.bind(this),
        device: this.cameraDevice,
        plugin: this.plugin,
      });
      dynamicSettings.push(...patrolRulesSettings);
    }

    this.mixinState.storageSettings = await convertSettingsToStorageSettings({
      device: this,
      dynamicSettings,
      initStorage: this.initStorage,
    });

    const {
      lastSnapshotWebhook,
      postDetectionImageWebhook,
      enabledToMqtt,
      schedulerEnabled,
      audioAnalyzerEnabled,
      audioClassifierSource,
      maxSpaceInGb,
    } = this.mixinState.storageSettings.values;

    if (this.mixinState.storageSettings.settings.lastSnapshotWebhookCloudUrl) {
      this.mixinState.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide =
        !lastSnapshotWebhook;
    }
    if (this.mixinState.storageSettings.settings.lastSnapshotWebhookLocalUrl) {
      this.mixinState.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide =
        !lastSnapshotWebhook;
    }

    if (this.mixinState.storageSettings.settings.postDetectionImageUrls) {
      this.mixinState.storageSettings.settings.postDetectionImageUrls.hide =
        !postDetectionImageWebhook;
    }
    if (this.mixinState.storageSettings.settings.postDetectionImageClasses) {
      this.mixinState.storageSettings.settings.postDetectionImageClasses.hide =
        !postDetectionImageWebhook;
    }
    if (this.mixinState.storageSettings.settings.postDetectionImageMinDelay) {
      this.mixinState.storageSettings.settings.postDetectionImageMinDelay.hide =
        !postDetectionImageWebhook;
    }

    if (this.mixinState.storageSettings.settings.startTime) {
      this.mixinState.storageSettings.settings.startTime.hide =
        !schedulerEnabled;
    }
    if (this.mixinState.storageSettings.settings.endTime) {
      this.mixinState.storageSettings.settings.endTime.hide = !schedulerEnabled;
    }
    if (this.mixinState.storageSettings.settings.detectionSourceForMqtt) {
      this.mixinState.storageSettings.settings.detectionSourceForMqtt.choices =
        [ScryptedEventSource.Default, ...this.plugin.enabledDetectionSources];
    }
    if (this.mixinState.storageSettings.settings.facesSourceForMqtt) {
      this.mixinState.storageSettings.settings.facesSourceForMqtt.choices = [
        ScryptedEventSource.Default,
        ...this.plugin.enabledDetectionSources,
      ];
    }
    if (this.mixinState.storageSettings.settings.zonesSourceForMqtt) {
      this.mixinState.storageSettings.settings.zonesSourceForMqtt.choices = [
        ScryptedEventSource.Default,
        ...this.plugin.enabledZonesSources,
      ];
    }
    if (this.mixinState.storageSettings.settings.occupancySourceForMqtt) {
      this.mixinState.storageSettings.settings.occupancySourceForMqtt.choices =
        [...this.plugin.enabledOccupancySources];
      this.mixinState.storageSettings.settings.occupancySourceForMqtt.defaultValue =
        this.hasFrigateObjectDetectorMixin
          ? OccupancySource.Frigate
          : OccupancySource.Off;
    }
    if (this.mixinState.storageSettings.settings.mqttRediscoverDevice) {
      this.mixinState.storageSettings.settings.mqttRediscoverDevice.hide =
        !enabledToMqtt;
    }

    const isAudioClassifierEnabled =
      audioClassifierSource !== AudioAnalyzerSource.Disabled;
    if (this.mixinState.storageSettings.settings.audioClassifierSource) {
      this.mixinState.storageSettings.settings.audioClassifierSource.hide =
        !audioAnalyzerEnabled;
    }
    if (this.mixinState.storageSettings.settings.audioAnalyzerStreamName) {
      this.mixinState.storageSettings.settings.audioAnalyzerStreamName.hide =
        !audioAnalyzerEnabled;
    }
    if (this.mixinState.storageSettings.settings.audioAnalyzerCustomStreamUrl) {
      this.mixinState.storageSettings.settings.audioAnalyzerCustomStreamUrl.hide =
        !audioAnalyzerEnabled;
    }
    if (this.mixinState.storageSettings.settings.audioAnalyzerCustomStreamUrl) {
      this.mixinState.storageSettings.settings.audioAnalyzerCustomStreamUrl.hide =
        !audioAnalyzerEnabled;
    }
    if (this.mixinState.storageSettings.settings.audioAnalyzerProcessPid) {
      this.mixinState.storageSettings.settings.audioAnalyzerProcessPid.hide =
        !audioAnalyzerEnabled;
    }
    if (this.mixinState.storageSettings.settings.audioAnalyzerSensitivity) {
      this.mixinState.storageSettings.settings.audioAnalyzerSensitivity.hide =
        !audioAnalyzerEnabled || !isAudioClassifierEnabled;
    }
    if (this.mixinState.storageSettings.settings.occupiedSpaceInGb) {
      this.mixinState.storageSettings.settings.occupiedSpaceInGb.range = [
        0,
        maxSpaceInGb || 20,
      ];
    }

    if (this.streams) {
      const streamNames = this.streams
        .map((stream) => stream.subgroup?.replace("Stream: ", "") ?? "")
        .filter((name) => name);
      this.mixinState.storageSettings.settings.audioAnalyzerStreamName.choices =
        streamNames;
      this.mixinState.storageSettings.settings.videoRecorderStreamName.choices =
        streamNames;
      const firstStream = streamNames[0];
      if (!this.mixinState.storageSettings.values.audioAnalyzerStreamName) {
        this.mixinState.storageSettings.values.audioAnalyzerStreamName =
          firstStream;
      }
      if (!this.mixinState.storageSettings.values.videoRecorderStreamName) {
        this.mixinState.storageSettings.values.videoRecorderStreamName =
          firstStream;
      }
    }
  }

  async getObserveZones() {
    try {
      const now = new Date().getTime();
      const isUpdated =
        this.mixinState.lastObserveZonesFetched &&
        now - this.mixinState.lastObserveZonesFetched <= 1000 * 60;
      if (this.mixinState.observeZoneData && isUpdated) {
        return this.mixinState.observeZoneData;
      }

      const res: ObserveZoneData[] = [];
      const settings = await this.mixinDevice.getSettings();
      const zonesSetting =
        settings.find((setting: { key: string }) =>
          new RegExp("objectdetectionplugin:.*:zones").test(setting.key),
        )?.value ?? [];

      const zoneNames = zonesSetting?.filter((zone) => {
        return (
          settings.find((setting: { key: string }) =>
            new RegExp(
              `objectdetectionplugin:.*:zoneinfo-filterMode-${zone}`,
            ).test(setting.key),
          )?.value === "observe"
        );
      });

      zoneNames.forEach((zoneName) => {
        const zonePath = JSON.parse(
          settings.find(
            (setting) =>
              setting.subgroup === `Zone: ${zoneName}` &&
              setting.type === "clippath",
          )?.value ?? "[]",
        );

        res.push({
          name: zoneName,
          path: zonePath,
        });
      });

      this.mixinState.observeZoneData = res;
      this.mixinState.lastObserveZonesFetched = now;
      return this.mixinState.observeZoneData;
    } catch (e) {
      this.getLogger().log("Error in getObserveZones", e);
      return [];
    }
  }

  async getOccupancyZones(detectionSource: ScryptedEventSource) {
    const isFrigate = detectionSource === ScryptedEventSource.Frigate;
    const zonesData = isFrigate
      ? (await this.getFrigateData()).frigateZones
      : await this.getObserveZones();

    return zonesData;
  }

  /** Returns list of accessory switch kinds available for this camera (for API/config). */
  getAccessorySwitchKinds(): CameraNativeIdAccessoryKind[] {
    return [...(this.cameraAccessorySwitchKinds || [])];
  }

  /** Returns current camera switch state for MQTT publish and discovery initial state. */
  async getCameraMqttCurrentState(): Promise<InitialCameraState & {
    notificationsEnabled: boolean;
    isRecording: boolean;
    isSnapshotsEnabled: boolean;
    isRebroadcastEnabled: boolean;
    accessorySwitchStates: Partial<Record<CameraNativeIdAccessoryKind, boolean>>;
  }> {
    const settings = (await this.mixinDevice.getSettings()) as Setting[];
    const hasVideoRecorder = this.cameraDevice.interfaces?.includes(ScryptedInterface.VideoRecorder);
    const isRecording =
      hasVideoRecorder && !settings.find((s) => s.key === "recording:privacyMode")?.value;
    const isSnapshotsEnabled = !settings.find((s) => s.key === "snapshot:privacyMode")?.value;
    const isRebroadcastEnabled = !settings.find((s) => s.key === "prebuffer:privacyMode")?.value;
    const { notificationsEnabled } = this.mixinState.storageSettings.values;
    const accessorySwitchStates: Partial<Record<CameraNativeIdAccessoryKind, boolean>> = {};
    // Only read state for accessory devices that exist (avoid proxy errors for missing devices)
    for (const [kind, device] of Object.entries(this.cameraAccessorySwitchDevices) as [CameraNativeIdAccessoryKind, ScryptedDeviceBase & OnOff][]) {
      if (device) {
        try {
          accessorySwitchStates[kind] = !!device.on;
        } catch (e) {
          // Device proxy might throw if device was removed; skip
        }
      }
    }
    return {
      notificationsEnabled,
      isRecording,
      isSnapshotsEnabled,
      isRebroadcastEnabled,
      accessorySwitchStates,
    };
  }

  async getMqttZones(sourceParent?: ZonesSource): Promise<string[]> {
    const source = sourceParent ?? this.zonesSourceForMqtt;
    const zones: string[] = [];

    const isAll = source === ZonesSource.All;

    if (isAll || source === ZonesSource.Frigate) {
      try {
        const { frigateZones } = await this.getFrigateData();
        const zoneNames = (frigateZones || [])
          .map((z) => z.name)
          .filter(Boolean);

        zones.push(...zoneNames);
      } catch (e) {
        this.getLogger().debug?.(
          `Error fetching Frigate zones for MQTT, falling back to Observe zones: ${e}`,
        );
      }
    }

    if (isAll || source === ZonesSource.Scrypted) {
      try {
        const zonesData = await this.getObserveZones();
        const zoneNames = (zonesData || []).map((z) => z.name).filter(Boolean);

        zones.push(...zoneNames);
      } catch (e) {
        this.getLogger().debug?.(
          `Error fetching Frigate zones for MQTT, falling back to Observe zones: ${e}`,
        );
      }
    }

    return zones;
  }

  async getAudioData() {
    let labels: string[] = this.mixinState.audioLabels;

    try {
      const now = new Date().getTime();
      const isUpdated =
        this.mixinState.lastAudioDataFetched &&
        now - this.mixinState.lastAudioDataFetched <= 1000 * 60;

      if (!labels || !isUpdated) {
        this.mixinState.lastAudioDataFetched = now;
        const { device: audioClassifier } = this.getAudioClassifier();

        if (audioClassifier) {
          const { classes } = await audioClassifier.getDetectionModel();
          labels = uniq(classes).sort((a, b) => a.localeCompare(b));
        }
      }
    } catch (e) {
      this.getLogger().log("Error in getObserveZones", e);
    } finally {
      return { labels };
    }
  }

  async getFrigateData() {
    try {
      const now = new Date().getTime();
      const frigateObjectDetector = systemManager.getDeviceById(
        FRIGATE_BRIDGE_PLUGIN_ID,
        objectDetectorNativeId,
      );

      let audioLabels: string[];
      let objectLabels: string[];
      let zones: ZoneWithPath[] = [];
      let cameraName: string;

      if (
        frigateObjectDetector &&
        this.cameraDevice.mixins.includes(frigateObjectDetector.id)
      ) {
        const isUpdated =
          this.mixinState.lastFrigateDataFetched &&
          now - this.mixinState.lastFrigateDataFetched <= 1000 * 60;

        if (this.mixinState.frigateCameraName && isUpdated) {
          audioLabels = this.mixinState.frigateAudioLabels;
          objectLabels = this.mixinState.frigateObjectLabels;
          cameraName = this.mixinState.frigateCameraName;
          zones = this.mixinState.frigateZones;
        } else {
          const frigateCurrentData = await getFrigateMixinSettings(this.id);

          cameraName = frigateCurrentData.cameraName;
          objectLabels = frigateCurrentData.objectLabels;
          audioLabels = frigateCurrentData.audioLabels;
          zones = frigateCurrentData.zones;
        }

        this.mixinState.lastFrigateDataFetched = now;
        this.mixinState.frigateCameraName = cameraName;
        this.mixinState.frigateObjectLabels = objectLabels;
        this.mixinState.frigateAudioLabels = audioLabels;
        this.mixinState.frigateZones = zones;
      }

      return {
        frigateAudioLabels: audioLabels,
        frigateObjectLabels: objectLabels,
        frigateZones: zones,
        cameraName,
      };
    } catch (e) {
      this.getLogger().log("Error in getFrigateData", e.message);
      return {};
    }
  }

  async getMixinSettings(): Promise<Setting[]> {
    try {
      return this.mixinState.storageSettings.getSettings();
    } catch (e) {
      this.getLogger().log("Error in getMixinSettings", e);
      return [];
    }
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    const [group, ...rest] = key.split(":");
    if (group === this.settingsGroupKey) {
      this.mixinState.storageSettings.putSetting(rest.join(":"), value);
    } else {
      super.putSetting(key, value);
    }
  }

  async putMixinSetting(key: string, value: string) {
    this.mixinState.storageSettings.putSetting(key, value);
  }

  async release() {
    const logger = this.getLogger();
    logger.info("Releasing mixin");
    this.killed = true;
    this.mainLoopListener && clearInterval(this.mainLoopListener);
    this.mainLoopListener = undefined;

    this.stopPatrol("Mixin released");
    this.resetListeners();
    this.stopDecoder("Release");
  }

  public getLogger(forceNew?: boolean) {
    if (!this.mixinState.logger || forceNew) {
      const newLogger = this.plugin.getLoggerInternal({
        console: this.console,
        storage: this.mixinState.storageSettings,
        friendlyName: this.mixinState.clientId,
      });

      if (forceNew) {
        return newLogger;
      } else {
        this.mixinState.logger = newLogger;
      }
    }

    return this.mixinState.logger;
  }

  async triggerRule(props: {
    matchRule: MatchRule;
    eventSource: ScryptedEventSource;
    device: DeviceInterface;
    b64Image?: string;
    triggerTime: number;
    skipMqttImage?: boolean;
    skipTrigger?: boolean;
  }) {
    const logger = this.getLogger();

    try {
      const {
        matchRule,
        eventSource,
        b64Image,
        device,
        triggerTime,
        skipMqttImage,
        skipTrigger,
      } = props;
      const { rule } = matchRule;

      const { timePassed } =
        !skipMqttImage &&
        this.isDelayPassed({
          type: DelayType.RuleImageUpdate,
          matchRule,
          eventSource,
        });

      if (this.isActiveForMqttReporting) {
        const mqttClient = await this.getMqttClient();
        if (mqttClient) {
          try {
            publishRuleData({
              mqttClient,
              device,
              triggerValue: !skipTrigger ? true : undefined,
              console: logger,
              b64Image: timePassed ? b64Image : undefined,
              rule,
              triggerTime,
              skipMqttImage,
            }).catch(logger.error);
          } catch (e) {
            logger.log(`Error in publishRuleData`, e);
          }
        }
      }

      if (rule.ruleType === RuleType.Detection && !skipTrigger) {
        const { disableNvrRecordingSeconds, name } = rule as DetectionRule;
        if (disableNvrRecordingSeconds !== undefined) {
          const seconds = Number(disableNvrRecordingSeconds);

          logger.log(
            `Enabling NVR recordings for ${seconds} seconds from rule ${rule.name}`,
          );
          await this.toggleRecording(device, true);

          if (!this.mixinState.detectionRuleListeners[name]) {
            this.mixinState.detectionRuleListeners[name] = {};
          }

          const { disableNvrRecordingTimeout } =
            this.mixinState.detectionRuleListeners[name];

          if (disableNvrRecordingTimeout) {
            clearTimeout(disableNvrRecordingTimeout);
            this.mixinState.detectionRuleListeners[
              name
            ].disableNvrRecordingTimeout = undefined;
          }

          this.mixinState.detectionRuleListeners[
            name
          ].disableNvrRecordingTimeout = setTimeout(async () => {
            logger.log(`Disabling NVR recordings from rule ${rule.name}`);
            await this.toggleRecording(device, false);
          }, seconds * 1000);
        }

        this.plugin
          .triggerRuleSequences({
            sequences: rule.onTriggerSequences,
            postFix: "trigger",
            rule,
            deviceId: device.id,
          })
          .catch(logger.error);

        this.resetRuleEntities(rule).catch(logger.log);
      }
    } catch (e) {
      logger.log("error in triggerRule", e);
    }
  }

  public async getImage(props?: {
    detectionId?: string;
    eventId?: string;
    image?: MediaObject;
    reason: GetImageReason;
    skipResize?: boolean;
  }) {
    const {
      reason,
      detectionId,
      eventId,
      image: imageParent,
      skipResize,
    } = props ?? {};
    const logger = this.getLogger();
    const now = Date.now();
    const { minSnapshotDelay } = this.mixinState.storageSettings.values;
    logger[reason !== GetImageReason.MotionUpdate ? "info" : "debug"](
      `Getting image for reason ${reason}, ${detectionId} ${eventId}`,
    );

    let image: MediaObject = imageParent;
    let b64Image: string;
    let imageUrl: string;
    let imageSource: ImageSource;

    const msPassedFromSnapshot =
      this.mixinState.lastPictureTaken !== undefined
        ? now - this.mixinState.lastPictureTaken
        : 0;
    const msPassedFromDecoder =
      this.mixinState.lastFrameAcquired !== undefined
        ? now - this.mixinState.lastFrameAcquired
        : 0;

    const forceLatest = [
      GetImageReason.MotionUpdate,
      GetImageReason.FromFrigate,
    ].includes(reason);
    const preferLatest = [
      GetImageReason.RulesRefresh,
      GetImageReason.AudioTrigger,
    ].includes(reason);
    const forceSnapshot = [
      GetImageReason.Sensor,
      GetImageReason.Notification,
      GetImageReason.ObjectUpdate,
    ].includes(reason);
    const tryDetector = !!detectionId && !!eventId;
    const isQuickNotification = reason === GetImageReason.QuickNotification;
    const isFromNvr = reason === GetImageReason.FromNvr;
    const snapshotTimeout =
      reason === GetImageReason.RulesRefresh
        ? 10000
        : isQuickNotification
          ? 2000
          : this.mixinState.currentSnapshotTimeout;
    const decoderRunning = !this.framesGeneratorSignal.finished;
    const forceDecoder = reason === GetImageReason.RulesRefresh;

    let logPayload: any = {
      decoderRunning,
      msPassedFromDecoder,
      msPassedFromSnapshot,
      reason,
      preferLatest,
      forceLatest,
      forceSnapshot,
      tryDetector,
      snapshotTimeout,
      forceDecoder,
    };

    const findFromDetector = () => async () => {
      try {
        if (!detectionId && !eventId) {
          return null;
        }

        const detectImage = await this.cameraDevice.getDetectionInput(
          detectionId,
          eventId,
        );

        if (detectImage) {
          if (skipResize) {
            image = detectImage;
          } else {
            const convertedImage =
              await sdk.mediaManager.convertMediaObject<Image>(
                detectImage,
                ScryptedMimeTypes.Image,
              );
            image = await convertedImage.toImage({
              resize: {
                width: SNAPSHOT_WIDTH,
              },
            });
          }
          imageSource = ImageSource.Detector;
        }
      } catch (e) {
        logger.log(
          `Error finding the ${reason} image from the detector for detectionId ${detectionId} and eventId ${eventId} (${e.message})`,
        );
      }
    };

    const findFromSnapshot = (force: boolean, timeout: number) => async () => {
      const timePassed =
        !this.mixinState.lastPictureTaken ||
        msPassedFromSnapshot >= 1000 * minSnapshotDelay;

      if (timePassed || force) {
        try {
          image = await this.cameraDevice.takePicture({
            reason: "event",
            timeout,
            picture: skipResize
              ? undefined
              : {
                width: SNAPSHOT_WIDTH,
              },
          });
          this.mixinState.lastPictureTaken = now;
          imageSource = ImageSource.Snapshot;
          this.mixinState.currentSnapshotTimeout = 4000;
        } catch (e) {
          logger.log(
            `Error taking a snapshot for reason ${reason} (timeout ${snapshotTimeout} ms): (${e.message})`,
          );
          this.mixinState.lastPictureTaken = undefined;
          if (
            this.mixinState.currentSnapshotTimeout <
            1000 * minSnapshotDelay
          ) {
            logger.log(
              `Increasing timeout to ${this.mixinState.currentSnapshotTimeout + 1000}`,
            );
            this.mixinState.currentSnapshotTimeout += 1000;
          }
        }
      } else {
        logger.debug(
          `Skipping snapshot image`,
          JSON.stringify({
            timePassed,
            force,
          }),
        );
      }
    };

    const findFromDecoder = () => async () => {
      const isRecent =
        this.mixinState.lastFrameAcquired && msPassedFromDecoder <= 500;

      if (
        this.mixinState.lastFrame &&
        (forceDecoder || (decoderRunning && isRecent))
      ) {
        const mo = await sdk.mediaManager.createMediaObject(
          this.mixinState.lastFrame,
          "image/jpeg",
        );
        if (this.mixinState.decoderResize && !skipResize) {
          const convertedImage =
            await sdk.mediaManager.convertMediaObject<Image>(
              mo,
              ScryptedMimeTypes.Image,
            );
          image = await convertedImage.toImage({ format: "jpeg" });
        } else {
          image = mo;
        }

        imageSource = ImageSource.Decoder;
      } else {
        logger.debug(
          `Skipping decoder image`,
          JSON.stringify({
            isRecent,
            decoderRunning,
            hasFrame: !!this.mixinState.lastFrame,
            msPassedFromDecoder,
          }),
        );
      }
    };

    const findFromLatest = (ms: number) => async () => {
      const isRecent = msPassedFromSnapshot && msPassedFromSnapshot <= ms;

      if (isRecent) {
        image = this.mixinState.lastImage;
        b64Image = this.mixinState.lastB64Image;
        imageSource = ImageSource.Latest;
      } else {
        logger.debug(
          `Skipping latest image`,
          JSON.stringify({
            isRecent,
            ms,
          }),
        );
      }
    };

    try {
      if (!image) {
        let runners = [];
        const checkLatest = findFromLatest(forceLatest ? 5000 : 2000);
        const checkVeryRecent = findFromLatest(200);
        const checkSnapshot = findFromSnapshot(forceSnapshot, snapshotTimeout);
        const checkDetector = findFromDetector();
        const checkDecoder = findFromDecoder();

        if (this.cameraDevice.sleeping) {
          logger.info(`Not waking up the camera for a snapshot`);
          runners = [checkDetector, checkVeryRecent, checkLatest];
        } else if (reason === GetImageReason.FromFrigate) {
          runners = [
            checkDetector,
            checkDecoder,
            checkVeryRecent,
            checkLatest,
            checkSnapshot,
          ];
        } else if (reason === GetImageReason.AccumulatedDetections) {
          runners = [checkDecoder, checkDetector, checkSnapshot];
        } else if (forceLatest) {
          runners = [checkDecoder, checkVeryRecent, checkLatest];
        } else if (preferLatest) {
          runners = [checkDecoder, checkVeryRecent, checkLatest, checkSnapshot];
        } else if (isQuickNotification) {
          if (tryDetector) {
            runners = [checkDetector, checkDecoder, checkLatest, checkSnapshot];
          }
        } else if (tryDetector) {
          runners = [
            checkDetector,
            checkDecoder,
            checkVeryRecent,
            checkSnapshot,
          ];
        } else if (isFromNvr) {
          runners = [checkDetector, checkSnapshot, checkVeryRecent];
        } else {
          runners = [checkDecoder, checkVeryRecent, checkSnapshot];
        }

        for (const runner of runners) {
          await runner();
          if (image) {
            break;
          }
        }
      } else {
        imageSource = ImageSource.Input;
      }

      if (image) {
        b64Image = await moToB64(image);
      } else {
        imageSource = ImageSource.NotFound;
      }
    } catch (e) {
      logger.log(`Error during getImage`, e);
    } finally {
      logPayload = {
        ...logPayload,
        imageSource,
        imageFound: !!image,
      };
      logger[reason !== GetImageReason.MotionUpdate ? "info" : "debug"](
        `Image found from ${imageSource} for reason ${reason} lastSnapshotMs ${msPassedFromSnapshot} lastDecoderMs ${msPassedFromDecoder}`,
      );
      logger.debug(logPayload);
      if (!imageParent && image && b64Image) {
        this.mixinState.lastImage = image;
        this.mixinState.lastB64Image = b64Image;
      }

      return { image, b64Image, imageUrl, imageSource };
    }
  }

  async checkOutdatedRules() {
    if (this.mixinState.checkingOutatedRules) {
      return;
    }

    this.mixinState.checkingOutatedRules = true;
    const now = new Date().getTime();
    const logger = this.getLogger();
    const { occupancySourceForMqtt } = this.mixinState.storageSettings.values;

    try {
      const anyOutdatedOccupancyRule =
        this.mixinState.runningOccupancyRules.some((rule) => {
          const { forceUpdate, name } = rule;
          const currentState = this.mixinState.occupancyState[name];
          const shouldForceFrame =
            !currentState ||
            now - (currentState?.lastCheck ?? 0) >= 1000 * forceUpdate ||
            (currentState.occupancyToConfirm != undefined &&
              !!currentState.confirmationStart);

          const isMotionOk =
            this.cameraDevice.motionDetected ||
            !this.mixinState.lastMotionEnd ||
            now - this.mixinState.lastMotionEnd > 1000 * 10;

          if (!this.mixinState.occupancyState[name]) {
            const initState: CurrentOccupancyState =
              getInitOccupancyState(rule);
            logger.log(
              `Initializing occupancy data for rule ${name} to ${JSON.stringify(initState)}`,
            );
            this.mixinState.occupancyState[name] = initState;
          }

          logger.info(
            `Should force occupancy data update: ${JSON.stringify({
              shouldForceFrame,
              isMotionOk,
              lastCheck: currentState?.lastCheck,
              forceUpdate,
              now,
              name,
            })}`,
          );

          return shouldForceFrame && isMotionOk;
        }) || occupancySourceForMqtt !== OccupancySource.Off;

      const timelapsesToRefresh = (
        this.mixinState.runningTimelapseRules || []
      ).filter((rule) => {
        const { regularSnapshotInterval, name } = rule;
        const lastCheck = this.mixinState.timelapseLastCheck[name];
        const shouldForceFrame =
          !lastCheck ||
          now - (lastCheck ?? 0) >= 1000 * regularSnapshotInterval;

        logger.info(
          `Should force timelapse frame: ${JSON.stringify({
            shouldForceFrame,
            lastCheck,
            regularSnapshotInterval,
            now,
            name,
          })}`,
        );

        return shouldForceFrame;
      });

      const anyTimelapseToRefresh = !!timelapsesToRefresh.length;

      if (anyOutdatedOccupancyRule || anyTimelapseToRefresh) {
        const { image, b64Image, imageSource } = await this.getImage({
          reason: GetImageReason.RulesRefresh,
        });
        if (image && b64Image) {
          if (anyOutdatedOccupancyRule) {
            this.checkOccupancyData({
              image,
              b64Image,
              imageSource,
              source: "MainFlow",
            }).catch(logger.log);
          }

          if (anyTimelapseToRefresh) {
            for (const rule of uniqBy(
              timelapsesToRefresh,
              (rule) => rule.name,
            )) {
              logger.log(
                `Adding regular frame from ${imageSource} to the timelapse rule ${rule.name}`,
              );
              this.plugin
                .storeTimelapseFrame({
                  imageMo: image,
                  timestamp: now,
                  device: this.cameraDevice,
                  rule: rule as TimelapseRule,
                })
                .catch(logger.log);

              this.mixinState.timelapseLastCheck[rule.name] = now;
            }
          }
        }
      }
    } catch (e) {
      logger.log(`Error during checkOutdatedRules`, e);
    } finally {
      this.mixinState.checkingOutatedRules = false;
    }
  }

  async manualCheckOccupancyRule(ruleName: string) {
    try {
      const logger = this.getLogger();
      const rule = this.mixinState.runningOccupancyRules.find(
        (rule) => rule.name === ruleName,
      );

      logger.log(`Starting AI check for occupancy rule ${ruleName}`);

      const { image } = await this.getImage({
        reason: GetImageReason.Sensor,
      });

      const zonesData = await this.getOccupancyZones(rule.detectionSource);
      const zone = zonesData.find(
        (zoneData) => zoneData.name === rule.observeZone,
      );

      const { newB64Image, newImage } = await addZoneClipPathToImage({
        image,
        clipPaths: [zone.path],
        console: logger,
        plugin: this.plugin,
      });
      const occupiesFromAi = await checkObjectsOccupancy({
        b64Image: newB64Image,
        logger,
        plugin: this.plugin,
        detectionClass: rule.detectionClass,
      });

      const detectedObjectsFromAi = Number(occupiesFromAi.response);

      const currentState = this.mixinState.occupancyState[ruleName];
      const message = `AI detected ${detectedObjectsFromAi}, current state ${JSON.stringify(currentState)}`;
      logger.log(message);

      const { devNotifier } = this.plugin.storageSettings.values;
      (devNotifier as Notifier).sendNotification(
        `Occupancy AI check ${ruleName}`,
        {
          body: message,
        },
        newImage,
      );
    } catch (e) {
      this.getLogger().log(
        `Error in manualCheckOccupancyRule for rule ${ruleName}`,
        e,
      );
    }
  }

  async checkOccupancyData(props: {
    image: MediaObject;
    b64Image: string;
    imageSource: ImageSource;
    source: "Detections" | "MainFlow";
  }) {
    const { source } = props;
    let { image: imageParent, b64Image, imageSource } = props;
    const { occupancySourceForMqtt, enabledToMqtt } =
      this.mixinState.storageSettings.values;

    const shouldRun =
      !!this.mixinState.runningOccupancyRules.length ||
      occupancySourceForMqtt !== OccupancySource.Off;

    if (!shouldRun) {
      return;
    }

    const logger = this.getLogger();

    logger.debug(
      `CheckOccupancyData from source ${source}: ${JSON.stringify({ hasImage: !!imageParent, imageSource, processingOccupanceData: this.mixinState.processingOccupanceData })}`,
    );
    if (this.mixinState.processingOccupanceData) {
      return;
    }

    if (!imageParent) {
      return;
    }

    const now = Date.now();
    const frigateTriggerTimeShiftMs = 5_000;

    try {
      if (imageParent && imageSource === ImageSource.Input) {
        const logger = this.getLogger();
        logger.info(
          `Incoming occupancy imageSource is Input, refetching image without eventId/detectionId`,
        );

        const refetchReason =
          source === "MainFlow"
            ? GetImageReason.RulesRefresh
            : GetImageReason.ObjectUpdate;
        const refetched = await this.getImage({ reason: refetchReason });
        if (refetched?.image && refetched?.b64Image) {
          imageParent = refetched.image;
          b64Image = refetched.b64Image;
          imageSource = refetched.imageSource;
        }
      }

      if (
        !this.isDelayPassed({
          type: DelayType.OccupancyRegularCheck,
        }).timePassed
      ) {
        return;
      }

      this.mixinState.processingOccupanceData = true;

      logger.debug(`Checking occupancy for reason ${source}`);

      const occupancyRulesDataTmpMap: Record<string, OccupancyRuleData> = {};

      const objectDetector: ObjectDetection & ScryptedDeviceBase =
        this.plugin.storageSettings.values.objectDetectionDevice;

      if (!objectDetector) {
        logger.log(`No detection plugin selected. skipping occupancy`);
        return;
      }

      const detectedResultParent = await this.executeDetection(imageParent);

      if (
        !objectDetector.interfaces.includes(
          ScryptedInterface.ObjectDetectionGenerator,
        )
      ) {
        detectedResultParent.detections = filterOverlappedDetections(
          detectedResultParent.detections,
        );
      }

      for (const occupancyRule of this.mixinState.runningOccupancyRules) {
        let image = imageParent;

        const {
          name,
          zoneType,
          observeZone,
          scoreThreshold,
          detectionClass,
          maxObjects,
          captureZone,
          detectionSource,
        } = occupancyRule;

        const isFrigate = detectionSource === ScryptedEventSource.Frigate;
        const zonesData = await this.getOccupancyZones(detectionSource);

        const zone = zonesData.find(
          (zoneData) => zoneData.name === observeZone,
        );

        if (!zone) {
          logger.log(
            `Zone ${zone} for rule ${name} not found, skipping checks. Available data: ${JSON.stringify({ zonesData, rule: occupancyRule })}`,
          );
          continue;
        }

        let objectsDetected = 0;
        let maxScore = 0;
        let detectedResult = detectedResultParent;

        let updatedState: CurrentOccupancyState = {
          ...(this.mixinState.occupancyState[name] ??
            ({} as CurrentOccupancyState)),
          referenceZone: zone,
        };

        if (isFrigate) {
          const sensorId = buildOccupancyZoneId({
            className: detectionClass,
            zoneName: observeZone,
          })?.totalId;
          objectsDetected = Number(this.sensors?.[sensorId]?.value ?? 0);
        } else {
          if (captureZone?.length >= 3) {
            const convertedImage =
              await sdk.mediaManager.convertMediaObject<Image>(
                imageParent,
                ScryptedMimeTypes.Image,
              );
            let left = convertedImage.width;
            let top = convertedImage.height;
            let right = 0;
            let bottom = 0;
            for (const point of captureZone) {
              left = Math.min(left, point[0]);
              top = Math.min(top, point[1]);
              right = Math.max(right, point[0]);
              bottom = Math.max(bottom, point[1]);
            }

            left = left * convertedImage.width;
            top = top * convertedImage.height;
            right = right * convertedImage.width;
            bottom = bottom * convertedImage.height;

            let width = right - left;
            let height = bottom - top;
            // square it for standard detection
            width = height = Math.max(width, height);
            // recenter it
            left = left + (right - left - width) / 2;
            top = top + (bottom - top - height) / 2;
            // ensure bounds are within image.
            left = Math.max(0, left);
            top = Math.max(0, top);
            width = Math.min(width, convertedImage.width - left);
            height = Math.min(height, convertedImage.height - top);

            if (
              !Number.isNaN(left) &&
              !Number.isNaN(top) &&
              !Number.isNaN(width) &&
              !Number.isNaN(height)
            ) {
              const croppedImage = await convertedImage.toImage({
                crop: {
                  left,
                  top,
                  width,
                  height,
                },
              });
              detectedResult = await this.executeDetection(croppedImage);
            }

            if (
              !objectDetector.interfaces.includes(
                ScryptedInterface.ObjectDetectionGenerator,
              )
            ) {
              detectedResult.detections = filterOverlappedDetections(
                detectedResult.detections,
              );
            }

            // adjust the origin of the bounding boxes for the crop.
            for (const d of detectedResult.detections) {
              d.boundingBox[0] += left;
              d.boundingBox[1] += top;
            }
            detectedResult.inputDimensions = [
              convertedImage.width,
              convertedImage.height,
            ];
          }

          for (const detection of detectedResult.detections) {
            const className = detectionClassesDefaultMap[detection.className];
            if (
              detection.score >= scoreThreshold &&
              detectionClass === className
            ) {
              if (!maxScore || detection.score > maxScore) {
                maxScore = detection.score;
              }
              const boundingBoxInCoords = normalizeBox(
                detection.boundingBox,
                detectedResult.inputDimensions,
              );
              let zoneMatches = false;

              if (zoneType === ZoneMatchType.Intersect) {
                zoneMatches = polygonIntersectsBoundingBox(
                  zone.path,
                  boundingBoxInCoords,
                );
              } else {
                zoneMatches = polygonContainsBoundingBox(
                  zone.path,
                  boundingBoxInCoords,
                );
              }

              if (zoneMatches) {
                objectsDetected += 1;
              }
            }
          }

          updatedState.score = maxScore;
        }

        const occupies = (maxObjects || 1) - objectsDetected <= 0;

        this.mixinState.occupancyState[name] = updatedState;

        const existingRule = occupancyRulesDataTmpMap[name];
        if (!existingRule) {
          occupancyRulesDataTmpMap[name] = {
            rule: occupancyRule,
            occupies,
            triggerTime: isFrigate ? now - frigateTriggerTimeShiftMs : now,
            objectsDetected: objectsDetected,
            image,
            objectsDetectedResult: [detectedResult],
          };
        } else if (!existingRule.occupies && occupies) {
          existingRule.occupies = true;
        }
      }

      const occupancyRulesData: OccupancyRuleData[] = [];
      const notifiedRules: string[] = [];
      for (const occupancyRuleTmpData of Object.values(
        occupancyRulesDataTmpMap,
      )) {
        const { rule, image } = occupancyRuleTmpData;
        const { name, changeStateConfirm } = rule;
        const isFrigate = rule.detectionSource === ScryptedEventSource.Frigate;
        const currentState = this.mixinState.occupancyState[name];
        const lastChangeElpasedMs = now - (currentState?.lastChange ?? 0);
        const tooOld = !currentState || lastChangeElpasedMs >= 1000 * 60 * 10; // Force an update every 10 minutes
        const toConfirm =
          currentState.occupancyToConfirm != undefined &&
          !!currentState.confirmationStart;
        const isChanged =
          occupancyRuleTmpData.occupies !== currentState.occupies;

        logger.info(
          JSON.stringify({
            rule: name,
            occupancyToConfirm: currentState.occupancyToConfirm,
            confirmationStart: currentState.confirmationStart,
            occupies: occupancyRuleTmpData.occupies,
            currentOccupies: currentState.occupies,
            tooOld,
            toConfirm,
            isChanged,
          }),
        );

        const {
          occupancy: { occupiesKey, detectedObjectsKey },
        } = getRuleKeys({
          ruleType: RuleType.Occupancy,
          ruleName: name,
        });

        if (
          currentState.objectsDetected !== occupancyRuleTmpData.objectsDetected
        ) {
          await this.mixinState.storageSettings.putSetting(
            detectedObjectsKey,
            occupancyRuleTmpData.objectsDetected,
          );
        }

        const occupancyDataToUpdate: CurrentOccupancyState = {
          ...(currentState ?? getInitOccupancyState(rule)),
          lastCheck: now,
        };

        if (toConfirm) {
          const elpasedTimeMs = now - (currentState?.confirmationStart ?? 0);
          const isConfirmationTimePassed =
            elpasedTimeMs >= 1000 * changeStateConfirm;
          const isStateConfirmed =
            occupancyRuleTmpData.occupies === currentState.occupancyToConfirm;

          if (!isConfirmationTimePassed) {
            if (isStateConfirmed) {
              // Do nothing and wait for next iteration
              this.mixinState.occupancyState[name] = {
                ...occupancyDataToUpdate,
                confirmedFrames: (currentState.confirmedFrames ?? 0) + 1,
              };
              logger.log(
                `Confirmation time is not passed yet for rule ${name}: toConfirm ${currentState.occupancyToConfirm} started ${elpasedTimeMs / 1000} seconds ago  (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames})`,
              );
            } else {
              // Reset confirmation data because the value changed before confirmation time passed
              logger.log(
                `Confirmation failed for rule ${name}: toConfirm ${currentState.occupancyToConfirm} after ${elpasedTimeMs / 1000} seconds (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames})`,
              );

              this.mixinState.occupancyState[name] = {
                ...getInitOccupancyState(rule),
                lastCheck: now,
              };
            }
          } else {
            if (isStateConfirmed) {
              // Time is passed and value didn't change, update the state. But let's ask AI first
              let confirmedByAi = true;

              if (rule.confirmWithAi) {
                try {
                  const zonesData = await this.getOccupancyZones(
                    rule.detectionSource,
                  );
                  const zone = zonesData.find(
                    (zoneData) => zoneData.name === rule.observeZone,
                  );

                  const { newB64Image } = await addZoneClipPathToImage({
                    image,
                    clipPaths: [zone.path],
                    console: logger,
                    plugin: this.plugin,
                  });
                  const occupiesFromAi = await checkObjectsOccupancy({
                    b64Image: newB64Image,
                    logger,
                    plugin: this.plugin,
                    detectionClass: rule.detectionClass,
                  });

                  const detectedObjectsFromAi = Number(occupiesFromAi.response);
                  if (!Number.isNaN(detectedObjectsFromAi)) {
                    confirmedByAi =
                      detectedObjectsFromAi === currentState.objectsDetected;
                  } else {
                    confirmedByAi = true;
                  }
                } catch (e) {
                  logger.error(
                    `Error trying to confirm occupancy rule ${rule.name}`,
                    e,
                  );
                  confirmedByAi = true;
                }
              }

              if (confirmedByAi) {
                this.mixinState.occupancyState[name] = {
                  ...getInitOccupancyState(rule),
                  lastChange: now,
                  occupies: occupancyRuleTmpData.occupies,
                  objectsDetected: occupancyRuleTmpData.objectsDetected,
                };

                const { b64Image: _, ...rest } = currentState;
                const {
                  b64Image: __,
                  image: ____,
                  ...rest2
                } = occupancyRuleTmpData;
                const { b64Image: ___, ...rest3 } = occupancyDataToUpdate;

                logger.log(
                  `Confirming occupancy rule ${name}: ${occupancyRuleTmpData.occupies} ${occupancyRuleTmpData.objectsDetected} (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames}): ${JSON.stringify(
                    {
                      occupancyRuleTmpData: rest2,
                      currentState: rest,
                      occupancyData: rest3,
                    },
                  )}`,
                );

                occupancyRulesData.push({
                  ...occupancyRuleTmpData,
                  triggerTime: isFrigate
                    ? (currentState.confirmationStart ?? now) -
                    frigateTriggerTimeShiftMs
                    : currentState.confirmationStart,
                  changed: true,
                  b64Image: currentState.b64Image,
                });

                if (currentState.occupies !== occupancyRuleTmpData.occupies) {
                  await this.mixinState.storageSettings.putSetting(
                    occupiesKey,
                    occupancyRuleTmpData.occupies,
                  );
                }
              } else {
                this.mixinState.occupancyState[name] = {
                  ...occupancyDataToUpdate,
                  confirmationStart: now,
                  occupancyToConfirm: occupancyRuleTmpData.occupies,
                };

                logger.log(
                  `Discarding confirmation of occupancy rule ${name}: ${occupancyRuleTmpData.occupies} ${occupancyRuleTmpData.objectsDetected} (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames}). AI didn't confirm`,
                );
              }
            } else {
              // Time is passed and value changed, restart confirmation flow
              this.mixinState.occupancyState[name] = {
                ...occupancyDataToUpdate,
                confirmationStart: now,
                occupancyToConfirm: occupancyRuleTmpData.occupies,
              };

              logger.log(
                `Restarting confirmation flow (because time is passed and value changed) for occupancy rule ${name}: toConfirm ${occupancyRuleTmpData.occupies}`,
              );
            }
          }
        } else if (isChanged) {
          const b64Image = await moToB64(image);
          logger.log(
            `Marking the rule to confirm ${occupancyRuleTmpData.occupies} for next iteration ${name}: ${occupancyRuleTmpData.objectsDetected} objects, score ${currentState.score}, image ${getB64ImageLog(b64Image)}: ${JSON.stringify(
              {
                isChanged,
                savedOccupies: currentState.occupies,
                nowOccupies: occupancyRuleTmpData.occupies,
              },
            )}`,
          );
          this.mixinState.occupancyState[name] = {
            ...occupancyDataToUpdate,
            confirmationStart: now,
            confirmedFrames: 0,
            rejectedFrames: 0,
            score: 0,
            occupancyToConfirm: occupancyRuleTmpData.occupies,
            b64Image,
          };
        } else if (tooOld) {
          logger.info(
            `Force pushing rule ${name}, last change ${lastChangeElpasedMs / 1000} seconds ago`,
          );

          occupancyRulesData.push({
            ...occupancyRuleTmpData,
            triggerTime: isFrigate
              ? (currentState.confirmationStart ?? now) -
              frigateTriggerTimeShiftMs
              : currentState.confirmationStart,
            changed: false,
          });

          notifiedRules.push(occupancyRuleTmpData.rule.name);
          this.mixinState.occupancyState[name] = {
            ...occupancyDataToUpdate,
          };
        }
        {
          logger.info(`Refreshing lastCheck only for rule ${name}`);
        }
      }
      const mqttClient = await this.getMqttClient();

      if (
        enabledToMqtt &&
        this.isActiveForMqttReporting &&
        detectedResultParent &&
        mqttClient
      ) {
        let classOccupancy: ClassOccupancy = {};
        let classZoneOccupancy: ClassZoneOccupancy = {};
        if (occupancySourceForMqtt === OccupancySource.Scrypted) {
          for (const className of detectionClassForObjectsReporting) {
            const classObjects = detectedResultParent.detections.filter(
              (det) => className === detectionClassesDefaultMap[det.className],
            )?.length;

            classOccupancy[className] = classObjects;
            // TODO: Implement scrypted parsing
          }
        } else if (occupancySourceForMqtt === OccupancySource.Frigate) {
          const { frigateZones } = await this.getFrigateData();

          for (const className of detectionClassForObjectsReporting) {
            const totalClassSensorId = buildOccupancyZoneId({
              className,
            })?.totalId;
            const classTotalObjects = Number(
              this.sensors?.[totalClassSensorId]?.value ?? 0,
            );
            classOccupancy[className] = classTotalObjects;

            for (const zone of frigateZones) {
              const totalZoneClassSensorId = buildOccupancyZoneId({
                className,
                zoneName: zone.name,
              })?.totalId;
              const zoneClassTotalObjects = Number(
                this.sensors?.[totalZoneClassSensorId]?.value ?? 0,
              );

              if (!classZoneOccupancy[zone.name]) {
                classZoneOccupancy[zone.name] = {};
              }
              classZoneOccupancy[zone.name][className] = zoneClassTotalObjects;
            }
          }
        }

        const logData = occupancyRulesData.map((elem) => {
          const { rule, b64Image, image, ...rest } = elem;
          return rest;
        });
        logger.debug(
          `Publishing occupancy data from source ${source}. ${JSON.stringify(logData)} with class occupancy: ${JSON.stringify({ classOccupancy, classZoneOccupancy })}`,
        );
        publishOccupancy({
          console: logger,
          device: this.cameraDevice,
          mqttClient,
          classOccupancy,
          classZoneOccupancy,
          occupancyRulesData,
        }).catch(logger.error);
      }

      for (const occupancyRuleData of occupancyRulesData) {
        const { rule, b64Image } = occupancyRuleData;

        const { timePassed } = this.isDelayPassed({
          type: DelayType.OccupancyNotification,
          matchRule: { rule },
          eventSource: ScryptedEventSource.RawDetection,
        });

        if (!notifiedRules.includes(rule.name) && timePassed) {
          let image = b64Image ? await b64ToMo(b64Image) : imageParent;
          const triggerTime = occupancyRuleData?.triggerTime ?? now;
          let imageToUse: MediaObject = image;

          if (image) {
            const { error, processedImage } =
              await this.executeImagePostProcessing({
                image,
                imageProcessing: rule.imageProcessing,
                shouldReDetect: true,
                imageSource: ImageSource.Decoder,
                eventSource: NotifyRuleSource.Decoder,
                className: rule.detectionClass,
              });

            if (error) {
              imageToUse = image;
            } else {
              image = processedImage;
            }
          }

          let b64ImageToUse = imageToUse
            ? await moToB64(imageToUse)
            : undefined;

          if (rule.showActiveZones) {
            logger.log(`Adding active zone to image: ${rule.observeZone}`);

            const zonesData = await this.getOccupancyZones(
              rule.detectionSource,
            );
            const zone = zonesData.find(
              (zoneData) => zoneData.name === rule.observeZone,
            );

            const { newB64Image, newImage } = await addZoneClipPathToImage({
              image,
              clipPaths: [zone.path],
              console: logger,
              plugin: this.plugin,
            });
            b64ImageToUse = newB64Image;
            imageToUse = newImage;
          }

          await this.plugin.notifyOccupancyEvent({
            cameraDevice: this.cameraDevice,
            rule,
            triggerTime,
            image: imageToUse,
            b64Image: b64ImageToUse,
            occupancyData: occupancyRuleData,
          });
        }
      }
    } catch (e) {
      logger.log("Error in checkOccupancyData", e);
    } finally {
      this.mixinState.processingOccupanceData = false;
    }
  }

  public async processAudioDetection(props: { dBs: number }) {
    const logger = this.getLogger();
    const { dBs } = props;
    logger.debug(`Audio detection: ${dBs} dB`);
    const now = Date.now();

    let image: MediaObject;
    let b64Image: string;
    for (const rule of this.mixinState.runningAudioRules ?? []) {
      const {
        name,
        audioDuration,
        decibelThreshold,
        customText,
        hitPercentage,
      } = rule;
      let samples = this.mixinState.audioRuleSamples[name] ?? [];

      logger.debug(
        `Audio rule: ${JSON.stringify({
          name,
          samples,
          hitPercentage,
          decibelThreshold,
          audioDuration,
        })}`,
      );

      let windowReached = false;
      this.mixinState.audioRuleSamples[name] = [
        ...samples,
        { dBs, timestamp: now },
      ].filter((sample) => {
        const isOverWindow = now - sample.timestamp > audioDuration * 1000;
        if (isOverWindow && !windowReached) {
          windowReached = true;
        }

        return !isOverWindow;
      });

      samples = this.mixinState.audioRuleSamples[name];

      if (windowReached) {
        const hitsInWindow = samples.filter(
          (sample) => sample.dBs >= decibelThreshold,
        );
        const hitsInWindowPercentage =
          (hitsInWindow.length / samples.length) * 100;

        if (hitsInWindowPercentage >= hitPercentage) {
          logger.info(
            `Hits percentage reached: ${JSON.stringify({
              hitsInWindowPercentage,
              hitsInWindow,
              samples: samples.length,
            })}`,
          );

          const { timePassed: notificationTimePassed } = this.isDelayPassed({
            type: DelayType.RuleNotification,
            matchRule: { rule, inputDimensions: [0, 0] } as MatchRule,
          });

          if (notificationTimePassed) {
            let imageSource: ImageSource;

            if (!image) {
              const {
                image: imageNew,
                b64Image: b64ImageNew,
                imageSource: imageSourceNew,
              } = await this.getImage({ reason: GetImageReason.AudioTrigger });
              image = imageNew;
              b64Image = b64ImageNew;
              imageSource = imageSourceNew;
            }

            logger.log(
              `Triggering audio notification, image coming from ${imageSource} with an hit % of ${hitsInWindowPercentage} (${hitsInWindow.length} hits / ${samples.length} samples)`,
            );

            let message = customText;

            message = message.toString();
            message = message
              .toString()
              .replace("${decibels}", String(decibelThreshold) ?? "")
              .replace("${duration}", String(audioDuration) ?? "");

            await this.plugin.notifyAudioEvent({
              cameraDevice: this.cameraDevice,
              image,
              message,
              rule,
              triggerTime: now,
              b64Image,
            });

            this.triggerRule({
              matchRule: { rule },
              b64Image,
              device: this.cameraDevice,
              triggerTime: now,
              eventSource: ScryptedEventSource.RawDetection,
            }).catch(logger.log);

            this.resetAudioRule(name);
          } else {
            logger.info(`Notification time not passed yet`);
          }
        } else {
          logger.info(
            `Hits percentage not reached: ${JSON.stringify({
              hitsInWindowPercentage,
              hitsInWindow,
              samples: samples.length,
            })}`,
          );
        }
      } else {
        logger.info(
          `Not enough samples, just adding ${JSON.stringify({
            samples: samples.length,
          })}`,
        );
      }
    }
  }

  async processAccumulatedDetections() {
    if (
      !this.mixinState.accumulatedDetections.length &&
      !this.mixinState.accumulatedRules.length
    ) {
      return;
    }

    const logger = this.getLogger();
    const dataToAnalyze: {
      eventId: string;
      event: ObjectsDetected;
      eventSource: ScryptedEventSource;
    }[] = [];
    const faceDetections: {
      label: string;
      boundingBox: ObjectDetectionResult["boundingBox"];
      inputDimensions: ObjectsDetected["inputDimensions"];
    }[] = [];
    const facesSourceForMqtt = this.facesSourceForMqtt;

    for (const det of this.mixinState.accumulatedDetections) {
      const facesSet = new Set<string>();
      dataToAnalyze.push({
        event: det.detect,
        eventSource: det.eventSource,
        eventId: det.eventId,
      });

      if (
        det.eventSource === facesSourceForMqtt ||
        facesSourceForMqtt === ScryptedEventSource.All
      ) {
        for (const innerDet of det.detect.detections) {
          const { className, label } = innerDet;
          if (isFaceClassname(className) && !facesSet.has(label)) {
            facesSet.add(label);
            faceDetections.push({
              label,
              inputDimensions: det.detect.inputDimensions,
              boundingBox: innerDet.boundingBox,
            });
          }
        }
      }
    }

    const rulesToUpdate = uniqBy(
      cloneDeep(this.mixinState.accumulatedRules),
      getDetectionKey,
    );

    // Clearing the buckets right away to not lose too many detections
    this.mixinState.accumulatedDetections = undefined;
    this.mixinState.accumulatedDetections = [];
    this.mixinState.accumulatedRules = undefined;
    this.mixinState.accumulatedRules = [];

    const triggerTime = dataToAnalyze[0]?.event.timestamp;
    const detections = uniqBy(
      dataToAnalyze.flatMap((item) => item.event.detections),
      (item) => `${item.className}-${item.label}`,
    );

    const isOnlyMotion =
      !rulesToUpdate.length &&
      detections.length === 1 &&
      detectionClassesDefaultMap[detections[0]?.className] ===
      DetectionClass.Motion;

    logger.debug(
      `Accumulated data to analyze: ${JSON.stringify({ triggerTime, detections, rules: rulesToUpdate.map(getDetectionKey) })}`,
    );

    let image: MediaObject;
    let b64Image: string;
    let imageSource: ImageSource;
    for (const data of dataToAnalyze) {
      const {
        event: { detectionId },
        eventId,
      } = data;
      if (detectionId) {
        const imageData = await this.getImage({
          detectionId,
          eventId,
          reason: GetImageReason.QuickNotification,
          skipResize: true,
        });

        if (imageData.imageSource === ImageSource.Detector) {
          image = imageData.image;
          b64Image = imageData.b64Image;
          imageSource = imageData.imageSource;

          break;
        }
      }
    }

    if (!image || !b64Image) {
      const imageData = await this.getImage({
        reason:
          isOnlyMotion && !rulesToUpdate.length
            ? GetImageReason.MotionUpdate
            : GetImageReason.ObjectUpdate,
      });

      image = imageData.image;
      b64Image = imageData.b64Image;
      imageSource = imageData.imageSource;
    }

    if (image && b64Image) {
      try {
        if (rulesToUpdate.length) {
          logger.info(
            `Updating accumulated rules ${getRulesLog(rulesToUpdate)} with image source ${imageSource}`,
          );
          for (const matchRule of rulesToUpdate) {
            const { match } = matchRule;

            logger.info(
              `Publishing accumulated detection rule ${getDetectionKey(matchRule)} data, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}. Has image ${!!image}`,
            );

            this.triggerRule({
              matchRule,
              skipTrigger: true,
              b64Image,
              device: this.cameraDevice,
              triggerTime,
              eventSource: ScryptedEventSource.RawDetection,
            }).catch(logger.error);

            this.notifyDetectionRule({
              triggerDeviceId: this.id,
              eventSource: NotifyRuleSource.AccumulatedDetection,
              matchRule,
              imageData: {
                image,
                imageSource,
              },
              eventType: detectionClassesDefaultMap[match.className],
              triggerTime,
            }).catch(logger.error);
          }
        }

        this.checkOccupancyData({
          image,
          b64Image,
          imageSource,
          source: "Detections",
        }).catch(logger.log);

        if (!isOnlyMotion && this.mixinState.runningTimelapseRules?.length) {
          for (const rule of this.mixinState.runningTimelapseRules) {
            const classnamesString = getDetectionsLog(detections);
            logger.log(
              `Adding detection frame from ${imageSource} (${classnamesString}) to the timelapse rule ${rule.name}`,
            );

            this.plugin
              .storeTimelapseFrame({
                imageMo: image,
                timestamp: triggerTime,
                device: this.cameraDevice,
                rule,
              })
              .catch(logger.log);
          }
        }

        if (!!faceDetections.length && this.isActiveForMqttReporting) {
          const mqttClient = await this.getMqttClient();
          if (mqttClient) {
            let inputDimensions: [number, number] =
              faceDetections[0].inputDimensions;

            if (!inputDimensions) {
              const convertedImage =
                await sdk.mediaManager.convertMediaObject<Image>(
                  image,
                  ScryptedMimeTypes.Image,
                );
              inputDimensions = [convertedImage.width, convertedImage.height];
            }

            const room = this.cameraDevice.room;
            if (room) {
              for (const faceDet of faceDetections) {
                const { label, boundingBox } = faceDet;
                const isDelayPassed = this.isDelayPassed({
                  type: DelayType.PeopleTrackerImageUpdate,
                  label,
                });
                if (isDelayPassed.timePassed) {
                  const { newB64Image } = await cropImageToDetection({
                    image,
                    boundingBox,
                    inputDimensions,
                    plugin: this.plugin,
                    sizeIncrease: 2,
                    console: logger,
                  });

                  if (newB64Image) {
                    publishPeopleData({
                      mqttClient,
                      console: logger,
                      faces: [label],
                      b64Image: newB64Image,
                      room: this.cameraDevice.room,
                      imageSource,
                      triggerTime,
                    }).catch(logger.error);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        logger.log(
          `Error on publishing data: ${JSON.stringify(dataToAnalyze)}`,
          e,
        );
      }
    } else {
      logger.debug(
        `Image not found for rules ${rulesToUpdate.map((rule) => rule.rule.name).join(",")}`,
      );
    }
  }

  get detectionSourceForMqtt(): ScryptedEventSource {
    const { detectionSourceForMqtt } = this.mixinState.storageSettings.values;
    const { detectionSourceForMqtt: detectionSourceForMqttPlugin } =
      this.plugin.storageSettings.values;

    let source: ScryptedEventSource;
    if (detectionSourceForMqtt !== ScryptedEventSource.Default) {
      source = detectionSourceForMqtt;
    } else {
      source = detectionSourceForMqttPlugin;
    }

    return source ?? ScryptedEventSource.All;
  }

  get facesSourceForMqtt(): ScryptedEventSource {
    const { facesSourceForMqtt } = this.mixinState.storageSettings.values;
    const { facesSourceForMqtt: facesSourceForMqttPlugin } =
      this.plugin.storageSettings.values;

    let source: ScryptedEventSource;
    if (facesSourceForMqtt !== ScryptedEventSource.Default) {
      source = facesSourceForMqtt;
    } else {
      source = facesSourceForMqttPlugin;
    }

    return source ?? ScryptedEventSource.All;
  }

  get zonesSourceForMqtt(): ZonesSource {
    const { zonesSourceForMqtt } = this.mixinState.storageSettings.values;
    const { zonesSourceForMqtt: zonesSourceForMqttPlugin } =
      this.plugin.storageSettings.values;

    let source: ZonesSource;
    if (zonesSourceForMqtt !== ZonesSource.Default) {
      source = zonesSourceForMqtt as ZonesSource;
    } else {
      source = zonesSourceForMqttPlugin as ZonesSource;
    }

    return source ?? ZonesSource.All;
  }

  async executeDetection(image: MediaObject) {
    const objectDetector: ObjectDetection & ScryptedDeviceBase =
      this.plugin.storageSettings.values.objectDetectionDevice;

    const detection = await objectDetector.detectObjects(image);

    return detection;
  }

  public async executeImagePostProcessing(props: {
    image: MediaObject;
    imageSource: ImageSource;
    shouldReDetect: boolean;
    eventSource: NotifyRuleSource;
    imageProcessing: ImagePostProcessing;
    className: string;
    label?: string;
    boundingBox?: ObjectDetectionResult["boundingBox"];
  }) {
    const {
      image,
      shouldReDetect,
      imageSource,
      eventSource,
      imageProcessing,
      className,
      label,
      boundingBox,
    } = props;
    const logger = this.getLogger();
    const objectDetector: ObjectDetection & ScryptedDeviceBase =
      this.plugin.storageSettings.values.objectDetectionDevice;

    const match: ObjectDetectionResult = {
      className,
      label,
      boundingBox,
      score: 1,
    };

    let processedImage: MediaObject;
    let processedB64Image: string;
    let error: string;

    if (image) {
      if (objectDetector) {
        let transformedDetections: ObjectDetectionResult[];

        const isAudio = isAudioClassname(className);
        if (shouldReDetect) {
          const detection = await this.executeDetection(image);
          logger.log(
            `Post-processing redetection results: ${JSON.stringify({
              detection,
              match,
            })}`,
          );

          if (detection.detections.length) {
            if (isAudio && label) {
              if (["crying", "yell"].includes(label)) {
                transformedDetections = detection.detections.filter(
                  (det) => det.className === DetectionClass.Person,
                );
              } else if (["bark"].includes(label)) {
                transformedDetections = detection.detections.filter(
                  (det) => det.className === DetectionClass.Animal,
                );
              } else {
                transformedDetections = detection.detections.filter(
                  (det) => det.className !== DetectionClass.Motion,
                );
              }
            } else {
              const matchingDetections = detection.detections.filter(
                (det) =>
                  det.className === className &&
                  (label ? det.label === label : true),
              );

              if (matchingDetections.length > 0) {
                if (label) {
                  transformedDetections = [matchingDetections[0]];
                } else if (boundingBox) {
                  const [targetX, targetY] = boundingBox;
                  let closestDetection = matchingDetections[0];
                  let minDistance = Infinity;

                  for (const det of matchingDetections) {
                    const [detX, detY] = det.boundingBox;
                    const distance = Math.sqrt(
                      Math.pow(detX - targetX, 2) + Math.pow(detY - targetY, 2),
                    );

                    if (distance < minDistance) {
                      minDistance = distance;
                      closestDetection = det;
                    }
                  }

                  transformedDetections = [closestDetection];
                }
              } else {
                transformedDetections = [];
              }
            }
          } else {
            logger.log(
              `Post-processing re-detection didn't find anything. ${JSON.stringify(
                {
                  detection,
                  match,
                },
              )}`,
            );
            error = "No detections re-detected";
            transformedDetections = [];
          }
        } else {
          transformedDetections = [match];
        }

        const canContinue =
          transformedDetections?.length ||
          eventSource === NotifyRuleSource.Test;
        if (canContinue && image) {
          const convertedImage =
            await sdk.mediaManager.convertMediaObject<Image>(
              image,
              ScryptedMimeTypes.Image,
            );
          const inputDimensions: [number, number] = [
            convertedImage.width,
            convertedImage.height,
          ];
          logger.log(
            `Post-processing starting with: ${JSON.stringify({
              transformedDetections,
              image: !!image,
              shouldReDetect,
              inputDimensions,
              eventSource,
              imageProcessing,
            })}`,
          );

          let shouldFallback = false;

          try {
            if (imageProcessing === ImagePostProcessing.MarkBoundaries) {
              if (transformedDetections.length) {
                const { newImage, newB64Image } = await addBoundingBoxesToImage(
                  {
                    image,
                    detections: transformedDetections,
                    inputDimensions,
                    plugin: this.plugin,
                  },
                );
                processedB64Image = newB64Image;
                processedImage = newImage;
              } else {
                shouldFallback = true;
              }
            } else if (imageProcessing === ImagePostProcessing.Crop) {
              if (transformedDetections.length) {
                try {
                  const { newB64Image, newImage } = await cropImageToDetection({
                    image,
                    boundingBox: transformedDetections[0].boundingBox,
                    inputDimensions,
                    plugin: this.plugin,
                    console: logger,
                  });

                  processedImage = newImage;
                  processedB64Image = newB64Image;
                } catch (e) {
                  error = e.message;
                  logger.error(
                    "Failed to crop image",
                    JSON.stringify({
                      transformedDetections,
                      inputDimensions,
                      error,
                      match,
                      imageProcessing,
                    }),
                  );
                }
              } else {
                shouldFallback = true;
              }
            } else {
              shouldFallback = true;
            }
          } catch (e) {
            error = e.message;
            logger.error(
              `Error during post-processing`,
              JSON.stringify({
                transformedDetections,
                inputDimensions,
                shouldReDetect,
                error,
                image: !!image,
                imageSource,
              }),
              e,
            );
          }

          if (shouldFallback) {
            processedB64Image = await moToB64(image);
            processedImage = image;
          }
        } else {
          logger.log(
            `Post-processing interrupted: ${JSON.stringify({
              transformedDetections,
              image: !!image,
              shouldReDetect,
            })}`,
          );

          processedImage = image;
          processedB64Image = await moToB64(image);
          error = "No matching detections re-detected";
        }
      }
    } else {
      logger.log(
        `Post-processing skipping, no image provided, ${JSON.stringify({
          match,
          imageProcessing,
        })}`,
      );

      error = "No image provided";
    }

    return {
      processedImage,
      processedB64Image,
      error,
    };
  }

  public async notifyDetectionRule(props: NotifyDetectionProps) {
    const { matchRule, imageData, eventSource, forceExecution } = props;
    const logger = this.getLogger();
    const { rule, match } = matchRule;
    const { detectionSource, imageProcessing: imageProcessingParent } =
      rule as DetectionRule;

    let imageProcessing = imageProcessingParent;

    const { timePassed, lastSetInSeconds, minDelayInSeconds } =
      this.isDelayPassed({
        type: DelayType.RuleNotification,
        matchRule: matchRule as MatchRule,
      });

    if (forceExecution || timePassed) {
      let croppedImage = imageData?.croppedImage;
      let fullFrameImage = imageData?.fullFrameImage;
      let markedImage = imageData?.markedImage;
      let imageSource = imageData?.imageSource;
      let image: MediaObject;
      let shouldReDetect = false;

      if (!imageData || !fullFrameImage) {
        let { image: newImage, imageSource: newImageSource } =
          await this.getImage({
            reason: GetImageReason.Notification,
            skipResize: imageProcessing === ImagePostProcessing.Crop,
          });

        fullFrameImage = newImage;
        imageSource = newImageSource;

        shouldReDetect = true;
      }

      let processingError: string;
      let imageToProcess: MediaObject;

      if (detectionSource === ScryptedEventSource.NVR) {
        if ([ImagePostProcessing.MarkBoundaries].includes(imageProcessing)) {
          imageToProcess = fullFrameImage;

          if (!fullFrameImage) {
            shouldReDetect = true;
          }
        } else if (imageProcessing === ImagePostProcessing.FullFrame) {
          image = fullFrameImage;
        } else if (
          [ImagePostProcessing.Default, ImagePostProcessing.Crop].includes(
            imageProcessing,
          )
        ) {
          image = croppedImage;
          imageProcessing = ImagePostProcessing.Crop;

          if (!image) {
            imageToProcess = fullFrameImage;
          }
        }
      } else if (detectionSource === ScryptedEventSource.RawDetection) {
        if (
          [
            ImagePostProcessing.Crop,
            ImagePostProcessing.MarkBoundaries,
          ].includes(imageProcessing)
        ) {
          imageToProcess = fullFrameImage;

          if (!fullFrameImage) {
            shouldReDetect = true;
          }
        } else if (
          [ImagePostProcessing.Default, ImagePostProcessing.FullFrame].includes(
            imageProcessing,
          )
        ) {
          image = fullFrameImage;
          imageProcessing = ImagePostProcessing.FullFrame;
        }
      } else if (detectionSource === ScryptedEventSource.Frigate) {
        if (imageProcessing === ImagePostProcessing.Crop) {
          imageToProcess = fullFrameImage;
          shouldReDetect = true;
        } else if (imageProcessing === ImagePostProcessing.MarkBoundaries) {
          imageToProcess = fullFrameImage;
          shouldReDetect = true;
        } else if (imageProcessing === ImagePostProcessing.Default) {
          image = markedImage ?? fullFrameImage;
        } else if (imageProcessing === ImagePostProcessing.FullFrame) {
          image = fullFrameImage;
        }
      }

      logger.log(
        `Preprocess notification image: ${JSON.stringify({
          shouldReDetect,
          imageSource,
          image: !!image,
          fullFrameImage: !!fullFrameImage,
          imageToProcess: !!imageToProcess,
          croppedImage: !!croppedImage,
          markedImage: !!markedImage,
          detectionSource,
          imageProcessing,
          imageProcessingParent,
        })}`,
      );

      if (imageToProcess) {
        const { error, processedImage } = await this.executeImagePostProcessing(
          {
            image: imageToProcess,
            imageProcessing,
            shouldReDetect,
            imageSource,
            eventSource,
            boundingBox: match.boundingBox,
            className: match.className,
            label: match.label,
          },
        );
        logger.log(
          `Post-processing result: ${JSON.stringify({
            hasError: !!error,
            error,
            processedImage: !!processedImage,
          })}`,
        );

        if (error) {
          if (rule.imageProcessing !== ImagePostProcessing.Crop) {
            image = imageToProcess;
          } else {
            processingError = error;
          }
        } else {
          image = processedImage;
        }
      }

      if (processingError) {
        logger.log(
          `Post-processing failed. Skipping notification and resetting delay to allow new detections to come through: ${processingError}`,
        );

        return;
      } else {
        if (!image) {
          image = imageData?.fullFrameImage;
        }

        if (!image && !isAudioClassname(match.className)) {
          logger.log(
            `Skipping notification, image was not provided: ${JSON.stringify({
              imageToProcess: !!imageToProcess,
              matchRule,
              shouldReDetect,
              imageSource,
              image: !!image,
              fullFrameImage: !!fullFrameImage,
              croppedImage: !!croppedImage,
            })}`,
          );
          return;
        } else if (imageToProcess) {
          logger.log(
            `Post-processing ${imageProcessing} successful. ${JSON.stringify({
              detectionSource,
              image: !!image,
              imageSource,
              shouldReDetect,
              imageProcessing,
              matchRule,
              fullFrameImage: !!imageData?.fullFrameImage,
              croppedImage: !!imageData?.croppedImage,
              imageToProcess: !!imageToProcess,
              srcImageSource: imageData?.imageSource,
            })}`,
          );
        }

        logger.log(
          `Starting notifiers for detection rule (${eventSource}) ${getDetectionKey(matchRule as MatchRule)}, detectionId ${matchRule.event?.detectionId || "-"}, decoder ${this.decoderType} image from ${imageSource}, last check ${lastSetInSeconds ? lastSetInSeconds + "s ago" : "-"} with delay ${minDelayInSeconds}s`,
        );
        logger.log(`Original event: ${JSON.stringify(matchRule.event)}`);

        if (match.id) {
          this.mixinState.objectIdLastReport[match.id] = Date.now();
        }

        if (image && rule.showActiveZones && match.zones?.length) {
          const detectionRule = rule as DetectionRule;
          const zoneRules = detectionRule.whitelistedZones;
          let zonesToShow: string[] = [];

          if (eventSource === NotifyRuleSource.Test) {
            zonesToShow = match.zones;
          } else if (zoneRules?.length) {
            zonesToShow = match.zones.filter((zone) =>
              zoneRules.includes(zone),
            );
          }

          if (zonesToShow.length) {
            logger.log(
              `Adding active zones to image: ${zonesToShow.join(", ")}`,
            );
            let clipPaths: number[][][] = [];

            if (detectionRule.detectionSource === ScryptedEventSource.Frigate) {
              const { frigateZones } = await this.getFrigateData();
              clipPaths = frigateZones
                .filter((zone) => zonesToShow.includes(zone.name))
                .map((zone) => zone.path);
            } else {
              const zonesData = await this.getObserveZones();
              clipPaths = zonesData
                .filter((zone) => zonesToShow.includes(zone.name))
                .map((zone) => zone.path);
            }
            const { newImage } = await addZoneClipPathToImage({
              image,
              clipPaths,
              console: logger,
              plugin: this.plugin,
            });

            if (newImage) {
              logger.log(
                `Active zones added successfully to image: ${zonesToShow.join(", ")}`,
              );

              image = newImage;
            }
          }
        }

        await this.plugin.notifyDetectionEvent({
          ...props,
          imageData: {
            image,
            imageSource,
          },
        });
      }
    }
  }

  isDelayPassed(props: IsDelayPassedProps) {
    const { type } = props;

    const detectionSourceForMqtt = this.detectionSourceForMqtt;

    let delayKey = `${type}`;
    let referenceTime = Date.now();
    let minDelayInSeconds: number;

    if (type === DelayType.BasicDetectionImage) {
      if (detectionSourceForMqtt === ScryptedEventSource.NVR) {
        minDelayInSeconds = undefined;
      } else {
        const { eventSource } = props;
        const { classname, label } = props;
        let key = !isPlateClassname(classname)
          ? `${classname}-${label}`
          : classname;
        key += `-${eventSource}`;
        delayKey += `-${key}`;

        const {
          updateFrequencyMotionImagesInSeconds,
          updateFrequencyObjectImagesInSeconds,
        } = this.plugin.storageSettings.values;

        minDelayInSeconds = isMotionClassname(classname)
          ? updateFrequencyMotionImagesInSeconds
          : updateFrequencyObjectImagesInSeconds;
      }
    } else if (type === DelayType.BasicDetectionTrigger) {
      const { classname, label } = props;
      const key = !isPlateClassname(classname)
        ? `${classname}-${label}`
        : classname;
      delayKey += `-${key}`;
      minDelayInSeconds = 5;
    } else if (type === DelayType.RuleImageUpdate) {
      const { matchRule } = props;
      const lastDetectionkey = getDetectionKey(matchRule);

      delayKey += `-${lastDetectionkey}`;
      minDelayInSeconds = matchRule.rule.minMqttPublishDelay;
    } else if (type === DelayType.RuleNotification) {
      const { matchRule } = props;
      const { minDelayTime } = this.mixinState.storageSettings.values;
      const lastDetectionkey = getDetectionKey(matchRule);

      delayKey += `-${lastDetectionkey}`;
      minDelayInSeconds = matchRule.rule.minDelay ?? minDelayTime;
    } else if (type === DelayType.EventRecording) {
      const { minDelay, lastEnd } = props;

      if (lastEnd) {
        referenceTime = lastEnd;
      }

      minDelayInSeconds = minDelay;
    } else if (type === DelayType.RuleMinCheck) {
      const { rule } = props;

      delayKey += `-${rule.name}`;
      minDelayInSeconds = 3;
    } else if (type === DelayType.OccupancyNotification) {
      const { matchRule } = props;

      delayKey += `-${matchRule.rule.name}`;
      minDelayInSeconds = 5;
    } else if (type === DelayType.PostWebhookImage) {
      const { classname } = props;
      const { postDetectionImageMinDelay } =
        this.mixinState.storageSettings.values;

      delayKey += `-${classname}`;
      minDelayInSeconds = postDetectionImageMinDelay;
    } else if (type === DelayType.FsImageUpdate) {
      const { filename } = props;

      delayKey += `-${filename}`;
      minDelayInSeconds = 5;
    } else if (type === DelayType.DecoderFrameOnStorage) {
      minDelayInSeconds =
        this.mixinState.storageSettings.values.decoderFrequency / 1000;
    } else if (type === DelayType.OccupancyRegularCheck) {
      const { occupancySourceForMqtt } = this.mixinState.storageSettings.values;
      minDelayInSeconds =
        !!this.mixinState.runningOccupancyRules.length ||
          occupancySourceForMqtt !== OccupancySource.Off
          ? 0.3
          : 0;
    } else if (type === DelayType.SequenceExecution) {
      const { delay, postFix } = props;
      delayKey += `-${postFix}`;
      minDelayInSeconds = delay ?? 15;
    } else if (type === DelayType.EventStore) {
      const { identifiers } = props;

      if (identifiers.length === 1 && isMotionClassname(identifiers[0])) {
        delayKey = `${DelayType.EventStore}_motion`;
        minDelayInSeconds = 30;
      } else {
        delayKey = `${DelayType.EventStore}`;
        minDelayInSeconds = 6;
      }
    } else if (type === DelayType.PeopleTrackerImageUpdate) {
      delayKey = `${DelayType.PeopleTrackerImageUpdate}_label`;
      minDelayInSeconds = 5;
    }

    const isOnPlugin = type === DelayType.SequenceExecution;

    const lastSetTime = isOnPlugin
      ? this.plugin.lastDelaySet[delayKey]
      : this.mixinState.lastDelaySet[delayKey];
    const timePassed =
      !lastSetTime || !minDelayInSeconds
        ? true
        : referenceTime - lastSetTime >= minDelayInSeconds * 1000;
    const lastSetInSeconds = lastSetTime
      ? (referenceTime - lastSetTime) / 1000
      : undefined;

    this.getLogger().debug(
      `Is delay passed for ${delayKey}: ${timePassed}, last set ${lastSetInSeconds}. ${JSON.stringify(props)}`,
    );

    if (timePassed) {
      if (isOnPlugin) {
        this.plugin.lastDelaySet[delayKey] = referenceTime;
      } else {
        this.mixinState.lastDelaySet[delayKey] = referenceTime;
      }
    }

    return {
      timePassed,
      lastSetInSeconds,
      minDelayInSeconds,
      delayKey,
    };
  }

  async onRestart() {
    this.mixinState.storageSettings.values.delayPassedData = JSON.stringify(
      this.mixinState.lastDelaySet,
    );
  }

  async checkDetectionRuleMatches(props: {
    candidates: ObjectDetectionResult[];
    rule: DetectionRule;
    isAudioEvent: boolean;
    isAnimalEvent: boolean;
    isVehicleEvent: boolean;
    eventSource: ScryptedEventSource;
    image: MediaObject;
    detect: ObjectsDetected;
  }) {
    const {
      eventSource,
      rule,
      candidates,
      isAudioEvent,
      isAnimalEvent,
      isVehicleEvent,
      image,
      detect,
    } = props;
    const logger = this.getLogger();
    const { ignoreCameraDetections } = this.mixinState.storageSettings.values;

    const {
      detectionClasses,
      scoreThreshold,
      whitelistedZones,
      blacklistedZones,
      people,
      plates,
      plateMaxDistance,
      labelScoreThreshold,
      audioLabels,
      animalLabels,
      vehicleLabels,
      detectionSource,
      clipDescription,
      clipConfidence,
      aiFilter,
    } = rule;
    const isRuleFromFrigate = detectionSource === ScryptedEventSource.Frigate;
    const isRuleRawDetection =
      detectionSource === ScryptedEventSource.RawDetection;
    const isDetectionFromNvr = eventSource === ScryptedEventSource.NVR;

    const { clipDevice } = this.plugin.storageSettings.values;

    const matchRules: MatchRule[] = [];
    const report: any[] = [];

    for (const d of candidates) {
      let dataToReport: any = {};
      const {
        className: classnameRaw,
        score,
        zones,
        label,
        labelScore,
        embedding,
        id,
      } = d;

      const className = detectionClassesDefaultMap[classnameRaw];

      const shouldHaveBoundingBox =
        isObjectClassname(className) ||
        isFaceClassname(className) ||
        isPlateClassname(className);

      if (ignoreCameraDetections && shouldHaveBoundingBox && !d.boundingBox) {
        continue;
      }

      if (!className) {
        logger.log(
          `Classname ${classnameRaw} not mapped. Candidates ${JSON.stringify(candidates)}`,
        );

        continue;
      }

      if (!detectionClasses.includes(className)) {
        logger.debug(
          `Classname ${className} not contained in ${detectionClasses}`,
        );

        continue;
      }

      if (
        people?.length &&
        isFaceClassname(className) &&
        (!label || !people.includes(label))
      ) {
        logger.debug(`Face ${label} not contained in ${people}`);

        continue;
      }

      if (plates?.length && isPlateClassname(className)) {
        const anyValidPlate = plates.some(
          (plate) => levenshteinDistance(plate, label) > plateMaxDistance,
        );

        if (!anyValidPlate) {
          logger.debug(`Plate ${label} not contained in ${plates}`);

          continue;
        }
      }

      if (isPlateClassname(className) || isFaceClassname(className)) {
        const labelScoreOk = !labelScore || labelScore > labelScoreThreshold;

        if (!labelScoreOk) {
          logger.debug(
            `Label score ${labelScore} not ok ${labelScoreThreshold}`,
          );

          continue;
        }
      }

      if (audioLabels && isAudioEvent) {
        if (audioLabels.length && !audioLabels.includes(label)) {
          logger.debug(`Audio label ${label} not whitelisted ${audioLabels}`);

          continue;
        }
      }

      if (animalLabels && isAnimalEvent) {
        if (animalLabels.length && !animalLabels.includes(label)) {
          logger.debug(`Animal label ${label} not whitelisted ${animalLabels}`);

          continue;
        }
      }

      if (vehicleLabels && isVehicleEvent) {
        if (vehicleLabels.length && !vehicleLabels.includes(label)) {
          logger.debug(
            `Vehicle label ${label} not whitelisted ${vehicleLabels}`,
          );

          continue;
        }
      }

      const scoreOk = !score || score > scoreThreshold;

      if (!scoreOk) {
        logger.debug(`Score ${score} not ok ${scoreThreshold}`);

        continue;
      }

      dataToReport = {
        zones,

        score,
        scoreThreshold,
        scoreOk,

        className,
        detectionClasses,
      };

      let zonesOk = true;
      const isPlugin = rule.source === RuleSource.Plugin;

      const isIncluded = whitelistedZones?.length
        ? zones?.some((zone) => {
          const zoneName = isPlugin ? `${this.name}::${zone}` : zone;
          return whitelistedZones.includes(zoneName);
        })
        : true;
      const isExcluded = blacklistedZones?.length
        ? zones?.some((zone) => {
          const zoneName = isPlugin ? `${this.name}::${zone}` : zone;
          return blacklistedZones.includes(zoneName);
        })
        : false;

      zonesOk = isIncluded && !isExcluded;

      dataToReport = {
        ...dataToReport,
        zonesOk,
        isIncluded,
        isExcluded,
      };

      if (!zonesOk) {
        logger.debug(`Zones ${zones} not ok`);

        continue;
      }

      let similarityOk = true;
      if (clipDescription && clipDevice) {
        // For now just go ahead if it's a raw detection and it has already embedding from NVR,
        // or if it's an NVR notification. Could add a configuration to always calculate embedding on clipped images
        const canCheckSimilarity =
          (isRuleRawDetection && embedding) || isDetectionFromNvr;
        if (canCheckSimilarity) {
          try {
            const similarityScore = await getEmbeddingSimilarityScore({
              deviceId: clipDevice?.id,
              text: clipDescription,
              image,
              imageEmbedding: embedding,
              detId: id,
              plugin: this.plugin,
            });

            const threshold =
              similarityConcidenceThresholdMap[clipConfidence] ?? 0.25;
            if (similarityScore < threshold) {
              similarityOk = false;
            }

            logger.info(
              `Embedding similarity score for rule ${rule.name} (${clipDescription}): ${similarityScore} -> ${threshold}`,
            );
          } catch (e) {
            logger.error("Error calculating similarity", e);
          }
        } else {
          similarityOk = false;
        }
      }

      if (!similarityOk) {
        continue;
      }

      const matchRule: MatchRule = {
        match: d,
        rule,
        dataToReport,
        event: detect,
      };
      matchRules.push(matchRule);

      report.push(dataToReport);
    }

    let aiFilterMatches = true;
    if (aiFilter) {
      if (image) {
        const b64Image = await moToB64(image);
        logger.log(
          `Sending confirmation question to LLM for filter "${aiFilter}"`,
        );
        const confirmationFromAi = await confirmDetection({
          b64Image,
          logger,
          plugin: this.plugin,
          prompt: aiFilter,
        });
        logger.log(
          `LLM response for aiFilter "${aiFilter}" response: ${JSON.stringify(confirmationFromAi)}`,
        );
        aiFilterMatches = confirmationFromAi.response === "yes";
      } else {
        logger.log(`Skipping LLM filter "${aiFilter}", no image available`);
        aiFilterMatches = false;
      }
    }

    return {
      matchRules: aiFilterMatches ? matchRules : undefined,
      report,
    };
  }

  public async processDetections(props: {
    detect: ObjectsDetected;
    eventDetails?: EventDetails;
    image?: MediaObject;
    eventSource?: ScryptedEventSource;
  }) {
    const { detect, eventDetails, image: parentImage, eventSource } = props;
    const isDetectionFromNvr = eventSource === ScryptedEventSource.NVR;
    const isDetectionFromFrigate = eventSource === ScryptedEventSource.Frigate;
    const logger = this.getLogger();
    const { timestamp: triggerTimeParent, detections } = detect;
    const detectionSourceForMqtt = this.detectionSourceForMqtt;
    const facesSourceForMqtt = this.facesSourceForMqtt;
    let triggerTime = triggerTimeParent ?? Date.now();

    // logger.info(`Raw detections received: ${JSON.stringify({ detect, eventDetails, hasImage: !!parentImage, eventSource })}`)

    if (!detections?.length) {
      return;
    }

    const { minDelayTime, ignoreCameraDetections } =
      this.mixinState.storageSettings.values;

    const {
      candidates,
      facesFound,
      isAudioEvent,
      isAnimalEvent,
      isVehicleEvent,
    } = filterAndSortValidDetections({
      detect,
      logger,
      objectIdLastReport: this.mixinState.objectIdLastReport,
    });

    this.processPatrolBlockingDetections(candidates);

    if (this.mixinState.recordingState.recordingStartTime) {
      candidates.forEach((c) => {
        const dc = detectionClassesDefaultMap[c.className];
        if (dc) {
          this.mixinState.recordingState.recordingClassesDetected.add(dc);
        }
      });
    }

    const originalCandidates = cloneDeep(candidates);

    let detectionId: string = detect?.detectionId;
    let eventId: string =
      eventDetails?.eventId ??
      (detectionId
        ? this.mixinState.detectionIdEventIdMap[detectionId]
        : undefined);

    if (eventDetails && this.processDetectionsInterval) {
      this.mixinState.accumulatedDetections.push({
        detect: {
          ...detect,
          detections: cloneDeep(candidates),
        },
        eventId,
        eventSource,
      });
    }

    let croppedImage: MediaObject;
    let croppedImageB64Image: string;
    let markedImage: MediaObject;
    let markedImageB64Image: string;
    let fullFrameImage: MediaObject;
    let fullFrameB64Image: string;
    let imageSource: ImageSource;

    if (parentImage) {
      if (isDetectionFromNvr) {
        croppedImage = parentImage;
        croppedImageB64Image = await moToB64(parentImage);
      } else if (isDetectionFromFrigate) {
        markedImage = parentImage;
        markedImageB64Image = await moToB64(parentImage);
      }
    }

    if (detectionId) {
      this.mixinState.detectionIdEventIdMap[detectionId] = eventId;
      const classnamesLog = getDetectionsLog(detections);

      const {
        b64Image: decoderB64ImagFound,
        image: decoderImageFound,
        imageSource: newImageSource,
      } = await this.getImage({
        eventId,
        detectionId,
        reason: GetImageReason.QuickNotification,
        skipResize: true,
      });

      fullFrameB64Image = decoderB64ImagFound;
      fullFrameImage = decoderImageFound;
      imageSource = newImageSource;

      logger.info(
        `${eventSource} detections received, classnames ${classnamesLog}`,
      );
    }

    let mqttFsImage: MediaObject;
    let mqttFsB64Image: string;
    let mqttFsImageSource = ImageSource.NotFound;

    try {
      const canUpdateDetectionsOnMqtt =
        eventSource === detectionSourceForMqtt ||
        detectionSourceForMqtt === ScryptedEventSource.All;
      const canUpdateFacesOnMqtt =
        eventSource === facesSourceForMqtt ||
        facesSourceForMqtt === ScryptedEventSource.All;

      if (isDetectionFromNvr) {
        mqttFsImage = croppedImage;
        mqttFsB64Image = croppedImageB64Image;
        mqttFsImageSource = ImageSource.Input;
      }
      if (isDetectionFromFrigate) {
        mqttFsImage = markedImage;
        mqttFsB64Image = markedImageB64Image;
        mqttFsImageSource = ImageSource.Input;
      } else if (fullFrameImage) {
        mqttFsImage = fullFrameImage;
        mqttFsB64Image = fullFrameB64Image;
        mqttFsImageSource = ImageSource.Decoder;
      }

      if (this.isActiveForMqttReporting) {
        const mqttClient = await this.getMqttClient();
        if (mqttClient) {
          if (facesFound.length) {
            const room = this.cameraDevice.room;
            if (room) {
              let b64Image = croppedImageB64Image;
              if (canUpdateFacesOnMqtt) {
                if (eventSource === ScryptedEventSource.Frigate) {
                  logger.log(`Face tracker from Frigat not yet supported`);
                  b64Image = undefined;
                }

                if (b64Image) {
                  publishPeopleData({
                    mqttClient,
                    console: logger,
                    faces: facesFound,
                    b64Image,
                    room: this.cameraDevice.room,
                    imageSource: ImageSource.Input,
                    triggerTime,
                  }).catch(logger.error);
                }
              }
            }
          }

          if (canUpdateDetectionsOnMqtt) {
            if (mqttClient) {
              if (
                candidates.some((elem) => isObjectClassname(elem.className))
              ) {
                candidates.push({
                  className: DetectionClass.AnyObject,
                  score: 1,
                });
              }

              const spamBlockedDetections = candidates.filter(
                (det) =>
                  this.isDelayPassed({
                    type: DelayType.BasicDetectionTrigger,
                    classname: det.className,
                    label: det.label,
                    eventSource,
                  })?.timePassed,
              );

              if (spamBlockedDetections.length) {
                if (mqttFsImageSource === ImageSource.NotFound) {
                  const {
                    b64Image: b64ImageNew,
                    image: imageNew,
                    imageSource: imageSourceNew,
                  } = await this.getImage({
                    reason: isDetectionFromFrigate
                      ? GetImageReason.FromFrigate
                      : GetImageReason.MotionUpdate,
                  });

                  mqttFsB64Image = b64ImageNew;
                  mqttFsImageSource = imageSourceNew;
                }

                logger.info(
                  `Triggering basic detections ${getDetectionsLog(spamBlockedDetections)}`,
                );
                let detectionsPerZone: DetectionsPerZone | undefined;
                const zonesSourceForMqtt = this.zonesSourceForMqtt;
                const canUpdateZonesOnMqtt =
                  zonesSourceForMqtt === ZonesSource.Frigate
                    ? isDetectionFromFrigate
                    : true;

                if (canUpdateZonesOnMqtt) {
                  detectionsPerZone = getDetectionsPerZone(
                    spamBlockedDetections,
                  );
                }

                for (const detection of spamBlockedDetections) {
                  const { className, label } = detection;

                  publishBasicDetectionData({
                    mqttClient,
                    console: logger,
                    detection,
                    detectionsPerZone,
                    device: this.cameraDevice,
                    triggerTime,
                  }).catch(logger.error);

                  if (mqttFsB64Image) {
                    const { timePassed } = this.isDelayPassed({
                      classname: className,
                      label,
                      eventSource,
                      type: DelayType.BasicDetectionImage,
                    });

                    if (timePassed) {
                      logger.info(
                        `Updating image for classname ${className} source: ${eventSource ? "NVR" : "Decoder"}`,
                      );
                      const detectionsPerZone = getDetectionsPerZone([
                        detection,
                      ]);

                      publishClassnameImages({
                        mqttClient,
                        console: logger,
                        detections: [detection],
                        device: this.cameraDevice,
                        b64Image: mqttFsB64Image,
                        triggerTime,
                        detectionsPerZone,
                      }).catch(logger.error);
                    }
                  }
                }

                this.resetDetectionEntities({
                  resetSource: "Timeout",
                }).catch(logger.log);
              }
            }
          }
        }
      }

      if (mqttFsB64Image) {
        this.plugin.storeDetectionImages({
          device: this.cameraDevice,
          timestamp: triggerTime,
          b64Image: mqttFsB64Image,
          detections,
          eventSource,
        });
      }

      if (
        fullFrameB64Image &&
        fullFrameImage &&
        this.plugin.storageSettings.values.storeEvents
      ) {
        logger.info(
          `Storing ${eventSource} event image: ${JSON.stringify({
            detections,
            candidates,
          })}`,
        );

        const storeEventId = getDetectionEventKey({ detectionId, eventId });

        this.plugin
          .storeEventImage({
            b64Image: fullFrameB64Image,
            detections: originalCandidates,
            device: this.cameraDevice,
            eventSource,
            logger,
            timestamp: triggerTime,
            image: fullFrameImage,
            eventId: storeEventId,
            detectionId,
          })
          .catch(logger.error);
      }
    } catch (e) {
      logger.log("Error parsing detections", e);
    }

    try {
      const rules =
        cloneDeep(
          this.mixinState.runningDetectionRules.filter(
            (rule) =>
              rule.detectionSource === eventSource &&
              rule.currentlyActive &&
              rule.detectionClasses?.length,
          ),
        ) ?? [];

      logger.debug(
        `Detections incoming ${JSON.stringify({
          candidates,
          detect,
          minDelayTime,
          ignoreCameraDetections,
          rules,
        })}`,
      );

      for (const rule of rules) {
        const ruleImage = mqttFsImage;
        const ruleB64Image = mqttFsB64Image;

        const { report, matchRules } = await this.checkDetectionRuleMatches({
          rule,
          candidates,
          isAudioEvent,
          detect,
          eventSource,
          image: ruleImage,
          isAnimalEvent,
          isVehicleEvent,
        });

        if (matchRules?.length) {
          ruleImage &&
            logger.info(
              `checkDetectionRuleMatches result ${JSON.stringify(report)}`,
            );
          for (const matchRule of matchRules) {
            if (ruleImage) {
              this.notifyDetectionRule({
                triggerDeviceId: this.id,
                eventSource: NotifyRuleSource.Decoder,
                matchRule,
                imageData: {
                  croppedImage,
                  markedImage,
                  fullFrameImage,
                  imageSource,
                },
                eventType:
                  detectionClassesDefaultMap[matchRule.match.className],
                triggerTime,
              }).catch(logger.log);
            } else {
              this.mixinState.accumulatedRules.push(matchRule);
            }

            logger.info(
              `Publishing detection rule ${matchRule.rule.name} data, b64Image ${getB64ImageLog(ruleB64Image)}`,
            );

            this.triggerRule({
              matchRule,
              b64Image: ruleB64Image,
              device: this.cameraDevice,
              triggerTime,
              eventSource,
            }).catch(logger.log);
          }
        }
      }

      const recordingRules =
        cloneDeep(
          this.mixinState.runningRecordingRules.filter(
            (rule) =>
              rule.currentlyActive &&
              rule.detectionClasses?.length &&
              rule.detectionClasses.some((dc) =>
                candidates.some((c) => {
                  const mappedClass = detectionClassesDefaultMap[c.className];
                  if (mappedClass !== dc) {
                    return false;
                  }

                  const hasScoreThreshold =
                    rule.scoreThreshold !== undefined &&
                    rule.scoreThreshold !== null;
                  if (!hasScoreThreshold) {
                    return true;
                  }

                  return (
                    c.score === undefined || c.score >= rule.scoreThreshold
                  );
                }),
              ),
          ),
        ) ?? [];

      if (recordingRules.length) {
        await this.startRecording({
          triggerTime,
          rules: recordingRules,
          candidates,
        });
      }
    } catch (e) {
      logger.log("Error finding a match", e);
    }
  }

  resetMqttMotionTimeout() {
    this.mixinState.mqttDetectionMotionTimeout &&
      clearTimeout(this.mixinState.mqttDetectionMotionTimeout);
    this.mixinState.mqttDetectionMotionTimeout = undefined;
  }

  resetRuleTriggerTimeout(ruleName: string) {
    this.mixinState.detectionRuleListeners[ruleName]?.turnOffTimeout &&
      clearTimeout(
        this.mixinState.detectionRuleListeners[ruleName]?.turnOffTimeout,
      );
    this.mixinState.detectionRuleListeners[ruleName] = {
      ...this.mixinState.detectionRuleListeners[ruleName],
      turnOffTimeout: undefined,
    };
  }

  async startDoorbellListener() {
    try {
      const logger = this.getLogger();

      this.binaryListener && this.binaryListener.removeListener();
      this.binaryListener = systemManager.listenDevice(
        this.id,
        {
          event: ScryptedInterface.BinarySensor,
        },
        async (_, __, data) => {
          const now = Date.now();

          if (data) {
            const { image, imageSource, b64Image } = await this.getImage({
              reason: GetImageReason.Sensor,
            });
            logger.log(`Doorbell event detected, image found ${imageSource}`);
            const detections: ObjectDetectionResult[] = [
              {
                className: DetectionClass.Doorbell,
                score: 1,
              },
            ];

            this.processDetections({
              detect: { timestamp: now, detections },
              eventSource: ScryptedEventSource.RawDetection,
              image,
            }).catch(logger.log);

            if (this.plugin.storageSettings.values.storeEvents) {
              this.plugin
                .storeEventImage({
                  b64Image,
                  detections: [
                    { className: DetectionClass.Doorbell, score: 1 },
                  ],
                  device: this.cameraDevice,
                  eventSource: ScryptedEventSource.RawDetection,
                  logger,
                  timestamp: now,
                  image,
                })
                .catch(logger.error);
            }
          } else {
            this.resetDetectionEntities({
              resetSource: "MotionSensor",
              classnames: [DetectionClass.Doorbell],
            }).catch(logger.log);
          }
        },
      );
    } catch (e) {
      this.getLogger().log("Error in startBinaryListener", e);
    }
  }

  async startAudioVolumeControlsListener() {
    try {
      const logger = this.getLogger();

      this.stopAudioVolumeControlsListener();

      this.audioVolumesListener = systemManager.listenDevice(
        this.id,
        {
          event: ScryptedInterface.AudioVolumeControl,
        },
        async (_, __, data) => {
          const now = Date.now();

          if (data) {
            this.processAudioDetection({
              dBs: data?.dBFS,
            }).catch(logger.log);
          }
        },
      );
    } catch (e) {
      this.getLogger().log("Error in startAudioVolumeControlsListener", e);
    }
  }

  async startObjectDetectionListeners() {
    try {
      const logger = this.getLogger();

      this.detectionListener && this.detectionListener.removeListener();
      this.detectionListener = systemManager.listenDevice(
        this.id,
        {
          event: ScryptedInterface.ObjectDetector,
        },
        async (_, eventDetails, data) => {
          let detect: ObjectsDetected = data;

          let eventSource = ScryptedEventSource.RawDetection;

          if (detect.sourceId === FRIGATE_BRIDGE_PLUGIN_ID) {
            logger.info(
              "Frigate detection event received",
              JSON.stringify(detect),
            );
            eventSource = ScryptedEventSource.Frigate;
          }

          logger.debug(JSON.stringify({ _, eventDetails, data }));

          this.processDetections({ detect, eventDetails, eventSource }).catch(
            logger.log,
          );
        },
      );

      this.motionListener = systemManager.listenDevice(
        this.id,
        {
          event: ScryptedInterface.MotionSensor,
        },
        async (_, __, data) => {
          const now = Date.now();
          const decoderType = this.decoderType;
          const shouldUseDecoder = decoderType === DecoderType.OnMotion;

          if (data) {
            this.plugin.cameraMotionActive.add(this.id);
            const timestamp = now;
            const detections: ObjectDetectionResult[] = [
              {
                className: "motion",
                score: 1,
              },
            ];
            this.processDetections({
              detect: { timestamp, detections },
              eventSource: ScryptedEventSource.RawDetection,
            }).catch(logger.log);

            if (shouldUseDecoder) {
              this.startDecoder("StartMotion").catch(logger.error);
            }
          } else {
            this.plugin.cameraMotionActive.delete(this.id);
            this.mixinState.detectionIdEventIdMap = {};
            this.mixinState.objectIdLastReport = {};
            this.mixinState.lastMotionEnd = now;
            this.resetDetectionEntities({
              resetSource: "MotionSensor",
            }).catch(logger.log);

            if (shouldUseDecoder) {
              this.stopDecoder("EndMotion");
            }
          }
        },
      );
    } catch (e) {
      this.getLogger().log("Error in startObjectDetectionListeners", e);
    }
  }

  async resetDetectionEntities(props: {
    resetSource: "MotionSensor" | "Timeout";
    classnames?: DetectionClass[];
  }) {
    const { resetSource, classnames } = props;
    const isFromSensor = resetSource === "MotionSensor";
    const logger = this.getLogger();
    const mqttClient = await this.getMqttClient();

    if (!mqttClient) {
      return;
    }

    const funct = async () => {
      logger.info(
        `Resetting basic detections ${classnames ?? "All"}, signal coming from ${resetSource}`,
      );
      const zones = await this.getMqttZones();

      await publishResetDetectionsEntities({
        mqttClient,
        device: this.cameraDevice,
        console: logger,
        classnames,
        zones,
      });
    };

    if (isFromSensor) {
      if (this.mixinState.mqttDetectionMotionTimeout) {
        await funct();
        this.resetMqttMotionTimeout();
      }
    } else {
      this.resetMqttMotionTimeout();

      const { motionDuration } = this.mixinState.storageSettings.values;
      this.mixinState.mqttDetectionMotionTimeout = setTimeout(async () => {
        await funct();
      }, motionDuration * 1000);
    }
  }

  async resetRuleEntities(rule: BaseRule) {
    const logger = this.getLogger();
    const mqttClient = await this.getMqttClient();
    if (!mqttClient) {
      return;
    }

    const { motionDuration } = this.mixinState.storageSettings.values;

    const turnOffTimeout = setTimeout(async () => {
      logger.info(`Rule ${rule.name} trigger entities reset`);

      await publishResetRuleEntities({
        mqttClient,
        device: this.cameraDevice,
        console: logger,
        rule,
      });

      this.plugin
        .triggerRuleSequences({
          sequences: rule.onResetSequences,
          postFix: "reset",
          rule,
          deviceId: this.cameraDevice.id,
        })
        .catch(logger.error);
    }, motionDuration * 1000);

    const ruleName = rule.name;
    this.resetRuleTriggerTimeout(ruleName);

    this.mixinState.detectionRuleListeners[ruleName] = {
      ...this.mixinState.detectionRuleListeners[ruleName],
      turnOffTimeout,
    };
  }

  async getFrameGenerator() {
    const pipelines = getAllDevices().filter((d) =>
      d.interfaces.includes(ScryptedInterface.VideoFrameGenerator),
    );
    const webassembly =
      sdk.systemManager.getDeviceById(NVR_PLUGIN_ID, "decoder") || undefined;
    const ffmpeg =
      sdk.systemManager.getDeviceById(VIDEO_ANALYSIS_PLUGIN_ID, "ffmpeg") ||
      undefined;
    const use =
      pipelines.find((p) => p.name === "Default") || webassembly || ffmpeg;

    return {
      pipelines,
      use,
    };
  }

  async createFrameGenerator(
    skipDecoder?: boolean,
  ): Promise<AsyncGenerator<VideoFrame, any, unknown>> {
    const logger = this.getLogger();
    const stream = await this.cameraDevice.getVideoStream({
      prebuffer: 0,
      destination: this.mixinState.decoderStream,
      audio: null,
    });

    const frameGeneratorData = await this.getFrameGenerator();

    logger.info(
      `Camera decoder check: ${JSON.stringify({
        streamFound: !!stream,
        destination: this.mixinState.decoderStream,
        frameGeneratorData,
        skipDecoder,
      })}`,
    );

    if (!skipDecoder) {
      return stream as unknown as AsyncGenerator<VideoFrame, any, unknown>;
    }

    const videoFrameGenerator =
      systemManager.getDeviceById<VideoFrameGenerator>(
        frameGeneratorData.use?.id,
      );

    if (!videoFrameGenerator) throw new Error("invalid VideoFrameGenerator");

    try {
      return await videoFrameGenerator.generateVideoFrames(stream, {
        queue: 0,
      });
    } finally {
    }
  }

  getAudioClassifier() {
    let pluginName: string;
    const { audioClassifierSource } = this.mixinState.storageSettings.values;
    if (!this.audioClassifier) {
      const { device, pluginName: pluginNameFound } =
        this.plugin.getAudioAnalysisDevice(audioClassifierSource);
      this.audioClassifier = device;
      pluginName = pluginNameFound;
    }

    return { device: this.audioClassifier, pluginName, audioClassifierSource };
  }

  async restartAudioAnalysis() {
    if (this.isActiveForAudioAnalysis) {
      await this.stopAudioAnalysis();
      await this.startAudioAnalyzer();
    }
  }

  async stopAudioAnalysis() {
    try {
      const { audioAnalyzerProcessPid } =
        this.mixinState.storageSettings.values;
      if (audioAnalyzerProcessPid) {
        process.kill(parseInt(audioAnalyzerProcessPid));
        this.mixinState.storageSettings.values.audioAnalyzerProcessPid =
          undefined;
      }
      this.audioRtspFfmpegStream?.stop();
      this.audioRtspFfmpegStream = undefined;
    } catch { }
  }

  async startAudioAnalyzer() {
    const logger = this.getLogger();
    const ffmpegPath = await sdk.mediaManager.getFFmpegPath();

    if (this.audioRtspFfmpegStream) {
      this.audioRtspFfmpegStream.stop();
      this.audioRtspFfmpegStream = undefined;
    }
    await this.stopAudioAnalysis();

    if (!this.mixinState.storageSettings.values.audioAnalyzerEnabled) {
      logger.log("Audio analyzer is disabled, not starting.");
      return;
    }

    let rtspUrl: string;

    const { audioAnalyzerStreamName, audioAnalyzerCustomStreamUrl } =
      this.mixinState.storageSettings.values;

    if (audioAnalyzerCustomStreamUrl) {
      rtspUrl = audioAnalyzerCustomStreamUrl;
      logger.log(`Rebroadcast URL manually set: ${getUrlLog(rtspUrl)}`);
    } else if (audioAnalyzerStreamName) {
      const rebroadcastConfig = this.streams.find(
        (setting) => setting.subgroup === `Stream: ${audioAnalyzerStreamName}`,
      );
      rtspUrl = rebroadcastConfig?.value as string;

      logger.log(
        `Rebroadcast URL found: ${JSON.stringify({
          url: getUrlLog(rtspUrl),
          streamName: audioAnalyzerStreamName,
          rebroadcastConfig,
        })}`,
      );
    }

    if (!rtspUrl) {
      logger.error(`URL not set, check settings`);
      return;
    }

    this.audioRtspFfmpegStream = new AudioRtspFfmpegStream({
      rtspUrl,
      ffmpegPath,
      console: logger,
    });

    const pid = this.audioRtspFfmpegStream.start();
    this.mixinState.storageSettings.values.audioAnalyzerProcessPid =
      String(pid);
    const {
      device: classifier,
      pluginName,
      audioClassifierSource,
    } = this.getAudioClassifier();

    if (
      !classifier &&
      !this.plugin.audioClassifierMissingLogged.has(audioClassifierSource)
    ) {
      this.plugin.log.a(
        `Audio classifier device for source ${audioClassifierSource} not found. Install plugin "${pluginName}" to enable audio analysis.`,
      );
      this.plugin.audioClassifierMissingLogged.add(audioClassifierSource);
    }

    this.audioRtspFfmpegStream.on("audio", (audioData) => {
      const { db, rms, float32Samples, audio, int16Samples, mean, stddev } =
        audioData as AudioChunkData;
      const { audioAnalyzerSensitivity } =
        this.mixinState.storageSettings.values;

      logger.info(
        `Audio analysis volumes detected: ${JSON.stringify({ db, rms, mean, stddev, audioAnalyzerSensitivity })}`,
      );
      logger.debug(
        `Audio data: ${JSON.stringify({ int16Samples, audio, float32Samples })}`,
      );

      if (db !== undefined) {
        this.processAudioDetection({
          dBs: db,
        }).catch(logger.error);
      }

      if (this.shouldClassifyAudio && this.audioClassifier) {
        const threshold = sensitivityDbThresholds[audioAnalyzerSensitivity];
        if (db > threshold) {
          logger.debug(
            `Audio classification triggered, db ${db} above threshold ${threshold}`,
          );
          const chunk = Array.from(float32Samples).slice(0, 15600);
          executeAudioClassification({
            chunk,
            logger,
            source: AudioAnalyzerSource.YAMNET,
            labels: this.audioClassificationLabels,
            threshold,
            classifierDevice: this.audioClassifier,
          }).then(async (detect) => {
            if (detect) {
              logger.info(
                `Audio classification result: ${JSON.stringify(detect)}`,
              );
              this.processDetections({
                detect,
                eventSource: ScryptedEventSource.RawDetection,
              }).catch(logger.error);
            }
          });
        }
      }
    });
  }

  async startRecording(props: {
    triggerTime: number;
    rules: RecordingRule[];
    candidates?: ObjectDetectionResult[];
  }) {
    const { triggerTime, rules, candidates } = props;
    const logger = this.getLogger();
    const {
      videoRecorderCustomStreamUrl,
      videoRecorderStreamName,
      videoRecorderH264,
    } = this.mixinState.storageSettings.values;

    const hasAnyProlongRule = rules?.some(
      (r) => r.currentlyActive && r.prolongClipOnMotion,
    );
    if (hasAnyProlongRule) {
      this.ensureRecordingMotionCheckInterval();
    } else {
      this.clearRecordingMotionCheckInterval();
    }

    const maxPostEvent = Math.max(...rules.map((r) => r.postEventSeconds));
    const maxClipLength = Math.max(...rules.map((r) => r.maxClipLength));
    const maxClipRecordingDelay = Math.max(...rules.map((r) => r.minDelay));
    const now = Date.now();

    if (this.videoRecorder) {
      if (now - this.mixinState.recordingState.lastRecordingProlongLog > 2500) {
        logger.log(
          `Recording already active, extending: ${getDetectionsLog(candidates)}`,
        );
        this.mixinState.recordingState.lastRecordingProlongLog = now;
      }

      if (this.mixinState.recordingState.recordingTimeout) {
        clearTimeout(this.mixinState.recordingState.recordingTimeout);
      }

      const startTime =
        this.mixinState.recordingState.recordingStartTime || now;
      const elapsedSeconds = (now - startTime) / 1000;

      let durationToRecord = maxPostEvent;
      const totalProjectedDuration = elapsedSeconds + durationToRecord;

      if (totalProjectedDuration > maxClipLength) {
        durationToRecord = maxClipLength - elapsedSeconds;
        logger.info(
          `Capping recording duration to max clip length. Remaining: ${durationToRecord}s`,
        );
      }

      if (durationToRecord > 0) {
        this.mixinState.recordingState.recordingTimeout = setTimeout(() => {
          this.stopRecording();
        }, durationToRecord * 1000);
        logger.info(`Recording extended by ${durationToRecord}s`);
      } else {
        logger.info(`Max clip length reached. Stopping recording.`);
        this.stopRecording();
      }

      return;
    }

    if (
      !this.isDelayPassed({
        type: DelayType.EventRecording,
        minDelay: maxClipRecordingDelay,
        lastEnd: this.mixinState.recordingState.lastRecordingEndTime,
      })?.timePassed
    ) {
      return;
    }

    let rtspUrl: string;

    if (videoRecorderCustomStreamUrl) {
      rtspUrl = videoRecorderCustomStreamUrl;
      logger.log(`Rebroadcast URL manually set: ${getUrlLog(rtspUrl)}`);
    } else if (videoRecorderStreamName) {
      const rebroadcastConfig = this.streams.find(
        (setting) => setting.subgroup === `Stream: ${videoRecorderStreamName}`,
      );
      rtspUrl = rebroadcastConfig?.value as string;

      logger.log(
        `Rebroadcast URL found: ${JSON.stringify({
          url: getUrlLog(rtspUrl),
          streamName: videoRecorderStreamName,
          rebroadcastConfig,
        })}`,
      );
    }

    if (!rtspUrl) {
      logger.error("Recording RTSP URL not configured");
      return;
    }

    const { recordedClipPath, recordedEventsPath } =
      this.plugin.getRecordedEventPath({
        cameraId: this.id,
        fileName: `${triggerTime}`,
      });

    try {
      await fs.promises.access(recordedEventsPath);
    } catch {
      await fs.promises.mkdir(recordedEventsPath, { recursive: true });
    }

    await this.stopRecording();

    const recorder = new VideoRtspFfmpegRecorder({
      rtspUrl,
      console: logger,
      ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
      h264: videoRecorderH264,
    });

    // If ffmpeg ends by itself (no restart), finalize clip immediately.
    recorder.on("ended", (ended: any) => {
      try {
        if (this.videoRecorder !== recorder) {
          return;
        }

        if (ended?.willRestart) {
          return;
        }

        logger.warn(
          `Video recorder ended (willRestart=false). Finalizing recording. Details: ${JSON.stringify(ended)}`,
        );
        this.stopRecording().catch(logger.error);
      } catch (e) {
        logger.error("Error handling video recorder end event", e);
      }
    });

    this.videoRecorder = recorder;

    const pid = this.videoRecorder.start(recordedClipPath, maxClipLength);
    if (pid) {
      this.mixinState.storageSettings.values.videoRecorderProcessPid =
        String(pid);
    }

    this.mixinState.recordingState.recordingStartTime = triggerTime;
    this.mixinState.recordingState.recordingClassesDetected.clear();
    if (candidates) {
      candidates.forEach((c) => {
        const dc = detectionClassesDefaultMap[c.className];
        if (dc) {
          this.mixinState.recordingState.recordingClassesDetected.add(dc);
        }
      });
    }

    const duration = Math.min(maxPostEvent, maxClipLength);

    this.mixinState.recordingState.recordingTimeout = setTimeout(() => {
      this.stopRecording();
    }, duration * 1000);

    if (hasAnyProlongRule) {
      this.ensureRecordingMotionCheckInterval();
    }

    logger.log(
      `Starting event videoclip recordings for rules: ${rules.map((r) => r.name).join(", ")} with duration ${duration}s`,
    );
  }

  private ensureRecordingMotionCheckInterval() {
    if (this.mixinState.recordingState.motionCheckInterval) {
      return;
    }

    const logger = this.getLogger();

    this.mixinState.recordingState.motionCheckInterval = setInterval(() => {
      try {
        if (
          !this.videoRecorder ||
          !this.mixinState.recordingState.recordingStartTime
        ) {
          this.clearRecordingMotionCheckInterval();
          return;
        }

        const prolongRules = this.mixinState.runningRecordingRules?.filter(
          (rule) =>
            rule.currentlyActive &&
            rule.detectionClasses?.length &&
            rule.prolongClipOnMotion,
        );

        if (!prolongRules.length) {
          return;
        }

        if (!this.cameraDevice.motionDetected) {
          return;
        }

        this.startRecording({
          triggerTime: Date.now(),
          rules: prolongRules,
        }).catch(logger.error);
      } catch (e) {
        logger.error("Error during recording motion interval check", e);
      }
    }, 1000);
  }

  private clearRecordingMotionCheckInterval() {
    if (this.mixinState.recordingState.motionCheckInterval) {
      clearInterval(this.mixinState.recordingState.motionCheckInterval);
      this.mixinState.recordingState.motionCheckInterval = undefined;
    }
  }

  async stopRecording() {
    if (this.mixinState.recordingState.stopInProgress) {
      return this.mixinState.recordingState.stopInProgress;
    }

    const stopPromise = (async () => {
      this.clearRecordingMotionCheckInterval();
      if (this.videoRecorder) {
        const endTime = Date.now();
        this.mixinState.recordingState.lastRecordingEndTime = endTime;
        if (this.mixinState.recordingState.recordingTimeout) {
          clearTimeout(this.mixinState.recordingState.recordingTimeout);
          this.mixinState.recordingState.recordingTimeout = undefined;
        }
        const startTime = this.mixinState.recordingState.recordingStartTime;
        const classesDetected = Array.from(
          this.mixinState.recordingState.recordingClassesDetected,
        );

        const { recordedClipPath, recordedThumbnailPath } =
          this.plugin.getRecordedEventPath({
            cameraId: this.id,
            fileName: `${startTime}`,
          });

        this.mixinState.recordingState.recordingStartTime = undefined;
        this.mixinState.recordingState.recordingClassesDetected.clear();

        const recorderToStop = this.videoRecorder;
        await recorderToStop.stop(recordedThumbnailPath);
        if (this.videoRecorder === recorderToStop) {
          this.videoRecorder = undefined;
        }
        this.mixinState.storageSettings.values.videoRecorderProcessPid =
          undefined;

        if (startTime) {
          const newFilename = getVideoClipName({
            startTime,
            endTime,
            classesDetected,
            logger: this.getLogger(),
          });

          const {
            recordedClipPath: newRecordedClipPath,
            recordedThumbnailPath: newRecordedThumbnailPath,
          } = this.plugin.getRecordedEventPath({
            cameraId: this.id,
            fileName: newFilename,
          });

          try {
            await fs.promises.rename(recordedClipPath, newRecordedClipPath);
            await fs.promises.rename(
              recordedThumbnailPath,
              newRecordedThumbnailPath,
            );
            this.getLogger().log(`Renamed recording to ${newFilename}`);
          } catch (e) {
            this.getLogger().error("Error renaming recording files", e);
          }
        }
      } else {
        try {
          const { videoRecorderProcessPid } =
            this.mixinState.storageSettings.values;
          if (videoRecorderProcessPid) {
            try {
              process.kill(parseInt(videoRecorderProcessPid), "SIGINT");
            } catch { }
            this.mixinState.storageSettings.values.videoRecorderProcessPid =
              undefined;
          }
        } catch (e) {
          this.getLogger().error("Error killing video recorder process", e);
        }
      }
    })().finally(() => {
      if (this.mixinState.recordingState.stopInProgress === stopPromise) {
        this.mixinState.recordingState.stopInProgress = undefined;
      }
    });

    this.mixinState.recordingState.stopInProgress = stopPromise;
    return stopPromise;
  }
}
