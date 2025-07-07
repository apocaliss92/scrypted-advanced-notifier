import sdk, { BoundingBoxResult, DeviceBase, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, Image, LauncherApplication, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetection, ObjectDetectionResult, ObjectsDetected, PushHandler, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Settings, SettingValue, VideoClips, WritableDeviceState } from "@scrypted/sdk";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import child_process from 'child_process';
import { once } from "events";
import fs from 'fs';
import { cloneDeep, isEqual, sortBy, uniq } from 'lodash';
import path from 'path';
import { BasePlugin, BaseSettingsKey, getBaseSettings, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getRpcData } from '../../scrypted-monitor/src/utils';
import { ffmpegFilterImageBuffer } from "../../scrypted/plugins/snapshot/src/ffmpeg-image-filter";
import { name as pluginName, version } from '../package.json';
import { AiSource, getAiMessage, getAiSettings } from "./aiUtils";
import { AdvancedNotifierAlarmSystem } from "./alarmSystem";
import { haAlarmAutomation, haAlarmAutomationId } from "./alarmUtils";
import { AdvancedNotifierCamera } from "./camera";
import { AdvancedNotifierCameraMixin, OccupancyRuleData } from "./cameraMixin";
import { AdvancedNotifierDataFetcher } from "./dataFetcher";
import { addEvent, cleanupEvents } from "./db";
import { DetectionClass, isLabelDetection, isMotionClassname } from "./detectionClasses";
import { servePluginGeneratedThumbnail, servePluginGeneratedVideoclip } from "./httpUtils";
import { idPrefix, publishPluginValues, publishRuleEnabled, setupPluginAutodiscovery, subscribeToPluginMqttTopics } from "./mqtt-utils";
import { AdvancedNotifierNotifier } from "./notifier";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE, ADVANCED_NOTIFIER_CAMERA_INTERFACE, ADVANCED_NOTIFIER_INTERFACE, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE, ALARM_SYSTEM_NATIVE_ID, AudioRule, BaseRule, CAMERA_NATIVE_ID, checkUserLogin, convertSettingsToStorageSettings, DATA_FETCHER_NATIVE_ID, DECODER_FRAME_MIN_TIME, DecoderType, DelayType, DETECTION_CLIP_PREFIX, DetectionEvent, DetectionRule, DetectionRuleActivation, deviceFilter, DeviceInterface, ExtendedNotificationAction, FRIGATE_BRIDGE_PLUGIN_NAME, generatePrivateKey, getAllDevices, getAssetSource, getB64ImageLog, getDetectionRules, getDetectionRulesSettings, getDetectionsLog, getDetectionsLogShort, getElegibleDevices, getEventTextKey, getFrigateTextKey, GetImageReason, getNotifierData, getRuleKeys, getSnoozeId, getTextSettings, getWebHookUrls, getWebhooks, haSnoozeAutomation, haSnoozeAutomationId, HOMEASSISTANT_PLUGIN_ID, isDetectionClass, isDeviceSupported, LATEST_IMAGE_SUFFIX, MAX_PENDING_RESULT_PER_CAMERA, MAX_RPC_OBJECTS_PER_CAMERA, moToB64, NotificationPriority, NOTIFIER_NATIVE_ID, notifierFilter, NTFY_PLUGIN_ID, NVR_PLUGIN_ID, nvrAcceleratedMotionSensorId, NvrEvent, OccupancyRule, ParseNotificationMessageResult, parseNvrNotificationMessage, pluginRulesGroup, PUSHOVER_PLUGIN_ID, RuleSource, RuleType, ruleTypeMetadataMap, safeParseJson, ScryptedEventSource, splitRules, TELEGRAM_PLUGIN_ID, TextSettingKey, TIMELAPSE_CLIP_PREFIX, TimelapseRule, VideoclipSpeed, videoclipSpeedMultiplier, isSecretValid, SOFT_RPC_OBJECTS_PER_CAMERA, MAX_RPC_OBJECTS_PER_SENSOR, MAX_RPC_OBJECTS_PER_NOTIFIER, SOFT_RPC_OBJECTS_PER_SENSOR, SOFT_RPC_OBJECTS_PER_NOTIFIER, ImagePostProcessing, addBoundingBoxesToImage, cropImageToDetection } from "./utils";

const { systemManager, mediaManager } = sdk;

export type PluginSettingKey =
    | 'pluginEnabled'
    | 'mqttEnabled'
    | 'overridePublicDomain'
    | 'notificationsEnabled'
    | 'sendDevNotifications'
    | 'serverId'
    | 'localAddresses'
    | 'scryptedToken'
    | 'nvrUrl'
    | 'mqttActiveEntitiesTopic'
    | 'useNvrDetectionsForMqtt'
    | 'detectionSourceForMqtt'
    | 'onActiveDevices'
    | 'objectDetectionDevice'
    | 'clipDevice'
    | 'securitySystem'
    | 'testDevice'
    | 'testNotifier'
    | 'testEventType'
    | 'testLabel'
    | 'testPriority'
    | 'testPostProcessing'
    | 'testGenerateClip'
    | 'testGenerateClipSpeed'
    | 'testUseAi'
    | 'testSound'
    | 'testBypassSnooze'
    | 'testAddSnoozing'
    | 'testAddActions'
    | 'testButton'
    | 'checkConfigurations'
    | 'aiSource'
    | 'aiFixed'
    | 'imagesPath'
    | 'videoclipsRetention'
    | 'imagesRegex'
    | 'storeEvents'
    | 'cleanupEvents'
    | 'enableDecoder'
    | 'privateKey'
    | 'cloudEndpointInternal'
    | BaseSettingsKey
    | TextSettingKey;

export default class AdvancedNotifierPlugin extends BasePlugin implements MixinProvider, HttpRequestHandler, DeviceProvider, PushHandler, LauncherApplication {
    initStorage: StorageSettingsDict<PluginSettingKey> = {
        ...getBaseSettings({
            onPluginSwitch: async (_, enabled) => {
                await this.startStop(enabled);
                await this.startStopMixins(enabled);
            },
            hideHa: false,
            baseGroupName: '',
        }),
        overridePublicDomain: {
            title: 'Override public address',
            type: 'string',
            placeholder: 'https://scrypted.yourdomain.net',
            subgroup: 'Advanced',
        },
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
        notificationsEnabled: {
            title: 'Notifications enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        sendDevNotifications: {
            title: 'Send notifications on config errors',
            description: 'Uses the devNotifier',
            type: 'boolean',
            defaultValue: false,
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
        useNvrDetectionsForMqtt: {
            subgroup: 'MQTT',
            title: 'Use NVR detections',
            description: 'Use NVR detection to publish MQTT state messages for basic detections.',
            type: 'boolean',
            immediate: true
        },
        detectionSourceForMqtt: {
            title: 'Detections source',
            description: 'Which source should be used to update MQTT',
            type: 'string',
            subgroup: 'MQTT',
            immediate: true,
            combobox: true,
            choices: [],
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
            group: pluginRulesGroup,
            description: 'Select the object detection device to use for detecting objects.',
            type: 'device',
            deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}'`,
            immediate: true,
        },
        clipDevice: {
            title: 'Clip device',
            group: pluginRulesGroup,
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
        enableDecoder: {
            title: 'Enable decoder',
            group: pluginRulesGroup,
            description: 'Master controller to allow decoder usage.',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        testDevice: {
            title: 'Device',
            group: 'Test',
            immediate: true,
            type: 'device',
            deviceFilter: deviceFilter,
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
            defaultValue: ImagePostProcessing.None
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
        aiFixed: {
            type: 'boolean',
            hide: true,
        },
        cloudEndpointInternal: {
            type: 'string',
            hide: true,
        },
        imagesPath: {
            title: 'Storage path',
            group: 'Storage',
            description: 'Disk path where to save images and clips. Default will be the plugin folder',
            type: 'string',
        },
        imagesRegex: {
            title: 'Images name',
            description: 'Filename for the images. Possible values to be used are: ${name} ${timestamp}. Using only ${name} will ensure to have only 1 image per type',
            group: 'Storage',
            type: 'string',
            defaultValue: '${name}',
            placeholder: '${name}',
        },
        storeEvents: {
            title: 'Store event images',
            group: 'Storage',
            type: 'boolean',
            immediate: true,
            defaultValue: true,
        },
        cleanupEvents: {
            title: 'Cleanup events data',
            group: 'Storage',
            type: 'button',
            onPut: async () => await this.clearAllEventsData()
        },
        videoclipsRetention: {
            title: 'Videoclip retention days',
            group: 'Storage',
            description: 'How many days to keep the generated clips',
            type: 'number',
            defaultValue: 30,
        },
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
    frigateLabels: string[];
    frigateCameras: string[];
    lastFrigateDataFetched: number;
    localEndpointInternal: string;
    connectionTime = Date.now();

    imageEmbeddingCache: Map<string, Buffer> = new Map();
    textEmbeddingCache: Map<string, Buffer> = new Map();

    accumulatedTimelapsesToGenerate: { ruleName: string, deviceId: string }[] = [];
    mainFlowInProgress = false;

    cameraMotionActive = new Set<string>();

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

    get cloudEndpoint() {
        return this.storageSettings.values.overridePublicDomain || this.storageSettings.getItem('cloudEndpointInternal');
    }

    async init() {
        const logger = this.getLogger();

        const cloudPlugin = systemManager.getDeviceByName<Settings>('Scrypted Cloud');
        if (cloudPlugin) {
            this.hasCloudPlugin = true;
            try {
                const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: false });
                const cloudUrl = new URL(cloudEndpoint).origin;
                await this.storageSettings.putSetting('cloudEndpointInternal', cloudUrl);

                logger.log(`Cloud endpoint found ${cloudUrl}`);
            } catch (e) {
                logger.error(`Error finding a public endpoint. Set the override domain property with your public address`, e);
            }
        } else {
            logger.log('Cloud plugin not found');
            this.hasCloudPlugin = false;
        }

        const frigatePlugin = systemManager.getDeviceByName<Settings>(FRIGATE_BRIDGE_PLUGIN_NAME);
        if (frigatePlugin) {
            const settings = await frigatePlugin.getSettings();
            const serverUrl = settings.find(setting => setting.key === 'serverUrl')?.value as string;
            logger.log(`Frigate API found ${serverUrl}`);
            this.frigateApi = serverUrl;
            const { frigateLabels, frigateCameras } = await this.getFrigateData();
            logger.log(`Frigate labels found ${frigateLabels}`);
            logger.log(`Frigate cameras found ${frigateCameras}`);
        }

        const [major, minor, patch] = version.split('.').map(num => parseInt(num, 10));

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier NVR notifier',
                nativeId: NOTIFIER_NATIVE_ID,
                interfaces: [ScryptedInterface.Notifier, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE],
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
            await mixin.startStop(enabled);
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
                videoclipStream,
                videoclipThumbnail,
                eventsApp,
                eventThumbnail,
                eventImage,
                eventVideoclip,
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
                    videoUrl = `${this.cloudEndpoint}${videoUrl}`;

                    const isIos = /iPhone|iPad|iPod/i.test(request.headers['user-agent']);
                    const { isNvr } = getAssetSource({ videoUrl });

                    // If iOS and nvr clips, prebuffer to avoid streaming issues 
                    if (isNvr && isIos) {
                        const remoteResponse = await axios.get<Buffer[]>(videoUrl, {
                            headers: request.headers,
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
                } else if ([privateWebhook, webhook].includes(videoclipThumbnail)) {
                    await servePluginGeneratedThumbnail({
                        fileId: deviceIdOrAction,
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
                        const imageUrl = `${this.cloudEndpoint}/${decodeURIComponent(path)}`;
                        const jpeg = await axios.get<Buffer>(imageUrl, {
                            responseType: "arraybuffer",
                            headers: {
                                ...request.headers
                            }
                        })

                        response.send(jpeg.data, {
                            code: 200,
                            headers: {
                                "Cache-Control": "max-age=31536000"
                            }
                        });
                        return;
                        // response.send('', {
                        //     code: 302,
                        //     headers: {
                        //         ...request.headers,
                        //         Location: imageUrl,
                        //     }
                        // });
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
                        const { eventThumbnailPath, eventImagePath } = this.getEventPaths({ cameraName: realDevice.name, fileName: decodedRuleNameOrSnoozeIdOrSnapshotId });

                        const imagePath = webhook === eventThumbnail ? eventThumbnailPath : eventImagePath;

                        const jpeg = await fs.promises.readFile(imagePath);

                        response.send(jpeg, {
                            headers: {
                                "Cache-Control": "max-age=31536000"
                            }
                        });
                    }
                    return;
                } else if ([privateWebhook, webhook].some(hook => [videoclipStream].includes(hook))) {
                    await servePluginGeneratedVideoclip({
                        fileId: deviceIdOrAction,
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
                } else if (webhook === videoclipStream) {
                    await servePluginGeneratedVideoclip({
                        fileId: deviceIdOrAction,
                        request,
                        response,
                        plugin: this,
                    });
                    return;
                } else if (webhook === videoclipThumbnail) {
                    await servePluginGeneratedThumbnail({
                        fileId: deviceIdOrAction,
                        plugin: this,
                        request,
                        response
                    });
                    return;
                } else if (webhook === lastSnapshot) {
                    const isWebhookEnabled = device?.storageSettings.values.lastSnapshotWebhook;

                    if (isWebhookEnabled) {
                        const imageIdentifier = `${ruleNameOrSnoozeIdOrSnapshotId}${LATEST_IMAGE_SUFFIX}`;
                        const { filePath: imagePath } = this.getDetectionImagePaths({ device: realDevice, imageIdentifier });

                        try {
                            const jpeg = await fs.promises.readFile(imagePath);

                            response.send(jpeg, {
                                headers: {
                                    'Content-Type': 'image/jpeg',
                                }
                            });
                            return;
                        } catch (e) {
                            const message = `Error getting snapshot ${ruleNameOrSnoozeIdOrSnapshotId} for device ${device.name}: ${e.message}`;
                            logger.log(message)
                            response.send(message, {
                                code: 404,
                            });
                            return;
                        }
                    }
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

                    const message = device?.snoozeNotification({
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
            logger.log(`Error in onRequest`, e.message);
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

            const objDetectionPlugin = systemManager.getDeviceByName<Settings>('Scrypted NVR Object Detection');
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

    getLogger(device?: ScryptedDeviceBase) {
        if (device) {
            const mixin = this.currentCameraMixinsMap[device.id] ||
                this.currentNotifierMixinsMap[device.id] ||
                this.currentSensorMixinsMap[device.id];

            if (mixin) {
                return super.getLoggerInternal({
                    console: mixin.console,
                    storage: mixin.storageSettings,
                    friendlyName: mixin.clientId,
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
        }

        if (this.storageSettings.values.haEnabled) {
            await this.generateHomeassistantHelpers();
        }

        if (!this.storageSettings.values.privateKey) {
            const privateKey = generatePrivateKey();
            await this.putSetting('privateKey', privateKey);
        }

        if (!this.storageSettings.values.aiFixed) {
            const aiPlatform = this.storageSettings.getItem('aiSource' as any);
            if (aiPlatform !== 'Disabled') {
                await this.putSetting('aiSource', AiSource.Manual);
            }
            await this.putSetting('aiFixed', true);
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
            const { availableRules, allowedRules } = getDetectionRules({ pluginStorage, console: logger });

            const [rulesToEnable, rulesToDisable] = splitRules({
                allRules: availableRules,
                currentlyRunningRules: this.runningDetectionRules,
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

            this.runningDetectionRules = cloneDeep(allowedRules) || [];
            this.deviceVideocameraMap = deviceVideocameraMap;
            this.videocameraDevicesMap = videocameraDevicesMap;
            this.allAvailableRules = availableRules;

            const now = Date.now();

            if (!this.lastConfigurationsCheck || (now - this.lastConfigurationsCheck) > 1000 * 60 * 60) {
                this.lastConfigurationsCheck = now;
                await this.checkPluginConfigurations(false);
            }

            const { mqttEnabled, notificationsEnabled } = this.storageSettings.values;
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

                    publishPluginValues({
                        mqttClient,
                        notificationsEnabled,
                        rulesToEnable,
                        rulesToDisable,
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
                    const { pendingResults, rpcObjects } = await getRpcData();
                    const pluginPendingResults = pendingResults.find(elem => elem.name === pluginName)?.count;
                    const pluginRpcObjects = rpcObjects.find(elem => elem.name === pluginName)?.count;

                    logger.info(`PLUGIN-STUCK-CHECK: active devices ${activeDevices}, pending results ${pluginPendingResults} RPC objects ${pluginRpcObjects}`);

                    const camerasHardCap = MAX_RPC_OBJECTS_PER_CAMERA * activeCameras;
                    const sensorsHardCap = MAX_RPC_OBJECTS_PER_SENSOR * activeSensors;
                    const notifiersHardCap = MAX_RPC_OBJECTS_PER_NOTIFIER * activeNotifiers;

                    const camerasSoftCap = SOFT_RPC_OBJECTS_PER_CAMERA * activeCameras;
                    const sensorsSoftCap = SOFT_RPC_OBJECTS_PER_SENSOR * activeSensors;
                    const notifiersSoftCap = SOFT_RPC_OBJECTS_PER_NOTIFIER * activeNotifiers;

                    const hardCap = camerasHardCap + sensorsHardCap + notifiersHardCap;
                    const softCap = camerasSoftCap + sensorsSoftCap + notifiersSoftCap;

                    const maxActiveMotion = Math.floor(activeCameras / 15);
                    if (pluginRpcObjects > softCap && ((now - this.connectionTime) > (1000 * 60 * 60 * 2)) && this.cameraMotionActive.size <= maxActiveMotion) {
                        logger.log(`${pluginRpcObjects} (> ${softCap}) RPC objects found, soft resetting because not much active motion`)
                        this.restartRequested = true;
                        await sdk.deviceManager.requestRestart();
                    } else if (
                        pluginPendingResults > (MAX_PENDING_RESULT_PER_CAMERA * activeDevices) ||
                        pluginRpcObjects > hardCap
                    ) {
                        logger.error(`Advanced notifier plugin seems stuck, ${pluginPendingResults} pending results and ${pluginRpcObjects} (> ${hardCap}) RPC objects. Restarting`);
                        this.restartRequested = true;
                        await sdk.deviceManager.requestRestart();
                    }
                }
            }

            if (this.accumulatedTimelapsesToGenerate) {
                const timelapsesToRun = [...this.accumulatedTimelapsesToGenerate];
                this.accumulatedTimelapsesToGenerate = [];

                for (const timelapse of timelapsesToRun) {
                    const { deviceId, ruleName } = timelapse;
                    const deviceMixin = this.currentCameraMixinsMap[deviceId];
                    const rule = deviceMixin.allAvailableRules.find(rule => rule.ruleType === RuleType.Timelapse && rule.name === ruleName);
                    const device = sdk.systemManager.getDeviceById<DeviceInterface>(deviceId);
                    const deviceLogger = deviceMixin.getLogger();
                    const { fileName } = await this.generateTimelapse({
                        rule,
                        device,
                        logger: deviceLogger,
                    });
                    await this.notifyTimelapse({
                        cameraDevice: device,
                        timelapseName: fileName,
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

                const mixin = this.currentCameraMixinsMap[device.id] || this.currentSensorMixinsMap[device.id];

                if (mixin) {
                    const notifiersSettings = (await mixin.storageSettings.getSettings())
                        .filter((sett) => sett.key?.match(notifiersRegex));

                    for (const notifiersSetting of notifiersSettings) {
                        const [_, type, name] = notifiersSetting.key.match(notifiersRegex);
                        const missingNotifiers = (notifiersSetting.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                        if (missingNotifiers.length) {
                            missingNotifiersOfDeviceRules.push({ deviceName: device.name, notifierIds: missingNotifiers, ruleName: `${type}_${name}` });
                        }
                    }
                } else {
                    logger.log(`Mixin not found for device ${device.name}`);
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
                sendDevNotifications,
                scryptedToken,
                nvrUrl,
                objectDetectionDevice,
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
                    sendDevNotifications && (devNotifier as Notifier).sendNotification('Advanced notifier not correctly configured', {
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

    async refreshSettings() {
        const logger = this.getLogger();
        const dynamicSettings: StorageSetting[] = [];
        const people = (await this.getKnownPeople());
        const { frigateLabels } = await this.getFrigateData();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Plugin,
            logger,
            frigateLabels,
            people,
            refreshSettings: async () => await this.refreshSettings(),
        });

        dynamicSettings.push(...getAiSettings({
            storage: this.storageSettings,
            logger,
            onRefresh: async () => await this.refreshSettings(),
        }));

        if (frigateLabels) {
            for (const label of frigateLabels) {
                dynamicSettings.push({
                    key: getFrigateTextKey(label),
                    group: 'Texts',
                    subgroup: 'Frigate labels',
                    title: `${label} text`,
                    type: 'string',
                    defaultValue: label,
                    placeholder: label,
                });
            }
        }

        dynamicSettings.push(...detectionRulesSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        const {
            mqttEnabled,
            useNvrDetectionsForMqtt,
            testDevice,
            testNotifier,
            testGenerateClip,
        } = this.storageSettings.values;

        try {
            if (mqttEnabled) {
                this.storageSettings.settings.detectionSourceForMqtt.defaultValue =
                    useNvrDetectionsForMqtt ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection;
                this.storageSettings.settings.detectionSourceForMqtt.choices = this.enabledDetectionSources;
            }
            this.storageSettings.settings.useNvrDetectionsForMqtt.hide = true;

            this.storageSettings.settings.mqttActiveEntitiesTopic.hide = !mqttEnabled;
            this.storageSettings.settings.detectionSourceForMqtt.hide = !mqttEnabled;
        } catch { }

        const { isCamera } = testDevice ? isDeviceSupported(testDevice) : {};
        this.storageSettings.settings.testEventType.hide = !isCamera;
        this.storageSettings.settings.testGenerateClipSpeed.hide = !testGenerateClip;

        if (testNotifier) {
            const { priorityChoices } = getNotifierData({ notifierId: testNotifier.id, ruleType: RuleType.Detection });
            this.storageSettings.settings.testPriority.choices = priorityChoices;
        }
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
            return super.getSettings();
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
        cb: (videoUrl?: string) => Promise<void>,
        rule: BaseRule
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        pastMs: number,
    }) {
        const { cb, rule, device, logger, triggerTime, pastMs } = props;
        const deviceMixin = this.currentCameraMixinsMap[device.id];

        const prepareClip = async () => {
            const { fileName: clipName, filteredFiles } = await this.generateShortClip({
                device,
                logger,
                rule,
                triggerTime,
                pastMs,
            }) ?? {};

            if (filteredFiles?.length) {
                const { fileId } = this.getShortClipPaths({ cameraName: device.name, fileName: clipName });
                const { videoclipStreamUrl } = await getWebHookUrls({
                    console: logger,
                    fileId: fileId,
                    cloudEndpoint: this.cloudEndpoint,
                    secret: this.storageSettings.values.privateKey
                });

                await cb(videoclipStreamUrl);
            } else {
                await cb();
            }
        }

        const decoderType = deviceMixin.decoderType;
        if (rule.generateClip && decoderType !== DecoderType.Off) {
            const cameraMixin = this.currentCameraMixinsMap[device.id];
            const delay = rule.generateClipPostSeconds ?? 3;
            logger.log(`Starting clip recording for rule ${rule.name} in ${delay} seconds (${decoderType})`);
            cameraMixin.clipGenerationTimeout[rule.name] = setTimeout(async () => {
                await prepareClip();
            }, 1000 * delay)
        } else {
            cb();
        }
    }

    async notifyOccupancyEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        rule: OccupancyRule,
        image: MediaObject,
        occupancyData: OccupancyRuleData
    }) {
        const { cameraDevice, rule, triggerTime, image, occupancyData } = props;
        const logger = this.getLogger(cameraDevice);

        let message = occupancyData.occupies ?
            rule.zoneOccupiedText :
            rule.zoneNotOccupiedText;

        message = message.toString()
            .replace('${detectedObjects}', String(occupancyData.objectsDetected) ?? '')
            .replace('${maxObjects}', String(rule.maxObjects) ?? '');

        const executeNotify = async (videoUrl?: string) => {
            logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ rule })} `);

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
                }).catch(logger.error);
            }
        }

        this.checkIfClipRequired({
            cb: executeNotify,
            device: cameraDevice,
            logger,
            rule,
            triggerTime,
            pastMs: 0,
        });

    }

    async notifyAudioEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        message: string,
        rule: AudioRule,
        image: MediaObject,
    }) {
        const { cameraDevice, rule, message, triggerTime, image } = props;

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                image,
                message,
                triggerTime,
                device: cameraDevice,
                rule
            });
        }
    }

    async notifyTimelapse(props: {
        cameraDevice: DeviceInterface,
        rule: TimelapseRule,
        timelapseName: string,
    }) {
        const { cameraDevice, rule, timelapseName } = props;
        const logger = this.getLogger(cameraDevice);
        const { fileId } = this.getRulePaths({
            cameraName: cameraDevice.name,
            fileName: timelapseName,
            ruleName: rule.name
        });

        const { videoclipStreamUrl } = await getWebHookUrls({
            console: logger,
            fileId: fileId,
            cloudEndpoint: this.cloudEndpoint,
            secret: this.storageSettings.values.privateKey
        });

        const { videoclipPath, snapshotPath } = this.getRulePaths({
            ruleName: rule.name,
            cameraName: cameraDevice.name,
            fileName: timelapseName,
        });
        const fileURLToPath = `file://${snapshotPath}`;
        const image = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        const fileStats = await fs.promises.stat(videoclipPath);
        const sizeInBytes = fileStats.size;

        for (const notifierId of (rule.notifiers ?? [])) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                device: cameraDevice,
                rule,
                videoUrl: videoclipStreamUrl,
                clickUrl: videoclipStreamUrl,
                videoSize: sizeInBytes,
                image,
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

        for (const rule of rules) {
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
            logger.log(`Device not found for NVR notification: ${cameraName} ${eventType} ${triggerDevice?.name}`);
            return;
        }

        if (isCamera) {
            logger.info(JSON.stringify({ allDetections, cameraName, options }));
            if (isDetectionClass(eventType)) {
                await (foundDevice as AdvancedNotifierCameraMixin)?.processDetections({
                    detect: { timestamp: triggerTime, detections: allDetections },
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
        // else {
        //     await (foundDevice as AdvancedNotifierSensorMixin)?.processEvent({
        //         image,
        //         triggerTime,
        //         triggered: true,
        //         eventSource: ScryptedEventSource.NVR
        //     });
        // }
    }

    public getLinkedCamera = async (deviceId: string) => {
        const device = systemManager.getDeviceById<DeviceInterface>(deviceId);
        const cameraDevice = await this.getCameraDevice(device);

        if (!device || !cameraDevice) {
            this.getLogger().log(`Camera device for ID ${deviceId} not found.Device found: ${!!device} and camera was found: ${!!cameraDevice} `);
        }

        return { device: cameraDevice, triggerDevice: device };
    }

    public notifyDetectionEvent = async (props: {
        image?: MediaObject,
        match?: ObjectDetectionResult,
        rule: DetectionRule,
        eventType: DetectionEvent,
        triggerDeviceId: string,
        snoozeId?: string,
        triggerTime: number,
        forceAi?: boolean,
    }) => {
        const {
            eventType,
            triggerDeviceId,
            snoozeId,
            triggerTime,
            match,
            image: imageParent,
            rule,
            forceAi,
        } = props;
        const { device: cameraDevice, triggerDevice } = await this.getLinkedCamera(triggerDeviceId);
        const logger = this.getLogger(cameraDevice);
        const cameraMixin = this.currentCameraMixinsMap[cameraDevice.id];

        if (rule.activationType === DetectionRuleActivation.AdvancedSecuritySystem) {
            this.alarmSystem.onEventTrigger({ triggerDevice }).catch(logger.log);
        }

        let { b64Image, image, imageSource } = await cameraMixin.getImage({
            image: imageParent,
            reason: GetImageReason.Notification
        });

        const objectDetector: ObjectDetection & ScryptedDeviceBase = this.storageSettings.values.objectDetectionDevice;

        if (match && objectDetector) {
            if (rule.imageProcessing === ImagePostProcessing.MarkBoundaries) {
                const detection = await objectDetector.detectObjects(image);
                if (detection.detections.length) {
                    logger.log('Adding bounding boxes');

                    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
                    const { newImage, newB64Image } = await addBoundingBoxesToImage({
                        bufferImage,
                        console: logger,
                        detection,
                    });
                    b64Image = newB64Image;
                    image = newImage;
                }
            } else if (rule.imageProcessing === ImagePostProcessing.Crop) {
                let boundingBox: BoundingBoxResult['boundingBox'];

                if (match.boundingBox) {
                    boundingBox = match.boundingBox;
                } else {
                    const detection = await objectDetector.detectObjects(image);
                    const found = detection.detections.find(det =>
                        det.className === match.className &&
                        (match.label ? det.className === match.className : true)
                    );
                    boundingBox = found?.boundingBox;

                    if (boundingBox) {
                        const { newB64Image, newImage } = await cropImageToDetection({
                            image,
                            boundingBox,
                            inputDimensions: detection.inputDimensions,
                            asSquare: false,
                        });

                        image = newImage;
                        b64Image = newB64Image;
                    }
                }
            }
        }

        const executeNotify = async (videoUrl?: string) => {
            logger.log(`${rule.notifiers.length} notifiers will be notified with videourl ${videoUrl} and image from ${imageSource}: ${JSON.stringify({ match, rule })} `);

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
                }).catch(e => logger.log(`Error on notifier ${notifier.name} `, e));

                const decoderType = cameraMixin.decoderType;
                if (rule.generateClip && decoderType !== DecoderType.Off) {
                    cameraMixin.clipGenerationTimeout[rule.name] = undefined;
                }
            }
        }

        this.checkIfClipRequired({
            cb: executeNotify,
            device: cameraDevice,
            logger,
            rule,
            triggerTime,
            pastMs: 3000
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

        const { isCamera, isSensor, isNotifier, sensorType } = isDeviceSupported({ interfaces: mixinDeviceInterfaces } as DeviceBase);

        if (isCamera) {
            return new AdvancedNotifierCameraMixin(
                props,
                this
            );
        } else if (isSensor) {
            return new AdvancedNotifierSensorMixin(
                props,
                sensorType,
                this
            );
        } else if (isNotifier) {
            return new AdvancedNotifierNotifierMixin(
                props,
                this
            );
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

    async getNotificationContent(props: {
        notifier: DeviceBase & Notifier,
        rule?: DetectionRule | OccupancyRule | TimelapseRule,
        triggerTime?: number,
        message?: string,
        videoUrl?: string,
        clickUrl?: string,
        detection?: ObjectDetectionResult,
        device?: DeviceInterface,
        eventType?: DetectionEvent,
        b64Image?: string,
        logger: Console,
        snoozeId?: string,
        forceAi?: boolean,
        videoSize?: number,
        isVideoclip?: boolean,
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
        } = props;
        if (!notifier) {
            return {};
        }
        const { notifierData } = rule ?? {};
        const notifierId = notifier.id;
        const cameraId = device?.id;
        const { actions, priority, addSnooze, addCameraActions, sound } = notifierData?.[notifierId] ?? {};
        const { withActions, withSnoozing, withSound } = getNotifierData({ notifierId, ruleType: rule?.ruleType });
        const cameraMixin = cameraId ? this.currentCameraMixinsMap[cameraId] : undefined;
        const notifierMixin = this.currentNotifierMixinsMap[notifierId];
        const { notifierActions, aiEnabled: cameraAiEnabled } = cameraMixin?.storageSettings.values ?? {}
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

        for (const { action, title, icon, url } of actionsToUseTmp) {
            let urlToUse = url;

            // Assuming every action without url is an HA action
            if (!urlToUse) {
                const { haActionUrl } = await getWebHookUrls({
                    cameraIdOrAction: action,
                    console: deviceLogger,
                    device,
                    cloudEndpoint: this.cloudEndpoint,
                    secret: this.storageSettings.values.privateKey
                });
                urlToUse = haActionUrl;
            }

            actionsToUse.push({
                action,
                title,
                icon,
                url: urlToUse
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

        let allActions: ExtendedNotificationAction[] = [...actionsToUse];

        const snoozePlaceholder = this.getTextKey({ notifierId, textKey: 'snoozeText' });
        const snoozes = [10, 30, 60];
        const { snoozeActions, endpoint } = await getWebHookUrls({
            console: deviceLogger,
            device,
            snoozes,
            snoozeId,
            snoozePlaceholder,
            cloudEndpoint: this.cloudEndpoint,
            secret: this.storageSettings.values.privateKey
        });

        const addSnozeActions = withSnoozing && addSnooze;
        if (addSnozeActions) {
            allActions = [...snoozeActions, ...actionsToUse];
        }
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
                for (const { data, title, url } of snoozeActions) {
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

            payload.silent = priority !== NotificationPriority.Normal;
        } else if (notifier.pluginId === PUSHOVER_PLUGIN_ID) {
            payload.data.pushover = {
                timestamp: triggerTime,
                url: clickUrl ?? externalUrl,
                html: 1,
                sound
            };

            if (allActions.length) {
                additionalMessageText += '\n';
                for (const { title, url } of allActions) {
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
        } else if (notifier.pluginId === HOMEASSISTANT_PLUGIN_ID) {
            const fileSizeInMegabytes = videoSize / (1024 * 1024);
            const isVideoValid = fileSizeInMegabytes < 50;

            payload.data.ha = {
                url: clickUrl ?? externalUrl,
                clickAction: clickUrl ?? externalUrl,
                video: isVideoValid ? videoUrl : undefined,
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
            for (const { action, icon, title } of actionsToUse) {
                haActions.push({
                    action,
                    icon,
                    title,
                })
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
            payload.data.ha.actions = haActions;

            if (priority === NotificationPriority.High) {
                payload.data.ha.push['interruption-level'] = 'critical';
                payload.data.ha.push.sound = {
                    ...payload.data.ha.push.sound,
                    critical: 1,
                    volume: 1.0
                };
            }
        } else if (notifier.pluginId === NTFY_PLUGIN_ID) {
            const ntfyActions: any[] = [{
                action: 'view',
                label: 'NVR',
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
                    const aiResponse = await getAiMessage({
                        b64Image,
                        logger,
                        originalTitle: message,
                        plugin: this,
                        detection,
                        timeStamp: triggerTime,
                        device,
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
                videoUrl
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
            });
        } catch (e) {
            this.getLogger().log('Error in notifyCamera', e);
        }
    }

    async sendNotificationInternal(props: {
        title?: string,
        b64Image?: string,
        image?: MediaObject | string,
        icon?: MediaObject | string,
        notifier: DeviceInterface,
        rule?: BaseRule,
        snoozeId?: string,
        triggerTime?: number,
        message?: string,
        videoUrl?: string,
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

        notifier.sendNotification(title, notifierOptions, image, icon).catch(logger.error);
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
                const { sensorType } = isDeviceSupported(testDevice);
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
                    testLabel,
                    testNotifier,
                    testPriority,
                    testSound,
                    testUseAi,
                    testPostProcessing,
                })}`);

                const snoozeId = testBypassSnooze ? Math.random().toString(36).substring(2, 12) : undefined;
                await this.notifyDetectionEvent({
                    eventType,
                    triggerDeviceId: testDevice.id,
                    triggerTime: currentTime - 2000,
                    snoozeId,
                    match: isDetection ? { label: testLabel, className: testEventType, score: 1 } : undefined,
                    forceAi: testUseAi,
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
                        generateClip: testGenerateClip,
                        generateClipPostSeconds: 3,
                        useAi: testUseAi,
                        ruleType: RuleType.Detection,
                        activationType: DetectionRuleActivation.Always,
                        source: RuleSource.Plugin,
                        isEnabled: true,
                        name: 'Test rule',
                        notifiers: [testNotifier?.id]
                    }
                })
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
        cameraName: string
    }) {
        const { cameraName } = props;
        const imagesPath = this.getStoragePath();
        const cameraPath = path.join(imagesPath, cameraName);

        return {
            cameraPath
        };
    }

    public getDetectionImagePaths = (props: { imageIdentifier: string, device: ScryptedDeviceBase }) => {
        const { device, imageIdentifier } = props;
        const { cameraPath } = this.getFsPaths({ cameraName: device.name });
        const filePath = path.join(cameraPath, `${imageIdentifier}.jpg`);

        return { filePath };
    }

    public getRulePaths = (props: {
        cameraName: string,
        ruleName?: string,
        fileName?: string,
    }) => {
        const { cameraName, ruleName, fileName } = props;
        const { cameraPath } = this.getFsPaths({ cameraName });

        const rulesPath = path.join(cameraPath, 'rules');
        const rulePath = ruleName ? path.join(rulesPath, ruleName) : undefined;
        const framesPath = rulePath ? path.join(rulePath, 'frames') : undefined;
        const generatedPath = rulePath ? path.join(rulePath, 'generated') : undefined;
        const videoclipPath = fileName && generatedPath ? path.join(generatedPath, `${fileName}.mp4`) : undefined;
        const snapshotPath = fileName && generatedPath ? path.join(generatedPath, `${fileName}.jpg`) : undefined;
        const framePath = fileName && framesPath ? path.join(framesPath, `${fileName}.jpg`) : undefined;

        const fileId = `${TIMELAPSE_CLIP_PREFIX}_${cameraName}_${ruleName}_${fileName}`;

        return {
            rulePath,
            framesPath,
            generatedPath,
            snapshotPath,
            videoclipPath,
            framePath,
            rulesPath,
            fileId,
        };
    }

    public getShortClipPaths = (props: {
        cameraName: string,
        fileName?: string,
    }) => {
        const { cameraName, fileName } = props;
        const { cameraPath } = this.getFsPaths({ cameraName });

        const shortClipsPath = path.join(cameraPath, 'shortClips');
        const framesPath = path.join(shortClipsPath, 'frames');
        const generatedPath = path.join(shortClipsPath, 'generated');
        const framePath = fileName ? path.join(framesPath, `${fileName}.jpg`) : undefined;
        const snapshotPath = fileName && generatedPath ? path.join(generatedPath, `${fileName}.jpg`) : undefined;
        const videoclipPath = fileName ? path.join(generatedPath, `${fileName}.mp4`) : undefined;

        const fileId = `${DETECTION_CLIP_PREFIX}_${cameraName}_${fileName}`;

        return {
            shortClipsPath,
            framesPath,
            generatedPath,
            framePath,
            snapshotPath,
            videoclipPath,
            fileId,
        };
    }

    public getEventPaths = (props: {
        cameraName: string,
        fileName?: string,
    }) => {
        const { cameraName, fileName } = props;
        const { cameraPath } = this.getFsPaths({ cameraName });

        const eventsPath = path.join(cameraPath, 'events');
        const dbPath = path.join(cameraPath, 'events_db.json');
        const thumbnailsPath = path.join(eventsPath, 'thumbnails');
        const imagesPath = path.join(eventsPath, 'images');
        const eventThumbnailPath = fileName ? path.join(thumbnailsPath, `${fileName}.jpg`) : undefined;
        const eventImagePath = fileName ? path.join(imagesPath, `${fileName}.jpg`) : undefined;

        return {
            eventsPath,
            eventThumbnailPath,
            eventImagePath,
            fileId: fileName,
            dbPath,
            thumbnailsPath,
            imagesPath,
        };
    }

    public storeImage = async (props: {
        device: ScryptedDeviceBase,
        name: string,
        timestamp: number,
        b64Image?: string,
        detection?: ObjectDetectionResult,
        eventSource: ScryptedEventSource
    }) => {
        const { device, name, timestamp, b64Image, detection, eventSource } = props;
        const { imagesRegex } = this.storageSettings.values;
        const logger = this.getLogger(device);
        const mixin = this.currentCameraMixinsMap[device.id];
        const { className, label } = detection ?? {};

        if (b64Image) {
            if (mixin.isDelayPassed({ type: DelayType.FsImageUpdate, filename: name, eventSource })?.timePassed) {
                const { cameraPath } = this.getFsPaths({ cameraName: device.name });

                try {
                    await fs.promises.access(cameraPath);
                } catch {
                    await fs.promises.mkdir(cameraPath, { recursive: true });
                }

                const filename = imagesRegex
                    .replace('${name}', name)
                    .replace('${timestamp}', timestamp);

                const latestImage = `${name}${LATEST_IMAGE_SUFFIX}`;
                const { filePath: imagePath } = this.getDetectionImagePaths({ device, imageIdentifier: filename });
                const { filePath: latestPath } = this.getDetectionImagePaths({ device, imageIdentifier: latestImage });

                const base64Data = b64Image.replace(/^data:image\/png;base64,/, "");
                await fs.promises.writeFile(imagePath, base64Data, 'base64');
                await fs.promises.writeFile(latestPath, base64Data, 'base64');
            }

            const {
                postDetectionImageUrls,
                postDetectionImageClasses,
                postDetectionImageWebhook
            } = mixin.storageSettings.values;

            if (
                postDetectionImageWebhook &&
                postDetectionImageClasses?.includes(className) &&
                mixin.isDelayPassed({
                    type: DelayType.PostWebhookImage,
                    classname: className,
                    eventSource,
                }).timePassed
            ) {
                for (const url of postDetectionImageUrls) {
                    logger.log(`Posting ${className} image to ${url}, ${timestamp} ${label}`);
                    await axios.post(url, {
                        classname: className,
                        label,
                        b64Image,
                        timestamp,
                        name
                    }, { timeout: 5000 }).catch(e => {
                        logger.log(`Error webhook POST ${url}: ${e.message}`);
                    });
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
            const { framesPath, framePath } = this.getRulePaths({
                cameraName: device.name,
                ruleName: rule.name,
                fileName: String(timestamp),
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
                cameraName: device.name,
                ruleName: rule.name,
            });

            await fs.promises.rm(framesPath, { recursive: true, force: true, maxRetries: 10 });
            logger.log(`Folder ${framesPath} removed`);
        } catch (e) {
            logger.error(`Error clearing timelapse frames for rule ${rule.name}`, e);
        }
    }

    getfont() {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
        const unzippedFs = path.join(pluginVolume, 'zip/unzipped/fs');
        const fontFile = path.join(unzippedFs, 'Lato-Bold.ttf');

        return fontFile;
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
    }) => {
        const { rule, logger, device } = props;

        try {
            const fileName = String(Date.now());
            const {
                framesPath,
                rulePath,
                generatedPath,
                videoclipPath,
                snapshotPath
            } = this.getRulePaths({
                cameraName: device.name,
                ruleName: rule.name,
                fileName
            });
            const listPath = path.join(rulePath, 'file_list.txt');

            const files = await fs.promises.readdir(framesPath);
            const sortedFiles = files
                .map(file => file.split('.')[0])
                .sort((a, b) => parseInt(a) - parseInt(b));
            const fileListContent = sortedFiles
                .map(file => `file '${this.getRulePaths({
                    cameraName: device.name,
                    ruleName: rule.name,
                    fileName: file
                }).framePath}'`)
                .join('\n');
            await fs.promises.writeFile(listPath, fileListContent);

            try {
                await fs.promises.access(generatedPath);
            } catch {
                await fs.promises.mkdir(generatedPath, { recursive: true });
            }

            const ffmpegArgs = [
                '-loglevel', 'error',
                '-f', 'concat',
                '-safe', '0',
                '-r', `${rule.timelapseFramerate}`,
                '-i', listPath,
                // '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                '-vf', "scale='min(1280,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-y',
                videoclipPath
            ];

            logger.log(`Generating timelapse ${rule.name} with ${sortedFiles.length} frames and arguments: ${ffmpegArgs}`);

            const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                stdio: 'inherit',
            });

            await once(cp, 'exit');

            try {
                await fs.promises.access(framesPath);
            } catch (err) {
                await fs.promises.mkdir(framesPath, { recursive: true });
            }

            const selectedFrame = sortedFiles[Math.floor(sortedFiles.length / 2)].split('.')[0];
            const { framePath } = this.getRulePaths({
                cameraName: device.name,
                fileName: selectedFrame,
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
                logger.log(`Saving thumbnail in ${snapshotPath}`);
                await fs.promises.writeFile(snapshotPath, buf);
            } else {
                logger.log('Not saving, image is corrupted');
            }

            return { fileName };
        } catch (e) {
            logger.log('Error generating timelapse', e);
        }
    }

    public getStoragePath() {
        const { imagesPath } = this.storageSettings.values;

        return imagesPath || process.env.SCRYPTED_PLUGIN_VOLUME;
    }

    public storeDetectionFrame = async (props: {
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

        const { framesPath } = this.getShortClipPaths({ cameraName: device.name });

        try {
            await fs.promises.access(framesPath);
        } catch {
            await fs.promises.mkdir(framesPath, { recursive: true });
        }

        if (imageMo) {
            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(framesPath, `${timestamp}.jpg`), jpeg);
        } else {
            await fs.promises.writeFile(path.join(framesPath, `${timestamp}.jpg`), imageBuffer);
        }
    }

    public clearVideoclipsData = async (props: {
        device: ScryptedDeviceBase,
        logger: Console,
        framesThreshold: number,
        videoclipsThreshold: number,
    }) => {
        const { device, logger, framesThreshold, videoclipsThreshold } = props;
        const { framesPath, generatedPath } = this.getShortClipPaths({ cameraName: device.name });
        logger.log(`Cleaning up generated data`);

        const logData = {
            framesFound: 0,
            framesRemoved: 0,
            clipsFound: 0,
            clipsRemoved: 0,
            timelapsesFound: 0,
            timelapsesRemoved: 0
        };

        try {
            const frames = await fs.promises.readdir(framesPath);
            logData.framesFound = frames.length;

            for (const filename of frames) {
                const filepath = path.join(framesPath, filename);
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

        try {
            const clips = await fs.promises.readdir(generatedPath);
            logData.clipsFound = clips.length;

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
        } catch { }

        const { rulesPath } = this.getRulePaths({ cameraName: device.name });

        try {
            await fs.promises.access(rulesPath);
            const rulesFolder = await fs.promises.readdir(rulesPath);

            for (const ruleFolder of rulesFolder) {
                const { generatedPath } = this.getRulePaths({
                    cameraName: device.name,
                    ruleName: ruleFolder
                });

                const timelapses = await fs.promises.readdir(generatedPath);
                logData.timelapsesFound += timelapses.length;

                for (const filename of timelapses) {
                    const filepath = path.join(generatedPath, filename);
                    const fileTimestamp = parseInt(filename);

                    if (fileTimestamp < videoclipsThreshold) {
                        try {
                            await fs.promises.unlink(filepath);
                            logData.timelapsesRemoved += 1;
                        } catch (err) {
                            logger.error(`Error removing timelapse ${filename}`, err.message);
                        }
                    }
                }
            }
        } catch { }

        logger.log(`Cleanup completed ${JSON.stringify(logData)}`);
    }

    public generateShortClip = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
        pastMs: number,
    }) => {
        const { device, rule, logger, triggerTime, pastMs } = props;

        const minTime = triggerTime - pastMs;

        try {
            const fileName = String(triggerTime);
            const {
                shortClipsPath,
                framesPath,
                generatedPath,
                videoclipPath,
                snapshotPath,
            } = this.getShortClipPaths({ cameraName: device.name, fileName });
            const listPath = path.join(shortClipsPath, 'file_list.txt');

            try {
                await fs.promises.access(framesPath);
            } catch {
                await fs.promises.mkdir(framesPath, { recursive: true });
            }

            let preTriggerFrames = 0;
            let postTriggerFrames = 0;
            let eventFrameName: string;
            const files = await fs.promises.readdir(framesPath);
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
                                eventFrameName = frameName;
                            }
                            postTriggerFrames++;
                        }

                        return true;
                    }

                    if (!eventFrameName) {
                        eventFrameName = frameName;
                    }

                    return false;
                })
                .map(file => `file '${this.getShortClipPaths({
                    cameraName: device.name,
                    fileName: file
                }).framePath}'`);
            const framesAmount = filteredFiles.length;

            if (framesAmount) {
                const inputFps = 1000 / DECODER_FRAME_MIN_TIME;
                const fpsMultiplier = videoclipSpeedMultiplier[rule.generateClipSpeed ?? VideoclipSpeed.Fast];
                const fps = inputFps * fpsMultiplier;
                const fileListContent = filteredFiles.join('\n');

                await fs.promises.writeFile(listPath, fileListContent);

                try {
                    await fs.promises.access(generatedPath);
                } catch {
                    await fs.promises.mkdir(generatedPath, { recursive: true });
                }

                const ffmpegArgs = [
                    '-loglevel', 'error',
                    '-f', 'concat',
                    '-safe', '0',
                    '-r', `${fps}`,
                    '-i', listPath,
                    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                    // '-vf', 'scale=-2:480',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-y',
                    videoclipPath
                ];
                logger.log(`Start detection clip generation ${rule.name} ${triggerTime} ${inputFps} fps with ${framesAmount} total frames (${preTriggerFrames} pre and ${postTriggerFrames} post) and arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');
                logger.log(`Detection clip ${videoclipPath} generated`);

                const { framePath } = this.getShortClipPaths({
                    cameraName: device.name,
                    fileName: eventFrameName,
                });
                try {
                    const jpeg = await fs.promises.readFile(framePath);

                    if (jpeg.length) {
                        logger.log(`Saving thumbnail in ${snapshotPath}`);
                        await fs.promises.writeFile(snapshotPath, jpeg);
                    } else {
                        logger.log('Not saving, image is corrupted');
                    }
                } catch (e) {
                    logger.log(`Error generating short clip thumbnail ${JSON.stringify({
                        eventFrameName,
                        framePath,
                    })}`, e);
                }
            } else {
                logger.log(`Skipping ${rule.name} ${triggerTime} clip generation, no frames available in ${framesPath}`);

            }

            return { fileName, preTriggerFrames, postTriggerFrames, filteredFiles };

        } catch (e) {
            logger.log('Error generating short clip', e);

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

        if (!deviceMixin?.isDelayPassed({
            type: DelayType.EventStore,
            identifiers: detections.map(det => {
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
            }),
        })?.timePassed) {
            return;
        }

        const fileName = `${timestamp}_${eventSource}_${getDetectionsLogShort(detections)}`;
        const { eventImagePath, eventThumbnailPath, thumbnailsPath, imagesPath, fileId } = this.getEventPaths({ fileName, cameraName: device.name });

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

        addEvent({
            event: {
                id: fileId,
                classes: classNames,
                label,
                timestamp,
                source: eventSource,
                deviceName: device.name,
                sensorName: triggerDevice?.name,
                eventId,
            },
            logger,
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

            await cleanupEvents({ logger });
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
                cameraName: device.name,
            });

            await fs.promises.rm(eventsPath, { recursive: true, force: true, maxRetries: 10 });
            logger.log(`Folder ${eventsPath} removed`);
        } catch (e) {
            logger.error(`Error clearing events data for device ${device.name}`, e);
        }
    }
}

