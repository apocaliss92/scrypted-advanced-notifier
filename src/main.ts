import sdk, { DeviceBase, DeviceProvider, Entry, HttpRequest, HttpRequestHandler, HttpResponse, Image, LauncherApplication, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetection, ObjectDetectionResult, OnOff, Lock, PanTiltZoom, Program, PushHandler, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Settings, SettingValue, VideoClips, WritableDeviceState, PanTiltZoomMovement } from "@scrypted/sdk";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import child_process from 'child_process';
import { once } from "events";
import fs from 'fs';
import https from 'https';
import { cloneDeep, isEqual, max, sortBy, uniq } from 'lodash';
import path from 'path';
import { BasePlugin, BaseSettingsKey, getBaseSettings, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getRpcData } from '../../scrypted-monitor/src/utils';
import { ffmpegFilterImageBuffer } from "../../scrypted/plugins/snapshot/src/ffmpeg-image-filter";
import { name as pluginName } from '../package.json';
import { AiSource, getAiMessage, getAiSettingKeys, getAiSettings } from "./aiUtils";
import { AdvancedNotifierAlarmSystem } from "./alarmSystem";
import { haAlarmAutomation, haAlarmAutomationId } from "./alarmUtils";
import { AdvancedNotifierCamera } from "./camera";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierDataFetcher } from "./dataFetcher";
import { addEvent, cleanupDatabases, cleanupEvents, cleanupOldEvents } from "./db";
import { DetectionClass, detectionClassesDefaultMap, isLabelDetection, isMotionClassname, isPlateClassname } from "./detectionClasses";
import { serveGif, serveImage, servePluginGeneratedVideoclip } from "./httpUtils";
import { idPrefix, publishPluginValues, publishRuleEnabled, setupPluginAutodiscovery, subscribeToPluginMqttTopics } from "./mqtt-utils";
import { AdvancedNotifierNotifier } from "./notifier";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { CameraMixinState, OccupancyRuleData } from "./states";
import { ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE, ADVANCED_NOTIFIER_CAMERA_INTERFACE, ADVANCED_NOTIFIER_INTERFACE, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE, ALARM_SYSTEM_NATIVE_ID, AssetOriginSource, AudioRule, BaseRule, CAMERA_NATIVE_ID, checkUserLogin, convertSettingsToStorageSettings, DATA_FETCHER_NATIVE_ID, DecoderType, defaultClipPostSeconds, defaultClipPreSeconds, defaultOccupancyClipPreSeconds, DelayType, DetectionEvent, DetectionRule, DetectionRuleActivation, deviceFilter, DeviceInterface, DevNotifications, ExtendedNotificationAction, FRIGATE_BRIDGE_PLUGIN_NAME, generatePrivateKey, getSequencesSettings, getAllDevices, getAssetSource, getAssetsParams, getB64ImageLog, getDetectionRules, getDetectionRulesSettings, getDetectionsLog, getDetectionsLogShort, getElegibleDevices, getEventTextKey, getFrigateTextKey, GetImageReason, getNotifierData, getRuleKeys, getSnoozeId, getTextSettings, getWebhooks, getWebHookUrls, HARD_MIN_RPC_OBJECTS, haSnoozeAutomation, haSnoozeAutomationId, HOMEASSISTANT_PLUGIN_ID, ImagePostProcessing, ImageSource, isDetectionClass, isDeviceSupported, isSecretValid, MAX_PENDING_RESULT_PER_CAMERA, MAX_RPC_OBJECTS_PER_CAMERA, MAX_RPC_OBJECTS_PER_NOTIFIER, MAX_RPC_OBJECTS_PER_PLUGIN, MAX_RPC_OBJECTS_PER_SENSOR, moToB64, NotificationPriority, NOTIFIER_NATIVE_ID, notifierFilter, NotifyDetectionProps, NotifyRuleSource, NTFY_PLUGIN_ID, NVR_PLUGIN_ID, nvrAcceleratedMotionSensorId, NvrEvent, OccupancyRule, ParseNotificationMessageResult, parseNvrNotificationMessage, pluginRulesGroup, PUSHOVER_PLUGIN_ID, ruleSequencesGroup, ruleSequencesKey, RuleSource, RuleType, ruleTypeMetadataMap, safeParseJson, SCRYPTED_NVR_OBJECT_DETECTION_NAME, ScryptedEventSource, SNAPSHOT_WIDTH, SnoozeItem, SOFT_MIN_RPC_OBJECTS, SOFT_RPC_OBJECTS_PER_CAMERA, SOFT_RPC_OBJECTS_PER_NOTIFIER, SOFT_RPC_OBJECTS_PER_PLUGIN, SOFT_RPC_OBJECTS_PER_SENSOR, splitRules, TELEGRAM_PLUGIN_ID, TextSettingKey, TimelapseRule, VideoclipSpeed, videoclipSpeedMultiplier, VideoclipType, ZENTIK_PLUGIN_ID, getSequenceObject, RuleActionType, RuleActionsSequence, getRecordingRulesSettings, getRecordingRules, RecordingRule, calculateSize, formatSize } from "./utils";
import { AudioAnalyzerSource } from "./audioAnalyzerUtils";
import { parseVideoFileName } from "./videoRecorderUtils";

const { systemManager, mediaManager } = sdk;

export type PluginSettingKey =
    | 'pluginEnabled'
    | 'mqttEnabled'
    | 'notificationsEnabled'
    | 'frigateEnabled'
    | 'devNotifications'
    | 'serverId'
    | 'localAddresses'
    | 'scryptedToken'
    | 'nvrUrl'
    | 'mqttActiveEntitiesTopic'
    | 'detectionSourceForMqtt'
    | 'facesSourceForMqtt'
    | 'onActiveDevices'
    | 'objectDetectionDevice'
    | 'clipDevice'
    | 'securitySystem'
    | 'snoozes'
    | 'testDevice'
    | 'testNotifier'
    | 'testEventType'
    | 'testLabel'
    | 'testPriority'
    | 'testPostProcessing'
    | 'testGenerateClip'
    | 'testGenerateClipSpeed'
    | 'testClipPreSeconds'
    | 'testClipPostSeconds'
    | 'testGenerateClipType'
    | 'testUseAi'
    | 'testSound'
    | 'testBypassSnooze'
    | 'testAddSnoozing'
    | 'testAddActions'
    | 'testButton'
    | 'checkConfigurations'
    | 'aiSource'
    | 'imagesPath'
    | typeof ruleSequencesKey
    | 'storeEvents'
    | 'cleanupEvents'
    | 'enableDecoder'
    | 'assetsOriginSource'
    | 'customOriginUrl'
    | 'privateKey'
    | 'postProcessingCropSizeIncrease'
    | 'postProcessingMarkingSizeIncrease'
    | 'postProcessingVehicleBoundingColor'
    | 'postProcessingPersonBoundingColor'
    | 'postProcessingAnimalBoundingColor'
    | 'postProcessingFaceBoundingColor'
    | 'postProcessingPlateBoundingColor'
    | 'postProcessingOtherBoundingColor'
    | 'postProcessingFontSize'
    | 'postProcessingLineThickness'
    | 'postProcessingShowScore'
    | 'postProcessingAspectRatio'
    | 'eventsDbsRemoved612'
    | BaseSettingsKey
    | TextSettingKey;

export default class AdvancedNotifierPlugin extends BasePlugin implements MixinProvider, HttpRequestHandler, DeviceProvider, PushHandler, LauncherApplication {
    private clearVideoclipsQueue: Promise<void> = Promise.resolve();

    initStorage: StorageSettingsDict<PluginSettingKey> = {
        ...getBaseSettings({
            onPluginSwitch: async (_, enabled) => {
                this.getLogger().log(`Plugin switch set to ${enabled}`);
                await this.startStop(enabled);
                await this.startStopMixins(enabled);
            },
            hideHa: false,
            baseGroupName: '',
        }),
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        mqttEnabled: {
            title: 'MQTT enabled',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        frigateEnabled: {
            title: 'Frifate enabled',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
            hide: true,
        },
        notificationsEnabled: {
            title: 'Notifications enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        devNotifications: {
            title: 'Dev notifications',
            description: 'Enable the notifications you want to receive',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: Object.keys(DevNotifications),
            defaultValue: [],
            immediate: true,

            subgroup: 'Advanced',
        },
        privateKey: {
            title: 'Secret',
            description: 'Random string used to protect public resources.Used either as token either as public secret generator for limited time tokens',
            type: 'string',
            subgroup: 'Advanced',
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
            subgroup: 'Advanced',
        },
        localAddresses: {
            title: 'Local addresses',
            type: 'string',
            multiple: true,
            hide: true,
            subgroup: 'Advanced',
        },
        scryptedToken: {
            title: 'Scrypted token',
            description: 'Token to be found on the Homeassistant entity generated by the Scrypted integration (i.e. sensor.scrypted_token_{ip}',
            type: 'string',
            subgroup: 'Homeassistant',
        },
        nvrUrl: {
            title: 'NVR url',
            description: 'Url pointing to the NVR instance, useful to generate direct links to timeline',
            type: 'string',
            defaultValue: 'https://nvr.scrypted.app/',
            placeholder: 'https://nvr.scrypted.app/',
            subgroup: 'Advanced',
        },
        mqttActiveEntitiesTopic: {
            title: 'Active entities topic',
            subgroup: 'MQTT',
            description: 'Topic containing a list of device names/ids, it will be used for the "OnActive" rules',
            onPut: async () => {
                await this.setupMqttEntities();
            },
        },
        detectionSourceForMqtt: {
            title: 'Detections source',
            description: 'Which source should be used to update MQTT',
            type: 'string',
            subgroup: 'MQTT',
            immediate: true,
            combobox: true,
            choices: [],
            defaultValue: ScryptedEventSource.NVR
        },
        facesSourceForMqtt: {
            title: 'Faces source',
            description: 'Which source should be used to update the people tracker.',
            type: 'string',
            subgroup: 'MQTT',
            immediate: true,
            combobox: true,
            choices: [],
            defaultValue: ScryptedEventSource.NVR
        },
        ...getTextSettings({ forMixin: false }),
        [ruleTypeMetadataMap[RuleType.Detection].rulesKey]: {
            title: 'Detection rules',
            group: pluginRulesGroup,
            type: 'string',
            multiple: true,
            immediate: true,
            combobox: true,
            choices: [],
            defaultValue: [],
            onPut: async () => await this.refreshSettings()
        },
        [ruleTypeMetadataMap[RuleType.Recording].rulesKey]: {
            title: 'Recording rules',
            group: pluginRulesGroup,
            type: 'string',
            multiple: true,
            immediate: true,
            combobox: true,
            choices: [],
            defaultValue: [],
            onPut: async () => await this.refreshSettings()
        },
        [ruleSequencesKey]: {
            title: 'Sequences',
            description: 'Define sequences of actions when a rule is triggered',
            group: ruleSequencesGroup,
            type: 'string',
            multiple: true,
            immediate: true,
            combobox: true,
            choices: [],
            defaultValue: [],
            onPut: async () => await this.refreshSettings()
        },
        onActiveDevices: {
            title: '"OnActive" devices',
            group: pluginRulesGroup,
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: deviceFilter,
            defaultValue: [],
        },
        objectDetectionDevice: {
            title: 'Object Detector',
            subgroup: 'Advanced',
            description: 'Select the object detection device to use for detecting objects.',
            type: 'device',
            deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}'`,
            immediate: true,
        },
        clipDevice: {
            title: 'Clip device',
            subgroup: 'Advanced',
            description: 'Select the clip device plugin to execute text embedding.',
            type: 'device',
            deviceFilter: `interfaces.includes('TextEmbedding') && interfaces.includes('ImageEmbedding')`,
            immediate: true,
        },
        securitySystem: {
            title: 'Security system',
            group: pluginRulesGroup,
            description: 'Select the security system device that will be used to enable rules.',
            type: 'device',
            deviceFilter: `type === '${ScryptedDeviceType.SecuritySystem}' && !interfaces.includes('${ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE}')`,
            immediate: true,
        },
        snoozes: {
            title: 'Default snoozes',
            group: pluginRulesGroup,
            description: 'Snoozes (In minutes) to use on notifications. Do not apply for Scrypted App notifiers. If multiple of 60 will be shown as hours, otherwise minutes',
            type: 'string',
            multiple: true,
            defaultValue: ['10', '30', '60'],
        },
        enableDecoder: {
            title: 'Enable decoder',
            subgroup: 'Advanced',
            description: 'Master controller to allow decoder usage.',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        assetsOriginSource: {
            title: 'Assets origin source',
            subgroup: 'Advanced',
            description: 'Select the source of the assets',
            type: 'string',
            defaultValue: AssetOriginSource.CloudSecure,
            immediate: true,
            choices: [
                AssetOriginSource.CloudSecure,
                AssetOriginSource.LocalSecure,
                AssetOriginSource.LocalInsecure,
                AssetOriginSource.Custom,
            ],
            onPut: async () => await this.refreshSettings()
        },
        customOriginUrl: {
            title: 'Custom origin URL',
            subgroup: 'Advanced',
            description: 'Enter a custom URL for the asset origin, in case of missing cloud plugin',
            type: 'string',
        },
        testDevice: {
            title: 'Device',
            group: 'Test',
            immediate: true,
            type: 'device',
            deviceFilter: deviceFilter,
            onPut: async () => await this.refreshSettings()
        },
        testNotifier: {
            group: 'Test',
            title: 'Notifier',
            type: 'device',
            deviceFilter: notifierFilter,
            immediate: true,
        },
        testEventType: {
            group: 'Test',
            title: 'Event type',
            type: 'string',
            immediate: true,
            choices: [
                ...Object.values(DetectionClass),
                ...Object.values(NvrEvent),
            ],
            onPut: async () => await this.refreshSettings()
        },
        testLabel: {
            group: 'Test',
            title: 'Event label',
            type: 'string',
        },
        testPriority: {
            group: 'Test',
            title: 'Priority',
            type: 'string',
            immediate: true,
            choices: Object.keys(NotificationPriority),
            defaultValue: NotificationPriority.Normal
        },
        testPostProcessing: {
            group: 'Test',
            title: 'Image processing',
            type: 'string',
            immediate: true,
            choices: Object.keys(ImagePostProcessing),
            defaultValue: ImagePostProcessing.Default
        },
        testGenerateClip: {
            group: 'Test',
            title: 'Generate clip',
            type: 'boolean',
            immediate: true,
            defaultValue: false,
            onPut: async () => await this.refreshSettings()
        },
        testGenerateClipSpeed: {
            group: 'Test',
            subgroup: 'Clip',
            title: 'Clip speed',
            choices: [
                VideoclipSpeed.SuperSlow,
                VideoclipSpeed.Slow,
                VideoclipSpeed.Realtime,
                VideoclipSpeed.Fast,
                VideoclipSpeed.SuperFast,
            ],
            type: 'string',
            immediate: true,
            defaultValue: VideoclipSpeed.Fast,
        },
        testClipPreSeconds: {
            title: 'Clip pre event duration',
            description: 'How many seconds to record pre event',
            group: 'Test',
            subgroup: 'Clip',
            type: 'number',
            defaultValue: defaultClipPreSeconds,
        },
        testClipPostSeconds: {
            title: 'Clip post duration',
            description: 'How many seconds to record post event',
            group: 'Test',
            subgroup: 'Clip',
            type: 'number',
            defaultValue: defaultClipPostSeconds
        },
        testGenerateClipType: {
            group: 'Test',
            subgroup: 'Clip',
            title: 'Clip Type',
            choices: [
                VideoclipType.GIF,
                VideoclipType.MP4,
            ],
            type: 'string',
            immediate: true,
            defaultValue: VideoclipType.GIF,
        },
        testUseAi: {
            group: 'Test',
            title: 'Use AI for descriptions',
            type: 'boolean',
            immediate: true,
            defaultValue: false
        },
        testSound: {
            group: 'Test',
            title: 'Sound',
            type: 'string',
        },
        testBypassSnooze: {
            group: 'Test',
            title: 'Bypass snoozes',
            type: 'boolean',
            immediate: true,
            defaultValue: false
        },
        testAddSnoozing: {
            group: 'Test',
            title: 'Add snoozings',
            type: 'boolean',
            immediate: true,
            defaultValue: false
        },
        testAddActions: {
            group: 'Test',
            title: 'Add actions',
            type: 'boolean',
            immediate: true,
            defaultValue: false
        },
        testButton: {
            group: 'Test',
            title: 'Send notification',
            type: 'button',
            onPut: async () => {
                await this.executeNotificationTest();
            },
        },
        checkConfigurations: {
            group: 'Test',
            title: 'Check configurations',
            type: 'button',
            onPut: async () => {
                await this.checkPluginConfigurations(true);
            },
        },
        aiSource: {
            title: 'AI Source',
            type: 'string',
            group: 'AI',
            immediate: true,
            // choices: [AiSource.Disabled, AiSource.Manual],
            choices: Object.values(AiSource),
            defaultValue: AiSource.Disabled,
            onPut: async () => await this.refreshSettings()
        },
        imagesPath: {
            title: 'Storage path',
            group: 'Storage',
            description: 'Disk path where to save images and clips. Default will be the plugin folder',
            type: 'string',
        },
        storeEvents: {
            title: 'Store event images',
            group: 'Storage',
            type: 'boolean',
            immediate: true,
            defaultValue: false,
        },
        cleanupEvents: {
            title: 'Cleanup events data',
            group: 'Storage',
            type: 'button',
            onPut: async () => await this.clearAllEventsData()
        },
        postProcessingCropSizeIncrease: {
            title: 'Size increase',
            group: 'Post-Processing',
            subgroup: 'Crop',
            description: 'Factor to increse the padding of the cropped thumbnails, higher the number more space around the detected object',
            type: 'number',
            defaultValue: 1.2,
        },
        postProcessingAspectRatio: {
            title: 'Aspect ratio',
            group: 'Post-Processing',
            subgroup: 'Crop',
            description: 'Aspect ratio of the cropped thumbnail. Leave blank to use the camera aspect ratio',
            type: 'number',
            defaultValue: 1,
        },
        postProcessingMarkingSizeIncrease: {
            title: 'Size increase',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Factor to increse the padding of the boundaries, higher the number more space around the detected object',
            type: 'number',
        },
        postProcessingFontSize: {
            title: 'Texts font size',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            type: 'number',
            defaultValue: 40,
        },
        postProcessingLineThickness: {
            title: 'Lines thickness',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            type: 'number',
            defaultValue: 8,
        },
        postProcessingShowScore: {
            title: 'Show score',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        postProcessingAnimalBoundingColor: {
            title: 'Animal marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around animal objects',
            type: 'string',
            defaultValue: '#2ECC40',
        },
        postProcessingVehicleBoundingColor: {
            title: 'Vehicle marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around animal objects',
            type: 'string',
            defaultValue: '#0074D9',
        },
        postProcessingPersonBoundingColor: {
            title: 'Person marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around person objects',
            type: 'string',
            defaultValue: '#FF4136',
        },
        postProcessingPlateBoundingColor: {
            title: 'Plate marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around plate objects',
            type: 'string',
            defaultValue: '#B10DC9',
        },
        postProcessingFaceBoundingColor: {
            title: 'Face marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around face objects',
            type: 'string',
            defaultValue: '#FF851B',
        },
        postProcessingOtherBoundingColor: {
            title: 'Unclassified marking color',
            group: 'Post-Processing',
            subgroup: 'Marking boundaries',
            description: 'Color to use for the marking boundaries around unclassified objects',
            type: 'string',
            defaultValue: '#AAAAAA',
        },
        eventsDbsRemoved612: {
            type: 'boolean',
            hide: true,
        }
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    public deviceVideocameraMap: Record<string, string> = {};
    public videocameraDevicesMap: Record<string, string[]> = {};
    public currentCameraMixinsMap: Record<string, AdvancedNotifierCameraMixin> = {};
    public currentSensorMixinsMap: Record<string, AdvancedNotifierSensorMixin> = {};
    public currentNotifierMixinsMap: Record<string, AdvancedNotifierNotifierMixin> = {};
    private mainFlowInterval: NodeJS.Timeout;
    defaultNotifier: AdvancedNotifierNotifier;
    camera: AdvancedNotifierCamera;
    alarmSystem: AdvancedNotifierAlarmSystem;
    dataFetcher: AdvancedNotifierDataFetcher;
    runningDetectionRules: DetectionRule[] = [];
    runningRecordingRules: RecordingRule[] = [];
    lastNotExistingNotifier: number;
    public allAvailableRules: BaseRule[] = [];
    lastAutoDiscovery: number;
    lastConfigurationsCheck: number;
    lastKnownPeopleFetched: number;
    hasCloudPlugin: boolean;
    frigateApi: string;
    knownPeople: string[] = [];
    restartRequested = false;
    public aiMessageResponseMap: Record<string, string> = {};
    audioLabels: string[];
    frigateLabels: string[];
    frigateCameras: string[];
    lastFrigateDataFetched: number;
    lastAudioDataFetched: number;
    localEndpointInternal: string;
    connectionTime = Date.now();
    private cameraAutodiscoveryQueue: { cameraId: string; task: () => Promise<void> }[] = [];
    public lastCameraAutodiscoveryMap: Record<string, number> = {};
    private processingCameraAutodiscovery = false;

    imageEmbeddingCache: Record<string, Buffer> = {};
    textEmbeddingCache: Record<string, Buffer> = {};

    lastDelaySet: Record<string, number> = {};

    accumulatedTimelapsesToGenerate: { ruleName: string, deviceId: string }[] = [];
    mainFlowInProgress = false;

    cameraMotionActive = new Set<string>();

    cameraStates: Record<string, CameraMixinState> = {};
    audioClassifierMissingLogged = new Set<AudioAnalyzerSource>();

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Advanced notifier'
        });

        this.applicationInfo = {
            name: 'Advanced Notifier',
            description: 'Events viewer',
            icon: 'fa-play',
            href: '/endpoint/@apocaliss92/scrypted-advanced-notifier/public/app',
            cloudHref: '/endpoint/@apocaliss92/scrypted-advanced-notifier/public/app',
        }
        this.startStop(this.storageSettings.values.pluginEnabled).then().catch(this.getLogger().log);
    }

    enqueueCameraAutodiscovery(cameraId: string, task: () => Promise<void>) {
        if (this.cameraAutodiscoveryQueue.find(e => e.cameraId === cameraId)) {
            return;
        }
        this.cameraAutodiscoveryQueue.push({ cameraId, task });
        this.processCameraAutodiscoveryQueue();
    }

    private processCameraAutodiscoveryQueue() {
        if (this.processingCameraAutodiscovery) {
            return;
        }
        const logger = this.getLogger();
        this.processingCameraAutodiscovery = true;

        const processNext = () => {
            const entry = this.cameraAutodiscoveryQueue.shift();
            if (!entry) {
                this.processingCameraAutodiscovery = false;
                return;
            }
            const start = Date.now();
            entry.task().catch(e => logger.error('Camera autodiscovery error', e)).finally(() => {
                this.lastCameraAutodiscoveryMap[entry.cameraId] = Date.now();
                const elapsed = Date.now() - start;
                const delay = Math.max(0, 300 - elapsed);
                setTimeout(processNext, delay);
            });
        };
        processNext();
    }

    async init() {
        const logger = this.getLogger();

        const cloudPlugin = systemManager.getDeviceByName<Settings>('Scrypted Cloud');
        if (cloudPlugin) {
            logger.log('Cloud plugin found');
            this.hasCloudPlugin = true;
        } else {
            logger.log('Cloud plugin not found');
            this.hasCloudPlugin = false;
        }

        const frigatePlugin = systemManager.getDeviceByName<Settings>(FRIGATE_BRIDGE_PLUGIN_NAME);
        if (frigatePlugin) {
            const settings = await frigatePlugin.getSettings();
            const serverUrl = settings.find(setting => setting.key === 'serverUrl')?.value as string;
            logger.log(`Frigate API found ${serverUrl}`);

            try {
                await axios.get(`${serverUrl}/api/config`, { timeout: 5000 });
                logger.log(`Frigate server is reachable`);
                this.frigateApi = serverUrl;

                const { frigateLabels, frigateCameras } = await this.getFrigateData();
                logger.log(`Frigate labels found ${frigateLabels}`);
                logger.log(`Frigate cameras found ${frigateCameras}`);
            } catch (e) {
                logger.log(`Frigate server not reachable: ${e.message}`);
                this.frigateApi = undefined;
            }
        }

        // const [major, minor, patch] = version.split('.').map(num => parseInt(num, 10));

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier NVR notifier',
                nativeId: NOTIFIER_NATIVE_ID,
                interfaces: [ScryptedInterface.Notifier, ScryptedInterface.Settings, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE],
                type: ScryptedDeviceType.Notifier,
            },
        );
        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier alarm system',
                nativeId: ALARM_SYSTEM_NATIVE_ID,
                interfaces: [
                    ScryptedInterface.SecuritySystem,
                    ScryptedInterface.Settings,
                    ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE
                ],
                type: ScryptedDeviceType.SecuritySystem,
            }
        );
        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier data fetcher',
                nativeId: DATA_FETCHER_NATIVE_ID,
                interfaces: [
                    ScryptedInterface.VideoClips,
                    ScryptedInterface.EventRecorder,
                    ScryptedInterface.Settings,
                ],
                type: ScryptedDeviceType.API,
            }
        );
        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier Camera',
                nativeId: CAMERA_NATIVE_ID,
                interfaces: [
                    ScryptedInterface.Camera,
                    ScryptedInterface.VideoClips,
                    ScryptedInterface.Settings,
                    ScryptedInterface.VideoCamera,
                    ADVANCED_NOTIFIER_CAMERA_INTERFACE
                ],
                type: ScryptedDeviceType.Camera,
            }
        );

        await this.initPluginSettings();

        if (!this.storageSettings.values.eventsDbsRemoved612) {
            logger.log(`Initiating old DBs migration`);
            const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
            const oldDbsPath = path.join(pluginVolume, 'dbs', 'events');
            const { dbsPath } = this.getEventPaths({});

            try {
                const files = await fs.promises.readdir(oldDbsPath);
                logger.log(`Found old DB files: ${files}`);
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const src = path.join(oldDbsPath, file);
                        const dest = path.join(dbsPath, file);
                        logger.log(`Copying old DB file from ${src} to ${dest}`);
                        await fs.promises.copyFile(src, dest);
                    }
                }

                await fs.promises.rm(path.join(pluginVolume, 'dbs'), { recursive: true, force: true });

                logger.log(`${files.length} DBs moved`);
            } catch (e) {
                logger.log('Error moving old DBs', e);
            }
            this.storageSettings.values.eventsDbsRemoved612 = true;
        }
        logger.log(`Initiating old DBs migration`);
    }


    async getDevice(nativeId: string) {
        if (nativeId === NOTIFIER_NATIVE_ID)
            return this.defaultNotifier ||= new AdvancedNotifierNotifier(NOTIFIER_NATIVE_ID, this);
        if (nativeId === CAMERA_NATIVE_ID)
            return this.camera ||= new AdvancedNotifierCamera(CAMERA_NATIVE_ID, this);
        if (nativeId === ALARM_SYSTEM_NATIVE_ID)
            return this.alarmSystem ||= new AdvancedNotifierAlarmSystem(ALARM_SYSTEM_NATIVE_ID, this);
        if (nativeId === DATA_FETCHER_NATIVE_ID)
            return this.dataFetcher ||= new AdvancedNotifierDataFetcher(DATA_FETCHER_NATIVE_ID, this);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async stop() {
        this.mainFlowInterval && clearInterval(this.mainFlowInterval);
        await this.mqttClient?.disconnect();
    }

    async startStopMixins(enabled: boolean) {
        for (const mixin of Object.values(this.currentCameraMixinsMap)) {
            await mixin.startStop(enabled, 'from_plugin');
        }
        for (const mixin of Object.values(this.currentSensorMixinsMap)) {
            await mixin.startStop(enabled);
        }
        for (const mixin of Object.values(this.currentNotifierMixinsMap)) {
            await mixin.startStop(enabled);
        }
    }

    async start() {
        try {
            await this.init();
            await this.refreshSettings();
            await this.refreshSettings();
            await this.mainFlow();

            this.mainFlowInterval = setInterval(async () => {
                if (!this.mainFlowInProgress) {
                    await this.mainFlow();
                }
            }, 2 * 1000);
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const logger = this.getLogger();
        const url = new URL(`http://localhost${request.url}`);

        const [_, __, ___, ____, privateWebhook, webhook, ...rest] = url.pathname.split('/');
        const [deviceIdOrActionRaw, ruleNameOrSnoozeIdOrSnapshotId, timelapseNameOrSnoozeTime] = rest
        let deviceIdOrAction = decodeURIComponent(deviceIdOrActionRaw);
        const decodedTimelapseNameOrSnoozeTime = decodeURIComponent(timelapseNameOrSnoozeTime);
        const decodedRuleNameOrSnoozeIdOrSnapshotId = decodeURIComponent(ruleNameOrSnoozeIdOrSnapshotId);

        logger.debug(`Webhook request: ${JSON.stringify({
            url: request.url,
            body: request.body,
            webhook,
            deviceIdOrActionRaw,
            deviceIdOrAction,
            ruleNameOrSnoozeIdOrSnapshotId,
            decodedRuleNameOrSnoozeIdOrSnapshotId,
            timelapseNameOrSnoozeTime,
            decodedTimelapseNameOrSnoozeTime,
        })}`);

        let nvrSnoozeId: string;
        let nvrSnoozeAction: string;
        let isNvrSnooze = false;
        if (request.body) {
            const body = safeParseJson(request.body);
            if (body.snoozeId && body.actionId) {
                nvrSnoozeId = body.snoozeId;
                nvrSnoozeAction = body.actionId;
                isNvrSnooze = true;
            }
        }
        const device = this.currentCameraMixinsMap[deviceIdOrAction];
        const realDevice = device ? systemManager.getDeviceById<ScryptedDeviceBase>(device.id) : undefined;

        try {
            const {
                lastSnapshot,
                haAction,
                snoozeNotification,
                postNotification,
                setAlarm,
                eventsApp,
                eventThumbnail,
                eventImage,
                eventVideoclip,
                imageRule,
                videoRule,
                gifRule,
                recordedClipThumbnail,
                recordedClipVideo,
            } = await getWebhooks();
            if ([webhook, privateWebhook].includes('app')) {
                if (deviceIdOrActionRaw) {
                    response.sendFile(`dist/${deviceIdOrActionRaw}`);
                } else {
                    response.sendFile('dist/index.html');
                }
                return;
            } else if ([webhook, privateWebhook].includes(eventsApp)) {
                if (webhook === eventsApp) {
                    const loginResponse = await checkUserLogin(request);
                    if (!loginResponse) {
                        response.send('Unauthorized', {
                            code: 401
                        });
                        return;
                    }
                }

                if ([privateWebhook, webhook].includes(eventVideoclip)) {
                    const device = sdk.systemManager.getDeviceById<VideoClips>(deviceIdOrAction);
                    const mo = await device.getVideoClip(decodedRuleNameOrSnoozeIdOrSnapshotId);
                    let videoUrl = (await mediaManager.convertMediaObjectToBuffer(mo, ScryptedMimeTypes.LocalUrl)).toString();
                    // const supportH265 = url.searchParams.get('h265');
                    // const range = request.headers.range;
                    if (videoUrl.startsWith('http')) {
                        const urlEntity = new URL(videoUrl);
                        videoUrl = `${urlEntity.pathname}${urlEntity.search}`;
                    }
                    const { assetsOrigin, } = await getAssetsParams({ plugin: this });
                    videoUrl = `${assetsOrigin}${videoUrl}`;

                    const isIos = /iPhone|iPad|iPod/i.test(request.headers['user-agent']);
                    const { isNvr } = getAssetSource({ videoUrl });

                    // If iOS and nvr clips, prebuffer to avoid streaming issues 
                    if (isNvr && isIos) {
                        const remoteResponse = await axios.get<Buffer[]>(videoUrl, {
                            headers: request.headers,
                            httpsAgent: new https.Agent({
                                rejectUnauthorized: false
                            }),
                            responseType: 'stream',
                        });
                        const chunks: Buffer[] = [];

                        for await (const chunk of remoteResponse.data) {
                            chunks.push(chunk);
                        }

                        response.send(Buffer.concat(chunks), {
                            code: 200,
                            headers: {
                                ...remoteResponse.headers,
                                'Content-Type': 'video/mp4',
                                'Content-Length': chunks.length,
                                'transfer-encoding': undefined,
                            },
                        });
                        return;
                    } else {
                        response.send('', {
                            code: 302,
                            headers: {
                                ...request.headers,
                                Location: videoUrl,
                            }
                        });
                        return;
                    }
                } else if ([privateWebhook, webhook].includes(imageRule)) {
                    const { imageHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(decodedTimelapseNameOrSnoozeTime),
                    });
                    await serveImage({
                        imagePath: imageHistoricalPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if ([privateWebhook, webhook].includes(gifRule)) {
                    const triggerTime = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { gifHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(triggerTime),
                    });
                    await serveGif({
                        gifPath: gifHistoricalPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if ([privateWebhook, webhook].some(hook => [eventThumbnail, eventImage].includes(hook))) {
                    logger.info(JSON.stringify({
                        cameraName: realDevice.name,
                        fileName: decodedRuleNameOrSnoozeIdOrSnapshotId
                    }));
                    const imageSource = timelapseNameOrSnoozeTime as ScryptedEventSource;

                    if (imageSource === ScryptedEventSource.NVR) {
                        const path = url.searchParams.get('path');
                        const { localAssetsOrigin, } = await getAssetsParams({ plugin: this });
                        const imageUrl = `${localAssetsOrigin}/${decodeURIComponent(path)}`;
                        const jpeg = await axios.get<Buffer>(imageUrl, {
                            responseType: "arraybuffer",
                            httpsAgent: new https.Agent({
                                rejectUnauthorized: false
                            }),
                            headers: {
                                ...request.headers
                            }
                        });

                        response.send(jpeg.data, {
                            code: 200,
                            headers: {
                                "Cache-Control": "max-age=31536000"
                            }
                        });
                        return;
                    } else if (imageSource === ScryptedEventSource.Frigate) {
                        const imagePath = webhook === eventThumbnail ? 'thumbnail' : 'snapshot';
                        const imageUrl = `${this.frigateApi}/events/${decodedRuleNameOrSnoozeIdOrSnapshotId}/${imagePath}.jpg`;
                        const jpeg = await axios.get<Buffer>(imageUrl, {
                            responseType: "arraybuffer"
                        });

                        response.send(jpeg.data, {
                            code: 200,
                            headers: {
                                ...jpeg.headers,
                                "Cache-Control": "max-age=31536000"
                            }
                        });
                        return;
                    } else {
                        const { eventThumbnailPath, eventImagePath } = this.getEventPaths({ cameraId: realDevice.id, fileName: decodedRuleNameOrSnoozeIdOrSnapshotId });

                        const imagePath = webhook === eventThumbnail ? eventThumbnailPath : eventImagePath;

                        const jpeg = await fs.promises.readFile(imagePath);

                        response.send(jpeg, {
                            headers: {
                                "Cache-Control": "max-age=31536000"
                            }
                        });
                    }
                    return;
                } else if ([privateWebhook, webhook].some(hook => [videoRule].includes(hook))) {
                    const triggerTime = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { videoHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(triggerTime),
                    });
                    await servePluginGeneratedVideoclip({
                        videoclipPath: videoHistoricalPath,
                        request,
                        response,
                        plugin: this,
                    });
                    return;
                }
            } else {
                const publicKey = url.searchParams.get('secret');

                if (!publicKey || !isSecretValid({
                    publicKey,
                    secret: this.storageSettings.values.privateKey,
                })) {
                    response.send('Unauthorized', {
                        code: 403
                    });
                    return;
                }

                if (webhook === haAction) {
                    const { url, accessToken } = await this.getHaApiUrl();

                    await axios.post(`${url}/api/events/mobile_app_notification_action`,
                        { "action": deviceIdOrAction },
                        {
                            headers: {
                                'Authorization': 'Bearer ' + accessToken,
                            }
                        });

                    response.send(`Action ${deviceIdOrAction} executed`, {
                        code: 200,
                    });
                    return;
                } else if (webhook === videoRule) {
                    const triggerTime = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { videoHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(triggerTime),
                    });
                    await servePluginGeneratedVideoclip({
                        videoclipPath: videoHistoricalPath,
                        request,
                        response,
                        plugin: this,
                    });
                    return;
                } else if (webhook === recordedClipVideo) {
                    const fileName = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { recordedClipPath } = this.getRecordedEventPath({
                        cameraId: realDevice.id,
                        fileName,
                    });
                    await servePluginGeneratedVideoclip({
                        videoclipPath: recordedClipPath,
                        request,
                        response,
                        plugin: this,
                    });
                    return;
                } else if (webhook === imageRule) {
                    const triggerTime = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { imageHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(triggerTime),
                    });
                    await serveImage({
                        imagePath: imageHistoricalPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if (webhook === recordedClipThumbnail) {
                    const fileName = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { recordedThumbnailPath } = this.getRecordedEventPath({
                        cameraId: realDevice.id,
                        fileName,
                    });
                    await serveImage({
                        imagePath: recordedThumbnailPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if (webhook === gifRule) {
                    const triggerTime = decodedTimelapseNameOrSnoozeTime.split('.')[0];
                    const { gifHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(triggerTime),
                    });
                    await serveGif({
                        gifPath: gifHistoricalPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if (webhook === lastSnapshot) {
                    const isWebhookEnabled = device?.mixinState.storageSettings.values.lastSnapshotWebhook;

                    if (isWebhookEnabled) {
                        const pieces = ruleNameOrSnoozeIdOrSnapshotId.split('__');
                        const firstPiece = pieces[0];

                        if (firstPiece === 'object-detection') {
                            const [_, ...rest] = pieces;
                            const identifier = rest.join('__');
                            const imageIdentifier = identifier;
                            const { filePath } = this.getDetectionImagePaths({ device: realDevice, imageIdentifier });
                            await serveImage({
                                imagePath: filePath,
                                plugin: this,
                                request,
                                response
                            })
                            return;
                        } else if (firstPiece === 'ruleImage') {
                            const [_, ruleName, variant] = pieces;
                            let imagePath: string;
                            const { imageLatestPath, imageLatestPathVariant } = this.getRulePaths({ cameraId: realDevice.id, ruleName });

                            if (!variant) {
                                imagePath = imageLatestPath;
                            } else {
                                imagePath = imageLatestPathVariant;
                            }
                            await serveImage({
                                imagePath,
                                plugin: this,
                                request,
                                response
                            });
                            return;
                        } else if (firstPiece === 'ruleClip') {
                            const [_, ruleName] = pieces;
                            const { videoclipLatestPath } = this.getRulePaths({ cameraId: realDevice.id, ruleName });

                            await servePluginGeneratedVideoclip({
                                videoclipPath: videoclipLatestPath,
                                request,
                                response,
                                plugin: this,
                            });
                            return;
                        } else if (firstPiece === 'ruleGif') {
                            const [_, ruleName] = pieces;
                            const { gifLatestPath } = this.getRulePaths({ cameraId: realDevice.id, ruleName });

                            await serveGif({
                                gifPath: gifLatestPath,
                                plugin: this,
                                request,
                                response
                            });
                            return;
                        }
                    }
                } else if (webhook === imageRule) {
                    const { imageHistoricalPath } = this.getRulePaths({
                        cameraId: realDevice.id,
                        ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                        triggerTime: Number(decodedTimelapseNameOrSnoozeTime),
                    });
                    await serveImage({
                        imagePath: imageHistoricalPath,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if (webhook === snoozeNotification || isNvrSnooze) {
                    let device: AdvancedNotifierCameraMixin;

                    let snoozeTime: number;
                    let snoozeId: string;
                    let deviceId: string;
                    if (isNvrSnooze) {
                        deviceId = nvrSnoozeId.split('_')[1];
                        device = this.currentCameraMixinsMap[deviceId];
                        snoozeId = nvrSnoozeId;
                        snoozeTime = Number(nvrSnoozeAction.split('snooze')[1]);
                    } else {
                        snoozeId = decodedRuleNameOrSnoozeIdOrSnapshotId;
                        deviceId = deviceIdOrAction;
                        device = this.currentCameraMixinsMap[deviceIdOrAction];
                        snoozeTime = Number(decodedTimelapseNameOrSnoozeTime);
                    }

                    const message = await device?.snoozeNotification({
                        snoozeId,
                        snoozeTime
                    });

                    response.send(message, {
                        code: 200,
                    });
                } else if (webhook === setAlarm) {
                    const mode = deviceIdOrAction as SecuritySystemMode
                    await this.alarmSystem.armSecuritySystem(mode);

                    response.send(`Alarm set to ${mode}`, {
                        code: 200,
                    });
                } else if (webhook === postNotification && request.method === 'POST') {
                    const parsedBody = JSON.parse(request.body ?? '{}');
                    const { cameraId, imageUrl, timestamp, message } = parsedBody;
                    const notifier = systemManager.getDeviceById(deviceIdOrAction);
                    const camera = systemManager.getDeviceById<DeviceInterface>(cameraId);

                    let image: MediaObject;
                    if (imageUrl) {
                        image = await sdk.mediaManager.createMediaObjectFromUrl(imageUrl);
                    }

                    const logMessage = `Notifying image ${getB64ImageLog(imageUrl)} to notifier ${notifier.name} through camera ${camera.name}. timestamp ${timestamp}`;
                    logger.log(logMessage);

                    this.notifyDetection({
                        triggerDevice: camera,
                        notifierId: deviceIdOrAction,
                        time: timestamp,
                        logger,
                        message,
                        image,
                        rule: { ruleType: RuleType.Detection } as DetectionRule
                    });

                    response.send(logMessage, {
                        code: 200,
                    });
                }
            }
        } catch (e) {
            logger.log(`Error in onRequest`, e.message, JSON.stringify(request));
            response.send(`${JSON.stringify(e)}, ${e.message}`, {
                code: 400,
            });

            return;
        }

        response.send(`Webhook not found`, {
            code: 404,
        });

        return;
    }

    onPush(request: HttpRequest): Promise<void> {
        return this.onRequest(request, undefined);
    }

    async getKnownPeople() {
        const logger = this.getLogger();
        try {
            const now = new Date().getTime();
            const isUpdated = this.lastKnownPeopleFetched && (now - this.lastKnownPeopleFetched) <= (1000 * 60);
            if (this.knownPeople && isUpdated) {
                return this.knownPeople;
            }

            const objDetectionPlugin = systemManager.getDeviceByName<Settings>(SCRYPTED_NVR_OBJECT_DETECTION_NAME);
            if (!objDetectionPlugin) {
                logger.log('Scrypted NVR Object Detection not found');
                return [];
            }

            const settings = await objDetectionPlugin.getSettings();
            const knownPeople = settings?.find(setting => setting.key === 'knownPeople')?.choices
                ?.filter(choice => !!choice)
                .map(person => person.trim());

            this.knownPeople = knownPeople;
            this.lastKnownPeopleFetched = now;
            return this.knownPeople;
        } catch (e) {
            logger.log('Error in getKnownPeople', e.message);
            return [];
        }
    }

    async getFrigateData() {
        try {
            const now = new Date().getTime();

            if (!this.frigateApi) {
                return {};
            }

            const isUpdated = this.lastFrigateDataFetched && (now - this.lastFrigateDataFetched) <= (1000 * 60);

            if (!isUpdated) {
                const frigatePlugin = systemManager.getDeviceByName<Settings>(FRIGATE_BRIDGE_PLUGIN_NAME);
                const settings = await frigatePlugin.getSettings();
                const labels = settings.find(setting => setting.key === 'labels')?.value as string[];
                const cameras = settings.find(setting => setting.key === 'cameras')?.value as string[];

                this.frigateLabels = labels.filter(label => label !== 'person');
                this.frigateCameras = cameras;
                this.lastFrigateDataFetched = now;
            }

            return {
                frigateLabels: this.frigateLabels,
                frigateCameras: this.frigateCameras,
            }
        } catch (e) {
            this.getLogger().log('Error in getObserveZones', e.message);
            return {};
        }
    }

    async getAudioData() {
        try {
            const now = new Date().getTime();

            const isUpdated = this.lastAudioDataFetched && (now - this.lastAudioDataFetched) <= (1000 * 60);
            const yamnetPlugin = sdk.systemManager.getDeviceByName<ObjectDetection>('YAMNet Audio Classification');


            if (!isUpdated && yamnetPlugin) {
                const { classes } = await yamnetPlugin.getDetectionModel();

                this.audioLabels = classes;
            }

            return {
                labels: this.audioLabels,
            }
        } catch (e) {
            this.getLogger().log('Error in getObserveZones', e.message);
            return {};
        }
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getMqttClient() {
        try {
            if (!this.mqttClient && !this.initializingMqtt) {
                const { mqttEnabled, useMqttPluginCredentials, pluginEnabled, mqttHost, mqttUsename, mqttPassword } = this.storageSettings.values;
                if (mqttEnabled && pluginEnabled) {
                    this.initializingMqtt = true;
                    const logger = this.getLogger();

                    if (this.mqttClient) {
                        this.mqttClient.disconnect();
                        this.mqttClient = undefined;
                    }

                    try {
                        this.mqttClient = await getMqttBasicClient({
                            logger,
                            useMqttPluginCredentials,
                            mqttHost,
                            mqttUsename,
                            mqttPassword,
                            clientId: `scrypted_an`,
                            configTopicPattern: `homeassistant/+/${idPrefix}-${this.pluginId}/+/config`
                        });
                        await this.mqttClient?.getMqttClient();
                    } catch (e) {
                        logger.log('Error setting up MQTT client', e);
                    } finally {
                        this.initializingMqtt = false;
                    }
                }
            }
        } catch { }

        return this.mqttClient;
    }

    getRealMixin(id: string) {
        let mixin: AdvancedNotifierCameraMixin | AdvancedNotifierSensorMixin | AdvancedNotifierNotifierMixin;
        let settings;

        if (this.currentCameraMixinsMap[id]) {
            mixin = this.currentCameraMixinsMap[id];
            settings = mixin?.mixinState.storageSettings;
        } else if (this.currentSensorMixinsMap[id]) {
            mixin = this.currentSensorMixinsMap[id];
            settings = mixin?.storageSettings;
        } else if (this.currentNotifierMixinsMap[id]) {
            mixin = this.currentNotifierMixinsMap[id];
            settings = mixin.storageSettings;
        }

        return { mixin, settings };
    }

    getLogger(device?: ScryptedDeviceBase) {
        if (device) {
            const deviceId = device.id;

            const { mixin, settings } = this.getRealMixin(deviceId);

            if (mixin) {
                return super.getLoggerInternal({
                    console: mixin.console,
                    storage: settings,
                    // TODO: Complete with other mixin states
                    friendlyName: this.cameraStates[deviceId]?.clientId,
                });
            }
        }

        return super.getLoggerInternal({});
    }

    private async setupMqttEntities() {
        const { mqttEnabled, mqttActiveEntitiesTopic } = this.storageSettings.values;
        if (mqttEnabled) {
            try {
                const mqttClient = await this.getMqttClient();
                const logger = this.getLogger();

                if (mqttClient) {
                    this.getLogger().log(`Subscribing to mqtt topics`);
                    await subscribeToPluginMqttTopics({
                        entitiesActiveTopic: mqttActiveEntitiesTopic,
                        mqttClient,
                        console: logger,
                        rules: this.allAvailableRules,
                        activeEntitiesCb: async (message) => {
                            logger.debug(`Received update for ${mqttActiveEntitiesTopic} topic: ${JSON.stringify(message)}`);
                            await this.updateOnActiveDevices(message);
                        },
                        activationRuleCb: async ({ active, ruleName }) => {
                            const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType: RuleType.Detection });
                            logger.debug(`Setting rule ${ruleName} to ${active}`);
                            await this.putSetting(enabledKey, active);
                        },
                        switchNotificationsEnabledCb: async (active) => {
                            logger.log(`Setting notifications active to ${!active}`);
                            await this.storageSettings.putSetting(`notificationsEnabled`, active);
                        },
                    });
                }
            } catch (e) {
                this.getLogger().log('Error setting up MQTT client', e);
            }
        }
    }

    private async updateOnActiveDevices(deviceIdentifiers: string[]) {
        const logger = this.getLogger();
        const deviceIds: string[] = [];
        for (const deviceIdentifier of deviceIdentifiers) {
            let device = sdk.systemManager.getDeviceById(deviceIdentifier);

            if (!device) {
                device = sdk.systemManager.getDeviceByName(deviceIdentifier);
            }

            if (device) {
                deviceIds.push(device.id);
            } else {
                logger.log(`Device identifier ${deviceIdentifier} not found`);
            }
        }

        logger.debug(`updateOnActiveDevices: ${JSON.stringify({
            deviceIdentifiers,
            stored: this.storageSettings.values.onActiveDevices ?? [],
            isEqual: isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.onActiveDevices ?? []))
        })}`);

        if (isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.onActiveDevices ?? []))) {
            logger.debug('Devices did not change');
        } else {
            logger.log(`"OnActiveDevices" changed: ${JSON.stringify(deviceIds)}`);
            this.putSetting('onActiveDevices', deviceIds);
        }
    }

    private async initPluginSettings() {
        const logger = this.getLogger();
        if (this.hasCloudPlugin) {
            const localAddresses = await sdk.endpointManager.getLocalAddresses();
            const mo = await mediaManager.createMediaObject('', 'text/plain')
            const serverId: string = await mediaManager.convertMediaObject(mo, ScryptedMimeTypes.ServerId);

            logger.log(`Server id found: ${serverId}`);
            await this.putSetting('serverId', serverId);

            logger.log(`Local addresses found: ${localAddresses}`);
            await this.putSetting('localAddresses', localAddresses);
        } else {
            this.storageSettings.settings.assetsOriginSource.defaultValue = AssetOriginSource.LocalSecure;
            this.storageSettings.settings.assetsOriginSource.choices = [
                AssetOriginSource.LocalSecure,
                AssetOriginSource.LocalInsecure,
                AssetOriginSource.Custom,
            ];
            if (this.storageSettings.values.assetsOriginSource === AssetOriginSource.CloudSecure) {
                logger.log(`Assets origin set to ${AssetOriginSource.CloudSecure} but cloud plugin is not installed. Changing to ${AssetOriginSource.LocalSecure}`);
                await this.putSetting('assetsOriginSource', AssetOriginSource.LocalSecure);
            }
        }

        if (this.storageSettings.values.haEnabled) {
            await this.generateHomeassistantHelpers();
        }

        if (!this.storageSettings.values.privateKey) {
            const privateKey = generatePrivateKey();
            await this.putSetting('privateKey', privateKey);
        }

        if (!this.storageSettings.values.objectDetectionDevice) {
            const allDetectors = getAllDevices().filter(dev => dev.interfaces.includes(ScryptedInterface.ObjectDetectionPreview) && dev.id !== nvrAcceleratedMotionSensorId);
            const nvrOne = sdk.systemManager.getDeviceByName(SCRYPTED_NVR_OBJECT_DETECTION_NAME);
            let toUse = allDetectors[0];
            if (nvrOne && allDetectors.some(dev => dev.id === nvrOne.id)) {
                toUse = nvrOne;
            }

            logger.log(`Object detector not set, defaulting to ${toUse.name}`);
            await this.putSetting('objectDetectionDevice', toUse.id);
        }

        if (!this.storageSettings.values.objectDetectionDevice) {
            const allClippers = getAllDevices().filter(dev => dev.interfaces.includes(ScryptedInterface.TextEmbedding));
            logger.log(`Clip device not set, defaulting to ${allClippers[0].name}`);
            await this.putSetting('clipDevice', allClippers[0].id);
        }
    }

    private async mainFlow() {
        const logger = this.getLogger();
        this.mainFlowInProgress = true;
        try {
            const deviceVideocameraMap: Record<string, string> = {};
            const videocameraDevicesMap: Record<string, string[]> = {};

            const allDevices = getElegibleDevices();
            for (const device of allDevices) {
                const { isCamera } = isDeviceSupported(device);
                const deviceId = device.id;
                try {
                    const settings = await device.getSettings();
                    const linkedCamera = settings.find(setting => setting.key === 'homeassistantMetadata:linkedCamera')?.value as string;
                    const nearbySensors = (settings.find(setting => setting.key === 'recording:nearbySensors')?.value as string[]) ?? [];
                    const nearbyLocks = (settings.find(setting => setting.key === 'recording:nearbyLocks')?.value as string[]) ?? [];

                    if (linkedCamera) {
                        const cameraDevice = systemManager.getDeviceById(linkedCamera);
                        if (cameraDevice) {
                            const cameraId = cameraDevice.id;
                            deviceVideocameraMap[deviceId] = cameraId;
                            if (!videocameraDevicesMap[cameraId]) {
                                videocameraDevicesMap[cameraId] = [];
                            }
                            !videocameraDevicesMap[cameraId].includes(deviceId) && videocameraDevicesMap[cameraId].push(deviceId);
                        } else {
                            logger.log(`Device ${device.name} is linked to the cameraId ${linkedCamera}, not available anymore`);
                        }
                    }

                    if (isCamera) {
                        const allLinkedSensorIds = [...nearbySensors, ...nearbyLocks];

                        for (const linkedSensorId of allLinkedSensorIds) {
                            deviceVideocameraMap[linkedSensorId] = deviceId;
                            if (!videocameraDevicesMap[deviceId]) {
                                videocameraDevicesMap[deviceId] = [];
                            }
                            !videocameraDevicesMap[deviceId].includes(linkedSensorId) && videocameraDevicesMap[deviceId].push(linkedSensorId);
                        }
                    }
                } catch (e) {
                    logger.log(`Error in mainFlow-${device}`, e);
                }
            }

            const pluginStorage = this.storageSettings;
            const { availableRules: availableDetectionRules, allowedRules: allowedDetectionRules } = getDetectionRules({ pluginStorage, console: logger });
            const { availableRules: availableRecordingRules, allowedRules: allowedRecordingRules } = getRecordingRules({ pluginStorage, console: logger });

            const availableRules = [...availableDetectionRules, ...availableRecordingRules];
            const allowedRules = [...allowedDetectionRules, ...allowedRecordingRules];
            const currentlyRunningRules = [...this.runningDetectionRules, ...this.runningRecordingRules];

            const [rulesToEnable, rulesToDisable] = splitRules({
                allRules: availableRules,
                currentlyRunningRules,
                rulesToActivate: allowedRules
            });

            for (const rule of rulesToEnable) {
                logger.log(`${rule.ruleType} rule started: ${rule.name}`);
                const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: rule.ruleType });
                this.putSetting(currentlyActiveKey, 'true');
            }

            for (const rule of rulesToDisable) {
                logger.log(`${rule.ruleType} rule stopped: ${rule.name}`);
                const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: rule.ruleType });
                this.putSetting(currentlyActiveKey, 'false');
            }

            this.runningDetectionRules = cloneDeep(allowedDetectionRules) || [];
            this.runningRecordingRules = cloneDeep(allowedRecordingRules) || [];
            this.deviceVideocameraMap = deviceVideocameraMap;
            this.videocameraDevicesMap = videocameraDevicesMap;
            this.allAvailableRules = availableRules;

            const now = Date.now();

            if (!this.lastConfigurationsCheck || (now - this.lastConfigurationsCheck) > 1000 * 60 * 60) {
                this.lastConfigurationsCheck = now;
                await this.checkPluginConfigurations(false);
            }

            const { mqttEnabled, notificationsEnabled, devNotifications, devNotifier } = this.storageSettings.values;
            if (mqttEnabled) {
                const mqttClient = await this.getMqttClient();
                if (mqttClient) {
                    const logger = this.getLogger();
                    if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                        this.lastAutoDiscovery = now;
                        this.aiMessageResponseMap = {};

                        logger.log('Starting MQTT autodiscovery');
                        setupPluginAutodiscovery({
                            mqttClient,
                            people: await this.getKnownPeople(),
                            console: logger,
                            rules: availableRules,
                        }).then(async (activeTopics) => {
                            await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                        }).catch(logger.error);

                        await this.setupMqttEntities();
                    }
                    let pluginRpcObjects: number | undefined;
                    let pluginPendingResults: number | undefined;
                    try {
                        const { stats } = await getRpcData();
                        const pluginStats = stats[pluginName];
                        pluginPendingResults = pluginStats?.pendingResults;
                        pluginRpcObjects = pluginStats?.rpcObjects;
                    } catch (e) {
                        logger?.error('Errore recuperando statistiche RPC per publishPluginValues', e);
                    }

                    publishPluginValues({
                        mqttClient,
                        notificationsEnabled,
                        rulesToEnable,
                        rulesToDisable,
                        rpcObjects: pluginRpcObjects,
                        pendingResults: pluginPendingResults,
                        rssMemoryMB: typeof process !== 'undefined' && process.memoryUsage ? Math.round(process.memoryUsage().rss / 1024 / 1024) : undefined,
                        heapMemoryMB: typeof process !== 'undefined' && process.memoryUsage ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024) : undefined,
                    }).catch(logger.error);
                }
            }

            if (!this.restartRequested) {
                // const activeDevices = (getAllDevices()
                //     .filter(device =>
                //         device.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE) &&
                //         (device.type === ScryptedDeviceType.Camera || device.type === ScryptedDeviceType.Doorbell)
                //     )?.length || 0) + 1;
                const activeCameras = Object.keys(this.currentCameraMixinsMap).length;
                const activeSensors = Object.keys(this.currentSensorMixinsMap).length;
                const activeNotifiers = Object.keys(this.currentNotifierMixinsMap).length;

                const activeDevices = activeCameras + activeSensors + activeNotifiers;

                if (!!activeDevices) {
                    const { stats } = await getRpcData();
                    const pluginStats = stats[pluginName];
                    const pluginPendingResults = pluginStats?.pendingResults;
                    const pluginRpcObjects = pluginStats?.rpcObjects;

                    logger.info(`PLUGIN-STUCK-CHECK: active devices ${activeDevices}, pending results ${pluginPendingResults} RPC objects ${pluginRpcObjects}`);

                    const camerasHardCap = MAX_RPC_OBJECTS_PER_CAMERA * activeCameras;
                    const sensorsHardCap = MAX_RPC_OBJECTS_PER_SENSOR * activeSensors;
                    const notifiersHardCap = MAX_RPC_OBJECTS_PER_NOTIFIER * activeNotifiers;

                    const camerasSoftCap = SOFT_RPC_OBJECTS_PER_CAMERA * activeCameras;
                    const sensorsSoftCap = SOFT_RPC_OBJECTS_PER_SENSOR * activeSensors;
                    const notifiersSoftCap = SOFT_RPC_OBJECTS_PER_NOTIFIER * activeNotifiers;

                    let hardCap = MAX_RPC_OBJECTS_PER_PLUGIN + camerasHardCap + sensorsHardCap + notifiersHardCap;
                    let softCap = SOFT_RPC_OBJECTS_PER_PLUGIN + camerasSoftCap + sensorsSoftCap + notifiersSoftCap;

                    hardCap = max([hardCap, HARD_MIN_RPC_OBJECTS]);
                    softCap = max([softCap, SOFT_MIN_RPC_OBJECTS]);

                    let shouldRestart = false;
                    const maxActiveMotion = Math.floor(activeCameras / 15);
                    let body: string;
                    if (pluginRpcObjects > softCap && ((now - this.connectionTime) > (1000 * 60 * 60 * 2)) && this.cameraMotionActive.size <= maxActiveMotion) {
                        body = `${pluginRpcObjects} (> ${softCap}) RPC objects found, soft resetting because not much active motion`;
                        shouldRestart = true;
                    } else if (
                        pluginPendingResults > (MAX_PENDING_RESULT_PER_CAMERA * activeDevices) ||
                        pluginRpcObjects > hardCap
                    ) {
                        shouldRestart = true;
                        body = `High resources detected, ${pluginPendingResults} pending results and ${pluginRpcObjects} (> ${hardCap}) RPC objects. Restarting`;
                    }

                    if (shouldRestart) {
                        this.restartRequested = true;
                        await sdk.deviceManager.requestRestart();
                        devNotifications?.includes(DevNotifications.SoftRestart) && (devNotifier as Notifier).sendNotification('Advanced notifier restarted', {
                            body
                        });
                        logger.log(body);

                        for (const mixin of Object.values(this.currentCameraMixinsMap)) {
                            await mixin.onRestart();
                        }
                    }
                }
            }

            if (this.accumulatedTimelapsesToGenerate) {
                const timelapsesToRun = [...this.accumulatedTimelapsesToGenerate];
                this.accumulatedTimelapsesToGenerate = undefined;
                this.accumulatedTimelapsesToGenerate = [];
                const triggerTime = Date.now();

                for (const timelapse of timelapsesToRun) {
                    const { deviceId, ruleName } = timelapse;
                    const deviceState = this.cameraStates[deviceId];
                    const rule = deviceState?.allAvailableRules.find(rule => rule.ruleType === RuleType.Timelapse && rule.name === ruleName);
                    const device = sdk.systemManager.getDeviceById<DeviceInterface>(deviceId);
                    const deviceLogger = deviceState.logger;
                    await this.ensureRuleFoldersExist({ cameraId: device.id, ruleName: rule.name });
                    await this.generateTimelapse({
                        rule,
                        device,
                        logger: deviceLogger,
                        triggerTime,
                    });
                    await this.notifyTimelapse({
                        cameraDevice: device,
                        triggerTime,
                        rule
                    });
                }
            }
        } catch (e) {
            logger.log('Error in mainFlow', e);
        } finally {
            this.mainFlowInProgress = false;
        }
    }

    private async checkPluginConfigurations(manual: boolean) {
        const logger = this.getLogger();
        try {
            const notifiersRegex = new RegExp('(rule|occupancyRule|timelapseRule):(.*):notifiers');
            const devicesRegex = new RegExp('(rule|occupancyRule|timelapseRule):(.*):devices');
            const activationTypeRegex = new RegExp('rule:(.*):activation');
            const allDevices = getElegibleDevices();

            const missingNotifiersOfDeviceRules: { deviceName: string, ruleName: string, notifierIds: string[] }[] = [];
            const missingNotifiersOfPluginRules: { ruleName: string, notifierIds: string[] }[] = [];
            const missingDevicesOfPluginRules: { ruleName: string, deviceIds: string[] }[] = [];
            const devicesWithoutRoom: string[] = [];

            for (const device of allDevices) {
                if (!device.room) {
                    devicesWithoutRoom.push(device.name);
                }

                const { mixin, settings } = this.getRealMixin(device.id);
                if (mixin) {
                    const notifiersSettings = (await settings.getSettings())
                        .filter((sett) => sett.key?.match(notifiersRegex));

                    for (const notifiersSetting of notifiersSettings) {
                        const [_, type, name] = notifiersSetting.key.match(notifiersRegex);
                        const missingNotifiers = (notifiersSetting.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                        if (missingNotifiers.length) {
                            missingNotifiersOfDeviceRules.push({ deviceName: device.name, notifierIds: missingNotifiers, ruleName: `${type}_${name}` });
                        }
                    }
                } else {
                    logger.info(`Mixin not found for device ${device.name}`);
                }
            }

            const pluginStorage = this.storageSettings;
            const notifiersSettings = (await this.storageSettings.getSettings())
                .filter((sett) => sett.key?.match(notifiersRegex));

            for (const notifiersSetting of notifiersSettings) {
                const [_, type, name] = notifiersSetting.key.match(notifiersRegex);
                const missingNotifiers = (notifiersSetting.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                if (missingNotifiers.length) {
                    missingNotifiersOfPluginRules.push({ notifierIds: missingNotifiers, ruleName: `${type}_${name}` });
                }
            }

            const devicesSettings = (await this.storageSettings.getSettings())
                .filter((sett) => sett.key?.match(devicesRegex));

            for (const devicesSetting of devicesSettings) {
                const [_, type, name] = devicesSetting.key.match(devicesRegex);
                const missingDevices = (devicesSetting.value as string[])?.filter(deviceId => !sdk.systemManager.getDeviceById(deviceId));
                if (missingDevices.length) {
                    missingDevicesOfPluginRules.push({ deviceIds: missingDevices, ruleName: `${type}_${name}` });
                }
            }

            const anyActiveOnRules = Object.entries(pluginStorage)
                .filter(([key, setting]) => key?.match(activationTypeRegex) && setting.value === DetectionRuleActivation.OnActive);

            const sensorsNotLinkedToAnyCamera = allDevices.filter(
                device => device.type === ScryptedDeviceType.Sensor && !this.deviceVideocameraMap[device.id]
            ).map(sensor => sensor.name);

            const {
                devNotifier,
                devNotifications,
                scryptedToken,
                nvrUrl,
                objectDetectionDevice,
                clipDevice,
                haEnabled,
                securitySystem,
            } = this.storageSettings.values;
            let storagePathError;

            const imagesPath = this.getStoragePath();

            const imagesPathSet = imagesPath && imagesPath !== '';

            if (imagesPathSet) {
                try {
                    await fs.promises.access(imagesPath);
                } catch (e) {
                    storagePathError = e;
                }
            }

            const alertHaIssues = haEnabled && anyActiveOnRules;

            const securitySystemDevice: SecuritySystem = typeof securitySystem === 'string' ? sdk.systemManager.getDeviceById<SecuritySystem>(securitySystem) : securitySystem;
            const securitySyetemState = securitySystemDevice?.securitySystemState;
            const securitySystemCorrectMode = securitySyetemState ? Object.keys(SecuritySystemMode).includes(securitySyetemState.mode) : undefined;

            const body = JSON.stringify({
                missingNotifiersOfDeviceRules: missingNotifiersOfDeviceRules.length ? missingNotifiersOfDeviceRules : undefined,
                missingNotifiersOfPluginRules: missingNotifiersOfPluginRules.length ? missingNotifiersOfPluginRules : undefined,
                missingDevicesOfPluginRules: missingDevicesOfPluginRules.length ? missingDevicesOfPluginRules : undefined,
                sensorsNotLinkedToAnyCamera: sensorsNotLinkedToAnyCamera.length ? sensorsNotLinkedToAnyCamera : undefined,
                devicesWithoutRoom: devicesWithoutRoom.length ? devicesWithoutRoom : undefined,
                storagePathError: storagePathError ?? (imagesPathSet ? 'No error' : 'Not set'),
                scryptedToken: scryptedToken ? 'Set' : 'Not set',
                serverId: this.storageSettings.getItem('serverId') ? 'Found' : 'Not found',
                nvrUrl: nvrUrl ? 'Set' : 'Not set',
                objectDetectionDevice: objectDetectionDevice ? objectDetectionDevice.name : 'Not set',
                clipDevice: clipDevice ? clipDevice.name : 'Not set',
                securitySystemSet: securitySystemDevice ? 'Set' : 'Not set',
                securitySystemState: securitySystemDevice ? securitySystemCorrectMode ? 'Ok' : `Wrong: ${securitySyetemState?.mode}` : undefined
            });

            if (manual) {
                logger.log(`checkPluginConfigurations results: ${body}`);
            } else {
                logger.debug(`Results: ${body}`);

                if (
                    missingNotifiersOfDeviceRules.length ||
                    missingNotifiersOfPluginRules.length ||
                    missingDevicesOfPluginRules.length ||
                    sensorsNotLinkedToAnyCamera.length ||
                    (alertHaIssues && devicesWithoutRoom.length) ||
                    !!storagePathError
                ) {
                    devNotifications?.includes(DevNotifications.ConfigCheckError) && (devNotifier as Notifier).sendNotification('Advanced notifier not correctly configured', {
                        body
                    });
                }
            }
        } catch (e) {
            logger.log('Error in checkExistingDevices', e);
        }
    }

    async toggleRule(ruleName: string, ruleType: RuleType, enabled: boolean) {
        const mqttClient = await this.getMqttClient();

        if (mqttClient) {
            const logger = this.getLogger();
            const rule = this.allAvailableRules.find(rule => rule.ruleType === ruleType && rule.name === ruleName);

            logger.log(`Setting ${ruleType} rule ${ruleName} enabled to ${enabled}`);

            if (rule) {
                await publishRuleEnabled({
                    console: logger,
                    rule,
                    enabled,
                    mqttClient
                });
            }
        }
    };


    async triggerRuleSequences(props: {
        sequences: RuleActionsSequence[],
        postFix: 'test' | string,
        rule: BaseRule,
        deviceId?: string,
    }) {
        const { postFix, sequences, rule, deviceId } = props;
        const isTest = postFix === 'test';

        if (sequences?.length) {
            const logger = this.getLogger();

            for (const sequence of sequences) {
                let canExecute = false;
                if (deviceId) {
                    const cameraMixin = deviceId ? this.currentCameraMixinsMap[deviceId] : undefined;
                    const { timePassed } = cameraMixin.isDelayPassed({
                        type: DelayType.SequenceExecution,
                        delay: sequence.minimumExecutionDelay,
                        postFix,
                    });
                    canExecute = timePassed;
                }

                if (isTest || (canExecute && sequence.enabled)) {
                    try {
                        logger.log(`Triggering sequence ${sequence.name} from rule ${rule.name}: ${JSON.stringify(sequence)}`);
                        for (const action of sequence.actions) {
                            logger[isTest ? 'log' : 'info'](`Executing action ${action.actionName} of type ${action.type} in sequence ${sequence.name}`);

                            if (action.type === RuleActionType.Wait && action.seconds) {
                                await new Promise(resolve => setTimeout(resolve, action.seconds * 1000));
                            } if (action.type === RuleActionType.Script) {
                                const device = sdk.systemManager.getDeviceById<Program>(action.deviceId);
                                await device.run();
                            } else if (action.type === RuleActionType.Ptz) {
                                const device = sdk.systemManager.getDeviceById<PanTiltZoom>(action.deviceId);
                                const presetId = action.presetName?.split(':')[1];
                                await device.ptzCommand({ preset: presetId, movement: PanTiltZoomMovement.Preset });
                            } else if (action.type === RuleActionType.Switch) {
                                const device = sdk.systemManager.getDeviceById<OnOff>(action.deviceId);
                                if (action.turnOn) {
                                    await device.turnOn();
                                } else {
                                    await device.turnOff();
                                }
                            } else if (action.type === RuleActionType.Lock) {
                                const device = sdk.systemManager.getDeviceById<Lock>(action.deviceId);
                                if (action.lock) {
                                    await device.lock();
                                } else {
                                    await device.unlock();
                                }
                            } else if (action.type === RuleActionType.Entry) {
                                const device = sdk.systemManager.getDeviceById<Entry>(action.deviceId);
                                if (action.openEntry) {
                                    await device.openEntry();
                                } else {
                                    await device.closeEntry();
                                }
                            }
                        }
                    } catch (e) {
                        logger.log(`Error triggering sequence ${sequence.name} from rule ${rule.name}: ${e.message}`);
                    }
                } else {
                    logger[isTest ? 'log' : 'info'](`Skipping sequence ${sequence.name}: enabled ${sequence.enabled}, canExecute ${canExecute}`);
                }
            }
        }
    }

    async testSequence(sequenceName: string) {
        const logger = this.getLogger();

        const sequence = getSequenceObject({
            sequenceName,
            storage: this.storageSettings,
        });

        logger.log(`Testing sequence ${sequenceName}: ${JSON.stringify(sequence)}`);
        await this.triggerRuleSequences({
            sequences: [sequence],
            postFix: 'test',
            rule: {
                name: 'test',
            } as BaseRule,
        });
    }

    async refreshSettings() {
        const logger = this.getLogger();
        const dynamicSettings: StorageSetting[] = [];
        const people = (await this.getKnownPeople());
        const { frigateLabels } = await this.getFrigateData();
        const { labels: audioLabels } = await this.getAudioData();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Plugin,
            logger,
            frigateLabels,
            audioLabels,
            people,
            refreshSettings: async () => await this.refreshSettings(),
            plugin: this,
        });
        dynamicSettings.push(...detectionRulesSettings);

        const recordingRulesSettings = await getRecordingRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Plugin,
            logger,
            refreshSettings: async () => await this.refreshSettings(),
        });
        dynamicSettings.push(...recordingRulesSettings);

        const actionRuleSettings = await getSequencesSettings({
            logger,
            refreshSettings: async () => await this.refreshSettings(),
            storage: this.storageSettings,
            onTestSequence: async (sequenceName: string) => {
                await this.testSequence(sequenceName);
            }
        })
        dynamicSettings.push(...actionRuleSettings);

        dynamicSettings.push(...getAiSettings({
            storage: this.storageSettings,
            logger,
            onRefresh: async () => await this.refreshSettings(),
        }));

        const additionalLabels = uniq([...frigateLabels ?? [], ...audioLabels ?? []]);

        if (additionalLabels.length) {
            for (const label of additionalLabels) {
                dynamicSettings.push({
                    key: getFrigateTextKey(label),
                    group: 'Texts',
                    subgroup: 'Additional labels',
                    title: `${label} text`,
                    type: 'string',
                    defaultValue: label,
                    placeholder: label,
                });
            }
        }

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        const {
            mqttEnabled,
            testDevice,
            testNotifier,
            testGenerateClip,
        } = this.storageSettings.values;

        try {
            if (mqttEnabled) {
                this.storageSettings.settings.detectionSourceForMqtt.choices = this.enabledDetectionSources;
                this.storageSettings.settings.facesSourceForMqtt.choices = this.enabledDetectionSources;
            }

            this.storageSettings.settings.mqttActiveEntitiesTopic.hide = !mqttEnabled;
            this.storageSettings.settings.detectionSourceForMqtt.hide = !mqttEnabled;
            this.storageSettings.settings.facesSourceForMqtt.hide = !mqttEnabled;
        } catch { }

        const { isCamera } = testDevice ? isDeviceSupported(testDevice) : {};
        this.storageSettings.settings.testEventType.hide = !isCamera;
        this.storageSettings.settings.testGenerateClipSpeed.hide = !testGenerateClip;
        this.storageSettings.settings.testGenerateClipType.hide = !testGenerateClip;
        this.storageSettings.settings.testClipPostSeconds.hide = !testGenerateClip;
        this.storageSettings.settings.testClipPreSeconds.hide = !testGenerateClip;
        // this.storageSettings.settings.frigateEnabled.hide = !this.frigateApi;

        if (testNotifier) {
            const { priorityChoices } = getNotifierData({ notifierId: testNotifier.id, ruleType: RuleType.Detection });
            this.storageSettings.settings.testPriority.choices = priorityChoices;
        }

        const originSource = this.storageSettings.values.assetsOriginSource;
        this.storageSettings.settings.customOriginUrl.hide = originSource !== AssetOriginSource.Custom;
    }

    get enabledDetectionSources() {
        return this.frigateApi ? [
            ScryptedEventSource.RawDetection,
            ScryptedEventSource.NVR,
            ScryptedEventSource.Frigate,
        ] : [
            ScryptedEventSource.RawDetection,
            ScryptedEventSource.NVR,
        ];
    }

    async getSettings() {
        try {
            const settings = await this.storageSettings.getSettings();

            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    generateHomeassistantHelpers = async () => {
        const logger = this.getLogger();

        try {
            const haApi = await this.getHaApi();
            const res = await haApi.postAutomation(haSnoozeAutomationId, haSnoozeAutomation);
            logger.log(`Generation snoozing automation: ${res.data.result}`);
            const res2 = await haApi.postAutomation(haAlarmAutomationId, haAlarmAutomation);
            logger.log(`Generation alarm automation: ${res2.data.result}`);
        } catch (e) {
            logger.log(e);
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        const { isNotifier, isCamera, isSupported } = isDeviceSupported({ interfaces, type } as DeviceBase);

        if (
            isSupported &&
            !interfaces.includes(ADVANCED_NOTIFIER_NOTIFIER_INTERFACE) &&
            !interfaces.includes(ADVANCED_NOTIFIER_CAMERA_INTERFACE)
        ) {
            const interfaces = [ScryptedInterface.Settings, ADVANCED_NOTIFIER_INTERFACE];

            if (isNotifier) {
                interfaces.push(ScryptedInterface.Notifier);
            } else if (isCamera) {
                interfaces.push(ScryptedInterface.VideoClips);
            }

            return interfaces;
        }

        return undefined;
    }

    async checkIfClipRequired(props: {
        cb: (props: { videoUrl?: string, gifUrl?: string, imageUrl?: string }) => Promise<void>,
        rule: BaseRule
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        b64Image?: string,
    }) {
        const { cb, rule, device, logger, triggerTime } = props;
        const deviceMixin = this.currentCameraMixinsMap[device.id];

        let pastMs: number;

        const pastSeconds = rule.generateClipPreSeconds;
        if (pastSeconds !== undefined) {
            pastMs = pastSeconds * 1000;
        } else {
            pastMs = (
                rule.ruleType === RuleType.Occupancy ?
                    defaultOccupancyClipPreSeconds :
                    defaultClipPreSeconds
            ) * 1000;
        }

        const prepareClip = async () => {
            if (rule.generateClipType === VideoclipType.MP4) {
                const { fileName, filteredFiles, } = await this.generateVideoclip({
                    device,
                    logger,
                    rule,
                    triggerTime,
                    pastMs,
                }) ?? {};

                if (filteredFiles?.length) {
                    const { videoRuleUrl, imageRuleUrl } = await getWebHookUrls({
                        console: logger,
                        fileId: fileName,
                        plugin: this,
                        ruleName: rule.name,
                        device
                    });

                    await cb({ videoUrl: videoRuleUrl, imageUrl: imageRuleUrl });
                } else {
                    await cb({});
                }
            } else if (rule.generateClipType === VideoclipType.GIF) {
                const { filteredFiles } = await this.generateGif({
                    device,
                    logger,
                    rule,
                    triggerTime,
                    pastMs,
                }) ?? {};

                if (filteredFiles?.length) {
                    const { gifRuleUrl, imageRuleUrl } = await getWebHookUrls({
                        console: logger,
                        fileId: String(triggerTime),
                        plugin: this,
                        ruleName: rule.name,
                        device
                    });

                    await cb({ gifUrl: gifRuleUrl, imageUrl: imageRuleUrl });
                } else {
                    await cb({});
                }
            }
        }

        const decoderType = deviceMixin.decoderType;
        if (rule.generateClip && decoderType !== DecoderType.Off) {
            const cameraState = this.cameraStates[device.id];
            const delay = rule.generateClipPostSeconds ?? 3;
            const key = `${device.id}_${rule.name}`;
            const now = Date.now();
            const maxExtensionRange = (rule as any).maxClipExtensionRange || 0;
            const maxExtensionMs = maxExtensionRange * 1000;
            const lastGeneration = cameraState.lastClipGenerationTimestamps[key];

            if (lastGeneration && (now - lastGeneration) < maxExtensionMs) {
                // Extend the existing clip generation by resetting the timeout
                logger.log(`Extending clip generation for rule ${rule.name} on device ${device.name}, within ${maxExtensionRange}s range`);
                cameraState.clipGenerationTimeout[rule.name] && clearTimeout(cameraState.clipGenerationTimeout[rule.name]);
                cameraState.clipGenerationTimeout[rule.name] = setTimeout(async () => {
                    cameraState.lastClipGenerationTimestamps[key] = Date.now();
                    await prepareClip();
                }, 1000 * delay);
            } else {
                // Start new clip generation
                logger.log(`Starting clip ${rule.generateClipType} recording for rule ${rule.name} in ${delay} seconds (${decoderType})`);
                cameraState.clipGenerationTimeout[rule.name] && clearTimeout(cameraState.clipGenerationTimeout[rule.name]);
                cameraState.clipGenerationTimeout[rule.name] = setTimeout(async () => {
                    cameraState.lastClipGenerationTimestamps[key] = Date.now();
                    await prepareClip();
                }, 1000 * delay);
            }
        } else {
            cb({});
        }
    }

    async notifyOccupancyEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        rule: OccupancyRule,
        image: MediaObject,
        b64Image: string,
        occupancyData: OccupancyRuleData
    }) {
        const { cameraDevice, rule, triggerTime, image, b64Image, occupancyData } = props;
        const logger = this.getLogger(cameraDevice);

        await this.ensureRuleFoldersExist({ cameraId: cameraDevice.id, ruleName: rule.name });

        let message = occupancyData.occupies ?
            rule.zoneOccupiedText :
            rule.zoneNotOccupiedText;

        message = message.toString()
            .replace('${detectedObjects}', String(occupancyData.objectsDetected) ?? '')
            .replace('${maxObjects}', String(rule.maxObjects) ?? '');

        const executeNotify = async (props: { videoUrl?: string, gifUrl?: string, imageUrl?: string }) => {
            const { gifUrl, videoUrl, imageUrl, } = props;
            logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ rule, gifUrl, videoUrl })} `);

            for (const notifierId of rule.notifiers) {
                const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

                this.sendNotificationInternal({
                    notifier,
                    image,
                    message,
                    triggerTime,
                    device: cameraDevice,
                    rule,
                    videoUrl,
                    gifUrl,
                    imageUrl,
                }).catch(logger.error);
            }
        }

        this.checkIfClipRequired({
            cb: executeNotify,
            device: cameraDevice,
            logger,
            rule,
            triggerTime,
            b64Image,
        }).catch(logger.error);
    }

    async ensureRuleFoldersExist(props: { cameraId: string, ruleName: string }) {
        const { cameraId, ruleName } = props;
        const logger = this.getLogger();
        const { generatedPath } = this.getRulePaths({
            cameraId,
            ruleName,
        });

        try {
            await fs.promises.access(generatedPath);
        } catch {
            logger.log(`Creating rule folder at ${generatedPath}`);
            await fs.promises.mkdir(generatedPath, { recursive: true });
        }
    }

    async notifyAudioEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        message: string,
        b64Image: string,
        rule: AudioRule,
        image: MediaObject,
    }) {
        const { cameraDevice, rule, triggerTime, b64Image, image, message } = props;
        const logger = this.getLogger(cameraDevice);
        const imageUrl = await this.storeRuleImage({
            device: cameraDevice,
            rule,
            b64Image,
            triggerTime,
            logger,
        });
        await this.ensureRuleFoldersExist({ cameraId: cameraDevice.id, ruleName: rule.name });

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                image,
                message,
                triggerTime,
                device: cameraDevice,
                rule,
                imageUrl,
            });
        }
    }

    async storeRuleImage(props: {
        device: ScryptedDeviceBase,
        rule: BaseRule,
        b64Image?: string,
        bufferImage?: Buffer,
        triggerTime: number,
        logger: Console
    }) {
        const { device, rule, b64Image, bufferImage, triggerTime, logger } = props;
        const { imageLatestPath, imageHistoricalPath, generatedPath } = this.getRulePaths({
            cameraId: device.id,
            ruleName: rule.name,
            triggerTime
        });

        logger.log(`Storing rule image for ${rule.name} into ${imageHistoricalPath} and latest at ${imageLatestPath}`);

        try {
            await fs.promises.access(generatedPath);
        } catch {
            await fs.promises.mkdir(generatedPath, { recursive: true });
        }

        if (b64Image) {
            const base64Data = b64Image.replace(/^data:image\/png;base64,/, "");
            await fs.promises.writeFile(imageHistoricalPath, base64Data, 'base64');
        } else if (bufferImage) {
            await fs.promises.writeFile(imageHistoricalPath, bufferImage);
        }
        await fs.promises.copyFile(imageHistoricalPath, imageLatestPath);

        const { imageRuleUrl } = await getWebHookUrls({
            fileId: String(triggerTime),
            ruleName: rule.name,
            plugin: this,
            device
        });

        return imageRuleUrl;
    }

    async notifyTimelapse(props: {
        cameraDevice: DeviceInterface,
        rule: TimelapseRule,
        triggerTime: number,
    }) {
        const { cameraDevice, rule, triggerTime } = props;
        const logger = this.getLogger(cameraDevice);

        const { videoRuleUrl, imageRuleUrl } = await getWebHookUrls({
            console: logger,
            plugin: this,
            fileId: String(triggerTime),
            ruleName: rule.name,
            device: cameraDevice,
        });

        await this.ensureRuleFoldersExist({ cameraId: cameraDevice.id, ruleName: rule.name });

        const { videoHistoricalPath } = this.getRulePaths({
            ruleName: rule.name,
            cameraId: cameraDevice.id,
            triggerTime
        });

        const fileStats = await fs.promises.stat(videoHistoricalPath);
        const sizeInBytes = fileStats.size;

        for (const notifierId of (rule.notifiers ?? [])) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                device: cameraDevice,
                rule,
                videoUrl: videoRuleUrl,
                clickUrl: videoRuleUrl,
                videoSize: sizeInBytes,
                imageUrl: imageRuleUrl,
                triggerTime: Date.now()
            });
        }
    }

    async notifyNvrEvent(props: ParseNotificationMessageResult & { cameraDevice: DeviceInterface, triggerTime: number }) {
        const { eventType, detection, triggerDevice, cameraDevice, triggerTime } = props;
        const rules = this.runningDetectionRules.filter(rule =>
            rule.detectionSource === ScryptedEventSource.NVR &&
            rule.nvrEvents.includes(eventType as NvrEvent)
        );
        const logger = this.getLogger();

        for (const rule of rules) {
            if (rules.length) {
                logger.log(`Starting notifiers for NVR event rule (${eventType}): ${JSON.stringify({ rule })}`);
            }

            const notifiers = rule.notifiers
            for (const notifierId of notifiers) {
                const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

                const title = triggerDevice.name;
                await this.sendNotificationInternal({
                    notifier,
                    device: cameraDevice,
                    rule,
                    triggerTime,
                    detection,
                    eventType,
                    title,
                });
            }
        }
    }

    async onNvrNotification(cameraName: string, options?: NotifierOptions, image?: MediaObject, icon?: MediaObject | string) {
        const logger = this.getLogger();
        const triggerTime = options?.recordedEvent?.data.timestamp ?? new Date().getTime();
        const cameraDevice = sdk.systemManager.getDeviceByName<DeviceInterface>(cameraName);
        const deviceSensors = this.videocameraDevicesMap[cameraDevice.id] ?? [];
        const result = await parseNvrNotificationMessage(cameraDevice, deviceSensors, options, logger);
        const {
            allDetections,
            eventType,
            triggerDevice,
        } = result;
        const { isCamera } = isDeviceSupported(triggerDevice);

        const foundDevice = this.currentCameraMixinsMap[triggerDevice.id] || this.currentSensorMixinsMap[triggerDevice.id];

        if (!foundDevice) {
            logger.info(`Device not found for NVR notification: ${cameraName} ${eventType} ${triggerDevice?.name}`);
            return;
        }

        if (isCamera) {
            logger.info(`NVR detections incoming: ${JSON.stringify({ allDetections, cameraName, options })}`);
            if (isDetectionClass(eventType)) {
                await (foundDevice as AdvancedNotifierCameraMixin)?.processDetections({
                    detect: { ...options.recordedEvent.data, detections: allDetections },
                    image,
                    eventSource: ScryptedEventSource.NVR,
                });
            } else {
                if (eventType) {
                    await this.notifyNvrEvent(
                        {
                            ...result,
                            cameraDevice,
                            triggerTime
                        }
                    );
                } else {
                    logger.error(`Notification coming from NVR not mapped yet: ${JSON.stringify({
                        cameraName,
                        options,
                        allDetections,
                        eventType,
                        triggerDevice: triggerDevice.name,
                    })
                        } `);
                }
            }
        }
    }

    public getLinkedCamera = async (deviceId: string) => {
        const device = systemManager.getDeviceById<DeviceInterface>(deviceId);
        const cameraDevice = await this.getCameraDevice(device);

        if (!device || !cameraDevice) {
            this.getLogger().log(`Camera device for ID ${deviceId} not found.Device found: ${!!device} and camera was found: ${!!cameraDevice} `);
        }

        return { device: cameraDevice, triggerDevice: device };
    }

    public notifyDetectionEvent = async (props: NotifyDetectionProps) => {
        const {
            eventType,
            triggerDeviceId,
            snoozeId,
            triggerTime: triggerTimeParent,
            forceAi,
            imageData,
            matchRule,
        } = props;
        const { rule: ruleParent, match } = matchRule;
        const rule = ruleParent as DetectionRule;
        const triggerTime = triggerTimeParent || Date.now();
        const { device: cameraDevice, triggerDevice } = await this.getLinkedCamera(triggerDeviceId);
        const logger = this.getLogger(cameraDevice);
        const cameraMixin = this.currentCameraMixinsMap[cameraDevice.id];

        await this.ensureRuleFoldersExist({ cameraId: cameraDevice.id, ruleName: rule.name });

        let image: MediaObject;
        let b64Image: string;
        let imageSource: ImageSource;

        if (!imageData) {
            let { b64Image: newB64Image, image: newImage, imageSource: newImageSource } = await cameraMixin.getImage({
                reason: GetImageReason.Notification
            });

            image = newImage;
            b64Image = newB64Image;
            imageSource = newImageSource;
        } else {
            image = imageData.image;
            b64Image = image ? await moToB64(image) : undefined;
            imageSource = imageData.imageSource;
        }

        if (rule.activationType === DetectionRuleActivation.AdvancedSecuritySystem) {
            this.alarmSystem.onEventTrigger({ triggerDevice }).catch(logger.log);
        }

        const executeNotify = async (props: { videoUrl?: string, gifUrl?: string, imageUrl?: string }) => {
            const { gifUrl, videoUrl, imageUrl: imageUrlParent } = props;
            let imageUrl = imageUrlParent;

            if (!imageUrl) {
                imageUrl = await this.storeRuleImage({
                    device: cameraDevice,
                    rule,
                    b64Image,
                    triggerTime,
                    logger,
                });
            }

            logger.log(`${rule.notifiers.length} notifiers will be notified with image from ${imageSource}: ${JSON.stringify({ match, rule, videoUrl, gifUrl, imageUrl })} `);

            for (const notifierId of rule.notifiers) {
                const notifier = systemManager.getDeviceById<Settings & ScryptedDeviceBase>(notifierId);

                this.notifyDetection({
                    triggerDevice,
                    cameraDevice,
                    notifierId,
                    time: triggerTime,
                    image,
                    b64Image,
                    detection: match,
                    eventType,
                    logger,
                    snoozeId,
                    rule: rule as DetectionRule,
                    videoUrl,
                    forceAi,
                    gifUrl,
                    imageUrl,
                }).catch(e => logger.log(`Error on notifier ${notifier.name} `, e));

                const decoderType = cameraMixin.decoderType;
                if (rule.generateClip && decoderType !== DecoderType.Off) {
                    cameraMixin.mixinState.clipGenerationTimeout[rule.name] && clearTimeout(cameraMixin.mixinState.clipGenerationTimeout[rule.name]);
                    cameraMixin.mixinState.clipGenerationTimeout[rule.name] = undefined;
                }
            }
        }

        this.checkIfClipRequired({
            cb: executeNotify,
            device: cameraDevice,
            logger,
            rule,
            triggerTime,
        }).catch(logger.error);
    };

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        const props = {
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Advanced notifier',
            groupKey: 'homeassistantMetadata',
        };
        const logger = this.getLogger();

        const { isCamera, isSensor, isNotifier, sensorType } = isDeviceSupported({ interfaces: mixinDeviceInterfaces } as DeviceBase);

        try {
            if (isCamera) {
                const mixin = new AdvancedNotifierCameraMixin(
                    props,
                    this
                );
                return mixin;
            } else if (isSensor) {
                const mixin = new AdvancedNotifierSensorMixin(
                    props,
                    sensorType,
                    this
                );
                return mixin;
            } else if (isNotifier) {
                const mixin = new AdvancedNotifierNotifierMixin(
                    props,
                    this
                );
                return mixin;
            }
        } catch (e) {
            logger.log(`Error in getMixin for device ${mixinDeviceState.name}`, e);
        }
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }

    private getUrls(cameraId: string, time: number) {
        const serverId = this.storageSettings.getItem('serverId');
        const nvrUrl = this.storageSettings.getItem('nvrUrl');
        const scryptedToken = this.storageSettings.getItem('scryptedToken');

        const timelinePart = `#/timeline/${cameraId}?time=${time}&from=notification&serverId=${serverId}&disableTransition=true`;
        const haUrl = `/api/scrypted/${scryptedToken}/endpoint/@scrypted/nvr/public/${timelinePart} `
        const externalUrl = `${nvrUrl}/${timelinePart}`
        return { externalUrl: externalUrl, haUrl: `/scrypted_${scryptedToken}?url=${encodeURIComponent(haUrl)}`, timelinePart }
    }

    private getTriggerZone = (detection: ObjectDetectionResult, rule: DetectionRule) => {
        const { zones } = detection ?? {};
        let zone: string;
        if (rule?.whitelistedZones) {
            zone = detection?.zones?.find(zoneInner => rule.whitelistedZones.includes(zoneInner));
        } else {
            zone = zones?.[0];
        }

        return zone;
    }

    getTextKey(props: {
        textKey: TextSettingKey,
        notifierId: string
    }) {
        const { notifierId, textKey } = props;
        return this.currentNotifierMixinsMap[notifierId]?.storageSettings.values[textKey] || this.storageSettings.values[textKey];
    }

    private async getNotificationText(
        props: {
            device: DeviceInterface,
            detectionTime: number,
            detection?: ObjectDetectionResult,
            eventType?: DetectionEvent,
            notifierId: string,
            externalUrl?: string,
            rule?: DetectionRule,
        }
    ) {
        const { detection, detectionTime, notifierId, device, externalUrl, rule, eventType } = props;
        const { label: labelRaw, className } = detection ?? {};

        let label = labelRaw;
        if (!isLabelDetection(className)) {
            const labelAttemptKey = getFrigateTextKey(labelRaw);
            label = this.getTextKey({ notifierId, textKey: labelAttemptKey }) ?? label;
        }

        const roomName = device?.room;

        const { key, subKey } = getEventTextKey({ eventType, hasLabel: !!label });

        const textToUse = rule?.customText || this.getTextKey({ notifierId, textKey: key });
        const subkeyText = subKey ? this.getTextKey({ notifierId, textKey: subKey }) : undefined;

        const detectionTimeText = this.getTextKey({ notifierId, textKey: 'detectionTimeText' });
        const time = eval(detectionTimeText.replace('${time}', detectionTime));

        const zone = this.getTriggerZone(detection, rule);

        return textToUse?.toString()
            .replace('${time}', time)
            .replace('${classnameText}', subkeyText ?? '')
            .replace('${nvrLink}', externalUrl ?? '')
            .replace('${person}', label ?? '')
            .replace('${plate}', label ?? '')
            .replace('${streamName}', label ?? '')
            .replace('${label}', label ?? '')
            .replace('${zone}', zone ?? '')
            .replace('${room}', roomName ?? '');
    }

    async buildSnoozes(props: { notifierId: string }) {
        const { notifierId } = props;
        const { snoozes } = this.storageSettings.values;

        const snoozePlaceholder = this.getTextKey({ notifierId, textKey: 'snoozeText' });
        const minutesPlaceholder = this.getTextKey({ notifierId, textKey: 'minutesText' });
        const hoursPlaceholder = this.getTextKey({ notifierId, textKey: 'hoursText' });

        const snoozeItems: SnoozeItem[] = [];

        for (const minutesText of snoozes) {
            const minutes = Number(minutesText);
            const isHours = minutes % 60 === 0;
            const time = isHours ? minutes / 60 : minutes;
            const timeString = `${time} ${isHours ? hoursPlaceholder : minutesPlaceholder}`;

            const text = snoozePlaceholder
                ?.replaceAll('${timeText}', timeString);

            snoozeItems.push({ text, minutes });
        }

        return { snoozeItems };
    }

    async getNotificationContent(props: {
        notifier: DeviceBase & Notifier,
        rule?: DetectionRule | OccupancyRule | TimelapseRule,
        triggerTime?: number,
        message?: string,
        videoUrl?: string,
        gifUrl?: string,
        clickUrl?: string,
        detection?: ObjectDetectionResult,
        device?: DeviceInterface,
        eventType?: DetectionEvent,
        b64Image?: string,
        logger: Console,
        snoozeId?: string,
        forceAi?: boolean,
        videoSize?: number,
    }) {
        const {
            notifier,
            rule,
            triggerTime,
            device,
            videoUrl,
            clickUrl,
            detection,
            eventType,
            message: messageParent,
            b64Image,
            logger,
            snoozeId: snoozeIdParent,
            forceAi,
            videoSize = 0,
            gifUrl: giftUrlParent,
        } = props;
        if (!notifier) {
            return {};
        }
        const { notifierData } = rule ?? {};
        const notifierId = notifier.id;
        const cameraId = device?.id;
        const { actions, priority, addSnooze, addCameraActions, sound, openInApp, channel, notificationIcon, iconColor } = notifierData?.[notifierId] ?? {};
        const { withActions, withSnoozing, withSound, withOpenInApp, withChannel, withNotificationIcon,
            withClearNotification, withDeleteNotification, withOpenNotification } = getNotifierData({ notifierId, ruleType: rule?.ruleType });
        const cameraMixin = cameraId ? this.currentCameraMixinsMap[cameraId] : undefined;
        const notifierMixin = this.currentNotifierMixinsMap[notifierId];
        const { notifierActions, aiEnabled: cameraAiEnabled } = cameraMixin?.mixinState.storageSettings.values ?? {}
        const { aiEnabled: notifierAiEnabled } = notifierMixin.storageSettings.values;
        const { haUrl, externalUrl, timelinePart } = this.getUrls(cameraId, triggerTime);
        const deviceLogger = this.getLogger(device);
        let aiUsed = false;

        let additionalMessageText: string = '';

        const actionsEnabled = withActions && addCameraActions;
        const actionsToUseTmp: ExtendedNotificationAction[] = actionsEnabled ?
            [...(actions ?? []),
            ...((notifierActions || []).map(action => safeParseJson(action)) ?? [])] :
            [];
        const actionsToUse: ExtendedNotificationAction[] = [];

        let gifUrl = giftUrlParent;
        if (gifUrl) {
            const actualUrl = new URL(gifUrl);
            gifUrl = `${actualUrl.origin}${actualUrl.pathname}${actualUrl.search}`;
        }

        for (const { action, title, icon, url, destructive } of actionsToUseTmp) {
            let urlToUse = url;

            // Assuming every action without url is an HA action
            if (!urlToUse) {
                const { haActionUrl } = await getWebHookUrls({
                    cameraIdOrAction: action,
                    console: deviceLogger,
                    device,
                    plugin: this
                });
                urlToUse = haActionUrl;
            }

            actionsToUse.push({
                action,
                title,
                icon,
                url: urlToUse,
                destructive,
            });
        }

        let snoozeId = snoozeIdParent;
        if (!snoozeId) {
            snoozeId = getSnoozeId({
                cameraId: device?.id,
                notifierId,
                priority,
                rule,
                detection,
            });
        }

        const { snoozeItems } = await this.buildSnoozes({ notifierId });
        const { snoozeActions, endpoint } = await getWebHookUrls({
            console: deviceLogger,
            device,
            snoozeId,
            snoozeItems,
            plugin: this
        });
        const openNvrText = this.getTextKey({ notifierId, textKey: 'openNvrText' });

        const addSnozeActions = withSnoozing && addSnooze;
        let payload: any = {
            data: {
                isNotificationFromAnPlugin: true,
                cameraId,
                eventType,
                snoozeId,
            }
        };

        if (notifier.pluginId === TELEGRAM_PLUGIN_ID) {
            payload.data.telegram = {};

            const telegramActions: any[][] = [];
            const firstLine: any[] = []
            if (videoUrl) {
                firstLine.push({
                    title: 'Clip',
                    url: videoUrl,
                });
            }
            firstLine.push({
                title: 'Live',
                url: externalUrl,
            });
            telegramActions.push(firstLine);

            if (addSnozeActions) {
                const snoozeLine: any[] = [];
                for (const { data, url } of snoozeActions) {
                    snoozeLine.push({
                        action: `scrypted_an_snooze_${cameraId}_${notifierId}_${data}_${snoozeId}`,
                        title: `${data} mins`,
                        url,
                    });
                }
                telegramActions.push(snoozeLine);
            }

            if (actionsToUse.length) {
                const actionsLine: any[] = [];
                for (const { url, title, action } of actionsToUse) {
                    actionsLine.push({
                        action,
                        uri: url,
                        title,
                    })
                }
                telegramActions.push(actionsLine);
            }

            payload.data.telegram.actions = telegramActions;
            if (videoUrl) {
                payload.data.telegram.gifUrl = videoUrl;
            }
            if (gifUrl) {
                payload.data.telegram.gifUrl = gifUrl;
            }

            payload.silent = priority !== NotificationPriority.Normal;
        } else if (notifier.pluginId === PUSHOVER_PLUGIN_ID) {
            payload.data.pushover = {
                timestamp: triggerTime,
                url: clickUrl ?? externalUrl,
                html: 1,
                sound
            };

            const acts: ExtendedNotificationAction[] = [];
            if (addSnozeActions) {
                acts.push(...snoozeActions);
            }
            acts.push(...actionsToUse);
            if (acts.length) {
                additionalMessageText += '\n';
                for (const { title, url } of acts) {
                    additionalMessageText += `<a href="${url}">${title}</a>\n`;
                }
            }
            if (videoUrl) {
                additionalMessageText += '\n' + `<a href="${videoUrl}">Clip</a>\n`;
            }

            const priorityToUse = priority === NotificationPriority.High ? 1 :
                priority === NotificationPriority.Normal ? 0 :
                    priority === NotificationPriority.Low ? -1 :
                        -2;

            payload.data.pushover.priority = priorityToUse;

            if (gifUrl) {
                const gifMo = await sdk.mediaManager.createMediaObjectFromUrl(gifUrl);
                const gifData = await sdk.mediaManager.convertMediaObjectToBuffer(gifMo, 'image/gif');
                payload.data.pushover.file = { name: 'media.gif', data: gifData };
            }
        } else if (notifier.pluginId === ZENTIK_PLUGIN_ID) {
            const zentikActions: any[] = [
                {
                    type: 'NAVIGATE',
                    title: openNvrText,
                    icon: 'sfsymbols:video',
                    value: externalUrl,
                }
            ];

            if (addSnozeActions) {
                for (const { url, title } of snoozeActions) {
                    zentikActions.push({
                        title,
                        type: 'BACKGROUND_CALL',
                        value: `POST::${url}`,
                        icon: 'sfsymbols:bell',
                        destructive: false
                    });
                }
            }

            if (actionsToUse.length) {
                for (const { url, title, icon } of actionsToUse) {
                    zentikActions.push({
                        type: 'BACKGROUND_CALL',
                        value: `POST::${url}`,
                        title,
                        icon,
                        destructive: false
                    })
                }
            }

            const tapUrl = openInApp && rule.ruleType === RuleType.Detection ?
                externalUrl :
                undefined;

            payload.data.zentik = {
                deliveryType: priority === NotificationPriority.High ? 'CRITICAL' :
                    priority === NotificationPriority.Low ? 'SILENT' : 'NORMAL',
                addMarkAsReadAction: withClearNotification,
                addOpenNotificationAction: !!withOpenNotification && !!openInApp,
                addDeleteAction: withDeleteNotification,
                gifUrl,
                videoUrl,
                actions: zentikActions,
                tapUrl
            };

        } else if (notifier.pluginId === HOMEASSISTANT_PLUGIN_ID) {
            const fileSizeInMegabytes = videoSize / (1024 * 1024);
            const isVideoValid = fileSizeInMegabytes < 50;

            const urlToUse = withOpenInApp && openInApp ? haUrl : externalUrl;
            payload.data.ha = {
                ttl: 0,
                importance: 'max',
                priority: 'high',
                url: clickUrl ?? urlToUse,
                clickAction: clickUrl ?? urlToUse,
                video: isVideoValid ? videoUrl : undefined,
                channel: withChannel ? channel : undefined,
                notification_icon: withNotificationIcon ? notificationIcon : undefined,
                color: iconColor,
                push: {
                    sound: {
                        name: withSound && sound ? sound : 'default'
                    }
                }
            };

            const haActions: any[] = [];
            if (videoUrl) {
                haActions.push({
                    action: `URI`,
                    icon: 'sfsymbols:video.circle',
                    title: 'Clip',
                    uri: videoUrl,
                });
            }
            if (addSnozeActions) {
                for (const { data, title, } of snoozeActions) {
                    haActions.push({
                        action: `scrypted_an_snooze_${cameraId}_${notifierId}_${data}_${snoozeId}`,
                        icon: 'sfsymbols:bell',
                        title,
                    });
                }
            }
            for (const { action, icon, title, destructive } of actionsToUse) {
                haActions.push({
                    action,
                    icon,
                    title,
                    destructive,
                })
            }

            if (withClearNotification) {
                haActions.push({
                    action: 'clear',
                    title: this.getTextKey({ notifierId, textKey: 'discardText' }),
                    icon: "sfsymbols:trash",
                    destructive: true
                });
            }

            payload.data.ha.actions = haActions;

            if (priority === NotificationPriority.High) {
                payload.data.ha.push['interruption-level'] = 'critical';
                payload.data.ha.push.sound = {
                    ...payload.data.ha.push.sound,
                    critical: 1,
                    volume: 1.0
                };
            }

            if (gifUrl) {
                payload.data.ha.image = gifUrl;
            }
        } else if (notifier.pluginId === NTFY_PLUGIN_ID) {
            const ntfyActions: any[] = [{
                action: 'view',
                label: openNvrText,
                url: externalUrl
            }];

            if (addSnozeActions) {
                ntfyActions.push(...snoozeActions.slice(0, 2).map(action => ({
                    action: 'http',
                    label: action.title,
                    url: action.url,
                    method: 'GET',
                })));
            } else {
                ntfyActions.push(...actionsToUse.slice(0, 2).map(action => ({
                    action: 'http',
                    label: action.title,
                    url: action.url,
                    method: 'GET',
                })));
            }

            payload.data.ntfy = {
                actions: ntfyActions
            };

            const priorityToUse = priority === NotificationPriority.SuperHigh ? 5 :
                priority === NotificationPriority.High ? 4 :
                    priority === NotificationPriority.Normal ? 3 :
                        priority === NotificationPriority.Low ? 2 :
                            1;

            payload.data.ntfy.priority = priorityToUse;
            if (gifUrl) {
                payload.data.ntfy.attach = gifUrl;
            }
        } else if (notifier.pluginId === NVR_PLUGIN_ID) {
            const localAddresses = safeParseJson(this.storageSettings.getItem('localAddresses'));
            payload.data = {
                ...payload.data,
                hash: timelinePart,
                localAddresses: localAddresses,
                actionUrl: endpoint,
                snoozeId,
            };

            if (addSnozeActions) {
                payload.actions = snoozeActions.map((action => ({
                    action: action.action,
                    title: action.title
                })));
            }

            if (priority === NotificationPriority.High) {
                payload.critical = true;
            } else if (priority === NotificationPriority.Low) {
                payload.silent = true;
            }
        }

        const { aiSource } = this.storageSettings.values;

        let message = messageParent;
        if (!message) {
            if (rule?.customText) {
                message = rule.customText;
            } else {
                const { externalUrl } = this.getUrls(device?.id, triggerTime);

                message = await this.getNotificationText({
                    detection,
                    externalUrl,
                    detectionTime: triggerTime,
                    notifierId: notifier.id,
                    eventType,
                    device,
                    rule: rule as DetectionRule,
                });

                if (forceAi || rule?.useAi || cameraAiEnabled || notifierAiEnabled) {
                    logger.log(`Notification AI: ${JSON.stringify({
                        aiSource,
                        camera: device?.name,
                        notifier: notifier?.name,
                        forceAi,
                        cameraAiEnabled,
                        notifierAiEnabled
                    })}`);
                }

                const isAiEnabled = forceAi || rule?.useAi || (!rule && cameraAiEnabled && notifierAiEnabled);
                if (aiSource !== AiSource.Disabled && isAiEnabled) {
                    const { systemPromptKey } = getAiSettingKeys();

                    const prompt = rule?.aiPrompt || this.storageSettings.getItem(systemPromptKey as any);
                    const aiResponse = await getAiMessage({
                        b64Image,
                        logger,
                        originalTitle: message,
                        plugin: this,
                        detection,
                        timeStamp: triggerTime,
                        device,
                        prompt
                    });

                    if (aiResponse.message) {
                        message = aiResponse.message;
                        aiUsed = true;
                    }

                    if (aiResponse.fromCache) {
                        logger.info(`AI response retrieved from cache: ${JSON.stringify(aiResponse)}`);
                    } else {
                        logger.log(`AI response generated: ${JSON.stringify(aiResponse)}`);
                    }
                }
            }
        }

        if (additionalMessageText) {
            message += additionalMessageText;
        }

        logger.info(`Notification content generated: ${JSON.stringify({
            notifier: notifier.name,
            cameraAiEnabled,
            notifierAiEnabled,
            aiSource,
            ruleAiEnabled: rule ? rule.useAi : 'Not applicable',
            actionsEnabled,
            addSnozeActions,
            payload,
            message,
        })}`)

        return { payload, message, aiUsed };
    }

    async notifyDetection(props: {
        cameraDevice?: DeviceInterface,
        triggerDevice: DeviceInterface,
        notifierId: string,
        snoozeId?: string,
        time: number,
        message?: string,
        image?: MediaObject,
        b64Image?: string,
        detection?: ObjectDetectionResult
        eventType?: DetectionEvent,
        rule?: DetectionRule,
        logger: Console,
        forceAi?: boolean,
        videoUrl?: string,
        gifUrl?: string,
        imageUrl?: string,
    }) {
        try {
            const {
                triggerDevice,
                cameraDevice,
                notifierId,
                time,
                image,
                b64Image,
                detection,
                logger,
                rule,
                snoozeId,
                eventType,
                message,
                forceAi,
                videoUrl,
                gifUrl,
                imageUrl,
            } = props;

            const device = cameraDevice ?? (await this.getLinkedCamera(triggerDevice.id))?.device;

            if (!device) {
                logger.log(`There is no camera linked to the device ${triggerDevice.name}`);
                return;
            }

            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            let title = (triggerDevice ?? device).name;

            let zone: string;
            if (rule && detection) {
                zone = this.getTriggerZone(detection, rule);
            }

            if (zone) {
                title += ` (${zone})`;
            }

            await this.sendNotificationInternal({
                notifier,
                title,
                icon: undefined,
                image,
                b64Image,
                message,
                triggerTime: time,
                device,
                rule,
                detection,
                eventType,
                snoozeId,
                forceAi,
                logger,
                videoUrl,
                gifUrl,
                imageUrl,
            });
        } catch (e) {
            this.getLogger().log('Error in notifyCamera', e);
        }
    }

    async sendNotificationInternal(props: {
        title?: string,
        b64Image?: string,
        image?: MediaObject | string,
        imageUrl?: string,
        icon?: MediaObject | string,
        notifier: DeviceInterface,
        rule: BaseRule,
        snoozeId?: string,
        triggerTime?: number,
        message?: string,
        videoUrl?: string,
        gifUrl?: string,
        clickUrl?: string,
        videoSize?: number,
        detection?: ObjectDetectionResult,
        device?: DeviceInterface,
        eventType?: DetectionEvent,
        forceAi?: boolean,
        logger?: Console
    }) {
        const {
            title: titleParent,
            icon,
            image,
            b64Image,
            notifier,
            device,
            rule,
            snoozeId,
            triggerTime,
            videoUrl,
            clickUrl,
            message: messageParent,
            detection,
            eventType,
            forceAi,
            logger: loggerParent,
            videoSize,
            gifUrl,
            imageUrl,
        } = props;
        const cameraMixin = this.currentCameraMixinsMap[device.id];
        const logger = loggerParent ?? cameraMixin.getLogger();

        let title = titleParent;
        if (!title) {
            title = device.name;
        }

        const { payload, message } = await this.getNotificationContent({
            device,
            notifier,
            rule,
            triggerTime,
            videoUrl,
            logger,
            b64Image,
            detection,
            eventType,
            message: messageParent,
            snoozeId,
            forceAi,
            videoSize,
            clickUrl,
            gifUrl,
        });

        const notifierOptions: NotifierOptions = {
            body: message,
            ...payload,
        };

        logger.log(`Sending rule ${rule.name} (${rule.ruleType}) notification ${triggerTime} to ${notifier.name}`);
        logger.info(JSON.stringify({
            notifierOptions,
            title,
            message,
            rule,
            payload
        }));

        notifier.sendNotification(title, notifierOptions, imageUrl ?? image, icon).catch(logger.error);
    }

    async executeNotificationTest() {
        const {
            testAddActions,
            testAddSnoozing,
            testBypassSnooze,
            testDevice,
            testEventType,
            testGenerateClip,
            testGenerateClipSpeed,
            testGenerateClipType,
            testClipPostSeconds,
            testClipPreSeconds,
            testNotifier,
            testPriority,
            testLabel,
            testSound,
            testUseAi,
            testPostProcessing,
        } = this.storageSettings.values;

        const logger = this.getLogger();

        try {
            if (testDevice && testEventType && testNotifier) {
                const currentTime = new Date().getTime();
                const testNotifierId = testNotifier.id
                const { sensorType, isCamera } = isDeviceSupported(testDevice);
                const eventType = sensorType ?? testEventType;
                const isDetection = isDetectionClass(testEventType);

                logger.log(`Sending ${eventType} test notification to ${testNotifier.name}: ${JSON.stringify({
                    deviceName: testDevice.name,
                    testAddActions,
                    testAddSnoozing,
                    testBypassSnooze,
                    testEventType,
                    testGenerateClip,
                    testGenerateClipSpeed,
                    testGenerateClipType,
                    testClipPreSeconds,
                    testClipPostSeconds,
                    testLabel,
                    testNotifier,
                    testPriority,
                    testSound,
                    testUseAi,
                    testPostProcessing,
                })}`);

                const snoozeId = testBypassSnooze ? Math.random().toString(36).substring(2, 12) : undefined;
                const payload: NotifyDetectionProps = {
                    eventType,
                    eventSource: NotifyRuleSource.Test,
                    triggerDeviceId: testDevice.id,
                    triggerTime: currentTime - 2000,
                    snoozeId,
                    matchRule: {
                        inputDimensions: [0, 0],
                        match: isDetection ? { label: testLabel, className: testEventType, score: 1 } : undefined,
                        rule: {
                            notifierData: {
                                [testNotifierId]: {
                                    priority: testPriority,
                                    actions: [],
                                    addSnooze: testAddSnoozing,
                                    addCameraActions: testAddActions,
                                    sound: testSound
                                }
                            },
                            imageProcessing: testPostProcessing,
                            generateClipSpeed: testGenerateClipSpeed,
                            generateClipType: testGenerateClipType,
                            generateClip: testGenerateClip,
                            generateClipPreSeconds: testClipPreSeconds,
                            generateClipPostSeconds: testClipPostSeconds,
                            useAi: testUseAi,
                            ruleType: RuleType.Detection,
                            activationType: DetectionRuleActivation.Always,
                            source: RuleSource.Plugin,
                            isEnabled: true,
                            name: 'Test rule',
                            detectionSource: ScryptedEventSource.RawDetection,
                            notifiers: [testNotifier?.id]
                        } as DetectionRule
                    },
                    forceAi: testUseAi,
                };

                if (isCamera) {
                    const cameraMixin = this.currentCameraMixinsMap[testDevice.id];
                    await cameraMixin.notifyDetectionRule(payload);
                } else {
                    await this.notifyDetectionEvent(payload);
                }
            }
        } catch (e) {
            logger.log('Error in executeNotificationTest', e);
        }
    }

    async getCameraDevice(device: DeviceInterface) {
        const deviceId = device.id;
        const { isCamera } = isDeviceSupported(device);

        if (isCamera) {
            return device;
        }

        const linkedCameraId = this.deviceVideocameraMap[deviceId];
        return systemManager.getDeviceById<DeviceInterface>(linkedCameraId);
    }

    public getFsPaths(props: {
        cameraId?: string,
        triggerTime?: number,
    }) {
        const { cameraId, triggerTime } = props;
        const storagePath = this.getStoragePath();
        const cameraPath = cameraId ? path.join(storagePath, cameraId) : undefined;
        const decoderpath = cameraPath ? path.join(cameraPath, 'decoder') : undefined;
        const framePath = triggerTime && decoderpath ? path.join(decoderpath, `${triggerTime}.jpg`) : undefined;

        return {
            storagePath,
            cameraPath,
            decoderpath,
            framePath,
        };
    }

    public getDetectionImagePaths = (props: { imageIdentifier?: string, device: ScryptedDeviceBase }) => {
        const { device, imageIdentifier } = props;
        const { cameraPath } = this.getFsPaths({ cameraId: device.id });
        const objectDetectionPath = path.join(cameraPath, 'detections');
        const filePath = imageIdentifier ? path.join(objectDetectionPath, `${imageIdentifier}.jpg`) : undefined;

        return { filePath, objectDetectionPath };
    }

    async decodeFileId(props: { fileId: string }) {
        const { fileId } = props;

        const [identifier, cameraId] = fileId.split('__');

        const device = systemManager.getDeviceById<DeviceInterface>(cameraId);

        if (identifier === 'rule') {
            const [_, __, ruleName, triggerTime] = fileId.split('__');
            const { videoHistoricalPath, imageHistoricalPath } = this.getRulePaths({
                cameraId,
                ruleName,
                triggerTime: Number(triggerTime),
            });

            const { videoRuleUrl, imageRuleUrl } = await getWebHookUrls({
                console: this.getLogger(),
                device: device,
                plugin: this,
                fileId: triggerTime,
            });

            return {
                videPath: videoHistoricalPath,
                imagePath: imageHistoricalPath,
                videoUrl: videoRuleUrl,
                imageUrl: imageRuleUrl
            };
        } else if (identifier === 'event') {
            const [_, __, fileName] = fileId.split('__');
            const { recordedClipPath, recordedThumbnailPath } = this.getRecordedEventPath({
                cameraId,
                fileName
            });

            const { recordedClipThumbnailPath, recordedClipVideoPath } = await getWebHookUrls({
                console: this.getLogger(),
                device: device,
                plugin: this,
                fileId: fileName,
            });

            return {
                videPath: recordedClipPath,
                imagePath: recordedThumbnailPath,
                videoUrl: recordedClipVideoPath,
                imageUrl: recordedClipThumbnailPath
            };
        }
    }

    public getRulePaths = (props: {
        cameraId: string,
        ruleName?: string,
        variant?: string,
        triggerTime?: number,
    }) => {
        const { cameraId, ruleName, variant, triggerTime } = props;
        const { cameraPath } = this.getFsPaths({ cameraId });

        const rulesPath = path.join(cameraPath, 'rules');
        const rulePath = ruleName ? path.join(rulesPath, ruleName) : undefined;
        const framesPath = rulePath ? path.join(rulePath, 'frames') : undefined;
        const framePath = triggerTime && framesPath ? path.join(framesPath, `${triggerTime}.jpg`) : undefined;
        const filesListPath = rulePath ? path.join(rulePath, 'file_list.txt') : undefined;
        const generatedPath = rulePath ? path.join(rulePath, 'generated') : undefined;

        const gifHistoricalPath = generatedPath ? path.join(generatedPath, `${triggerTime}.gif`) : undefined;
        const videoHistoricalPath = generatedPath ? path.join(generatedPath, `${triggerTime}.mp4`) : undefined;
        const imageHistoricalPath = generatedPath ? path.join(generatedPath, `${triggerTime}.jpg`) : undefined;
        const gifLatestPath = rulePath ? path.join(rulePath, `latest.gif`) : undefined;
        const videoclipLatestPath = rulePath ? path.join(rulePath, `latest.mp4`) : undefined;
        const imageLatestPath = rulePath ? path.join(rulePath, `latest.jpg`) : undefined;
        const imageLatestPathVariant = rulePath ? path.join(rulePath, `latest_${variant}.jpg`) : undefined;

        const fileId = `rule__${cameraId}__${ruleName}__${triggerTime}`;

        return {
            rulePath,
            framesPath,
            generatedPath,
            framePath,
            rulesPath,
            imageLatestPathVariant,
            filesListPath,
            videoclipLatestPath,
            gifLatestPath,
            imageLatestPath,
            gifHistoricalPath,
            imageHistoricalPath,
            videoHistoricalPath,
            fileId
        };
    }

    public getEventPaths = (props: {
        cameraId?: string,
        fileName?: string,
    }) => {
        const { cameraId, fileName } = props;
        const { cameraPath, storagePath } = this.getFsPaths({ cameraId });
        const dbsPath = path.join(storagePath, 'dbs');

        const eventsPath = cameraPath ? path.join(cameraPath, 'events') : undefined;
        const thumbnailsPath = eventsPath ? path.join(eventsPath, 'thumbnails') : undefined;
        const imagesPath = eventsPath ? path.join(eventsPath, 'images') : undefined;
        const eventThumbnailPath = fileName ? path.join(thumbnailsPath, `${fileName}.jpg`) : undefined;
        const eventImagePath = fileName ? path.join(imagesPath, `${fileName}.jpg`) : undefined;

        return {
            eventsPath,
            eventThumbnailPath,
            eventImagePath,
            fileId: fileName,
            dbsPath,
            thumbnailsPath,
            imagesPath,
        };
    }

    public getRecordedEventPath = (props: {
        cameraId: string,
        fileName?: string,
    }) => {
        const { cameraId, fileName } = props;
        const { cameraPath } = this.getFsPaths({ cameraId });

        const recordedEventsPath = path.join(cameraPath, 'recordedEvents');
        const recordedClipPath = fileName ? path.join(recordedEventsPath, `${fileName}.mp4`) : undefined;
        const recordedThumbnailPath = fileName ? path.join(recordedEventsPath, `${fileName}.jpg`) : undefined;

        const fileId = `event__${cameraId}__${fileName}`;

        return {
            recordedEventsPath,
            recordedClipPath,
            recordedThumbnailPath,
            fileId,
        };
    }

    public storeDetectionImages = async (props: {
        device: ScryptedDeviceBase,
        timestamp: number,
        b64Image?: string,
        detections?: ObjectDetectionResult[],
        eventSource: ScryptedEventSource,
        ruleName?: string,
        variant?: string,
    }) => {
        const { device, timestamp, b64Image, detections, eventSource, variant, ruleName } = props;
        const logger = this.getLogger(device);
        const mixin = this.currentCameraMixinsMap[device.id];

        const {
            postDetectionImageUrls,
            postDetectionImageClasses,
            postDetectionImageWebhook
        } = mixin.mixinState.storageSettings.values;

        if (b64Image && mixin) {
            const base64Data = b64Image.replace(/^data:image\/png;base64,/, "");

            if (ruleName) {
                const { imageLatestPath, imageLatestPathVariant } = this.getRulePaths({
                    cameraId: device.id,
                    ruleName,
                    variant
                });

                await fs.promises.writeFile(imageLatestPath, base64Data, 'base64');

                if (variant) {
                    await fs.promises.writeFile(imageLatestPathVariant, base64Data, 'base64');
                }
            } else {
                const { objectDetectionPath } = this.getDetectionImagePaths({ device });

                try {
                    await fs.promises.access(objectDetectionPath);
                } catch {
                    await fs.promises.mkdir(objectDetectionPath, { recursive: true });
                }

                const filesToProcess: { filename: string, className?: string, label?: string }[] = [];
                for (const detection of detections) {
                    const { className, label } = detection;
                    const detectionClass = detectionClassesDefaultMap[className];

                    if (detectionClass) {
                        let filename = className;

                        if (label && !isPlateClassname(className)) {
                            filename += `-${label}`;
                        }

                        if (eventSource !== ScryptedEventSource.RawDetection) {
                            filename += `__${eventSource}`;
                        }

                        if (mixin.isDelayPassed({ type: DelayType.FsImageUpdate, filename })?.timePassed) {
                            filesToProcess.push({ filename, className, label });
                        }
                    }
                }

                for (const { filename, className, label } of filesToProcess) {
                    const imagePath = path.join(objectDetectionPath, `${filename}.jpg`);
                    await fs.promises.writeFile(imagePath, base64Data, 'base64');

                    if (
                        postDetectionImageWebhook &&
                        className &&
                        postDetectionImageClasses?.includes(className) &&
                        mixin.isDelayPassed({
                            type: DelayType.PostWebhookImage,
                            classname: className,
                            eventSource,
                        }).timePassed
                    ) {
                        for (const url of postDetectionImageUrls) {
                            logger.log(`Posting ${className} image to ${url}, ${timestamp} ${label}`);
                            try {
                                await axios.post(url, {
                                    classname: className,
                                    label,
                                    b64Image,
                                    timestamp,
                                    name: filename
                                }, { timeout: 5000 })
                            } catch (e) {
                                logger.log(`Error webhook POST ${url}: ${e.message}`);
                            }
                        }
                    }
                }
            }
        }
    }

    public storeTimelapseFrame = async (props: {
        rule: TimelapseRule,
        timestamp: number,
        device: ScryptedDeviceBase,
        imageMo: MediaObject
    }) => {
        const { rule, timestamp, imageMo: imageMoParent, device } = props;

        let imageMo = imageMoParent;

        if (!imageMo) {
            return;
        }

        if (imageMo) {
            const { framePath, framesPath } = this.getRulePaths({
                cameraId: device.id,
                ruleName: rule.name,
                triggerTime: timestamp,
            });

            try {
                await fs.promises.access(framesPath);
            } catch {
                await fs.promises.mkdir(framesPath, { recursive: true });
            }

            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(framePath, jpeg);
        }
    }

    public clearTimelapseFrames = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console
    }) => {
        const { rule, logger, device } = props;
        logger.log(`Clearing frames for rule ${rule.name}.`);
        try {
            const { framesPath } = this.getRulePaths({
                cameraId: device.id,
                ruleName: rule.name,
            });

            await fs.promises.rm(framesPath, { recursive: true, force: true, maxRetries: 10 });
            logger.log(`Folder ${framesPath} removed`);
        } catch (e) {
            logger.error(`Error clearing timelapse frames for rule ${rule.name}`, e);
        }
    }

    public queueTimelapseGeneration(props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console
    }) {
        const { rule, device } = props;
        this.accumulatedTimelapsesToGenerate.push({ ruleName: rule.name, deviceId: device.id });
    }

    public generateTimelapse = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number
    }) => {
        const { rule, logger, device, triggerTime } = props;

        try {
            const {
                framesPath,
                filesListPath,
                videoHistoricalPath,
                imageHistoricalPath,
                generatedPath,
            } = this.getRulePaths({
                cameraId: device.id,
                ruleName: rule.name,
                triggerTime
            });

            try {
                await fs.promises.access(generatedPath);
            } catch {
                await fs.promises.mkdir(generatedPath, { recursive: true });
            }

            const files = await fs.promises.readdir(framesPath);
            const sortedFiles = files
                .map(file => file.split('.')[0])
                .sort((a, b) => parseInt(a) - parseInt(b));
            const fileListContent = sortedFiles
                .map(file => `file '${this.getRulePaths({
                    cameraId: device.id,
                    ruleName: rule.name,
                    triggerTime: Number(file)
                }).framePath}'`)
                .join('\n');
            await fs.promises.writeFile(filesListPath, fileListContent);

            const ffmpegArgs = [
                '-loglevel', 'error',
                '-nostdin',
                '-f', 'concat',
                '-safe', '0',
                '-i', filesListPath,
                '-r', `${rule.timelapseFramerate}`,
                '-vf', [
                    'scale=min(1280\\,iw):-2:force_original_aspect_ratio=decrease',
                    'pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:black',
                    'format=yuv420p'
                ].join(','),
                '-c:v', 'libx264',
                '-preset', 'faster',
                '-crf', '28',
                '-profile:v', 'main',
                '-level', '4.0',
                '-pix_fmt', 'yuv420p',
                '-fps_mode', 'cfr',
                '-movflags', '+faststart',
                '-max_muxing_queue_size', '1024',
                '-y',
                videoHistoricalPath
            ];

            logger.log(`Generating timelapse ${rule.name} with ${sortedFiles.length} frames and arguments: ${ffmpegArgs}`);

            const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                stdio: 'inherit',
            });

            await once(cp, 'exit');

            const selectedFrame = sortedFiles[Math.floor(sortedFiles.length / 2)].split('.')[0];
            const { framePath } = this.getRulePaths({
                cameraId: device.id,
                triggerTime: Number(selectedFrame),
                ruleName: rule.name
            });

            const jpeg = await fs.promises.readFile(framePath);
            const buf = await ffmpegFilterImageBuffer(jpeg, {
                ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
                blur: true,
                brightness: -.2,
                text: {
                    fontFile: undefined,
                    text: rule.name,
                },
                timeout: 10000,
            });

            if (jpeg.length) {
                logger.log(`Saving thumbnail in ${imageHistoricalPath}`);
                await fs.promises.writeFile(imageHistoricalPath, buf);
            } else {
                logger.log('Not saving, image is corrupted');
            }
        } catch (e) {
            logger.log('Error generating timelapse', e);
        }
    }

    public getStoragePath() {
        const { imagesPath } = this.storageSettings.values;

        return imagesPath || process.env.SCRYPTED_PLUGIN_VOLUME;
    }

    public storeDecoderFrame = async (props: {
        timestamp: number,
        device: ScryptedDeviceBase,
        imageMo?: MediaObject
        imageBuffer?: Buffer
    }) => {
        const { timestamp, imageMo: imageMoParent, imageBuffer, device } = props;

        let imageMo = imageMoParent;

        if (!imageMo && !imageBuffer) {
            return;
        }

        const { decoderpath } = this.getFsPaths({ cameraId: device.id });

        try {
            await fs.promises.access(decoderpath);
        } catch {
            await fs.promises.mkdir(decoderpath, { recursive: true });
        }

        if (imageMo) {
            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(decoderpath, `${timestamp}.jpg`), jpeg);
        } else {
            await fs.promises.writeFile(path.join(decoderpath, `${timestamp}.jpg`), imageBuffer);
        }
    }

    public clearVideoclipsData = (props: {
        device: ScryptedDeviceBase,
        logger: Console,
        maxSpaceInGb: number,
        maxDays: number,
        framesThreshold: number,
        eventsMaxDays: number,
        additionalCutoffDays?: number,
    }) => {
        this.clearVideoclipsQueue = this.clearVideoclipsQueue.then(async () => {
            try {
                await this.doClearVideoclipsData(props);
            } catch (e) {
                props.logger.error('Error in clearVideoclipsData', e);
            }
        });
        return this.clearVideoclipsQueue;
    }

    private doClearVideoclipsData = async (props: {
        device: ScryptedDeviceBase,
        logger: Console,
        maxSpaceInGb: number,
        maxDays: number,
        framesThreshold: number,
        eventsMaxDays: number,
        additionalCutoffDays?: number,
    }) => {
        const { device, logger, maxDays, maxSpaceInGb, framesThreshold, additionalCutoffDays = 0, eventsMaxDays } = props;
        const now = Date.now();
        const videoclipsThreshold = now - (1000 * 60 * 60 * 24 * (maxDays - additionalCutoffDays));
        const { decoderpath, cameraPath } = this.getFsPaths({ cameraId: device.id });
        const eventsThreshold = now - ((eventsMaxDays - additionalCutoffDays) * 1000 * 60 * 60 * 24);
        logger.log(`Cleaning up generated data: additionalCutoffDays=${additionalCutoffDays}, maxDays=${maxDays}, maxSpaceInGb=${maxSpaceInGb}, framesThreshold=${framesThreshold}, videoclipsThreshold=${videoclipsThreshold}, eventsThreshold=${eventsThreshold}`);

        const logData = {
            framesFound: 0,
            framesRemoved: 0,
            clipsFound: 0,
            clipsRemoved: 0,
            snapshotsFound: 0,
            snapshotsRemoved: 0,
            eventsFound: 0,
            eventsRemoved: 0,
            recordedEventsFound: 0,
            recordedEventsRemoved: 0,
        };

        const { occupiedSizeInBytes: occupiedSizeBefore } = await calculateSize({
            currentPath: cameraPath,
        });

        // Decoder frames cleanup
        try {
            const frames = await fs.promises.readdir(decoderpath);
            logData.framesFound = frames.length;

            for (const filename of frames) {
                const filepath = path.join(decoderpath, filename);
                const fileTimestamp = parseInt(filename);

                if (fileTimestamp < framesThreshold) {
                    try {
                        await fs.promises.unlink(filepath);
                        logData.framesRemoved += 1;
                    } catch (err) {
                        logger.error(`Error removing frame ${filename}`, err.message);
                    }
                }
            }
        } catch { }

        // Rules artifacts cleanup
        const { rulesPath } = this.getRulePaths({ cameraId: device.id });
        try {
            await fs.promises.access(rulesPath);
            const rulesFolder = await fs.promises.readdir(rulesPath);

            for (const ruleFolder of rulesFolder) {
                const { generatedPath } = this.getRulePaths({
                    cameraId: device.id,
                    ruleName: ruleFolder,
                });

                const generatedData = await fs.promises.readdir(generatedPath);
                const clips: string[] = [];
                const snapshots: string[] = [];

                for (const filename of generatedData) {
                    if (filename.endsWith('.mp4')) {
                        clips.push(filename);
                    } else if (filename.endsWith('.jpg')) {
                        snapshots.push(filename);
                    }
                }

                logData.clipsFound += clips.length;

                for (const filename of clips) {
                    const filepath = path.join(generatedPath, filename);
                    const fileTimestamp = parseInt(filename);

                    if (fileTimestamp < videoclipsThreshold) {
                        try {
                            await fs.promises.unlink(filepath);
                            logData.clipsRemoved += 1;
                        } catch (err) {
                            logger.error(`Error removing clip ${filename}`, err.message);
                        }
                    }
                }

                logData.snapshotsFound += snapshots.length;

                for (const filename of snapshots) {
                    const filepath = path.join(generatedPath, filename);
                    const fileTimestamp = parseInt(filename);

                    if (fileTimestamp < videoclipsThreshold) {
                        try {
                            await fs.promises.unlink(filepath);
                            logData.snapshotsRemoved += 1;
                        } catch (err) {
                            logger.error(`Error removing snapshot ${filename}`, err.message);
                        }
                    }
                }
            }
        } catch { }

        // Recorded events cleanup
        const { imagesPath, thumbnailsPath, dbsPath } = this.getEventPaths({ cameraId: device.id });

        await cleanupOldEvents({ logger, dbsPath, thresholdTimestamp: eventsThreshold, deviceId: device.id });

        try {
            await fs.promises.access(imagesPath);

            const imageFiles = await fs.promises.readdir(imagesPath);

            logData.eventsFound += imageFiles.length;

            for (const filename of imageFiles) {
                const fileName = filename.split('_')[0];
                const { eventImagePath } = this.getEventPaths({ cameraId: device.id, fileName: filename.split('.')[0] });

                const startTime = Number(fileName);
                if (startTime < eventsThreshold) {
                    try {
                        await fs.promises.unlink(eventImagePath);
                        logData.eventsRemoved += 1;
                    } catch (err) {
                        logger.error(`Error removing event ${filename}`, err.message);
                    }
                }
            }
            const thumbnailFiles = await fs.promises.readdir(thumbnailsPath);

            for (const filename of thumbnailFiles) {
                const fileName = filename.split('_')[0];
                const { eventThumbnailPath } = this.getEventPaths({ cameraId: device.id, fileName: filename.split('.')[0] });

                const startTime = Number(fileName);
                if (startTime < eventsThreshold) {
                    try {
                        await fs.promises.unlink(eventThumbnailPath);
                        logData.eventsRemoved += 1;
                    } catch (err) {
                        logger.error(`Error removing event ${filename}`, err.message);
                    }
                }
            }

        } catch { }

        // Recorded events cleanup
        const { recordedEventsPath } = this.getRecordedEventPath({ cameraId: device.id });
        try {
            await fs.promises.access(recordedEventsPath);

            const recordedEvents = await fs.promises.readdir(recordedEventsPath);
            const clips: string[] = [];
            const snapshots: string[] = [];

            for (const filename of recordedEvents) {
                if (filename.endsWith('.mp4')) {
                    clips.push(filename);
                } else if (filename.endsWith('.jpg')) {
                    snapshots.push(filename);
                }
            }

            logData.recordedEventsFound += clips.length;

            for (const filename of clips) {
                const { recordedClipPath, recordedThumbnailPath } = this.getRecordedEventPath({ cameraId: device.id, fileName: filename });

                const { startTime } = parseVideoFileName(filename);

                if (startTime < videoclipsThreshold) {
                    try {
                        await fs.promises.unlink(recordedClipPath);
                        await fs.promises.unlink(recordedThumbnailPath);
                        logData.recordedEventsRemoved += 1;
                    } catch (err) {
                        logger.error(`Error removing recorded event ${filename}`, err.message);
                    }
                }
            }

        } catch { }

        const { occupiedSizeInBytes: occupiedSizeAfter } = await calculateSize({
            currentPath: cameraPath,
        });
        const sizeFreed = occupiedSizeBefore - occupiedSizeAfter;
        const { formatted: sizeFreedFormatted } = formatSize(sizeFreed);

        const cameraMixin = this.currentCameraMixinsMap[device.id];
        const { value: occupiedSizeInGb, formatted: formattedOccupiedSizeInGb } = formatSize(occupiedSizeAfter, 'GB');
        cameraMixin.mixinState.storageSettings.values.occupiedSpaceInGb = occupiedSizeInGb;

        logger.log(`Cleanup completed ${JSON.stringify(logData)}, freed space: ${sizeFreedFormatted}, occupied space: ${formattedOccupiedSizeInGb}`);

        if (occupiedSizeInGb > (maxSpaceInGb * 0.95)) {
            logger.log(`Should clean additional space: occupiedSizeInGb ${occupiedSizeInGb} > maxSpaceInGb ${maxSpaceInGb} (95% cutoff)`);
            await this.clearVideoclipsData({
                device,
                logger,
                maxDays,
                maxSpaceInGb,
                framesThreshold,
                eventsMaxDays,
                additionalCutoffDays: additionalCutoffDays + 1,
            });
        }
    }

    public prepareClipGenerationFiles = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        pastMs: number,
    }) => {
        const { triggerTime, device, pastMs, rule } = props;
        const minTime = triggerTime - pastMs;
        const cameraMixin = this.currentCameraMixinsMap[device.id];

        const { decoderpath } = this.getFsPaths({ cameraId: device.id });
        const { filesListPath } = this.getRulePaths({ cameraId: device.id, triggerTime, ruleName: rule.name });

        let preTriggerFrames = 0;
        let postTriggerFrames = 0;
        let eventFrameTriggerTime: number;
        const files = await fs.promises.readdir(decoderpath);
        const filteredFiles = files
            .map(file => file.split('.')[0])
            .sort((a, b) => parseInt(a) - parseInt(b))
            .filter(frameName => {
                const fileTimestamp = parseInt(frameName);

                if (fileTimestamp > minTime) {
                    if (fileTimestamp < triggerTime) {
                        preTriggerFrames++;
                    } else {
                        if (postTriggerFrames === 0) {
                            eventFrameTriggerTime = fileTimestamp;
                        }
                        postTriggerFrames++;
                    }

                    return true;
                }

                if (!eventFrameTriggerTime) {
                    eventFrameTriggerTime = fileTimestamp;
                }

                return false;
            })
            .map(file => `file '${this.getFsPaths({
                cameraId: device.id,
                triggerTime: Number(file),
            }).framePath}'`);
        const framesAmount = filteredFiles.length;

        if (framesAmount) {
            const inputFps = 1000 / cameraMixin.mixinState.storageSettings.values.decoderFrequency;
            const fpsMultiplier = videoclipSpeedMultiplier[rule.generateClipSpeed ?? VideoclipSpeed.Fast];
            const fps = inputFps * fpsMultiplier;
            const fileListContent = filteredFiles.join('\n');

            await fs.promises.writeFile(filesListPath, fileListContent);

            return {
                fps,
                framesAmount,
                filesListPath,
                eventFrameTriggerTime,
                preTriggerFrames,
                postTriggerFrames,
                filteredFiles,
                inputFps
            };
        }
    }

    public generateVideoclip = async (props: {
        rule: BaseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        pastMs: number,
    }) => {
        const { device, rule, logger, triggerTime } = props;

        try {
            const {
                fps,
                framesAmount,
                filesListPath,
                eventFrameTriggerTime,
                preTriggerFrames,
                postTriggerFrames,
                filteredFiles,
                inputFps
            } = await this.prepareClipGenerationFiles(props);

            const fileName = String(triggerTime);
            const {
                videoHistoricalPath,
                imageHistoricalPath,
                videoclipLatestPath
            } = this.getRulePaths({ cameraId: device.id, triggerTime, ruleName: rule.name });

            if (framesAmount) {
                const ffmpegArgs = [
                    '-loglevel', 'error',
                    '-f', 'concat',
                    '-safe', '0',
                    '-r', `${fps}`,
                    '-i', filesListPath,
                    '-vf', `scale='min(${SNAPSHOT_WIDTH},iw)':'-2',pad=ceil(iw/2)*2:ceil(ih/2)*2`,
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-y',
                    videoHistoricalPath,
                ];
                logger.log(`Start detection MP4 clip generation ${rule.name} ${triggerTime} ${inputFps} fps with ${framesAmount} total frames (${preTriggerFrames} pre and ${postTriggerFrames} post) and arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');
                await fs.promises.copyFile(videoHistoricalPath, videoclipLatestPath);
                logger.log(`Detection clip ${videoHistoricalPath} generated`);

                const { framePath } = this.getFsPaths({
                    cameraId: device.id,
                    triggerTime: eventFrameTriggerTime,
                });
                try {
                    const jpeg = await fs.promises.readFile(framePath);

                    logger.log(`Saving thumbnail in ${imageHistoricalPath}`);
                    await this.storeRuleImage({
                        rule,
                        device,
                        triggerTime,
                        bufferImage: jpeg,
                        logger,
                    });
                } catch (e) {
                    logger.log(`Error generating videoclip thumbnail ${JSON.stringify({
                        eventFrameTriggerTime,
                        framePath,
                    })}`, e);
                }
            } else {
                logger.log(`Skipping ${rule.name} ${triggerTime} clip generation, no frames available`);

            }

            return { fileName, preTriggerFrames, postTriggerFrames, filteredFiles };

        } catch (e) {
            logger.log('Error generating videoclip', e);

            return {};
        }
    }

    public generateGif = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        pastMs: number,
    }) => {
        const { device, rule, logger, triggerTime } = props;

        try {
            const {
                fps,
                framesAmount,
                filesListPath,
                preTriggerFrames,
                postTriggerFrames,
                filteredFiles,
                inputFps,
                eventFrameTriggerTime,
            } = await this.prepareClipGenerationFiles(props);

            const { gifLatestPath, gifHistoricalPath, imageHistoricalPath } = this.getRulePaths({ cameraId: device.id, ruleName: rule.name, triggerTime });

            if (framesAmount) {
                const ffmpegArgs = [
                    '-loglevel', 'error',
                    '-f', 'concat',
                    '-safe', '0',
                    '-r', `${fps}`,
                    '-i', filesListPath,
                    '-vf', `scale='min(${SNAPSHOT_WIDTH},iw)':'-2',pad=ceil(iw/2)*2:ceil(ih/2)*2`,
                    '-y',
                    gifHistoricalPath,
                ];
                logger.log(`Start detection GIF generation ${rule.name} ${triggerTime} ${inputFps} fps with ${framesAmount} total frames (${preTriggerFrames} pre and ${postTriggerFrames} post) and arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');
                await fs.promises.copyFile(gifHistoricalPath, gifLatestPath);
                logger.log(`GIF ${gifHistoricalPath} generated`);

                const { framePath } = this.getFsPaths({
                    cameraId: device.id,
                    triggerTime: eventFrameTriggerTime,
                });

                try {
                    const jpeg = await fs.promises.readFile(framePath);

                    logger.log(`Saving thumbnail in ${imageHistoricalPath}`);
                    await this.storeRuleImage({
                        rule,
                        device,
                        triggerTime,
                        bufferImage: jpeg,
                        logger,
                    });
                } catch (e) {
                    logger.log(`Error generating gif thumbnail ${JSON.stringify({
                        eventFrameTriggerTime,
                        framePath,
                    })}`, e);
                }
            } else {
                logger.log(`Skipping ${rule.name} ${triggerTime} GIF generation, no frames available`);
            }

            return { preTriggerFrames, postTriggerFrames, filteredFiles };

        } catch (e) {
            logger.log('Error generating gif', e);

            return {};
        }
    }

    public async storeEventImage(props: {
        device: ScryptedDeviceBase,
        triggerDevice?: ScryptedDeviceBase,
        logger: Console,
        b64Image: string,
        image: MediaObject,
        detections: ObjectDetectionResult[],
        timestamp: number,
        eventSource: ScryptedEventSource,
        eventId?: string
    }) {
        const { triggerDevice, device, timestamp, logger, b64Image, detections, eventSource, image, eventId } = props;
        const classNames = uniq(detections.map(det => det.className));
        const label = detections.find(det => det.label)?.label;
        const deviceMixin = this.currentCameraMixinsMap[device.id];

        const identifiers = detections.map(det => {
            let identifier = det.className;
            if (isMotionClassname(det.className)) {
                return identifier;
            }
            if (det.label) {
                identifier += `_${det.label}`;
            }
            if (det.id) {
                identifier += `_${det.id}`;
            }

            return identifier;
        });

        if (!deviceMixin?.isDelayPassed({
            type: DelayType.EventStore,
            identifiers,
        })?.timePassed) {
            return;
        }

        const fileName = `${timestamp}_${eventSource}_${getDetectionsLogShort(detections)}`;
        const { eventImagePath, eventThumbnailPath, thumbnailsPath, imagesPath, fileId } = this.getEventPaths({ fileName, cameraId: device.id });

        try {
            await fs.promises.access(thumbnailsPath);
        } catch {
            await fs.promises.mkdir(thumbnailsPath, { recursive: true });
        }

        try {
            await fs.promises.access(imagesPath);
        } catch {
            await fs.promises.mkdir(imagesPath, { recursive: true });
        }

        logger.log(`Storing ${eventSource} event for classes ${getDetectionsLog(detections)} ${fileId}`);
        const base64Data = b64Image.replace(/^data:image\/png;base64,/, "");
        await fs.promises.writeFile(eventImagePath, base64Data, 'base64');

        const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(image, ScryptedMimeTypes.Image);
        const resizedImage = await convertedImage.toImage({
            resize: {
                height: 400,
            },
        });
        const smallB64Image = await moToB64(resizedImage);
        const smallBase64Data = smallB64Image.replace(/^data:image\/png;base64,/, "");
        await fs.promises.writeFile(eventThumbnailPath, smallBase64Data, 'base64');
        const { dbsPath } = this.getEventPaths({});

        addEvent({
            event: {
                id: fileId,
                classes: classNames,
                label,
                timestamp,
                source: eventSource,
                deviceName: device.name,
                deviceId: device.id,
                sensorName: triggerDevice?.name,
                eventId,
                detections,
            },
            logger,
            dbsPath,
        });
    }

    public clearAllEventsData = async () => {
        const logger = this.getLogger();
        logger.log(`Clearing all events`);
        try {
            for (const deviceId of Object.keys(this.currentCameraMixinsMap)) {
                const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(deviceId);
                const deviceLogger = this.currentCameraMixinsMap[deviceId].getLogger();
                await this.clearEventsData({ device, logger: deviceLogger })
            }
            const { dbsPath } = this.getEventPaths({});

            await cleanupEvents({ logger, dbsPath });
        } catch (e) {
            logger.error(`Error clearing all events data`, e);
        }
    }

    public clearEventsData = async (props: {
        device: ScryptedDeviceBase,
        logger: Console
    }) => {
        const { logger, device } = props;
        logger.log(`Clearing events for device ${device.name}`);
        try {
            const { eventsPath } = this.getEventPaths({
                cameraId: device.id,
            });

            await fs.promises.rm(eventsPath, { recursive: true, force: true, maxRetries: 10 });
            logger.log(`Folder ${eventsPath} removed`);
        } catch (e) {
            logger.error(`Error clearing events data for device ${device.name}`, e);
        }
    }

    getAudioAnalysisDevice(source: AudioAnalyzerSource) {
        let device: ObjectDetection = null;
        let pluginName: string = '';

        if (source === AudioAnalyzerSource.YAMNET) {
            pluginName = 'YAMNet Audio Classification';
        }

        if (pluginName) {
            device = sdk.systemManager.getDeviceByName<ObjectDetection>(pluginName);
        }

        if (!device && pluginName && !this.audioClassifierMissingLogged.has(source)) {
            this.log.a(`Audio classifier device for source ${source} not found. Install plugin "${pluginName}" to enable audio analysis.`);
            this.audioClassifierMissingLogged.add(source);
        }

        return device;
    }
}

