import sdk, { DeviceBase, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, NotificationAction, Notifier, NotifierOptions, ObjectDetectionResult, PushHandler, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SecuritySystem, SecuritySystemMode, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import child_process from 'child_process';
import { once } from "events";
import fs from 'fs';
import { cloneDeep, isEqual, sortBy } from 'lodash';
import path from 'path';
import { BasePlugin, BaseSettingsKey, getBaseSettings, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getRpcData } from '../../scrypted-monitor/src/utils';
import { name as pluginName, version } from '../package.json';
import { AiPlatform, getAiMessage } from "./aiUtils";
import { AdvancedNotifierAlarmSystem } from "./alarmSystem";
import { haAlarmAutomation, haAlarmAutomationId } from "./alarmUtils";
import { AdvancedNotifierCamera } from "./camera";
import { AdvancedNotifierCameraMixin, OccupancyRuleData } from "./cameraMixin";
import { DetectionClass } from "./detectionClasses";
import { idPrefix, publishPluginValues, publishRuleEnabled, setupPluginAutodiscovery, subscribeToPluginMqttTopics } from "./mqtt-utils";
import { AdvancedNotifierNotifier } from "./notifier";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE, ADVANCED_NOTIFIER_CAMERA_INTERFACE, ADVANCED_NOTIFIER_INTERFACE, ADVANCED_NOTIFIER_NOTIFIER_INTERFACE, ALARM_SYSTEM_NATIVE_ID, AudioRule, BaseRule, CAMERA_NATIVE_ID, convertSettingsToStorageSettings, DelayType, DetectionEvent, DetectionRule, DetectionRuleActivation, deviceFilter, DeviceInterface, getAiSettings, getAllDevices, getB64ImageLog, getDetectionRules, getDetectionRulesSettings, getElegibleDevices, getEventTextKey, GetImageReason, getNotifierData, getNowFriendlyDate, getRuleKeys, getSnoozeId, getTextSettings, getWebHookUrls, getWebooks, haSnoozeAutomation, haSnoozeAutomationId, HOMEASSISTANT_PLUGIN_ID, ImageSource, isDetectionClass, isDeviceSupported, LATEST_IMAGE_SUFFIX, MAX_PENDING_RESULT_PER_CAMERA, MAX_RPC_OBJECTS_PER_CAMERA, NotificationPriority, NotificationSource, NOTIFIER_NATIVE_ID, notifierFilter, NTFY_PLUGIN_ID, NVR_PLUGIN_ID, nvrAcceleratedMotionSensorId, NvrEvent, OccupancyRule, ParseNotificationMessageResult, parseNvrNotificationMessage, pluginRulesGroup, PUSHOVER_PLUGIN_ID, RuleSource, RuleType, ruleTypeMetadataMap, safeParseJson, ScryptedEventSource, splitRules, TextSettingKey, TimelapseRule } from "./utils";

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
    | 'onActiveDevices'
    | 'objectDetectionDevice'
    | 'securitySystem'
    | 'testDevice'
    | 'testNotifier'
    | 'testEventType'
    | 'testPriority'
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
    | 'cleanup340'
    | 'texts3412'
    | 'eventsChanged350'
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
        ...getTextSettings({ forMixin: false }),
        [ruleTypeMetadataMap[RuleType.Detection].rulesKey]: {
            title: 'Detection rules',
            group: pluginRulesGroup,
            type: 'string',
            multiple: true,
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
        cleanup340: {
            type: 'boolean',
            hide: true,
        },
        texts3412: {
            type: 'boolean',
            hide: true,
        },
        eventsChanged350: {
            type: 'boolean',
            hide: true,
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
    knownPeople: string[] = [];
    restartRequested = false;
    public aiMessageResponseMap: Record<string, string> = {};

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

        const [major, minor, patch] = version.split('.').map(num => parseInt(num, 10));

        if (major === 3 && minor >= 4 && !this.storageSettings.values.cleanup340) {
            const basePath = process.env.SCRYPTED_PLUGIN_VOLUME;
            const snapshotsFolder = path.join(basePath, 'snapshots');

            try {
                await fs.promises.rm(snapshotsFolder, { force: true, recursive: true });
                logger.log('Old snapshots folder cleaned up');
                this.storageSettings.values.cleanup340 = true;
            } catch (e) {
                logger.error(e);
            }
        }

        if (major === 3 && minor === 4 && patch >= 12 && !this.storageSettings.values.texts3412) {
            logger.log('Texts building has been reworked. Check Texts section to fill any missing');
            this.storageSettings.values.texts3412 = true;
        }

        if (major === 3 && minor === 5 && patch >= 0 && !this.storageSettings.values.eventsChanged350) {
            logger.log('Sensors have been reworked, check rules where they were enabled, they need to be selected again');
            this.storageSettings.values.eventsChanged350 = true;
        }

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
            await this.refreshSettings();
            await this.init();
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
        const params = url.searchParams.get('params') ?? '{}';

        const { filename } = JSON.parse(params);
        const [_, __, ___, ____, _____, webhook, ...rest] = url.pathname.split('/');
        const [deviceIdOrActionRaw, ruleNameOrSnoozeIdOrSnapshotId, timelapseNameOrSnoozeTime] = rest
        let deviceIdOrAction = decodeURIComponent(deviceIdOrActionRaw);
        logger.log(`Webhook request: ${JSON.stringify({
            url: request.url,
            body: request.body,
            webhook,
            deviceIdOrActionRaw,
            deviceIdOrAction,
            ruleNameOrSnoozeIdOrSnapshotId,
            timelapseNameOrSnoozeTime,
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
                const device = this.currentCameraMixinsMap[deviceIdOrAction];
                const isWebhookEnabled = device?.storageSettings.values.lastSnapshotWebhook;

                if (isWebhookEnabled) {
                    const realDevice = systemManager.getDeviceById<ScryptedDeviceBase>(device.id);

                    const imageIdentifier = `${ruleNameOrSnoozeIdOrSnapshotId}${LATEST_IMAGE_SUFFIX}`;
                    const { filePath: imagePath } = this.getImagePath({ device: realDevice, imageIdentifier });

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
                const decodedTimelapseName = decodeURIComponent(timelapseNameOrSnoozeTime);
                const decodedRuleName = decodeURIComponent(ruleNameOrSnoozeIdOrSnapshotId);
                const { generatedPath } = this.getTimelapseFolder({
                    ruleName: decodedRuleName
                });

                const timelapsePath = path.join(generatedPath, decodedTimelapseName);
                logger.debug(`Requesting timelapse ${decodedRuleName} for download: ${JSON.stringify({
                    generatedPath,
                    timelapseName: timelapseNameOrSnoozeTime,
                    decodedTimelapseName,
                    ruleName: ruleNameOrSnoozeIdOrSnapshotId,
                    decodedRuleName,
                    timelapsePath,
                })}`);

                response.sendFile(timelapsePath);
                return;
            } else if (webhook === timelapseStream) {
                const stat = await fs.promises.stat(filename);
                const fileSize = stat.size;
                const range = request.headers.range;

                logger.debug(`Videoclip requested: ${JSON.stringify({
                    filename,
                })}`);

                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(filename, { start, end });

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
                    response.sendFile(filename, {
                        code: 200,
                        headers: {
                            'Content-Length': fileSize,
                            'Content-Type': 'video/mp4',
                        }
                    });
                }

                return;
            } else if (webhook === timelapseThumbnail) {
                const thumbnailMo = await this.camera.getVideoClipThumbnail(decodeURIComponent(filename));
                if (!thumbnailMo) {
                    response.send('Generating', {
                        code: 400
                    });
                    return;
                }
                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
                response.send(jpeg, {
                    headers: {
                        'Content-Type': 'image/jpeg',
                    }
                });
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
                    const decodedSnoozeTime = decodeURIComponent(timelapseNameOrSnoozeTime);
                    snoozeId = decodeURIComponent(ruleNameOrSnoozeIdOrSnapshotId);
                    deviceId = deviceIdOrAction;
                    device = this.currentCameraMixinsMap[deviceIdOrAction];
                    snoozeTime = Number(decodedSnoozeTime);
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
                const decodedClipName = decodeURIComponent(timelapseNameOrSnoozeTime);
                const device = systemManager.getDeviceById<ScryptedDeviceBase>(deviceIdOrAction);

                const { generatedPath } = this.getDetectionSessionPath({
                    device,
                });

                const clipPath = path.join(generatedPath, decodedClipName);
                logger.debug(`Requesting detection clip ${decodedClipName} for download: ${JSON.stringify({
                    generatedPath,
                    timelapseName: timelapseNameOrSnoozeTime,
                    decodedClipName,
                    ruleName: ruleNameOrSnoozeIdOrSnapshotId,
                    clipPath,
                })}`);

                response.sendFile(clipPath);
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
            const cloudPlugin = systemManager.getDeviceByName<Settings>('Scrypted Cloud');
            const oauthUrl = await (cloudPlugin as any).getOauthUrl();
            const url = new URL(oauthUrl);
            const serverId = url.searchParams.get('server_id');
            const localAddresses = await sdk.endpointManager.getLocalAddresses();

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

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Plugin,
            logger,
            people,
            refreshSettings: async () => await this.refreshSettings(),
        });

        dynamicSettings.push(...getAiSettings({
            aiPlatform: this.storageSettings.values.aiPlatform,
            logger,
            onRefresh: async () => await this.refreshSettings(),
        }));

        dynamicSettings.push(...detectionRulesSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });
    }

    async getSettings() {
        try {
            const { mqttEnabled, testDevice, testNotifier } = this.storageSettings.values;

            this.storageSettings.settings.mqttActiveEntitiesTopic.hide = !mqttEnabled;
            this.storageSettings.settings.useNvrDetectionsForMqtt.hide = !mqttEnabled;

            const { isCamera } = testDevice ? isDeviceSupported(testDevice) : {};
            this.storageSettings.settings.testEventType.hide = !isCamera;

            if (testNotifier) {
                const { priorityChoices } = getNotifierData({ notifierId: testNotifier.id, ruleType: RuleType.Detection });
                this.storageSettings.settings.testPriority.choices = priorityChoices;
            }

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
            // allInterfaces.some(int => interfaces.includes(int)) &&
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

    async notifyOccupancyEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        rule: OccupancyRule,
        image: MediaObject,
        occupancyData: OccupancyRuleData
    }) {
        const { cameraDevice, rule, triggerTime, image, occupancyData } = props;

        let message = occupancyData.occupies ?
            rule.zoneOccupiedText :
            rule.zoneNotOccupiedText;

        message = message.toString()
            .replace('${detectedObjects}', String(occupancyData.objectsDetected) ?? '')
            .replace('${maxObjects}', String(rule.maxObjects) ?? '')

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                image,
                message,
                triggerTime,
                device: cameraDevice,
                rule,
            });
        }
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

        const { timelapseDownloadUrl } = await getWebHookUrls({
            console: logger,
            device: cameraDevice,
            clipName: timelapseName,
            rule,
        });

        const { generatedPath } = this.getTimelapseFolder({
            ruleName: rule.name
        });

        const timelapsePath = path.join(generatedPath, timelapseName);

        const fileStats = await fs.promises.stat(timelapsePath);
        const sizeInBytes = fileStats.size;
        const fileSizeInMegabytes = sizeInBytes / (1024 * 1024);
        const isVideoValid = fileSizeInMegabytes < 50;

        for (const notifierId of (rule.notifiers ?? [])) {
            const notifier = systemManager.getDeviceById<DeviceInterface>(notifierId);

            await this.sendNotificationInternal({
                notifier,
                device: cameraDevice,
                rule,
                videoUrl: isVideoValid ? timelapseDownloadUrl : undefined,
            });
        }
    }

    async notifyNvrEvent(props: ParseNotificationMessageResult & { cameraDevice: DeviceInterface, triggerTime: number }) {
        const { eventType, detection, triggerDevice, cameraDevice, triggerTime } = props;
        const rules = this.runningDetectionRules.filter(rule =>
            rule.isNvr &&
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

        const foundDevice = this.currentCameraMixinsMap[triggerDevice.id] || this.currentSensorMixinsMap[triggerDevice.id];

        if (!foundDevice) {
            logger.log(`Device not found for NVR notification: ${cameraName} ${eventType} ${triggerDevice?.name}`);
            return;
        }

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
        triggerTime: number,
    }) => {
        const {
            eventType,
            triggerDeviceId,
            triggerTime,
            match,
            image,
            rule,
        } = props;
        const triggerDevice = systemManager.getDeviceById<DeviceInterface>(triggerDeviceId);
        const cameraDevice = await this.getCameraDevice(triggerDevice);
        const logger = this.getLogger(cameraDevice);

        logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ match, rule })} `);

        if (rule.activationType === DetectionRuleActivation.AdvancedSecuritySystem) {
            this.alarmSystem.onEventTrigger({ triggerDevice }).catch(logger.log);
        }

        let videoUrl: string;

        if (rule.generateClip) {
            const clipName = await this.generateDetectionSessionClip({
                device: cameraDevice,
                logger,
                rule,
                triggerTime
            });
            const { detectionClipDownloadUrl } = await getWebHookUrls({
                console: logger,
                device: cameraDevice,
                clipName,
                rule,
            });
            videoUrl = detectionClipDownloadUrl
        }

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
                rule: rule as DetectionRule,
                videoUrl,
            }).catch(e => logger.log(`Error on notifier ${notifier.name} `, e));
        }
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
        const { label } = detection ?? {};

        const roomName = device?.room;

        const { key, subKey } = getEventTextKey({ eventType });

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
        detection?: ObjectDetectionResult,
        device?: DeviceInterface,
        eventType?: DetectionEvent,
        b64Image?: string,
        logger: Console,
        snoozeId?: string,
        forceAi?: boolean,
    }) {
        const {
            notifier,
            rule,
            triggerTime,
            device,
            videoUrl,
            detection,
            eventType,
            message: messageParent,
            b64Image,
            logger,
            snoozeId: snoozeIdParent,
            forceAi,
        } = props;
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
                url: !videoUrl ? externalUrl : videoUrl,
                html: 1,
                sound
            };

            if (allActions.length) {
                additionalMessageText += '\n';
                for (const { title, url } of allActions) {
                    additionalMessageText += `<a href="${url}">${title}</a>\n`;
                }
            }

            const priorityToUse = priority === NotificationPriority.High ? 1 :
                priority === NotificationPriority.Normal ? 0 :
                    priority === NotificationPriority.Low ? -1 :
                        -2;

            payload.data.pushover.priority = priorityToUse;
        } else if (notifier.pluginId === HOMEASSISTANT_PLUGIN_ID) {
            payload.data.ha = {
                url: videoUrl ?? haUrl,
                clickAction: videoUrl ?? haUrl,
                video: videoUrl,
                push: {
                    sound: {
                        name: withSound && sound ? sound : 'default'
                    }
                }
            };

            const haActions: any[] = [];
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
                    // haActions.push({
                    //     action: url ? 'URI' : action,
                    //     uri: url,
                    //     icon: 'sfsymbols:bell',
                    //     title,
                    // });
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

            // if (withSound) {
            //     payload.data.ha.push.sound = {
            //         ...payload.data.ha.push.sound,
            //         sound,
            //     };
            // }
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
            message: messageParent,
            detection,
            eventType,
            forceAi,
            logger: loggerParent
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
        });

        const notifierOptions: NotifierOptions = {
            body: message,
            ...payload,
        }

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
        const testDevice = this.storageSettings.getItem('testDevice') as DeviceInterface;
        const testNotifier = this.storageSettings.getItem('testNotifier') as DeviceInterface;
        const testEventType = this.storageSettings.getItem('testEventType') as DetectionEvent;
        const testPriority = this.storageSettings.getItem('testPriority') as NotificationPriority;
        const testUseAi = this.storageSettings.getItem('testUseAi') as boolean;
        const testBypassSnooze = this.storageSettings.getItem('testBypassSnooze') as boolean;
        const testAddActions = this.storageSettings.getItem('testAddActions') as boolean;
        const testAddSnoozing = this.storageSettings.getItem('testAddSnoozing') as boolean;
        const testSound = this.storageSettings.getItem('testSound') as string;

        const logger = this.getLogger();

        try {
            if (testDevice && testEventType && testNotifier) {
                const currentTime = new Date().getTime();
                const testNotifierId = testNotifier.id
                const { sensorType } = isDeviceSupported(testDevice);
                const eventType = sensorType ?? testEventType;
                const isDetection = isDetectionClass(testEventType);

                logger.log(`Sending ${eventType} test notification to ${testNotifier.name} - ${testDevice.name} - ${testEventType} ${sensorType} ${testSound}`);

                const snoozeId = testBypassSnooze ? Math.random().toString(36).substring(2, 12) : undefined;
                this.notifyDetection({
                    triggerDevice: testDevice,
                    notifierId: testNotifierId,
                    time: currentTime,
                    eventType,
                    detection: isDetection ? { label: 'TestLabelFound', className: testEventType, score: 1 } : undefined,
                    source: NotificationSource.TEST,
                    logger,
                    snoozeId,
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
                        generateClip: false,
                        useAi: testUseAi,
                        ruleType: RuleType.Detection,
                        markDetections: false,
                        activationType: DetectionRuleActivation.Always,
                        source: RuleSource.Plugin,
                        isEnabled: true,
                        name: "",
                        notifiers: []
                    }
                });
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

    public getImagePath = (props: { imageIdentifier: string, device: ScryptedDeviceBase }) => {
        const { device, imageIdentifier } = props;
        const { imagesPath } = this.storageSettings.values;
        const savePath = path.join(imagesPath, device.name);
        const filePath = path.join(savePath, `${imageIdentifier}.jpg`);

        return { savePath, filePath };
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
        const { imagesPath, imagesRegex } = this.storageSettings.values;
        const logger = this.getLogger(device);
        const mixin = this.currentCameraMixinsMap[device.id];

        if (b64Image) {
            if (imagesPath && mixin.isDelayPassed({ type: DelayType.FsImageUpdate, filename: name, eventSource })) {
                const { savePath } = this.getImagePath({ device, imageIdentifier: name });

                try {
                    await fs.promises.access(savePath);
                } catch {
                    await fs.promises.mkdir(savePath, { recursive: true });
                }

                const filename = imagesRegex
                    .replace('${name}', name)
                    .replace('${timestamp}', timestamp);

                const latestImage = `${name}${LATEST_IMAGE_SUFFIX}`;
                const { filePath: imagePath } = this.getImagePath({ device, imageIdentifier: filename });
                const { filePath: latestPath } = this.getImagePath({ device, imageIdentifier: latestImage });

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
                })
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

    public getTimelapseFolder = (props: {
        ruleName: string,
    }) => {
        let { imagesPath } = this.storageSettings.values;
        if (!imagesPath) {
            imagesPath = process.env.SCRYPTED_PLUGIN_VOLUME;
        }

        const { ruleName } = props;
        const mainPath = path.join(imagesPath, 'timelapses');
        const timelapsePath = path.join(mainPath, ruleName);
        const framesPath = path.join(timelapsePath, 'frames');
        const generatedPath = path.join(timelapsePath, 'generated');

        return {
            mainPath,
            timelapsePath,
            framesPath,
            generatedPath,
        };
    }

    public storeTimelapseFrame = async (props: {
        rule: TimelapseRule,
        timestamp: number,
        device: ScryptedDeviceBase,
        imageMo: MediaObject
    }) => {
        const { rule, timestamp, imageMo: imageMoParent, device } = props;
        const { imagesPath } = this.storageSettings.values;

        let imageMo = imageMoParent;

        if (!imageMo) {
            return;
        }

        if (imagesPath && imageMo) {
            const { framesPath } = this.getTimelapseFolder({ ruleName: rule.name });

            try {
                await fs.promises.access(framesPath);
            } catch {
                await fs.promises.mkdir(framesPath, { recursive: true });
            }

            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(framesPath, `${timestamp}.jpg`), jpeg);
        }
    }

    public clearTimelapseFrames = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console
    }) => {
        const { rule, logger } = props;
        logger.log(`Clearing frames for rule ${rule.name}.`);
        try {
            const { framesPath } = this.getTimelapseFolder({ ruleName: rule.name });

            await fs.promises.rm(framesPath, { recursive: true, force: true, maxRetries: 10 });
            logger.log(`Folder ${framesPath} removed`);
        } catch (e) {
            logger.error(`Error starting timelapse rule ${rule.name}`, e);
        }
    }

    public generateTimelapse = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
    }) => {
        const { rule, logger } = props;
        const { imagesPath } = this.storageSettings.values;

        if (imagesPath) {
            try {
                const { timelapsePath, framesPath, generatedPath } = this.getTimelapseFolder({ ruleName: rule.name });
                const listPath = path.join(timelapsePath, 'file_list.txt');

                const timelapseName = `${getNowFriendlyDate()}.mp4`;
                const outputFile = path.join(generatedPath, timelapseName);

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
                    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-y',
                    outputFile
                ];

                logger.log(`Generating timelapse ${rule.name} with arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');

                return timelapseName;
            } catch (e) {
                logger.log('Error generating timelapse', e);
            }
        }
    }

    public getDetectionSessionPath = (props: {
        device: ScryptedDeviceBase,
    }) => {
        let { imagesPath } = this.storageSettings.values;
        if (!imagesPath) {
            imagesPath = process.env.SCRYPTED_PLUGIN_VOLUME;
        }

        const { device } = props;
        const mainPath = path.join(imagesPath, 'detectionSessions');
        const detectionSessionPath = path.join(mainPath, device.name);
        const framesPath = path.join(detectionSessionPath, 'frames');
        const generatedPath = path.join(detectionSessionPath, 'generated');

        return {
            detectionSessionPath,
            framesPath,
            generatedPath,
        };
    }

    public storeDetectionFrame = async (props: {
        timestamp: number,
        device: ScryptedDeviceBase,
        imageMo: MediaObject
    }) => {
        const { timestamp, imageMo: imageMoParent, device } = props;
        const { imagesPath } = this.storageSettings.values;

        let imageMo = imageMoParent;

        if (!imageMo) {
            return;
        }

        if (imagesPath && imageMo) {
            const { framesPath } = this.getDetectionSessionPath({ device });

            try {
                await fs.promises.access(framesPath);
            } catch {
                await fs.promises.mkdir(framesPath, { recursive: true });
            }

            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(framesPath, `${timestamp}.jpg`), jpeg);
        }
    }

    public clearDetectionSessionFrames = async (props: {
        device: ScryptedDeviceBase,
        logger: Console
    }) => {
        const { device, logger } = props;
        const { framesPath } = this.getDetectionSessionPath({ device });

        await fs.promises.rm(framesPath, { recursive: true, force: true, maxRetries: 10 });
        logger.log(`Folder ${framesPath} removed`);
    }

    public generateDetectionSessionClip = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
        triggerTime: number,
    }) => {
        const { device, rule, logger, triggerTime } = props;
        const { imagesPath } = this.storageSettings.values;

        const minTime = triggerTime - (5 * 1000);

        if (imagesPath) {
            try {
                const { detectionSessionPath, framesPath, generatedPath } = this.getDetectionSessionPath({ device });
                const listPath = path.join(detectionSessionPath, 'file_list.txt');

                const fileName = `${getNowFriendlyDate()}.mp4`;
                const outputFile = path.join(generatedPath, fileName);

                const files = await fs.promises.readdir(framesPath);
                const fileListContent = files
                    .sort((a, b) => parseInt(a) - parseInt(b))
                    .filter(fileName => parseInt(fileName) > minTime)
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
                    '-r', `${10}`,
                    '-i', listPath,
                    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-y',
                    outputFile
                ];

                logger.log(`Generating detection clip ${rule.name} with arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');

                return fileName;

            } catch (e) {
                logger.log('Error generating timelapse', e);
            }
        }
    }
}

