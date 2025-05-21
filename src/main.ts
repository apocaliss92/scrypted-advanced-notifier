import sdk, { DeviceBase, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, NotificationAction, Notifier, NotifierOptions, ObjectDetectionResult, PushHandler, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import child_process from 'child_process';
import { once } from "events";
import fs from 'fs';
import { cloneDeep, isEqual, sortBy } from 'lodash';
import path from 'path';
import { BasePlugin, BaseSettingsKey, getBaseSettings, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getRpcData } from '../../scrypted-monitor/src/utils';
import { ffmpegFilterImageBuffer } from "../../scrypted/plugins/snapshot/src/ffmpeg-image-filter";
import { name as pluginName, version } from '../package.json';
import { AiPlatform, getAiMessage } from "./aiUtils";
import { AdvancedNotifierAlarmSystem } from "./alarmSystem";
import { haAlarmAutomation, haAlarmAutomationId } from "./alarmUtils";
import { AdvancedNotifierCamera } from "./camera";
import { AdvancedNotifierCameraMixin, OccupancyRuleData } from "./cameraMixin";
import { DetectionClass, isLabelDetection } from "./detectionClasses";
import { idPrefix, publishPluginValues, publishRuleEnabled, setupPluginAutodiscovery, subscribeToPluginMqttTopics } from "./mqtt-utils";
import { AdvancedNotifierNotifier } from "./notifier";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE, ADVANCED_NOTIFIER_CAMERA_INTERFACE, ADVANCED_NOTIFIER_INTERFACE, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE, ALARM_SYSTEM_NATIVE_ID, AudioRule, BaseRule, CAMERA_NATIVE_ID, convertSettingsToStorageSettings, DECODER_FRAME_MIN_TIME, DecoderType, DelayType, DetectionEvent, DetectionRule, DetectionRuleActivation, deviceFilter, DeviceInterface, FRIGATE_BRIDGE_PLUGIN_NAME, getAiSettings, getAllDevices, getB64ImageLog, getDetectionRules, getDetectionRulesSettings, getElegibleDevices, getEventTextKey, getFrigateTextKey, GetImageReason, getNotifierData, getRuleKeys, getSnoozeId, getTextSettings, getWebHookUrls, getWebooks, haSnoozeAutomation, haSnoozeAutomationId, HOMEASSISTANT_PLUGIN_ID, ImageSource, isDetectionClass, isDeviceSupported, LATEST_IMAGE_SUFFIX, MAX_PENDING_RESULT_PER_CAMERA, MAX_RPC_OBJECTS_PER_CAMERA, NotificationPriority, NotificationSource, NOTIFIER_NATIVE_ID, notifierFilter, NTFY_PLUGIN_ID, NVR_PLUGIN_ID, nvrAcceleratedMotionSensorId, NvrEvent, OccupancyRule, ParseNotificationMessageResult, parseNvrNotificationMessage, pluginRulesGroup, PUSHOVER_PLUGIN_ID, RuleSource, RuleType, ruleTypeMetadataMap, safeParseJson, ScryptedEventSource, splitRules, TextSettingKey, TimelapseRule, VideoclipSpeed, videoclipSpeedMultiplier } from "./utils";

const { systemManager, mediaManager } = sdk;

export type PluginSettingKey =
    | 'pluginEnabled'
    | 'mqttEnabled'
    | 'notificationsEnabled'
    | 'debug'
    | 'sendDevNotifications'
    | 'serverId'
    | 'localAddresses'
    | 'localIp'
    | 'scryptedToken'
    | 'nvrUrl'
    | 'enableCameraDevice'
    | 'mqttActiveEntitiesTopic'
    | 'useNvrDetectionsForMqtt'
    | 'detectionSourceForMqtt'
    | 'onActiveDevices'
    | 'objectDetectionDevice'
    | 'securitySystem'
    | 'testDevice'
    | 'testNotifier'
    | 'testEventType'
    | 'testPriority'
    | 'testGenerateClip'
    | 'testGenerateClipSpeed'
    | 'testUseAi'
    | 'testSound'
    | 'testBypassSnooze'
    | 'testAddSnoozing'
    | 'testAddActions'
    | 'testButton'
    | 'checkConfigurations'
    | 'aiPlatform'
    | 'imagesPath'
    | 'imagesRegex'
    | 'enableDecoder'
    | BaseSettingsKey
    | TextSettingKey;

export default class AdvancedNotifierPlugin extends BasePlugin implements MixinProvider, HttpRequestHandler, DeviceProvider, PushHandler {
    initStorage: StorageSettingsDict<PluginSettingKey> = {
        ...getBaseSettings({
            onPluginSwitch: async (_, enabled) => {
                await this.startStop(enabled);
                await this.startStopMixins(enabled);
            },
            hideHa: false,
            baseGroupName: ''
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
            defaultValue: true,
            immediate: true,
        },
        notificationsEnabled: {
            title: 'Notifications enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        sendDevNotifications: {
            title: 'Send notifications on config errors',
            description: 'Uses the devNotifier',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
        localAddresses: {
            title: 'Local addresses',
            type: 'string',
            multiple: true,
            hide: true,
        },
        localIp: {
            title: 'Server local ip',
            type: 'string',
            hide: true,
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
        },
        enableCameraDevice: {
            title: 'Enable Camera',
            description: 'Enable a camera device allowing to replay past timelapses generated',
            type: 'boolean',
            immediate: true,
            onPut: async (_, active) => this.executeCameraDiscovery(active)
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
            description: 'Select which detections should be used. The snapshots will come from the same source',
            type: 'string',
            subgroup: 'MQTT',
            immediate: true,
            combobox: true,
            choices: []
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
            description: 'Select the object detection plugin to use for detecting objects.',
            type: 'device',
            deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}'`,
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
        testPriority: {
            group: 'Test',
            title: 'Priority',
            type: 'string',
            immediate: true,
            choices: Object.keys(NotificationPriority),
            defaultValue: NotificationPriority.Normal
        },
        testGenerateClip: {
            group: 'Test',
            title: 'Generate clip',
            type: 'boolean',
            immediate: true,
            defaultValue: false
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
        aiPlatform: {
            title: 'AI Platform',
            type: 'string',
            group: 'AI',
            immediate: true,
            choices: Object.values(AiPlatform),
            defaultValue: AiPlatform.Disabled,
            onPut: async () => await this.refreshSettings()
        },
        imagesPath: {
            title: 'Storage path',
            group: 'Storage',
            description: 'Disk path where to save images. Leave blank if you do not want any image to be stored',
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
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    private deviceVideocameraMap: Record<string, string> = {};
    public videocameraDevicesMap: Record<string, string[]> = {};
    public currentCameraMixinsMap: Record<string, AdvancedNotifierCameraMixin> = {};
    public currentSensorMixinsMap: Record<string, AdvancedNotifierSensorMixin> = {};
    public currentNotifierMixinsMap: Record<string, AdvancedNotifierNotifierMixin> = {};
    private mainFlowInterval: NodeJS.Timeout;
    defaultNotifier: AdvancedNotifierNotifier;
    camera: AdvancedNotifierCamera;
    alarmSystem: AdvancedNotifierAlarmSystem;
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

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Advanced notifier'
        });

        this.startStop(this.storageSettings.values.pluginEnabled).then().catch(this.getLogger().log);
    }

    async init() {
        const logger = this.getLogger();

        const cloudPlugin = systemManager.getDeviceByName<Settings>('Scrypted Cloud');
        if (cloudPlugin) {
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
                name: 'Advanced alarm system',
                nativeId: ALARM_SYSTEM_NATIVE_ID,
                interfaces: [
                    ScryptedInterface.SecuritySystem,
                    ScryptedInterface.Settings,
                    ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE
                ],
                type: ScryptedDeviceType.SecuritySystem,
            }
        );
        await this.executeCameraDiscovery(this.storageSettings.values.enableCameraDevice);

        await this.initPluginSettings();
    }

    async executeCameraDiscovery(active: boolean) {
        const interfaces: string[] = [
            ScryptedInterface.Camera,
            ScryptedInterface.VideoClips,
            ADVANCED_NOTIFIER_CAMERA_INTERFACE
        ];

        if (active) {
            interfaces.push(ScryptedInterface.VideoCamera);
        }

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Advanced notifier Camera',
                nativeId: CAMERA_NATIVE_ID,
                interfaces,
                type: ScryptedDeviceType.Camera,
            }
        );
    }

    async getDevice(nativeId: string) {
        if (nativeId === NOTIFIER_NATIVE_ID)
            return this.defaultNotifier ||= new AdvancedNotifierNotifier(NOTIFIER_NATIVE_ID, this);
        if (nativeId === CAMERA_NATIVE_ID)
            return this.camera ||= new AdvancedNotifierCamera(CAMERA_NATIVE_ID, this);
        if (nativeId === ALARM_SYSTEM_NATIVE_ID)
            return this.alarmSystem ||= new AdvancedNotifierAlarmSystem(ALARM_SYSTEM_NATIVE_ID, this);
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
                await this.mainFlow();
            }, 2 * 1000);
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const logger = this.getLogger();
        const url = new URL(`http://localhost${request.url}`);

        const [_, __, ___, ____, _____, webhook, ...rest] = url.pathname.split('/');
        const [deviceIdOrActionRaw, ruleNameOrSnoozeIdOrSnapshotId, timelapseNameOrSnoozeTime] = rest
        let deviceIdOrAction = decodeURIComponent(deviceIdOrActionRaw);
        const decodedTimelapseNameOrSnoozeTime = decodeURIComponent(timelapseNameOrSnoozeTime);
        const decodedRuleNameOrSnoozeIdOrSnapshotId = decodeURIComponent(ruleNameOrSnoozeIdOrSnapshotId);

        logger.log(`Webhook request: ${JSON.stringify({
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
            logger.log('BODY', body);
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
                timelapseDownload,
                timelapseStream,
                timelapseThumbnail,
                snoozeNotification,
                postNotification,
                setAlarm,
                detectionClipDownload,
            } = await getWebooks();
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
            } else if (webhook === lastSnapshot) {
                const isWebhookEnabled = device?.storageSettings.values.lastSnapshotWebhook;

                if (isWebhookEnabled) {
                    const imageIdentifier = `${ruleNameOrSnoozeIdOrSnapshotId}${LATEST_IMAGE_SUFFIX}`;
                    const { filePath: imagePath } = this.getDetectionImagePaths({ device: realDevice, imageIdentifier });

                    try {
                        const mo = await sdk.mediaManager.createFFmpegMediaObject({
                            inputArguments: [
                                '-i', imagePath,
                            ]
                        });
                        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                        response.send(jpeg, {
                            headers: {
                                'Content-Type': 'image/jpeg',
                            }
                        });
                        return;
                    } catch (e) {
                        const message = `Error getting snapshot ${ruleNameOrSnoozeIdOrSnapshotId} for device ${device.name}`;
                        logger.log(message)
                        response.send(message, {
                            code: 404,
                        });
                        return;
                    }
                }
            } else if (webhook === timelapseDownload) {
                const { videoclipPath } = this.getRulePaths({
                    ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                    cameraName: realDevice.name,
                    fileName: decodedTimelapseNameOrSnoozeTime,
                });

                logger.debug(`Requesting timelapse ${decodedRuleNameOrSnoozeIdOrSnapshotId} for download: ${JSON.stringify({
                    videoclipPath,
                    timelapseName: timelapseNameOrSnoozeTime,
                    decodedTimelapseNameOrSnoozeTime,
                    ruleName: ruleNameOrSnoozeIdOrSnapshotId,
                    decodedRuleNameOrSnoozeIdOrSnapshotId,
                })}`);

                response.sendFile(videoclipPath);
                return;
            } else if (webhook === timelapseStream) {
                const { videoclipPath } = this.getRulePaths({
                    cameraName: realDevice.name,
                    ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                    fileName: decodedTimelapseNameOrSnoozeTime,
                });
                const stat = await fs.promises.stat(videoclipPath);
                const fileSize = stat.size;
                const range = request.headers.range;

                logger.debug(`Videoclip requested: ${JSON.stringify({
                    cameraName: realDevice.name,
                    ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                    fileName: timelapseNameOrSnoozeTime,
                    videoclipPath,
                })}`);

                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(videoclipPath, { start, end });

                    const sendVideo = async () => {
                        return new Promise<void>((resolve, reject) => {
                            try {
                                response.sendStream((async function* () {
                                    for await (const chunk of file) {
                                        yield chunk;
                                    }
                                })(), {
                                    code: 206,
                                    headers: {
                                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                                        'Accept-Ranges': 'bytes',
                                        'Content-Length': chunksize,
                                        'Content-Type': 'video/mp4',
                                    }
                                });

                                resolve();
                            } catch (err) {
                                reject(err);
                            }
                        });
                    };

                    try {
                        await sendVideo();
                        return;
                    } catch (e) {
                        logger.log('Error fetching videoclip', e);
                    }
                } else {
                    response.sendFile(videoclipPath, {
                        code: 200,
                        headers: {
                            'Content-Length': fileSize,
                            'Content-Type': 'video/mp4',
                        }
                    });
                }

                return;
            } else if (webhook === timelapseThumbnail) {
                const { fileId, snapshotPath } = this.getRulePaths({
                    cameraName: realDevice.name,
                    ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                    fileName: timelapseNameOrSnoozeTime,
                });
                logger.info(JSON.stringify({
                    cameraName: realDevice.name,
                    ruleName: decodedRuleNameOrSnoozeIdOrSnapshotId,
                    fileName: timelapseNameOrSnoozeTime,
                    fileId
                }));

                const mo = await this.camera.getVideoClipThumbnail(fileId);
                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');

                response.sendFile(snapshotPath);
                return;
                // response.send(jpeg, {
                //     headers: {
                //         'Content-Type': 'image/jpeg',
                //     }
                // });
                // return;
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
                    source: NotificationSource.POST_WEBHOOK,
                    logger,
                    message,
                    image,
                    rule: { ruleType: RuleType.Detection } as DetectionRule
                });

                response.send(logMessage, {
                    code: 200,
                });
            } else if (webhook === detectionClipDownload) {
                const device = systemManager.getDeviceById<ScryptedDeviceBase>(deviceIdOrAction);

                const { videoclipPath } = this.getShortClipPaths({
                    device,
                    fileName: decodedTimelapseNameOrSnoozeTime
                });

                logger.debug(`Requesting detection clip ${decodedRuleNameOrSnoozeIdOrSnapshotId} for download: ${JSON.stringify({
                    videoclipPath,
                    timelapseName: timelapseNameOrSnoozeTime,
                    decodedRuleNameOrSnoozeIdOrSnapshotId,
                    ruleName: ruleNameOrSnoozeIdOrSnapshotId,
                })}`);

                response.sendFile(videoclipPath);
                return;
            }
        } catch (e) {
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
        try {
            const now = new Date().getTime();
            const isUpdated = this.lastKnownPeopleFetched && (now - this.lastKnownPeopleFetched) <= (1000 * 60);
            if (this.knownPeople && isUpdated) {
                return this.knownPeople;
            }

            const objDetectionPlugin = systemManager.getDeviceByName<Settings>('Scrypted NVR Object Detection');
            const settings = await objDetectionPlugin.getSettings();
            const knownPeople = settings?.find(setting => setting.key === 'knownPeople')?.choices
                ?.filter(choice => !!choice)
                .map(person => person.trim());

            this.knownPeople = knownPeople;
            this.lastKnownPeopleFetched = now;
            return this.knownPeople;
        } catch (e) {
            this.getLogger().log('Error in getKnownPeople', e.message);
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

        return this.mqttClient;
    }
    getLogger(device?: ScryptedDeviceBase) {
        let logger = super.getLogger();
        if (device) {
            logger = this.currentCameraMixinsMap[device.id]?.getLogger() ??
                this.currentSensorMixinsMap[device.id]?.getLogger() ?? logger;
        }

        return logger;
    }

    private async setupMqttEntities() {
        const { mqttEnabled, mqttActiveEntitiesTopic } = this.storageSettings.values;
        if (mqttEnabled) {
            try {
                const mqttClient = await this.getMqttClient();
                const logger = this.getLogger();

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
            // const cloudPlugin = systemManager.getDeviceByName<Settings>('Scrypted Cloud');
            // const oauthUrl = await (cloudPlugin as any).getOauthUrl();
            // const url = new URL(oauthUrl);
            // const serverId = url.searchParams.get('server_id');
            const localAddresses = await sdk.endpointManager.getLocalAddresses();
            const mo = await mediaManager.createMediaObject('', 'text/plain')
            const serverId: string = await mediaManager.convertMediaObject(mo, ScryptedMimeTypes.ServerId);

            logger.log(`Server id found: ${serverId}`);
            await this.putSetting('serverId', serverId);

            logger.log(`Local addresses found: ${localAddresses}`);
            await this.putSetting('localAddresses', localAddresses);
        }

        const localIp = (await sdk.endpointManager.getLocalAddresses())?.[0];
        this.putSetting('localIp', localIp);
        logger.log(`Local IP found: ${localIp}`);

        if (this.storageSettings.values.haEnabled) {
            await this.generateHomeassistantHelpers();
        }
    }

    private async mainFlow() {
        const logger = this.getLogger();
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

            if (!this.restartRequested) {
                const activeDevices = (getAllDevices()
                    .filter(device =>
                        device.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE) &&
                        (device.type === ScryptedDeviceType.Camera || device.type === ScryptedDeviceType.Doorbell)
                    )?.length || 0) + 1;

                if (!!activeDevices) {
                    const { pendingResults, rpcObjects } = await getRpcData();
                    const pluginPendingResults = pendingResults.find(elem => elem.name === pluginName)?.count;
                    const pluginRpcObjects = rpcObjects.find(elem => elem.name === pluginName)?.count;

                    logger.info(`PLUGIN-STUCK-CHECK: active devices ${activeDevices}, pending results ${pluginPendingResults} RPC objects ${pluginRpcObjects}`);

                    if (
                        pluginPendingResults > (MAX_PENDING_RESULT_PER_CAMERA * activeDevices) ||
                        pluginRpcObjects > (MAX_RPC_OBJECTS_PER_CAMERA * activeDevices)
                    ) {
                        logger.error(`Advanced notifier plugin seems stuck, ${pluginPendingResults} pending results and ${pluginRpcObjects} RPC objects. Restarting`);
                        this.restartRequested = true;
                        await sdk.deviceManager.requestRestart();
                    }

                    // if (!this.restartRequested) {
                    //     const nvrPendingResults = pendingResults.find(elem => elem.name === NVR_PLUGIN_ID)?.count;
                    //     const nvrRpcObjects = rpcObjects.find(elem => elem.name === NVR_PLUGIN_ID)?.count;
                    //     logger.info(`NVR-STUCK-CHECK: active devices ${activeDevices}, pending results ${nvrPendingResults} RPC objects ${nvrRpcObjects}`);

                    //     if (
                    //         nvrPendingResults > (MAX_PENDING_RESULT_PER_CAMERA * activeDevices) ||
                    //         nvrRpcObjects > (MAX_RPC_OBJECTS_PER_CAMERA * activeDevices)
                    //     ) {
                    //         logger.error(`NVR plugin seems stuck, ${nvrPendingResults} pending results and ${nvrRpcObjects} RPC objects. Restarting`);
                    //         await sdk.deviceManager.requestRestart();
                    //     }
                    // }
                }
            }
        } catch (e) {
            logger.log('Error in mainFlow', e);
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
                imagesPath,
                scryptedToken,
                nvrUrl,
                objectDetectionDevice,
                haEnabled,
                securitySystem,
            } = this.storageSettings.values;
            let storagePathError;

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
            aiPlatform: this.storageSettings.values.aiPlatform,
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
    }

    async getSettings() {
        try {
            const {
                mqttEnabled,
                testDevice,
                testNotifier,
                useNvrDetectionsForMqtt,
                testGenerateClip,
            } = this.storageSettings.values;

            this.storageSettings.settings.mqttActiveEntitiesTopic.hide = !mqttEnabled;
            this.storageSettings.settings.detectionSourceForMqtt.hide = !mqttEnabled;

            if (mqttEnabled) {
                this.storageSettings.settings.detectionSourceForMqtt.defaultValue =
                    useNvrDetectionsForMqtt ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection;
                const enabledDetectionSources = this.frigateApi ? [
                    ScryptedEventSource.RawDetection,
                    ScryptedEventSource.NVR,
                    ScryptedEventSource.Frigate,
                ] : [
                    ScryptedEventSource.RawDetection,
                    ScryptedEventSource.NVR,
                ];
                this.storageSettings.settings.detectionSourceForMqtt.choices = enabledDetectionSources;
            }
            this.storageSettings.settings.useNvrDetectionsForMqtt.hide = true;

            const { isCamera } = testDevice ? isDeviceSupported(testDevice) : {};
            this.storageSettings.settings.testEventType.hide = !isCamera;
            this.storageSettings.settings.testGenerateClipSpeed.hide = !testGenerateClip;

            if (testNotifier) {
                const { priorityChoices } = getNotifierData({ notifierId: testNotifier.id, ruleType: RuleType.Detection });
                this.storageSettings.settings.testPriority.choices = priorityChoices;
            }

            this.storageSettings.settings.testPriority.hide = testDevice && testDevice !== 'None';

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
        const { isSupported } = isDeviceSupported({ interfaces } as DeviceBase);

        if (
            isSupported &&
            !interfaces.includes(ADVANCED_NOTIFIER_NOTIFIER_INTERFACE) &&
            !interfaces.includes(ADVANCED_NOTIFIER_CAMERA_INTERFACE)
        ) {
            const interfaces = [ScryptedInterface.Settings, ADVANCED_NOTIFIER_INTERFACE];

            if (type === ScryptedDeviceType.Notifier) {
                interfaces.push(ScryptedInterface.Notifier);
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
            });

            if (filteredFiles.length) {
                const { detectionClipDownloadUrl } = await getWebHookUrls({
                    console: logger,
                    device,
                    clipName,
                    rule,
                });

                await cb(detectionClipDownloadUrl);
            } else {
                await cb();
            }
        }

        if (rule.generateClip && deviceMixin.decoderType !== DecoderType.Off) {
            const cameraMixin = this.currentCameraMixinsMap[device.id];
            const delay = cameraMixin.decoderType === DecoderType.OnMotion ? 3 : 1.5;
            logger.log(`Starting clip recording for rule ${rule.name} in ${delay} seconds (${cameraMixin.decoderType})`);
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

        const { timelapseDownloadUrl, timelapseThumbnailUrl } = await getWebHookUrls({
            console: logger,
            device: cameraDevice,
            clipName: timelapseName,
            rule,
        });

        const { videoclipPath } = this.getRulePaths({
            ruleName: rule.name,
            cameraName: cameraDevice.name,
            fileName: timelapseName,
        });
        const image = await sdk.mediaManager.createMediaObjectFromUrl(timelapseThumbnailUrl);

        const fileStats = await fs.promises.stat(videoclipPath);
        const sizeInBytes = fileStats.size;

        for (const notifierId of (rule.notifiers ?? [])) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                device: cameraDevice,
                rule,
                videoUrl: timelapseDownloadUrl,
                clickUrl: timelapseDownloadUrl,
                videoSize: sizeInBytes,
                image,
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

        return { device: cameraDevice };
    }

    public notifyDetectionEvent = async (props: {
        image?: MediaObject,
        match?: ObjectDetectionResult,
        rule: DetectionRule,
        eventType: DetectionEvent,
        triggerDeviceId: string,
        snoozeId?: string,
        triggerTime: number,
        source?: NotificationSource,
    }) => {
        const {
            eventType,
            triggerDeviceId,
            snoozeId,
            triggerTime,
            match,
            image,
            rule,
        } = props;
        const triggerDevice = systemManager.getDeviceById<DeviceInterface>(triggerDeviceId);
        const cameraDevice = await this.getCameraDevice(triggerDevice);
        const logger = this.getLogger(cameraDevice);
        const cameraMixin = this.currentCameraMixinsMap[cameraDevice.id];

        if (rule.activationType === DetectionRuleActivation.AdvancedSecuritySystem) {
            this.alarmSystem.onEventTrigger({ triggerDevice }).catch(logger.log);
        }

        const executeNotify = async (videoUrl?: string) => {
            logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ match, rule })} `);

            for (const notifierId of rule.notifiers) {
                const notifier = systemManager.getDeviceById<Settings & ScryptedDeviceBase>(notifierId);

                this.notifyDetection({
                    triggerDevice,
                    cameraDevice,
                    notifierId,
                    time: triggerTime,
                    image,
                    detection: match,
                    source: NotificationSource.DETECTION,
                    eventType,
                    logger,
                    snoozeId,
                    rule: rule as DetectionRule,
                    videoUrl,
                }).catch(e => logger.log(`Error on notifier ${notifier.name} `, e));

                if (rule.generateClip && cameraMixin.decoderType !== DecoderType.Off) {
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
        });
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
        const { actions, priority, addSnooze, addCameraActions, sound } = notifierData[notifierId] ?? {};
        const { withActions, withSnoozing, withSound } = getNotifierData({ notifierId, ruleType: rule.ruleType });
        const cameraMixin = cameraId ? this.currentCameraMixinsMap[cameraId] : undefined;
        const notifierMixin = this.currentNotifierMixinsMap[notifierId];
        const { notifierActions, aiEnabled: cameraAiEnabled } = cameraMixin?.storageSettings.values ?? {}
        const { aiEnabled: notifierAiEnabled } = notifierMixin.storageSettings.values;
        const { haUrl, externalUrl, timelinePart } = this.getUrls(cameraId, triggerTime);
        const deviceLogger = this.getLogger(device);
        let aiUsed = false;

        let additionalMessageText: string = '';

        const actionsEnabled = withActions && addCameraActions;
        const actionsToUseTmp: NotificationAction[] = actionsEnabled ?
            [...(actions ?? []),
            ...((notifierActions || []).map(action => safeParseJson(action)) ?? [])] :
            [];
        const actionsToUse: NotificationAction[] = [];

        for (const { action, title, icon, url } of actionsToUseTmp) {
            let urlToUse = url;

            // Assuming every action without url is an HA action
            if (!urlToUse) {
                const { haActionUrl } = await getWebHookUrls({
                    cameraIdOrAction: action,
                    console: deviceLogger,
                    device,
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

        let allActions: NotificationAction[] = [...actionsToUse];

        const snoozePlaceholder = this.getTextKey({ notifierId, textKey: 'snoozeText' });
        const snoozes = [10, 30, 60];
        const { snoozeActions, endpoint } = await getWebHookUrls({
            console: deviceLogger,
            device,
            snoozes,
            snoozeId,
            snoozePlaceholder,
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

        if (notifier.pluginId === PUSHOVER_PLUGIN_ID) {
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
                url: clickUrl ?? haUrl,
                clickAction: clickUrl ?? haUrl,
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
            for (const { action, url, icon, title } of actionsToUse) {
                const isUriAction = action === 'URI';
                const urlToUse = isUriAction ? url : undefined;
                haActions.push({
                    action: url ? 'URI' : action,
                    uri: urlToUse,
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

        const { aiPlatform } = this.storageSettings.values;

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

                const isAiRuleOk = rule ? rule.useAi : true;

                if (rule.useAi) {
                    logger.log(`Notification AI: ${JSON.stringify({
                        aiPlatform,
                        isAiRuleOk,
                        cameraAiEnabled,
                        notifierAiEnabled
                    })}`);
                }

                const isAiEnabled = forceAi || (isAiRuleOk && cameraAiEnabled && notifierAiEnabled);
                if (aiPlatform !== AiPlatform.Disabled && isAiEnabled) {
                    const imageUrl = `data:image/jpeg;base64,${b64Image}`;
                    const aiResponse = await getAiMessage({
                        imageUrl,
                        b64Image,
                        logger,
                        originalTitle: message,
                        plugin: this,
                        detection,
                        timeStamp: triggerTime
                    });

                    if (aiResponse.message) {
                        message = aiResponse.message;
                        aiUsed = true;
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
            aiPlatform,
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
        detection?: ObjectDetectionResult
        eventType?: DetectionEvent,
        rule?: DetectionRule,
        source?: NotificationSource,
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
                image: imageParent,
                detection,
                source,
                logger,
                rule,
                snoozeId,
                eventType,
                message,
                forceAi,
                videoUrl
            } = props;

            const device = cameraDevice ?? await this.getCameraDevice(triggerDevice);

            if (!device) {
                logger.log(`There is no camera linked to the device ${triggerDevice.name}`);
                return;
            }

            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            const { b64Image, image, imageSource } = await this.currentCameraMixinsMap[device.id].getImage({
                image: imageParent,
                reason: GetImageReason.Notification
            });

            if (imageSource !== ImageSource.Input) {
                logger.log(`Notification image ${getB64ImageLog(b64Image)} fetched from ${imageSource}`);
            }

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
                source,
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
        source?: NotificationSource,
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
            source,
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
            source,
            title,
            message,
            rule,
            payload
        }));

        await notifier.sendNotification(title, notifierOptions, image, icon);
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
            testSound,
            testUseAi,
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
                    testNotifier,
                    testPriority,
                    testSound,
                    testUseAi,
                })}`);

                const snoozeId = testBypassSnooze ? Math.random().toString(36).substring(2, 12) : undefined;
                await this.notifyDetectionEvent({
                    source: NotificationSource.TEST,
                    eventType,
                    triggerDeviceId: testDevice.id,
                    triggerTime: currentTime - 2000,
                    snoozeId,
                    match: isDetection ? { label: 'TestLabelFound', className: testEventType, score: 1 } : undefined,
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
                        generateClipSpeed: testGenerateClipSpeed,
                        generateClip: testGenerateClip,
                        useAi: testUseAi,
                        ruleType: RuleType.Detection,
                        markDetections: false,
                        activationType: DetectionRuleActivation.Always,
                        source: RuleSource.Plugin,
                        isEnabled: true,
                        name: 'Test rule',
                        notifiers: [testNotifier?.id]
                    }
                })
                // this.notifyDetection({
                //     triggerDevice: testDevice,
                //     notifierId: testNotifierId,
                //     time: currentTime,
                //     eventType,
                //     detection: isDetection ? { label: 'TestLabelFound', className: testEventType, score: 1 } : undefined,
                //     source: NotificationSource.TEST,
                //     logger,
                //     snoozeId,
                //     forceAi: testUseAi,
                //     rule: {
                //         notifierData: {
                //             [testNotifierId]: {
                //                 priority: testPriority,
                //                 actions: [],
                //                 addSnooze: testAddSnoozing,
                //                 addCameraActions: testAddActions,
                //                 sound: testSound
                //             }
                //         },
                //         generateClipSpeed: testGenerateClipSpeed,
                //         generateClip: testGenerateClip,
                //         useAi: testUseAi,
                //         ruleType: RuleType.Detection,
                //         markDetections: false,
                //         activationType: DetectionRuleActivation.Always,
                //         source: RuleSource.Plugin,
                //         isEnabled: true,
                //         name: "",
                //         notifiers: []
                //     }
                // });
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

        const fileId = `${cameraName}_${ruleName}_${fileName}`;

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
        device: ScryptedDeviceBase,
        fileName?: string,
    }) => {
        const { device, fileName } = props;
        const { cameraPath } = this.getFsPaths({ cameraName: device.name });

        const shortClipsPath = path.join(cameraPath, 'shortClips');
        const framesPath = path.join(shortClipsPath, 'frames');
        const generatedPath = path.join(shortClipsPath, 'generated');
        const framePath = fileName ? path.join(framesPath, `${fileName}.jpg`) : undefined;
        const videoclipPath = fileName ? path.join(generatedPath, `${fileName}.mp4`) : undefined;

        return {
            shortClipsPath,
            framesPath,
            generatedPath,
            framePath,
            videoclipPath,
        };
    }

    public storeImage = async (props: {
        device: ScryptedDeviceBase,
        name: string,
        timestamp: number,
        b64Image?: string,
        classname?: string,
        label?: string,
        eventSource: ScryptedEventSource
    }) => {
        const { device, name, timestamp, b64Image, classname, label, eventSource } = props;
        const { imagesRegex } = this.storageSettings.values;
        const logger = this.getLogger(device);
        const mixin = this.currentCameraMixinsMap[device.id];

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
                postDetectionImageClasses?.includes(classname) &&
                mixin.isDelayPassed({
                    type: DelayType.PostWebhookImage,
                    classname,
                    eventSource,
                }).timePassed
            ) {
                for (const url of postDetectionImageUrls) {
                    logger.log(`Posting ${classname} image to ${url}, ${timestamp} ${label}`);
                    await axios.post(url, {
                        classname,
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
            logger.error(`Error starting timelapse rule ${rule.name}`, e);
        }
    }

    getfont() {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
        const unzippedFs = path.join(pluginVolume, 'zip/unzipped/fs');
        const fontFile = path.join(unzippedFs, 'Lato-Bold.ttf');

        return fontFile;
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
                .sort((a, b) => parseInt(a) - parseInt(b));
            const fileListContent = sortedFiles
                .map(file => `file '${path.join(framesPath, file)}'`)
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
            const mo = await sdk.mediaManager.createMediaObjectFromUrl(
                `file:${framePath}`
            );
            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');

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

        const { framesPath } = this.getShortClipPaths({ device });

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

    public clearDetectionSessionFrames = async (props: {
        device: ScryptedDeviceBase,
        logger: Console,
        threshold: number
    }) => {
        const { device, logger, threshold } = props;
        const { framesPath } = this.getShortClipPaths({ device });
        logger.log(`Cleaning up old frames ${threshold}`);

        try {
            const frames = await fs.promises.readdir(framesPath);
            let removedFrames = 0;

            for (const filename of frames) {
                const filepath = path.join(framesPath, filename);
                const fileTimestamp = parseInt(filename);

                if (fileTimestamp < threshold) {
                    try {
                        await fs.promises.unlink(filepath);
                        removedFrames += 1;
                    } catch (err) {
                        logger.error(`Error removing frame ${filename}`, err.message);
                    }
                }
            }

            logger.log(`Frames found ${frames.length}, removed ${removedFrames}`);
        } catch { }

        // const clips = await fs.promises.readdir(generatedPath);
        // let removedClips = 0;
        // logger.log(`${clips.length} clips found`);

        // for (const filename of clips) {
        //     const fileTimestamp = parseInt(filename);

        //     if (fileTimestamp < threshold) {
        //         const filepath = path.join(generatedPath, filename);
        //         try {
        //             await fs.promises.unlink(filepath);
        //             removedClips += 1;
        //         } catch (err) {
        //             logger.error(`Error removing clip ${filename}`, err.message);
        //         }
        //     }
        // }

        // logger.log(`${removedClips} old clips removed`);
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
            } = this.getShortClipPaths({ device, fileName });
            const listPath = path.join(shortClipsPath, 'file_list.txt');

            let preTriggerFrames = 0;
            let postTriggerFrames = 0;
            const files = await fs.promises.readdir(framesPath);
            const filteredFiles = files
                .sort((a, b) => parseInt(a) - parseInt(b))
                .filter(frameName => {
                    const fileTimestamp = parseInt(frameName);

                    if (fileTimestamp > minTime) {
                        if (fileTimestamp < triggerTime) {
                            preTriggerFrames++;
                        } else {
                            postTriggerFrames++;
                        }

                        return true;
                    }

                    return false;
                })
                .map(file => `file '${path.join(framesPath, file)}'`);
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
            } else {
                logger.log(`Skipping ${rule.name} ${triggerTime} clip generation, no frames available`);

            }

            return { fileName, preTriggerFrames, postTriggerFrames, filteredFiles };

        } catch (e) {
            logger.log('Error generating timelapse', e);
        }
    }
}

