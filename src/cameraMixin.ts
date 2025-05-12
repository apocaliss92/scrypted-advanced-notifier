import sdk, { Camera, EventDetails, EventListenerRegister, FFmpegInput, Image, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionResult, ObjectDetector, ObjectsDetected, PanTiltZoomCommand, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, VideoFrame, VideoFrameGenerator, VideoFrameGeneratorOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep, uniq, uniqBy } from "lodash";
import moment from "moment";
import { getBaseLogger, getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { filterOverlappedDetections } from '../../scrypted-basic-object-detector/src/util';
import { FrigateObjectDetection } from '../../scrypted-frigate-bridge/src/utils';
import { RtpPacket } from "../../scrypted/external/werift/packages/rtp/src/rtp/rtp";
import { startRtpForwarderProcess } from '../../scrypted/plugins/webrtc/src/rtp-forwarders';
import { Deferred } from "../../scrypted/server/src/deferred";
import { name as pluginName } from '../package.json';
import { DetectionClass, defaultDetectionClasses, detectionClassesDefaultMap, isFaceClassname, isObjectClassname, isPlateClassname, levenshteinDistance } from "./detectionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { idPrefix, publishAudioPressureValue, publishBasicDetectionData, publishCameraValues, publishClassnameImages, publishOccupancy, publishResetDetectionsEntities, publishResetRuleEntities, publishRuleData, publishRuleEnabled, setupCameraAutodiscovery, subscribeToCameraMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { AudioRule, BaseRule, DelayType, DetectionRule, DeviceInterface, GetImageReason, ImageSource, IsDelayPassedProps, MatchRule, MixinBaseSettingKey, NVR_PLUGIN_ID, ObserveZoneData, OccupancyRule, RuleSource, RuleType, SNAPSHOT_WIDTH, ScryptedEventSource, TimelapseRule, VIDEO_ANALYSIS_PLUGIN_ID, ZoneMatchType, b64ToMo, convertSettingsToStorageSettings, filterAndSortValidDetections, getActiveRules, getAllDevices, getAudioRulesSettings, getB64ImageLog, getDecibelsFromRtp_PCMU8, getDetectionRulesSettings, getMixinBaseSettings, getOccupancyRulesSettings, getRuleKeys, getTimelapseRulesSettings, getWebHookUrls, moToB64, splitRules } from "./utils";

const { systemManager } = sdk;

interface CurrentOccupancyState {
    occupancyToConfirm?: boolean,
    confirmationStart?: number,
    lastChange: number,
    lastCheck: number,
    score: number,
    b64Image: string;
    confirmedFrames: number;
    rejectedFrames: number;
}

const initOccupancyState: CurrentOccupancyState = {
    lastChange: undefined,
    confirmationStart: undefined,
    occupancyToConfirm: undefined,
    confirmedFrames: 0,
    rejectedFrames: 0,
    lastCheck: undefined,
    score: undefined,
    b64Image: undefined,
}

export type OccupancyRuleData = {
    rule: OccupancyRule;
    occupies: boolean;
    changed?: boolean;
    image?: MediaObject;
    b64Image?: string;
    triggerTime: number;
    objectsDetected?: number;
};

interface AccumulatedDetection { detect: ObjectsDetected, eventId: string };

type CameraSettingKey =
    | 'ignoreCameraDetections'
    | 'notificationsEnabled'
    | 'aiEnabled'
    | 'schedulerEnabled'
    | 'startTime'
    | 'endTime'
    | 'notifierActions'
    | 'minSnapshotDelay'
    | 'minMqttPublishDelay'
    | 'motionDuration'
    | 'checkOccupancy'
    | 'checkSoundPressure'
    | 'useFramesGenerator'
    | 'lastSnapshotWebhook'
    | 'lastSnapshotWebhookCloudUrl'
    | 'lastSnapshotWebhookLocalUrl'
    | 'postDetectionImageWebhook'
    | 'postDetectionImageUrls'
    | 'postDetectionImageClasses'
    | 'postDetectionImageMinDelay'
    | MixinBaseSettingKey;

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<CameraSettingKey> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            description: 'If checked, the detections reported by the camera will be ignored. Make sure to have an object detector mixin enabled',
            type: 'boolean',
            immediate: true,
        },
        notificationsEnabled: {
            title: 'Notifications enabled',
            description: 'Enable notifications related to this camera',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
            defaultValue: true,
        },
        aiEnabled: {
            title: 'AI descriptions',
            description: 'Use configured AI to generate descriptions',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
            defaultValue: false,
        },
        schedulerEnabled: {
            type: 'boolean',
            subgroup: 'Notifier',
            title: 'Scheduler',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        startTime: {
            title: 'Start time',
            subgroup: 'Notifier',
            type: 'time',
            immediate: true,
        },
        endTime: {
            title: 'End time',
            subgroup: 'Notifier',
            type: 'time',
            immediate: true,
        },
        notifierActions: {
            title: 'Default actions',
            description: 'Actions to show on every notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door", "url": "url"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true,
            defaultValue: [],
        },
        minSnapshotDelay: {
            title: 'Minimum snapshot acquisition delay',
            description: 'Minimum amount of seconds to wait until a new snapshot is taken from the camera',
            type: 'number',
            defaultValue: 5
        },
        minMqttPublishDelay: {
            title: 'Minimum MQTT publish delay',
            description: 'Minimum amount of seconds to wait a new image is published to MQTT for the basic detections',
            type: 'number',
            defaultValue: 5
        },
        motionDuration: {
            title: 'Off motion duration',
            type: 'number',
            defaultValue: 10
        },
        checkOccupancy: {
            title: 'Check objects occupancy regularly',
            description: 'Regularly check objects presence and report it to MQTT, performance intensive',
            type: 'boolean',
            immediate: true,
        },
        checkSoundPressure: {
            title: 'Audio pressure (dB) detection',
            description: 'Constinuously check the audio dBs detected and report it to MQTT',
            type: 'boolean',
            immediate: true,
        },
        useFramesGenerator: {
            title: 'Snapshot from Decoder',
            description: '[ATTENTION] Performance intensive and high cpu prone, ONLY use if you see many timeout errors on snapshot for cameras with frequent motion',
            type: 'boolean',
            immediate: true,
            // hide: true,
            // value: false
        },
        // WEBHOOKS
        lastSnapshotWebhook: {
            subgroup: 'Webhooks',
            title: 'Last snapshot',
            description: 'Check README for possible IMAGE_NAME to use',
            type: 'boolean',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        lastSnapshotWebhookCloudUrl: {
            subgroup: 'Webhooks',
            type: 'html',
            title: 'Cloud URL',
            readonly: true,
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'html',
            title: 'Local URL',
            readonly: true,
        },
        postDetectionImageWebhook: {
            subgroup: 'Webhooks',
            title: 'Post detection image',
            description: 'Execute a POST call to multiple URLs with the selected detection classes',
            type: 'boolean',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        postDetectionImageUrls: {
            subgroup: 'Webhooks',
            title: 'URLs',
            type: 'string',
            multiple: true,
            defaultValue: [],
        },
        postDetectionImageClasses: {
            subgroup: 'Webhooks',
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            type: 'string',
            choices: defaultDetectionClasses,
            defaultValue: []
        },
        postDetectionImageMinDelay: {
            subgroup: 'Webhooks',
            title: 'Minimum posting delay',
            type: 'number',
            defaultValue: 15,
        }
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    mqttClient: MqttClient;
    cameraDevice: DeviceInterface;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    binaryListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForMqttReporting: boolean;
    isActiveForNvrNotifications: boolean;
    isActiveForAudioDetections: boolean;
    isActiveForDoorbelDetections: boolean;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    lastRuleNotifiedMap: Record<string, number> = {};
    lastRulePublishedMap: Record<string, number> = {};
    lastImageUpdateOnFs: Record<string, number> = {};
    logger: Console;
    killed: boolean;
    framesGeneratorSignal = new Deferred<void>().resolve();
    frameGenerationStartTime: number;
    runningOccupancyRules: OccupancyRule[] = [];
    runningDetectionRules: DetectionRule[] = [];
    runningTimelapseRules: TimelapseRule[] = [];
    runningAudioRules: AudioRule[] = [];
    availableTimelapseRules: TimelapseRule[] = [];
    allAvailableRules: BaseRule[] = [];
    audioListeners: Record<string, {
        inProgress: boolean;
        lastDetection?: number;
        lastNotification?: number;
        resetInterval?: NodeJS.Timeout;
    }> = {};
    detectionRuleListeners: Record<string, {
        disableNvrRecordingTimeout?: NodeJS.Timeout;
        turnOffTimeout?: NodeJS.Timeout;
    }> = {};
    lastBasicDetectionsPublishedMap: Partial<Record<DetectionClass, number>> = {};
    lastObserveZonesFetched: number;
    observeZoneData: ObserveZoneData[];
    occupancyState: Record<string, CurrentOccupancyState> = {};
    timelapseLastCheck: Record<string, number> = {};
    audioForwarder: ReturnType<typeof startRtpForwarderProcess>;
    lastAudioDetected: number;
    lastAudioConnection: number;
    lastImage?: MediaObject;
    lastFrame?: MediaObject;
    lastFrameAcquired?: number;
    lastB64Image?: string;
    lastPictureTaken?: number;
    lastOccupancyRegularCheck?: number;
    lastOccupancyRuleNotified: Record<string, number> = {};
    lastWebhookImagePosted: Partial<Record<DetectionClass, number>> = {};

    accumulatedDetections: AccumulatedDetection[] = [];
    accumulatedRules: MatchRule[] = [];
    processDetectionsInterval: NodeJS.Timeout;
    processingAccumulatedDetections = false;
    clientId: string;

    snoozeUntilDic: Record<string, number> = {};
    consumedDetectionIdsSet: Set<string> = new Set();

    lastMotionEnd: number;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.clientId = `scrypted_an_camera_${this.id}`;
        this.plugin.currentCameraMixinsMap[this.id] = this;

        this.cameraDevice = systemManager.getDeviceById<DeviceInterface>(this.id);

        this.initValues().then().catch(logger.log);

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    ensureMixinsOrder() {
        const logger = this.getLogger();
        const nvrObjectDetector = systemManager.getDeviceById('@scrypted/nvr', 'detection')?.id;
        const basicObjectDetector = systemManager.getDeviceById('@apocaliss92/scrypted-basic-object-detector')?.id;
        const nvrId = systemManager.getDeviceById('@scrypted/nvr')?.id;
        const advancedNotifierId = systemManager.getDeviceById(pluginName)?.id;
        let shouldBeMoved = false;
        const thisMixinOrder = this.mixins.indexOf(this.plugin.id);

        if (nvrObjectDetector && this.mixins.indexOf(nvrObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (basicObjectDetector && this.mixins.indexOf(basicObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (nvrId && this.mixins.indexOf(nvrId) > thisMixinOrder) {
            shouldBeMoved = true
        }

        if (shouldBeMoved) {
            logger.log('This plugin needs object detection and NVR plugins to come before, fixing');
            setTimeout(() => {
                const currentMixins = this.mixins.filter(mixin => mixin !== advancedNotifierId);
                currentMixins.push(advancedNotifierId);
                const realDevice = systemManager.getDeviceById(this.id);
                realDevice.setMixins(currentMixins);
            }, 1000);
        }
    }

    async getMqttClient() {
        if (!this.mqttClient && !this.initializingMqtt) {
            const { mqttEnabled, useMqttPluginCredentials, pluginEnabled, mqttHost, mqttUsename, mqttPassword } = this.plugin.storageSettings.values;
            if (mqttEnabled && pluginEnabled) {
                this.initializingMqtt = true;
                const logger = this.getLogger();

                try {
                    this.mqttClient = await getMqttBasicClient({
                        logger,
                        useMqttPluginCredentials,
                        mqttHost,
                        mqttUsename,
                        mqttPassword,
                        clientId: this.clientId,
                        configTopicPattern: `homeassistant/+/${idPrefix}-${this.id}/+/config`
                    });
                    await this.mqttClient?.getMqttClient();
                } catch (e) {
                    logger.error('Error setting up MQTT client', e);
                } finally {
                    this.initializingMqtt = false;
                }
            }
        }

        return this.mqttClient;
    }

    public async startStop(enabled: boolean) {
        const logger = this.getLogger();

        if (enabled) {
            await this.startCheckInterval();
            this.ensureMixinsOrder();
        } else {
            await this.release();
        }
    }

    async enableRecording(device: Settings, enabled: boolean) {
        await device.putSetting(`recording:privacyMode`, !enabled)
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
                await this.getMqttClient();

                const {
                    allAllowedRules,
                    allAvailableRules,
                    allowedAudioRules,
                    allowedDetectionRules,
                    allowedOccupancyRules,
                    allowedTimelapseRules,
                    availableTimelapseRules,
                    shouldListenDetections,
                    shouldListenAudio,
                    isActiveForMqttReporting,
                    anyAllowedNvrDetectionRule,
                    shouldListenDoorbell,
                } = await getActiveRules({
                    device: this.cameraDevice,
                    console: logger,
                    plugin: this.plugin,
                    deviceStorage: this.storageSettings
                });

                const currentlyRunningRules = [
                    ...this.runningDetectionRules,
                    ...this.runningAudioRules,
                    ...this.runningOccupancyRules,
                    ...this.runningTimelapseRules,
                ];

                const [rulesToEnable, rulesToDisable] = splitRules({
                    allRules: allAvailableRules,
                    currentlyRunningRules: currentlyRunningRules,
                    rulesToActivate: allAllowedRules,
                    device: this.cameraDevice
                });

                const now = Date.now();
                logger.debug(`Detected rules: ${JSON.stringify({
                    rulesToEnable,
                    rulesToDisable,
                    allAvailableRules,
                    currentlyRunningRules,
                    allAllowedRules,
                })}`);

                for (const rule of rulesToEnable) {
                    const { ruleType, name } = rule;
                    logger.log(`${ruleType} rule started: ${name}`);

                    if (!rule.currentlyActive) {
                        if (ruleType === RuleType.Timelapse) {
                            await this.plugin.timelapseRuleStarted({
                                rule,
                                device: this.cameraDevice,
                                logger,
                            });
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        await this.putMixinSetting(currentlyActiveKey, 'true');
                    }
                }

                for (const rule of rulesToDisable) {
                    const { ruleType, name } = rule;
                    logger.log(`${ruleType} rule stopped: ${name}`);

                    if (rule.currentlyActive) {
                        if (ruleType === RuleType.Timelapse) {
                            const { timelapse: { lastGeneratedKey } } = getRuleKeys({
                                ruleType,
                                ruleName: rule.name,
                            });
                            const lastGenerated = (rule as TimelapseRule).lastGenerated;
                            const isTimePassed = !lastGenerated || (now - lastGenerated) >= (1000 * 60 * 60 * 1);
                            if (isTimePassed) {
                                await this.storageSettings.putSetting(lastGeneratedKey, lastGenerated);

                                this.plugin.timelapseRuleEnded({
                                    rule,
                                    device: this.cameraDevice,
                                    logger,
                                }).catch(logger.log);
                            }
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        await this.putMixinSetting(currentlyActiveKey, 'false');
                    }
                }

                this.runningDetectionRules = cloneDeep(allowedDetectionRules || []);
                this.runningOccupancyRules = cloneDeep(allowedOccupancyRules || []);
                this.runningTimelapseRules = cloneDeep(allowedTimelapseRules || []);
                this.runningAudioRules = cloneDeep(allowedAudioRules || []);
                this.availableTimelapseRules = cloneDeep(availableTimelapseRules || []);
                this.allAvailableRules = cloneDeep(allAvailableRules || []);

                this.isActiveForMqttReporting = isActiveForMqttReporting;

                const isDetectionListenerRunning = !!this.detectionListener || !!this.motionListener;

                const { entityId, checkOccupancy, checkSoundPressure, useFramesGenerator, notificationsEnabled } = this.storageSettings.values;

                // logger.log(JSON.stringify({ allDetectionRules, detectionRules }))
                if (isActiveForMqttReporting) {
                    const mqttClient = await this.getMqttClient();
                    if (mqttClient) {
                        // Every 60 minutes repeat the autodiscovery
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                            logger.log('Starting MQTT autodiscovery');
                            setupCameraAutodiscovery({
                                mqttClient,
                                device: this.cameraDevice,
                                console: logger,
                                rules: allAvailableRules,
                                occupancyEnabled: checkOccupancy,
                                withAudio: checkSoundPressure,
                            }).then(async (activeTopics) => {
                                await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                            }).catch(logger.error);

                            logger.debug(`Subscribing to mqtt topics`);
                            subscribeToCameraMqttTopics({
                                mqttClient,
                                rules: allAvailableRules,
                                device: this.cameraDevice,
                                console: logger,
                                activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                    const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                    logger.log(`Setting ${ruleType} rule ${ruleName} to ${active}`);
                                    await this.storageSettings.putSetting(`${enabledKey}`, active);
                                },
                                switchNotificationsEnabledCb: async (active) => {
                                    logger.log(`Setting notifications active to ${active}`);
                                    await this.storageSettings.putSetting(`notificationsEnabled`, active);
                                },
                                switchAudioDetectionCb: async (active) => {
                                    logger.log(`Setting audio detecion to ${active}`);
                                    await this.storageSettings.putSetting(`checkSoundPressure`, active);
                                },
                                switchOccupancyCheckCb: async (active) => {
                                    logger.log(`Setting occupancy check to ${active}`);
                                    await this.storageSettings.putSetting(`checkOccupancy`, active);
                                },
                                switchDecoderSnapshotsCb: async (active) => {
                                    logger.log(`Setting decoder snapshots to ${active}`);
                                    await this.storageSettings.putSetting(`useFramesGenerator`, active);
                                },
                                switchRecordingCb: this.cameraDevice.interfaces.includes(ScryptedInterface.VideoRecorder) ?
                                    async (active) => {
                                        logger.log(`Setting NVR privacy mode to ${!active}`);
                                        await this.enableRecording(this.cameraDevice, active);
                                    } :
                                    undefined,
                                rebootCb: this.cameraDevice.interfaces.includes(ScryptedInterface.Reboot) ?
                                    async () => {
                                        logger.log(`Rebooting camera`);
                                        await this.cameraDevice.reboot();
                                    } :
                                    undefined,
                                ptzCommandCb: this.cameraDevice.interfaces.includes(ScryptedInterface.PanTiltZoom) ?
                                    (async (ptzCommand: PanTiltZoomCommand) => {
                                        logger.log(`Executing ptz command: ${JSON.stringify(ptzCommand)}`);

                                        if (ptzCommand.preset) {
                                            const presetId = Object.entries(this.cameraDevice.ptzCapabilities?.presets ?? {}).find(([id, name]) => name === ptzCommand.preset)?.[0];
                                            if (presetId) {
                                                await this.cameraDevice.ptzCommand({ preset: presetId });
                                            }
                                        } else {
                                            await this.cameraDevice.ptzCommand(ptzCommand);
                                        }
                                    }) :
                                    undefined
                            }).catch(logger.error);

                            this.lastAutoDiscovery = now;
                        }

                        const settings = await this.mixinDevice.getSettings();
                        const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;

                        publishCameraValues({
                            console: logger,
                            device: this.cameraDevice,
                            mqttClient,
                            notificationsEnabled,
                            isRecording,
                            rulesToEnable,
                            rulesToDisable,
                            checkSoundPressure,
                            useFramesGenerator,
                            checkOccupancy
                        }).catch(logger.error);
                    }
                }

                if (isDetectionListenerRunning && !shouldListenDetections) {
                    logger.log('Stopping and cleaning Object listeners.');
                    this.resetListeners();
                } else if (!isDetectionListenerRunning && shouldListenDetections) {
                    logger.log(`Starting ${ScryptedInterface.ObjectDetector}/${ScryptedInterface.MotionSensor} listeners: ${JSON.stringify({
                        Detections: shouldListenDetections,
                        MQTT: isActiveForMqttReporting,
                        Doorbell: shouldListenDoorbell,
                        NotificationRules: allAllowedRules.length ? allAllowedRules.map(rule => rule.name).join(', ') : 'None',
                    })}`);
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

                if (anyAllowedNvrDetectionRule && !this.isActiveForNvrNotifications) {
                    logger.log(`Starting NVR events listener`);
                } else if (!anyAllowedNvrDetectionRule && this.isActiveForNvrNotifications) {
                    logger.log(`Stopping NVR events listener`);
                }
                this.isActiveForNvrNotifications = anyAllowedNvrDetectionRule;

                const shouldCheckAudio = shouldListenAudio || checkSoundPressure;
                if (shouldCheckAudio && !this.isActiveForAudioDetections) {
                    logger.log(`Starting Audio listener`);
                    await this.startAudioDetection();
                } else if (!shouldCheckAudio && this.isActiveForAudioDetections) {
                    logger.log(`Stopping Audio listener`);
                    await this.stopAudioListener();
                }
                // Restart audio stream every minute
                if (this.isActiveForAudioDetections && this.lastAudioConnection && (now - this.lastAudioConnection) >= 1000 * 60 * 1) {
                    logger.log(`Restarting Audio listener`);
                    await this.stopAudioListener();
                    await this.startAudioDetection();
                }
                this.isActiveForAudioDetections = shouldCheckAudio;


                const { haEnabled } = this.plugin.storageSettings.values;

                if (haEnabled && entityId && !this.plugin.fetchedEntities.includes(entityId)) {
                    logger.debug(`Entity id ${entityId} does not exists on HA`);
                }

                if (!this.processDetectionsInterval) {
                    logger.log('Starting processing of accumulated detections');
                    this.startAccumulatedDetectionsInterval();
                }

                await this.checkOutdatedRules();
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.log('Error in mainLoopListener', e);
            }
        }, 1000 * 2);
    }

    async startFramesGenerator() {
        const logger = this.getLogger();

        if (!this.framesGeneratorSignal || this.framesGeneratorSignal.finished) {
            logger.log(`Starting frames generator`);
            this.frameGenerationStartTime = Date.now();
            this.framesGeneratorSignal = new Deferred();

            for await (const frame of
                await sdk.connectRPCObject(
                    await this.createFrameGenerator())) {
                if (this.framesGeneratorSignal.finished) {
                    logger.log('Release decoder');
                    break;
                }

                const now = Date.now();

                const bufferFrame = await frame.image.toBuffer({
                    format: 'jpg',
                    // resize: {
                    //     width: SNAPSHOT_WIDTH,
                    // },
                });
                const moFrame = await sdk.mediaManager.createMediaObject(bufferFrame, 'image/jpeg');

                const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(moFrame, ScryptedMimeTypes.Image);
                this.lastFrame = await convertedImage.toImage({
                    format: 'jpg',
                    resize: {
                        width: SNAPSHOT_WIDTH,
                    },
                });
                this.lastFrameAcquired = now;

                // await sleep(200);
            }
        } else {
            logger.info('Streams generator not yet released');
        }
    }

    stopFramesGenerator() {
        const logger = this.getLogger();
        logger.log(`Stopping frames generator`);
        this.frameGenerationStartTime = undefined;
        this.framesGeneratorSignal.resolve();
    }

    startAccumulatedDetectionsInterval() {
        const logger = this.getLogger();
        this.processDetectionsInterval = setInterval(async () => {
            try {
                if (!this.killed && !this.processingAccumulatedDetections) {
                    try {
                        this.processingAccumulatedDetections = true;
                        await this.processAccumulatedDetections();
                    } catch (e) {
                        logger.log(`Error in startAccumulatedDetectionsInterval`, e);
                    } finally {
                        this.processingAccumulatedDetections = false;
                    }
                }
            } catch (e) {
                logger.log('Error in processDetectionsInterval', e);
            }
        }, 500);
    }

    resetAudioRule(ruleName: string, lastNotification?: number) {
        const resetInterval = this.audioListeners[ruleName]?.resetInterval;
        resetInterval && clearInterval(resetInterval);
        this.audioListeners[ruleName] = { inProgress: false, resetInterval: undefined, lastDetection: undefined, lastNotification };
    }

    stopAccumulatedDetectionsInterval() {
        this.processDetectionsInterval && clearInterval(this.processDetectionsInterval);
        this.processDetectionsInterval = undefined;
    }

    async stopAudioListener() {
        this.audioForwarder?.then(f => f.kill());
        this.audioForwarder = undefined;

        for (const ruleName of Object.keys(this.audioListeners)) {
            this.resetAudioRule(ruleName);
        }

        this.lastAudioConnection = undefined;
    }

    async stopDoorbellListener() {
        this.binaryListener?.removeListener && this.binaryListener.removeListener();
        this.binaryListener = undefined;
    }

    resetListeners() {
        if (this.detectionListener || this.motionListener || this.audioForwarder || this.binaryListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
        this.motionListener?.removeListener && this.motionListener.removeListener();
        this.motionListener = undefined;
        this.stopDoorbellListener();
        this.resetMqttMotionTimeout();

        Object.keys(this.detectionRuleListeners).forEach(ruleName => {
            const { disableNvrRecordingTimeout, turnOffTimeout } = this.detectionRuleListeners[ruleName];
            disableNvrRecordingTimeout && clearTimeout(disableNvrRecordingTimeout);
            turnOffTimeout && clearTimeout(turnOffTimeout);
        })
    }

    async initValues() {
        const logger = this.getLogger();
        try {
            if (this.plugin.hasCloudPlugin) {
                const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebHookUrls({
                    cameraIdOrAction: this.id,
                    console: logger,
                    device: this.cameraDevice,
                });

                await this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
                await this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
            }
        } catch { };

        await this.refreshSettings();
        await this.refreshSettings();
    }

    snoozeNotification(props: {
        snoozeId: string;
        snoozeTime: number;
    }) {
        const { snoozeId, snoozeTime } = props;
        const logger = this.getLogger();

        const res = `Snoozing ${snoozeId} for ${snoozeTime} minutes`;
        logger.log(res);

        const snoozedUntil = moment().add(snoozeTime, 'minutes').toDate().getTime();
        this.snoozeUntilDic[snoozeId] = snoozedUntil;

        return res;
    }

    async toggleRule(ruleName: string, ruleType: RuleType, enabled: boolean) {
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();
        const rule = this.allAvailableRules.find(rule => rule.ruleType === ruleType && rule.name === ruleName);

        logger.log(`Setting ${ruleType} rule ${ruleName} enabled to ${enabled}`);

        if (rule) {
            await publishRuleEnabled({
                console: logger,
                rule,
                device: this.cameraDevice,
                enabled,
                mqttClient
            });
        }
    };

    async refreshSettings() {
        const logger = this.getLogger();
        const dynamicSettings: StorageSetting[] = [];
        const zones = (await this.getObserveZones()).map(item => item.name);
        const people = (await this.plugin.getKnownPeople());

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            zones,
            people,
            device: this,
            logger,
            ruleSource: RuleSource.Device,
            refreshSettings: this.refreshSettings.bind(this),
        });
        dynamicSettings.push(...detectionRulesSettings);

        const occupancyRulesSettings = await getOccupancyRulesSettings({
            storage: this.storageSettings,
            zones,
            ruleSource: RuleSource.Device,
            logger,
            refreshSettings: this.refreshSettings.bind(this),
        });
        dynamicSettings.push(...occupancyRulesSettings);

        const timelapseRulesSettings = await getTimelapseRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            refreshSettings: this.refreshSettings.bind(this),
            onCleanDataTimelapse: async (ruleName) => {
                const rule = this.availableTimelapseRules?.find(rule => rule.name === ruleName);

                if (rule) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);
                    this.plugin.clearFramesData({
                        rule,
                        device,
                        logger,
                    }).catch(logger.log);
                }
            },
            onGenerateTimelapse: async (ruleName) => {
                const logger = this.getLogger();
                const rule = this.availableTimelapseRules?.find(rule => rule.name === ruleName);

                if (rule) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);
                    this.plugin.timelapseRuleEnded({
                        rule,
                        device,
                        logger,
                    }).catch(logger.log);
                }
            },
        });
        dynamicSettings.push(...timelapseRulesSettings);

        const audioRulesSettings = await getAudioRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            refreshSettings: this.refreshSettings.bind(this),
        });
        dynamicSettings.push(...audioRulesSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        const { lastSnapshotWebhook, postDetectionImageWebhook, enabledToMqtt, schedulerEnabled } = this.storageSettings.values

        if (this.storageSettings.settings.lastSnapshotWebhookCloudUrl) {
            this.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide = !lastSnapshotWebhook;
        }
        if (this.storageSettings.settings.lastSnapshotWebhookLocalUrl) {
            this.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide = !lastSnapshotWebhook;
        }

        if (this.storageSettings.settings.postDetectionImageUrls) {
            this.storageSettings.settings.postDetectionImageUrls.hide = !postDetectionImageWebhook;
        }
        if (this.storageSettings.settings.postDetectionImageClasses) {
            this.storageSettings.settings.postDetectionImageClasses.hide = !postDetectionImageWebhook;
        }
        if (this.storageSettings.settings.postDetectionImageMinDelay) {
            this.storageSettings.settings.postDetectionImageMinDelay.hide = !postDetectionImageWebhook;
        }

        if (this.storageSettings.settings.minMqttPublishDelay) {
            this.storageSettings.settings.minMqttPublishDelay.hide = !enabledToMqtt;
        }
        if (this.storageSettings.settings.checkOccupancy) {
            this.storageSettings.settings.checkOccupancy.hide = !enabledToMqtt;
        }
        if (this.storageSettings.settings.checkSoundPressure) {
            this.storageSettings.settings.checkSoundPressure.hide = !enabledToMqtt;
        }

        if (this.storageSettings.settings.startTime) {
            this.storageSettings.settings.startTime.hide = !schedulerEnabled;
        }
        if (this.storageSettings.settings.endTime) {
            this.storageSettings.settings.endTime.hide = !schedulerEnabled;
        }

        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.fetchedEntities;
            return {
                choices: entities ?? []
            }
        }
    }

    async getObserveZones() {
        try {
            const now = new Date().getTime();
            const isUpdated = this.lastObserveZonesFetched && (now - this.lastObserveZonesFetched) <= (1000 * 60);
            if (this.observeZoneData && isUpdated) {
                return this.observeZoneData;
            }

            const res: ObserveZoneData[] = [];
            const settings = await this.mixinDevice.getSettings();
            const zonesSetting = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:zones').test(setting.key))?.value ?? [];

            const zoneNames = zonesSetting?.filter(zone => {
                return settings.find((setting: { key: string; }) => new RegExp(`objectdetectionplugin:.*:zoneinfo-filterMode-${zone}`).test(setting.key))?.value === 'observe';
            });

            zoneNames.forEach(zoneName => {
                const zonePath = JSON.parse(settings.find((setting) => setting.subgroup === `Zone: ${zoneName}` && setting.type === 'clippath')?.value ?? '[]');

                res.push({
                    name: zoneName,
                    path: zonePath
                })
            });

            this.observeZoneData = res;
            this.lastObserveZonesFetched = now;
            return this.observeZoneData;
        } catch (e) {
            this.getLogger().log('Error in getObserveZones', e.message);
            return [];
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            return this.storageSettings.getSettings();
        } catch (e) {
            this.getLogger().log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [group, ...rest] = key.split(':');
        if (group === this.settingsGroupKey) {
            this.storageSettings.putSetting(rest.join(':'), value);
        } else {
            super.putSetting(key, value);
        }
    }

    async putMixinSetting(key: string, value: string) {
        this.storageSettings.putSetting(key, value);
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing mixin');
        this.killed = true;
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;

        this.mqttClient && this.mqttClient.disconnect();
        this.resetListeners();
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = getBaseLogger({
                deviceConsole: this.console,
                storage: this.storageSettings,
                friendlyName: this.clientId
            });

            if (forceNew) {
                return newLogger;
            } else {
                this.logger = newLogger;
            }
        }

        return this.logger;
    }

    async triggerRule(props: {
        matchRule: MatchRule,
        eventSource: ScryptedEventSource,
        device: DeviceInterface,
        b64Image?: string,
        triggerTime: number,
        skipMqttImage?: boolean,
        skipTrigger?: boolean,
    }) {
        const logger = this.getLogger();

        try {
            const { matchRule, eventSource, b64Image, device, triggerTime, skipMqttImage, skipTrigger } = props;
            const { rule, match } = matchRule;

            const timePassedForImageUpdate = !skipMqttImage && this.isDelayPassed({
                type: DelayType.RuleImageUpdate,
                matchRule,
                eventSource
            });

            if (this.isActiveForMqttReporting && timePassedForImageUpdate) {
                const mqttClient = await this.getMqttClient();
                if (mqttClient) {
                    try {
                        publishRuleData({
                            mqttClient,
                            device,
                            triggerValue: !skipTrigger ? true : undefined,
                            console: logger,
                            b64Image,
                            rule,
                            triggerTime,
                            skipMqttImage,
                        }).catch(logger.error);
                    } catch (e) {
                        logger.log(`Error in publishRuleData`, e);
                    }
                }
            }

            this.storeImagesOnFs({
                b64Image,
                classnamesData: match ? [match] : undefined,
                device: this.cameraDevice,
                triggerTime,
                prefix: `rule-${rule.name}`,
                eventSource,
            }).catch(logger.info);

            if (rule.ruleType === RuleType.Detection && !skipTrigger) {
                const { disableNvrRecordingSeconds, name } = rule as DetectionRule;
                if (disableNvrRecordingSeconds !== undefined) {
                    const seconds = Number(disableNvrRecordingSeconds);

                    logger.log(`Enabling NVR recordings for ${seconds} seconds`);
                    await this.enableRecording(device, true);

                    if (!this.detectionRuleListeners[name]) {
                        this.detectionRuleListeners[name] = {};
                    }

                    const { disableNvrRecordingTimeout } = this.detectionRuleListeners[name];

                    if (disableNvrRecordingTimeout) {
                        clearTimeout(disableNvrRecordingTimeout);
                        this.detectionRuleListeners[name].disableNvrRecordingTimeout = undefined;
                    }

                    this.detectionRuleListeners[name].disableNvrRecordingTimeout = setTimeout(async () => {
                        logger.log(`Disabling NVR recordings`);
                        await this.enableRecording(device, false);
                    }, seconds * 1000);
                }

                this.resetRuleEntities(rule).catch(logger.log);
            }

        } catch (e) {
            logger.log('error in triggerRule', e);
        }
    }

    getObjectDetector() {
        return systemManager.getDeviceById(this.id) as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
    }

    getDetectionKey(matchRule: MatchRule) {
        const { match, rule } = matchRule;
        let key = `rule-${rule.name}`;
        if (rule.ruleType === RuleType.Timelapse) {
            return key;
        } else {
            const { label, className } = match;
            const classname = detectionClassesDefaultMap[className];
            key = `${key}-${classname}`;
            if (label) {
                key += `-${label}`;
            }

            return key;
        }
    }

    public async getImage(props?: {
        detectionId?: string,
        eventId?: string,
        image?: MediaObject,
        reason: GetImageReason
    }) {
        const { reason, detectionId, eventId, image: imageParent } = props ?? {};
        const logger = this.getLogger();
        const now = Date.now();
        const { minSnapshotDelay: minSnapshotDelayParent, useFramesGenerator } = this.storageSettings.values;

        let image: MediaObject = imageParent;
        let b64Image: string;
        let imageUrl: string;
        let imageSource: ImageSource;

        const msPassedFromSnapshot = this.lastPictureTaken !== undefined ? now - this.lastPictureTaken : 0;
        const msPassedFromDecoder = this.lastFrameAcquired !== undefined ? now - this.lastFrameAcquired : 0;

        const preferLatest = [
            GetImageReason.RulesRefresh,
            GetImageReason.AudioTrigger,
            GetImageReason.MotionUpdate,
        ].includes(reason);
        const forceSnapshot = [
            GetImageReason.Sensor,
            GetImageReason.Notification,
        ].includes(reason);
        const tryDetector = !!detectionId && !!eventId;
        const snapshotTimeout = reason === GetImageReason.RulesRefresh ? 5000 : 2000;
        const decoderRunning = useFramesGenerator && !this.framesGeneratorSignal.finished;
        const minSnapshotDelay = reason === GetImageReason.MotionUpdate ? 10 : minSnapshotDelayParent;

        let logPayload: any = {
            decoderRunning,
            msPassedFromDecoder,
            msPassedFromSnapshot,
            reason,
            preferLatest,
            forceSnapshot,
            tryDetector,
            snapshotTimeout
        };

        const findFromDetector = () => async () => {
            try {
                const detectImage = await this.cameraDevice.getDetectionInput(detectionId, eventId);
                const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(detectImage, ScryptedMimeTypes.Image);
                image = await convertedImage.toImage({
                    resize: {
                        width: SNAPSHOT_WIDTH,
                    },
                });
                imageSource = ImageSource.Detector;
            } catch (e) {
                logger.log(`Error finding the image from the detector (${e.message}) for reason ${reason}`);
            }
        }

        const findFromSnapshot = (force: boolean, timeout: number) => async () => {
            const timePassed = !this.lastPictureTaken || msPassedFromSnapshot >= 1000 * minSnapshotDelay;

            if (timePassed || force) {
                try {
                    // this.lastImage = undefined;
                    const objectDetector = this.getObjectDetector();
                    image = await objectDetector.takePicture({
                        reason: 'event',
                        timeout,
                        picture: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                    this.lastPictureTaken = now;
                    imageSource = ImageSource.Snapshot;
                } catch (e) {
                    logger.log(`Error taking a snapshot (${e.message}) for reason ${reason}`);
                    this.lastPictureTaken = undefined;
                }
            } else {
                logger.info(`Skipping snapshot image`, JSON.stringify({
                    timePassed, force
                }));
            }
        }

        const findFromDecoder = () => async () => {
            const isRecent = !this.lastFrameAcquired || (msPassedFromDecoder) <= 500;

            if (decoderRunning && this.lastFrame && isRecent) {
                image = this.lastFrame;
                imageSource = ImageSource.Decoder;
            } else {
                logger.info(`Skipping decoder image`, JSON.stringify({
                    isRecent, useFramesGenerator, running: !this.framesGeneratorSignal.finished, hasFrame: !!this.lastFrame
                }));
            }
        };

        const findFromLatest = (ms: number) => async () => {
            const isRecent = msPassedFromSnapshot && msPassedFromSnapshot <= ms;

            if (isRecent) {
                image = this.lastImage;
                b64Image = this.lastB64Image;
                imageSource = ImageSource.Latest;
            } else {
                logger.info(`Skipping latest image`, JSON.stringify({
                    isRecent,
                    ms
                }));
            }
        };

        try {
            if (!image) {
                let runners = [];
                const checkLatest = findFromLatest(reason === GetImageReason.MotionUpdate ? 3000 : 2000);
                const checkVeryRecent = findFromLatest(200);
                const checkSnapshot = findFromSnapshot(forceSnapshot, snapshotTimeout);
                const checkDetector = findFromDetector();
                const checkDecoder = findFromDecoder();

                if (reason === GetImageReason.AccumulatedDetections) {
                    runners = [checkDetector];
                } else if (preferLatest) {
                    runners = [
                        checkVeryRecent,
                        checkLatest,
                        checkDecoder,
                        checkSnapshot,
                    ];
                } else if (tryDetector) {
                    runners = [
                        checkDetector,
                        checkDecoder,
                        checkVeryRecent,
                        checkSnapshot,
                    ];
                } else {
                    runners = [
                        checkDecoder,
                        checkVeryRecent,
                        checkSnapshot,
                    ];
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
                b64Image = await moToB64(image)
            } else {
                imageSource = ImageSource.NotFound;
            }
        } catch (e) {
            logger.log(`Error during getImage`, e);
        } finally {
            logPayload = {
                ...logPayload,
                imageSource,
                imageFound: !!image
            };
            if (reason !== GetImageReason.MotionUpdate) {
                logger.info(`Image found from ${imageSource} for reason ${reason}`);
            }
            logger.info(logPayload);
            if (!imageParent && image && b64Image) {
                this.lastImage = image;
                this.lastB64Image = b64Image;
            }

            return { image, b64Image, imageUrl, imageSource };
        }
    }

    async startAudioDetection() {
        const logger = this.getLogger(true);
        try {
            const loggerForFfmpeg = {
                ...logger,
                warn: logger.info,
                error: logger.info,
                log: logger.info,
            };
            if (this.audioForwarder) {
                this.stopAudioListener();
            }

            const mo = await this.cameraDevice.getVideoStream({
                video: null,
                audio: {},
            });
            const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);

            const fp = startRtpForwarderProcess(loggerForFfmpeg, ffmpegInput, {
                video: null,
                audio: {
                    codecCopy: 'pcm_u8',
                    encoderArguments: [
                        '-acodec', 'pcm_u8',
                        '-ac', '1',
                        '-ar', '8000',
                    ],
                    onRtp: rtp => {
                        const now = Date.now();
                        if (this.lastAudioDetected && now - this.lastAudioDetected < 1000)
                            return;
                        this.lastAudioDetected = now;

                        const packet = RtpPacket.deSerialize(rtp);
                        const decibels = getDecibelsFromRtp_PCMU8(packet.payload, logger);
                        this.processAudioDetection({ decibels }).catch(this.getLogger().error);
                    },
                }
            });

            this.audioForwarder = fp;

            fp.catch(() => {
                if (this.audioForwarder === fp)
                    this.audioForwarder = undefined;
            });

            this.audioForwarder.then(f => {
                f.killPromise.then(() => {
                    if (this.audioForwarder === fp)
                        this.audioForwarder = undefined;
                });
            }).catch(e => {
                logger.log(`Error in audio forwarder`, e?.message);
            });
            this.lastAudioConnection = Date.now();
        } catch (e) {
            logger.log('Error in startAudioDetection', e.message);
        }
    }

    async checkOutdatedRules() {
        const now = new Date().getTime();
        const logger = this.getLogger();

        const anyOutdatedOccupancyRule = this.runningOccupancyRules.some(rule => {
            const { forceUpdate, name } = rule;
            const currentState = this.occupancyState[name];
            const shouldForceFrame = !currentState ||
                (now - (currentState?.lastCheck ?? 0)) >= (1000 * (forceUpdate - 1));
            // const shouldForceFrame = !currentState ||
            //     (now - (currentState?.lastCheck ?? 0)) >= (1000 * (forceUpdate - 1)) ||
            //     (currentState.occupancyToConfirm != undefined && !!currentState.confirmationStart);

            if (!this.occupancyState[name]) {
                logger.log(`Initializing occupancy data for rule ${name} to ${JSON.stringify(initOccupancyState)}`);
                this.occupancyState[name] = cloneDeep(initOccupancyState);
            }

            logger.info(`Should force occupancy data update: ${JSON.stringify({
                shouldForceFrame,
                lastCheck: currentState?.lastCheck,
                forceUpdate,
                now,
                name
            })}`);

            return shouldForceFrame;
        }) || this.storageSettings.values.checkOccupancy;

        const timelapsesToRefresh = (this.runningTimelapseRules || []).filter(rule => {
            const { regularSnapshotInterval, name } = rule;
            const lastCheck = this.timelapseLastCheck[name];
            const shouldForceFrame = !lastCheck || (now - (lastCheck ?? 0)) >= (1000 * regularSnapshotInterval);

            logger.info(`Should force timelapse frame: ${JSON.stringify({
                shouldForceFrame,
                lastCheck,
                regularSnapshotInterval,
                now,
                name
            })}`);

            return shouldForceFrame;
        });

        const anyTimelapseToRefresh = !!timelapsesToRefresh.length;

        if (anyOutdatedOccupancyRule || anyTimelapseToRefresh) {
            const { image, b64Image } = await this.getImage({ reason: GetImageReason.RulesRefresh });
            if (image && b64Image) {
                if (anyOutdatedOccupancyRule) {
                    this.checkOccupancyData({ image, b64Image, source: 'MainFlow' }).catch(logger.log);
                }

                if (anyTimelapseToRefresh) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);

                    for (const rule of timelapsesToRefresh) {
                        logger.log(`Adding regular frame to the timelapse rule ${rule.name}`);
                        this.plugin.storeTimelapseFrame({
                            imageMo: image,
                            timestamp: now,
                            device,
                            rule: rule as TimelapseRule
                        }).catch(logger.log);

                        this.timelapseLastCheck[rule.name] = now;
                    }
                }
            }
        }
    }

    async checkOccupancyData(props: {
        image: MediaObject,
        b64Image: string,
        source: 'Detections' | 'MainFlow'
    }) {
        const { image: imageParent, source } = props;
        if (!imageParent) {
            return;
        }
        const now = Date.now();

        // Don't check if there is no motion or it's over since a while
        const isMotionOk = this.cameraDevice.motionDetected ||
            !this.lastMotionEnd ||
            (now - this.lastMotionEnd) > 1000 * 10;

        if (!isMotionOk) {
            return;
        }

        const logger = this.getLogger();

        try {
            const minDelayInSeconds = !!this.runningOccupancyRules.length || this.storageSettings.values.checkOccupancy ? 0.3 : 0;

            if (!minDelayInSeconds) {
                return;
            }

            const timePassed = !this.lastOccupancyRegularCheck || (now - this.lastOccupancyRegularCheck) > (1000 * minDelayInSeconds);

            if (!timePassed) {
                return;
            }

            logger.info(`Checking occupancy for reason ${source}`);

            const mqttClient = await this.getMqttClient();

            const occupancyRulesDataTmpMap: Record<string, OccupancyRuleData> = {};
            const zonesData = await this.getObserveZones();

            const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            if (!objectDetector) {
                logger.log(`No detection plugin selected. skipping occupancy`);
                return;
            }

            const detectedResultParent = await objectDetector.detectObjects(imageParent);

            if (!objectDetector.interfaces.includes(ScryptedInterface.ObjectDetectionGenerator)) {
                detectedResultParent.detections = filterOverlappedDetections(detectedResultParent.detections);
            }

            for (const occupancyRule of this.runningOccupancyRules) {
                let image = imageParent;

                const { name, zoneType, observeZone, scoreThreshold, detectionClass, maxObjects, captureZone } = occupancyRule;

                let detectedResult = detectedResultParent;

                if (captureZone?.length >= 3) {
                    const zone = zonesData.find(zoneData => zoneData.name === observeZone)?.path;
                    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(imageParent, ScryptedMimeTypes.Image);
                    let left = convertedImage.width;
                    let top = convertedImage.height;
                    let right = 0;
                    let bottom = 0;
                    for (const point of zone) {
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

                    if (!Number.isNaN(left) && !Number.isNaN(top) && !Number.isNaN(width) && !Number.isNaN(height)) {
                        image = await convertedImage.toImage({
                            crop: {
                                left,
                                top,
                                width,
                                height,
                            },
                        });
                        detectedResult = await objectDetector.detectObjects(image);
                    }

                    if (!objectDetector.interfaces.includes(ScryptedInterface.ObjectDetectionGenerator)) {
                        detectedResult.detections = filterOverlappedDetections(detectedResult.detections);
                    }

                    // adjust the origin of the bounding boxes for the crop.
                    for (const d of detectedResult.detections) {
                        d.boundingBox[0] += left;
                        d.boundingBox[1] += top;
                    }
                    detectedResult.inputDimensions = [convertedImage.width, convertedImage.height];
                }

                let objectsDetected = 0;
                let maxScore = 0;

                for (const detection of detectedResult.detections) {
                    const className = detectionClassesDefaultMap[detection.className];
                    if (detection.score >= scoreThreshold && detectionClass === className) {
                        if (!maxScore || detection.score > maxScore) {
                            maxScore = detection.score;
                        }
                        const boundingBoxInCoords = normalizeBox(detection.boundingBox, detectedResult.inputDimensions);
                        const zone = zonesData.find(zoneData => zoneData.name === observeZone);
                        if (zone) {
                            let zoneMatches = false;

                            if (zoneType === ZoneMatchType.Intersect) {
                                zoneMatches = polygonIntersectsBoundingBox(zone.path, boundingBoxInCoords);
                            } else {
                                zoneMatches = polygonContainsBoundingBox(zone.path, boundingBoxInCoords);
                            }

                            if (zoneMatches) {
                                objectsDetected += 1;
                            }
                        }
                    }
                }

                const occupies = ((maxObjects || 1) - objectsDetected) <= 0;

                const updatedState: CurrentOccupancyState = {
                    ...this.occupancyState[name] ?? {} as CurrentOccupancyState,
                    score: maxScore
                };

                this.occupancyState[name] = updatedState;

                const existingRule = occupancyRulesDataTmpMap[name];
                if (!existingRule) {
                    occupancyRulesDataTmpMap[name] = {
                        rule: occupancyRule,
                        occupies,
                        triggerTime: now,
                        objectsDetected: objectsDetected,
                        image,
                    }
                } else if (!existingRule.occupies && occupies) {
                    existingRule.occupies = true;
                }
            }

            const occupancyRulesData: OccupancyRuleData[] = [];
            const rulesToNotNotify: string[] = [];
            for (const occupancyRuleTmpData of Object.values(occupancyRulesDataTmpMap)) {
                const { rule, image } = occupancyRuleTmpData;
                const { name, changeStateConfirm } = rule;
                const currentState = this.occupancyState[name];
                const lastChangeElpasedMs = now - (currentState?.lastChange ?? 0);
                const tooOld = !currentState || lastChangeElpasedMs >= (1000 * 60 * 10); // Force an update every 10 minutes
                const toConfirm = currentState.occupancyToConfirm != undefined && !!currentState.confirmationStart;

                const {
                    occupancy: {
                        occupiesKey,
                        detectedObjectsKey
                    }
                } = getRuleKeys({
                    ruleType: RuleType.Occupancy,
                    ruleName: name,
                });

                if (occupancyRuleTmpData.rule.detectedObjects !== occupancyRuleTmpData.objectsDetected) {
                    await this.storageSettings.putSetting(detectedObjectsKey, occupancyRuleTmpData.objectsDetected);
                }

                let occupancyData: Partial<CurrentOccupancyState> = {
                    ...(currentState ?? initOccupancyState),
                    lastCheck: now,
                };

                // If last state change is too old, proceed with update regardless
                if (tooOld) {
                    logger.info(`Force pushing rule ${name}, last change ${lastChangeElpasedMs / 1000} seconds ago`);

                    occupancyData = {
                        ...occupancyData,
                        lastChange: now,
                    };

                    rulesToNotNotify.push(occupancyRuleTmpData.rule.name);
                } else if (toConfirm) {
                    const elpasedTimeMs = now - (currentState?.confirmationStart ?? 0);
                    const isConfirmationTimePassed = elpasedTimeMs >= (1000 * changeStateConfirm);
                    const isStateConfirmed = occupancyRuleTmpData.occupies === currentState.occupancyToConfirm;

                    if (!isConfirmationTimePassed) {
                        if (isStateConfirmed) {
                            // Do nothing and wait for next iteration
                            occupancyData = {
                                ...occupancyData,
                                confirmedFrames: (currentState.confirmedFrames ?? 0) + 1,
                            };
                            logger.log(`Confirmation time is not passed yet for rule ${name}: toConfirm ${currentState.occupancyToConfirm} started ${elpasedTimeMs / 1000} seconds ago`);
                        } else {
                            // TODO: Implement here flow with discarded frames instead of discard right away
                            // Reset confirmation data because the value changed before confirmation time passed
                            logger.log(`Confirmation failed for rule ${name}: toConfirm ${currentState.occupancyToConfirm} after ${elpasedTimeMs / 1000} seconds`);

                            occupancyData = {
                                ...initOccupancyState,
                                lastCheck: now,
                            };
                        }
                    } else {
                        if (isStateConfirmed) {
                            // Time is passed and value didn't change, update the state
                            occupancyData = {
                                ...initOccupancyState,
                                lastChange: now,
                            };

                            const stateActuallyChanged = occupancyRuleTmpData.occupies !== occupancyRuleTmpData.rule.occupies;

                            if (!stateActuallyChanged) {
                                rulesToNotNotify.push(occupancyRuleTmpData.rule.name);
                            } else {
                                logger.log(`Confirming occupancy rule ${name}: ${occupancyRuleTmpData.occupies} ${occupancyRuleTmpData.objectsDetected}`);
                                logger.log(JSON.stringify({
                                    occupancyRuleData: occupancyRuleTmpData,
                                    currentState,
                                    occupancyData,
                                }));
                            }

                            occupancyRulesData.push({
                                ...occupancyRuleTmpData,
                                triggerTime: currentState.confirmationStart,
                                changed: stateActuallyChanged
                            });

                            await this.storageSettings.putSetting(occupiesKey, occupancyRuleTmpData.occupies);

                        } else {
                            // Time is passed and value changed, restart confirmation flow
                            occupancyData = {
                                ...occupancyData,
                                confirmationStart: now,
                                occupancyToConfirm: occupancyRuleTmpData.occupies
                            };

                            logger.log(`Restarting confirmation flow (because time is passed and value changed) for occupancy rule ${name}: toConfirm ${occupancyRuleTmpData.occupies}`);
                        }
                    }
                } else if (occupancyRuleTmpData.occupies !== occupancyRuleTmpData.rule.occupies) {
                    logger.log(`Marking the rule to confirm ${occupancyRuleTmpData.occupies} for next iteration ${name}: ${occupancyRuleTmpData.objectsDetected} objects, score ${currentState.score}`);

                    occupancyData = {
                        ...occupancyData,
                        confirmationStart: now,
                        confirmedFrames: 0,
                        rejectedFrames: 0,
                        score: 0,
                        occupancyToConfirm: occupancyRuleTmpData.occupies,
                        b64Image: await moToB64(image)
                    };
                } else {
                    logger.info(`Refreshing lastCheck only for rule ${name}`);
                }

                const updatedState: CurrentOccupancyState = {
                    ...currentState,
                    ...occupancyData
                };

                this.occupancyState[name] = updatedState;
            }

            if (this.isActiveForMqttReporting && detectedResultParent) {
                logger.info(`Publishing occupancy data from source ${source}. ${JSON.stringify(occupancyRulesData)}`);
                publishOccupancy({
                    console: logger,
                    device: this.cameraDevice,
                    mqttClient,
                    objectsDetected: detectedResultParent,
                    occupancyRulesData,
                }).catch(logger.error);
            }

            for (const occupancyRuleData of occupancyRulesData) {
                const { rule, b64Image, triggerTime } = occupancyRuleData;

                this.storeImagesOnFs({
                    b64Image,
                    device: this.cameraDevice,
                    triggerTime,
                    prefix: `rule-${rule.name}`,
                    eventSource: ScryptedEventSource.RawDetection,
                }).catch(logger.info);

                const timePassed = this.isDelayPassed({
                    type: DelayType.OccupancyNotification,
                    matchRule: { rule },
                    eventSource: ScryptedEventSource.RawDetection
                });
                const image = b64Image ? await b64ToMo(b64Image) : imageParent;

                if (!rulesToNotNotify.includes(rule.name) && timePassed) {
                    const triggerTime = (occupancyRuleData?.triggerTime ?? now) - 10 * 1000;

                    await this.plugin.notifyOccupancyEvent({
                        cameraDevice: this.cameraDevice,
                        rule,
                        triggerTime,
                        image,
                        occupancyData: occupancyRuleData
                    });
                }
            }
        }
        catch (e) {
            logger.log('Error in checkOccupancyData', e);
        }
    }

    public async processAudioDetection(props: {
        decibels: number
    }) {
        const logger = this.getLogger();
        const { decibels } = props;
        logger.debug(`Audio detection: ${decibels} dB`);
        const now = Date.now();

        let image: MediaObject;
        let b64Image: string;
        for (const rule of (this.runningAudioRules ?? [])) {
            const { name, audioDuration, decibelThreshold, customText, minDelay } = rule;
            const { lastDetection, inProgress, lastNotification } = this.audioListeners[name] ?? {};
            const isThresholdMet = decibels >= decibelThreshold;
            const isTimePassed = !lastDetection || (now - lastDetection) > audioDuration;
            const isTimeForNotificationPassed = !minDelay || !lastNotification || (now - lastNotification) > (minDelay * 1000);

            if (isTimeForNotificationPassed && !image) {
                const { image: imageNew, b64Image: b64ImageNew } = await this.getImage({ reason: GetImageReason.AudioTrigger });
                image = imageNew;
                b64Image = b64ImageNew;
            }

            logger.debug(`Audio rule: ${JSON.stringify({
                name,
                isThresholdMet,
                isTimePassed,
                inProgress,
                audioDuration,
                decibelThreshold,
            })}`);
            const currentDuration = lastDetection ? (now - lastDetection) / 1000 : 0;

            const trigger = async () => {
                logger.info(`Audio rule ${name} passed: ${JSON.stringify({ currentDuration, decibels })}`);
                let message = customText;

                message = message.toString()
                    .replace('${decibels}', String(decibelThreshold) ?? '')
                    .replace('${duration}', String(audioDuration) ?? '')

                await this.plugin.notifyAudioEvent({
                    cameraDevice: this.cameraDevice,
                    image,
                    message,
                    rule,
                    triggerTime: now,
                });

                this.audioListeners[name] = {
                    ...this.audioListeners[name],
                    lastNotification: now
                };

                this.triggerRule({
                    matchRule: { rule },
                    b64Image,
                    device: this.cameraDevice,
                    triggerTime: now,
                    eventSource: ScryptedEventSource.RawDetection
                }).catch(logger.log);

                this.resetAudioRule(name, now);
            }

            if (!audioDuration) {
                if (isTimeForNotificationPassed) {
                    await trigger();
                } else {
                    logger.info(`Minimum amount of ${minDelay} seconds not passed yet`);
                }
            } else {
                if (inProgress) {
                    if (isThresholdMet) {
                        if (!isTimeForNotificationPassed) {
                            logger.info(`Minimum amount of ${minDelay} seconds not passed yet`);
                            // Do nothing and wait for next detection
                        } else if (!isTimePassed) {
                            logger.info(`Audio rule ${name} still in progress ${currentDuration} seconds`);
                            // Do nothing and wait for next detection
                        } else {
                            await trigger();
                        }
                    } else {
                        logger.info(`Audio rule ${name} didn't hold the threshold (${decibels} < ${decibelThreshold}), resetting after ${currentDuration} seconds`);
                        this.resetAudioRule(name);
                    }
                } else if (isThresholdMet) {
                    logger.info(`Audio rule ${name} started`);
                    this.audioListeners[name] = {
                        inProgress: true,
                        lastDetection: now,
                        resetInterval: undefined,
                    };
                }
            }
        }

        if (this.isActiveForMqttReporting && this.storageSettings.values.checkSoundPressure) {
            const mqttClient = await this.getMqttClient();

            await publishAudioPressureValue({
                console: logger,
                decibels,
                device: this.cameraDevice,
                mqttClient
            });
        }
    }

    async storeImagesOnFs(props: {
        prefix?: string,
        suffix?: string,
        classnamesData?: ObjectDetectionResult[],
        device: ScryptedDeviceBase,
        triggerTime: number,
        b64Image: string,
        eventSource: ScryptedEventSource,
    }) {
        const { classnamesData, prefix, suffix, device, triggerTime, b64Image, eventSource } = props;

        if (classnamesData) {
            for (const { className, label } of classnamesData) {
                const detectionClass = detectionClassesDefaultMap[className];
                if (detectionClass) {

                    let name = `${prefix}-${className}`;

                    if (label) {
                        name += `-${label}`;
                    }
                    if (suffix) {
                        name += `-${suffix}`;
                    }

                    this.plugin.storeImage({
                        device,
                        name,
                        timestamp: triggerTime,
                        b64Image,
                        classname: className,
                        label,
                        eventSource
                    });
                } else {
                    console.log(`${className} not found`);
                }
            }
        } else if (prefix) {
            this.plugin.storeImage({
                device,
                name: prefix,
                timestamp: triggerTime,
                b64Image,
                eventSource
            });
        }
    }

    async processAccumulatedDetections() {
        if (!this.accumulatedDetections.length && !this.accumulatedRules.length) {
            return;
        }

        const logger = this.getLogger();

        const dataToAnalyze = this.accumulatedDetections.map(det => ({
            triggerTime: det.detect.timestamp,
            detectionId: det.detect.detectionId,
            eventId: det.eventId,
            detections: det.detect.detections
        }));
        const rulesToUpdate = cloneDeep(this.accumulatedRules);

        // Clearing the buckets right away to not lose too many detections
        this.accumulatedDetections = [];
        this.accumulatedRules = [];

        const triggerTime = dataToAnalyze[0]?.triggerTime;
        const classnamesData = uniqBy(dataToAnalyze.flatMap(item => item.detections), item => `${item.className}-${item.label}`);

        const isOnlyMotion = !rulesToUpdate.length && classnamesData.length === 1 && detectionClassesDefaultMap[classnamesData[0]?.className] === DetectionClass.Motion;

        logger.debug(`Accumulated data to analyze: ${JSON.stringify({ triggerTime, classnamesData, rules: rulesToUpdate.map(rule => rule.rule.name) })}`);

        let image: MediaObject;
        let b64Image: string;
        let imageSource: ImageSource;
        for (const data of dataToAnalyze) {
            const { detectionId, eventId } = data;
            if (detectionId && eventId) {
                const imageData = await this.getImage({
                    detectionId,
                    eventId,
                    reason: GetImageReason.AccumulatedDetections
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
                reason: isOnlyMotion && !rulesToUpdate.length ?
                    GetImageReason.MotionUpdate :
                    GetImageReason.ObjectUpdate
            });

            image = imageData.image;
            b64Image = imageData.b64Image;
            imageSource = imageData.imageSource;
        }

        if (image && b64Image) {
            // if (bufferImage) {
            //     try {
            //         const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            //         if (!objectDetector) {
            //             return;
            //         }
            //         logger.log('Adding bounding boxes');

            //         const detection = await objectDetector.detectObjects(image);
            //         const { newB64Image, newImage } = await addBoundingBoxesToImage({
            //             console: logger,
            //             detection,
            //             bufferImage,
            //         });

            //         image = newImage;
            //         b64Image = newB64Image;
            //     } catch (e) {
            //         logger.log(`Error adding bounding boxes`, e);
            //     }
            // }

            try {
                const classnamesString = classnamesData.map(item => `${item.className}${item.label ? '-' + item.label : ''}`).join(', ');

                if (this.isActiveForMqttReporting) {
                    const mqttClient = await this.getMqttClient();

                    if (mqttClient) {
                        logger.info(`Updating classname images ${classnamesString} with image source ${imageSource}`);

                        const allowedClassnames = classnamesData.filter(classname => this.isDelayPassed({
                            classname: classname.className,
                            label: classname.label,
                            type: DelayType.BasicDetection,
                            eventSource: ScryptedEventSource.RawDetection
                        }));

                        allowedClassnames.length && await publishClassnameImages({
                            mqttClient,
                            console: logger,
                            classnamesData: allowedClassnames,
                            device: this.cameraDevice,
                            b64Image,
                            triggerTime,
                        }).catch(logger.error);
                    }
                }

                this.storeImagesOnFs({
                    b64Image,
                    classnamesData,
                    device: this.cameraDevice,
                    triggerTime,
                    prefix: 'object-detection',
                    eventSource: ScryptedEventSource.RawDetection,
                }).catch(logger.info);

                logger.info(`Updating rules ${rulesToUpdate.map(rule => rule.rule.name).join(', ')} with image source ${imageSource}`);
                for (const matchRule of rulesToUpdate) {
                    const { rule, match } = matchRule;

                    logger.info(`Publishing accumulated detection rule ${rule.name} data, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}. Has image ${!!image}`);

                    this.triggerRule({
                        matchRule,
                        skipTrigger: true,
                        b64Image,
                        device: this.cameraDevice,
                        triggerTime,
                        eventSource: ScryptedEventSource.RawDetection
                    }).catch(logger.log);

                    const timePassedForNotification = this.isDelayPassed({
                        type: DelayType.RuleNotification,
                        matchRule,
                        eventSource: ScryptedEventSource.RawDetection
                    });

                    if (timePassedForNotification) {
                        const detectionKey = this.getDetectionKey(matchRule);
                        logger.log(`Starting notifiers for detection rule ${rule.name}, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}`);

                        this.plugin.matchDetectionFound({
                            triggerDeviceId: this.id,
                            match,
                            rule,
                            image,
                            eventType: detectionClassesDefaultMap[match.className],
                            triggerTime,
                            detectionKey,
                        });
                    }
                }

                this.checkOccupancyData({
                    image,
                    b64Image,
                    source: 'Detections'
                }).catch(logger.log);

                if (!isOnlyMotion && this.runningTimelapseRules?.length) {
                    for (const rule of this.runningTimelapseRules) {
                        logger.log(`Adding detection frame (${classnamesString}) to the timelapse rule ${rule.name}`);

                        this.plugin.storeTimelapseFrame({
                            imageMo: image,
                            timestamp: triggerTime,
                            device: this.cameraDevice,
                            rule
                        }).catch(logger.log);
                    }
                }
            } catch (e) {
                logger.log(`Error on publishing data: ${JSON.stringify(dataToAnalyze)}`, e)
            }
        }
    }

    isDelayPassed(props: IsDelayPassedProps) {
        const { type, eventSource } = props;

        const { useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;
        const { minDelayTime } = this.storageSettings.values;

        if (useNvrDetectionsForMqtt) {
            return true;
        }
        const now = Date.now();

        if (type === DelayType.BasicDetection) {
            const { classname, label } = props;
            let key = label ? `${classname}-${label}` : classname;
            key += `-${eventSource}`
            const { minMqttPublishDelay } = this.storageSettings.values;
            const lastDetection = this.lastBasicDetectionsPublishedMap[key];
            const timePassed = !lastDetection || !minMqttPublishDelay || (now - lastDetection) >= (minMqttPublishDelay * 1000);

            this.getLogger().debug(key, timePassed, minMqttPublishDelay, lastDetection)

            if (timePassed) {
                this.lastBasicDetectionsPublishedMap[key] = now;
            }

            return timePassed;
        } else if (type === DelayType.RuleImageUpdate) {
            const { matchRule } = props;
            const lastDetectionkey = this.getDetectionKey(matchRule);

            const lastPublished = this.lastRulePublishedMap[lastDetectionkey];
            const timePassed = !lastPublished || !matchRule.rule.minMqttPublishDelay || (now - lastPublished) >= (matchRule.rule.minMqttPublishDelay) * 1000;

            if (timePassed) {
                this.lastRulePublishedMap[lastDetectionkey] = now;
            }

            return timePassed;
        } else if (type === DelayType.RuleNotification) {
            const { matchRule } = props;
            const lastDetectionkey = this.getDetectionKey(matchRule);

            const lastNotified = this.lastRuleNotifiedMap[lastDetectionkey];
            const delay = matchRule.rule.minDelay ?? minDelayTime;

            let timePassed = !lastNotified || (now - lastNotified) >= delay * 1000;

            if (timePassed) {
                this.lastRuleNotifiedMap[lastDetectionkey] = now;
            }

            return timePassed;
        } else if (type === DelayType.OccupancyNotification) {
            const { matchRule } = props;
            const ruleName = matchRule.rule.name;
            const lastNotified = this.lastOccupancyRuleNotified[ruleName];
            const delay = 5;

            const timePassed = !lastNotified || (now - lastNotified) >= delay * 1000;

            if (timePassed) {
                this.lastOccupancyRuleNotified[ruleName] = now;
            }

            return timePassed;
        } else if (type === DelayType.PostWebhookImage) {
            const { classname } = props;
            const lastPost = this.lastWebhookImagePosted[classname];
            const { postDetectionImageMinDelay } = this.storageSettings.values;

            const timePassed = !lastPost || (now - lastPost) >= postDetectionImageMinDelay * 1000;

            if (timePassed) {
                this.lastWebhookImagePosted[classname] = now;
            }

            return timePassed;
        } else if (type === DelayType.FsImageUpdate) {
            const { filename } = props;
            const lastUpdate = this.lastImageUpdateOnFs[filename];

            const timePassed = !lastUpdate || (now - lastUpdate) >= 5 * 1000;

            if (timePassed) {
                this.lastImageUpdateOnFs[filename] = now;
            }

            return timePassed;
        }
    }

    public async processDetections(props: {
        detect: ObjectsDetected,
        eventDetails?: EventDetails,
        image?: MediaObject,
        eventSource?: ScryptedEventSource
    }) {
        const { detect, eventDetails, image: parentImage, eventSource } = props;
        const isFromNvr = eventSource === ScryptedEventSource.NVR;
        const isFromFrigate = eventSource === ScryptedEventSource.Frigate;
        const isRawDetection = eventSource === ScryptedEventSource.RawDetection;
        const logger = this.getLogger();
        const { timestamp: triggerTime, detections, detectionId } = detect;
        const { eventId } = eventDetails ?? {};
        const { useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;
        const canUpdateMqttImage = (isFromNvr && useNvrDetectionsForMqtt) || isFromFrigate;

        if (!detections?.length) {
            return;
        }

        const {
            minDelayTime,
            ignoreCameraDetections,
        } = this.storageSettings.values;

        const { candidates } = filterAndSortValidDetections({
            detections: detections ?? [],
            logger,
            consumedDetectionIdsSet: new Set(),
            // consumedDetectionIdsSet: this.consumedDetectionIdsSet
        });

        eventDetails && this.processDetectionsInterval && this.accumulatedDetections.push({
            detect: {
                ...detect,
                detections: candidates
            },
            eventId: eventDetails.eventId
        });

        let image: MediaObject;
        let b64Image: string;

        try {
            // The MQTT image should be updated only if:
            // - the image comes already from NVR and the user wants MQTT detections to be used

            if ((isFromNvr && parentImage) || isFromFrigate) {
                const classnames = uniq(detections.map(d => d.className));
                const { b64Image: b64ImageNew, image: imageNew, imageSource } = await this.getImage({
                    image: parentImage,
                    reason: GetImageReason.FromNvr,
                });
                image = imageNew;
                b64Image = b64ImageNew;

                logger.log(`NVR detections received, classnames ${classnames.join(', ')}. b64Image ${getB64ImageLog(b64Image)} from ${imageSource}`);
            }

            if (this.isActiveForMqttReporting) {
                const mqttClient = await this.getMqttClient();

                if (mqttClient) {
                    let detectionsToUpdate = candidates;

                    // In case a non-NVR detection came in and user wants NVR detections to be used, just update the motion
                    if (useNvrDetectionsForMqtt && isRawDetection) {
                        logger.info(`Only updating motion, non-NVR detection incoming and using NVR detections for MQTT`);
                        detectionsToUpdate = [{ className: DetectionClass.Motion, score: 1 }];
                    }

                    if (candidates.some(elem => isObjectClassname(elem.className))) {
                        detectionsToUpdate.push(
                            { className: DetectionClass.AnyObject, score: 1 }
                        );
                    }

                    for (const detection of detectionsToUpdate) {
                        const { className, label } = detection;

                        logger.debug(`Triggering classname ${className}`);

                        publishBasicDetectionData({
                            mqttClient,
                            console: logger,
                            detection,
                            device: this.cameraDevice,
                            triggerTime,
                            room: this.cameraDevice.room,
                            b64Image
                        }).catch(logger.error);

                        if (canUpdateMqttImage && b64Image) {
                            const timePassed = this.isDelayPassed({
                                classname: className,
                                label,
                                eventSource,
                                type: DelayType.BasicDetection,
                            });

                            if (timePassed) {
                                logger.info(`Updating image for classname ${className} source: ${eventSource ? 'NVR' : 'Decoder'}`);

                                publishClassnameImages({
                                    mqttClient,
                                    console: logger,
                                    classnamesData: [detection],
                                    device: this.cameraDevice,
                                    b64Image,
                                    triggerTime,
                                }).catch(logger.error);
                            }
                        }
                    }

                    this.resetDetectionEntities({
                        resetSource: 'Timeout'
                    }).catch(logger.log);
                }
            }

            this.storeImagesOnFs({
                b64Image,
                classnamesData: candidates,
                device: this.cameraDevice,
                triggerTime,
                prefix: 'object-detection',
                suffix: !isRawDetection ? eventSource : undefined,
                eventSource
            }).catch(logger.info);
        } catch (e) {
            logger.log('Error parsing detections', e);
        }

        let dataToReport = {};
        try {
            const matchRules: MatchRule[] = [];
            // const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;
            // let shouldMarkBoundaries = false;

            const rules = cloneDeep(this.runningDetectionRules.filter(rule => !!rule.isNvr === !!isFromNvr)) ?? [];
            logger.debug(`Detections incoming ${JSON.stringify({
                candidates,
                detect,
                minDelayTime,
                ignoreCameraDetections,
                rules,
            })}`);

            for (const rule of rules) {
                const {
                    detectionClasses,
                    scoreThreshold,
                    whitelistedZones,
                    blacklistedZones,
                    people,
                    plates,
                    plateMaxDistance,
                    labelScoreThreshold,
                } = rule;

                if (!detectionClasses.length || !rule.currentlyActive) {
                    continue;
                }

                const match = candidates.find(d => {
                    if (ignoreCameraDetections && !d.boundingBox) {
                        return false;
                    }

                    const { className: classnameRaw, score, zones, label, labelScore } = d;
                    const className = detectionClassesDefaultMap[classnameRaw];

                    if (!className) {
                        logger.log(`Classname ${classnameRaw} not mapped. Candidates ${JSON.stringify(candidates)}`);

                        return false;
                    }

                    if (!detectionClasses.includes(className)) {
                        logger.debug(`Classname ${className} not contained in ${detectionClasses}`);
                        return false;
                    }

                    if (people?.length && isFaceClassname(className) && (!label || !people.includes(label))) {
                        logger.debug(`Face ${label} not contained in ${people}`);
                        return false;
                    }

                    if (plates?.length && isPlateClassname(className)) {
                        const anyValidPlate = plates.some(plate => levenshteinDistance(plate, label) > plateMaxDistance);

                        if (!anyValidPlate) {
                            logger.debug(`Plate ${label} not contained in ${plates}`);
                            return false;
                        }
                    }

                    if (isPlateClassname(className) || isFaceClassname(className)) {
                        const labelScoreOk = !labelScore || labelScore > labelScoreThreshold;

                        if (!labelScoreOk) {
                            logger.debug(`Label score ${labelScore} not ok ${labelScoreThreshold}`);
                            return false;
                        }
                    }

                    const scoreOk = !score || score > scoreThreshold;

                    if (!scoreOk) {
                        logger.debug(`Score ${score} not ok ${scoreThreshold}`);
                        return false;
                    }

                    dataToReport = {
                        zones,

                        score,
                        scoreThreshold,
                        scoreOk,

                        className,
                        detectionClasses
                    };

                    let zonesOk = true;
                    if (rule.source === RuleSource.Device) {
                        const isIncluded = whitelistedZones?.length ? zones.some(zone => whitelistedZones.includes(zone)) : true;
                        const isExcluded = blacklistedZones?.length ? zones.some(zone => blacklistedZones.includes(zone)) : false;

                        zonesOk = isIncluded && !isExcluded;

                        dataToReport = {
                            ...dataToReport,
                            zonesOk,
                            isIncluded,
                            isExcluded,
                        }
                    }

                    if (!zonesOk) {
                        logger.debug(`Zones ${zones} not ok`);
                        return false;
                    }

                    return true;
                });

                if (match) {
                    const matchRule = { match, rule, dataToReport };
                    matchRules.push(matchRule);
                    !rule.isNvr && this.accumulatedRules.push(matchRule);
                    // if (rule.markDetections) {
                    //     shouldMarkBoundaries = true;
                    // }
                }
            }

            // let markedImage: MediaObject;
            // let markedb64Image: string;
            // if (!!matchRules.length) {
            // let bufferImage: Buffer;

            // let isPeriodicImage = false
            // if (!imageToNotify) {
            //     const { b64Image: b64ImageNew, image: imageNew, bufferImage: bufferImageNew } = await this.getImage({ reason: "periodic" });
            //     imageToNotify = imageNew;
            //     b64Image = b64ImageNew;
            //     !!imageToNotify && (isPeriodicImage = true);
            //     // bufferImage = bufferImageNew;
            // }

            //     if (shouldMarkBoundaries && !!objectDetector) {
            //         const detectionResult = await objectDetector.detectObjects(imageToNotify);

            //         if (objectDetector.name !== 'Scrypted NVR Object Detection') {
            //             detectionResult.detections = filterOverlappedDetections(detectionResult.detections);
            //         }

            //         const { newB64Image, newImage } = await addBoundingBoxes(b64Image, detectionResult.detections);
            //         markedb64Image = newB64Image;
            //         markedImage = newImage;
            //     }
            // }

            if (matchRules.length) {
                logger.info(`Matching rules found: ${matchRules.map(({ rule }) => rule.name).join(', ')}`);

                for (const matchRule of matchRules) {
                    try {
                        const { match, rule } = matchRule;
                        const canUpdateMqttImage = isFromNvr && rule.isNvr && this.isDelayPassed({ type: DelayType.RuleImageUpdate, matchRule, eventSource });

                        if (this.isActiveForMqttReporting) {
                            logger.info(`Publishing detection rule ${matchRule.rule.name} data, b64Image ${getB64ImageLog(b64Image)} skipMqttImage ${!canUpdateMqttImage}`);

                            this.triggerRule({
                                matchRule,
                                b64Image,
                                device: this.cameraDevice,
                                triggerTime,
                                skipMqttImage: !canUpdateMqttImage,
                                eventSource,
                            }).catch(logger.log);
                        }

                        if (isFromNvr && rule.isNvr && this.isDelayPassed({ type: DelayType.RuleNotification, matchRule, eventSource })) {
                            const detectionKey = this.getDetectionKey(matchRule);
                            if (rule.ruleType === RuleType.Detection) {
                                logger.log(`Starting notifiers for detection rule ${rule.name}, b64Image ${getB64ImageLog(b64Image)}`);
                            }

                            this.plugin.matchDetectionFound({
                                triggerDeviceId: this.id,
                                match,
                                rule,
                                image,
                                eventType: detectionClassesDefaultMap[match.className],
                                triggerTime,
                                detectionKey,
                            });
                        }
                    } catch (e) {
                        logger.log(`Error processing matchRule ${JSON.stringify(matchRule)}`, e);
                    }
                }
            }
        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }

    resetMqttMotionTimeout() {
        this.mqttDetectionMotionTimeout && clearTimeout(this.mqttDetectionMotionTimeout);
        this.mqttDetectionMotionTimeout = undefined;
    }

    resetRuleTriggerTimeout(ruleName: string) {
        this.detectionRuleListeners[ruleName]?.turnOffTimeout && clearTimeout(this.detectionRuleListeners[ruleName]?.turnOffTimeout);
        this.detectionRuleListeners[ruleName] = {
            ...this.detectionRuleListeners[ruleName],
            turnOffTimeout: undefined
        };
    }

    async startDoorbellListener() {
        try {
            const logger = this.getLogger();

            this.binaryListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.BinarySensor,
            }, async (_, __, data) => {
                const timestamp = Date.now();

                const { image } = await this.getImage({ reason: GetImageReason.Sensor });
                if (data) {
                    const detections: ObjectDetectionResult[] = [{
                        className: DetectionClass.Doorbell,
                        score: 1,
                    }];
                    this.processDetections({
                        detect: { timestamp, detections },
                        eventSource: ScryptedEventSource.RawDetection,
                        image,
                    }).catch(logger.log);
                } else {
                    this.resetDetectionEntities({
                        resetSource: 'MotionSensor',
                        classnames: [DetectionClass.Doorbell]
                    }).catch(logger.log);
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startBinaryListener', e);
        }
    }

    async startObjectDetectionListeners() {
        try {
            const logger = this.getLogger();

            this.detectionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.ObjectDetector,
            }, async (_, eventDetails, data) => {
                const detect: ObjectsDetected | FrigateObjectDetection = data;

                let eventSource = ScryptedEventSource.RawDetection;
                const frigateEvent = (detect as FrigateObjectDetection)?.frigateEvent;

                if (frigateEvent) {
                    logger.log('Frigate event received', JSON.stringify(detect));

                    if (frigateEvent.type !== 'end' || !frigateEvent.after.has_snapshot) {
                        logger.log('Discarding frigate event');
                        return;
                    }
                    eventSource = ScryptedEventSource.Frigate;
                }

                this.processDetections({ detect, eventDetails, eventSource }).catch(logger.log);
            });

            this.motionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.MotionSensor,
            }, async (_, __, data) => {
                const { useFramesGenerator } = this.storageSettings.values;
                const now = Date.now();

                if (data) {
                    this.consumedDetectionIdsSet = new Set();
                    const timestamp = now;
                    const detections: ObjectDetectionResult[] = [{
                        className: 'motion',
                        score: 1,
                    }];
                    this.processDetections({ detect: { timestamp, detections }, eventSource: ScryptedEventSource.RawDetection }).catch(logger.log);

                    if (useFramesGenerator) {
                        this.startFramesGenerator().catch(logger.error);
                    }
                } else {
                    this.lastMotionEnd = now;
                    this.resetDetectionEntities({
                        resetSource: 'MotionSensor'
                    }).catch(logger.log);

                    if (useFramesGenerator) {
                        this.stopFramesGenerator();
                    }
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startObjectDetectionListeners', e);
        }
    }

    async resetDetectionEntities(props: {
        resetSource: 'MotionSensor' | 'Timeout',
        classnames?: DetectionClass[]
    }) {
        const { resetSource, classnames } = props;
        const isFromSensor = resetSource === 'MotionSensor';
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();

        const funct = async () => {
            logger.log(`Reset detections signal coming from ${resetSource}`);

            await publishResetDetectionsEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger,
                classnames
            });
        };

        if (isFromSensor) {
            if (this.mqttDetectionMotionTimeout) {
                await funct();
                this.resetMqttMotionTimeout();
            }
        } else {
            this.resetMqttMotionTimeout();

            const { motionDuration } = this.storageSettings.values;
            this.mqttDetectionMotionTimeout = setTimeout(async () => {
                await funct();
            }, motionDuration * 1000);
        }
    }

    async resetRuleEntities(rule: BaseRule) {
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();
        const { motionDuration, } = this.storageSettings.values;

        const turnOffTimeout = setTimeout(async () => {
            logger.log(`Rule ${rule.name} trigger entities reset`);

            await publishResetRuleEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger,
                rule,
            });
        }, motionDuration * 1000);

        const ruleName = rule.name;
        this.resetRuleTriggerTimeout(ruleName);

        this.detectionRuleListeners[ruleName] = {
            ...this.detectionRuleListeners[ruleName],
            turnOffTimeout
        };
    }

    async getDetectionModel() {
        return await (this.plugin.storageSettings.values.objectDetectionDevice as ObjectDetection)?.getDetectionModel();
    }

    async getFrameGenerator() {
        // TODO: restore this to pick the defaultDecoder from object Detection mixin
        // let frameGenerator = this.storageSettings.values.newPipeline as string;
        // if (frameGenerator === 'Default')
        //     frameGenerator = this.plugin.storageSettings.values.defaultDecoder || 'Default';
        const frameGenerator = 'Default';

        const pipelines = getAllDevices().filter(d => d.interfaces.includes(ScryptedInterface.VideoFrameGenerator));
        const webassembly = sdk.systemManager.getDeviceById(NVR_PLUGIN_ID, 'decoder') || undefined;
        const gstreamer = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'gstreamer') || undefined;
        const libav = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'libav') || undefined;
        const ffmpeg = sdk.systemManager.getDeviceById(VIDEO_ANALYSIS_PLUGIN_ID, 'ffmpeg') || undefined;
        const use = pipelines.find(p => p.name === frameGenerator) || webassembly || gstreamer || libav || ffmpeg;
        return use.id;
    }

    async createFrameGenerator(options?: VideoFrameGeneratorOptions): Promise<AsyncGenerator<VideoFrame, any, unknown>> {
        // const destination: MediaStreamDestination = 'remote-recorder';
        const destination: MediaStreamDestination = 'local-recorder';
        const model = await this.getDetectionModel();
        const stream = await this.cameraDevice.getVideoStream({
            prebuffer: 0,
            // prebuffer: model.prebuffer,
            destination,
        });

        if (model.decoder) {
            return stream as unknown as AsyncGenerator<VideoFrame, any, unknown>
        }

        const frameGenerator = await this.getFrameGenerator();
        const videoFrameGenerator = systemManager.getDeviceById<VideoFrameGenerator>(frameGenerator);

        // const videoFrameGenerator = sdk.systemManager.getDeviceById<VideoFrameGenerator>(VIDEO_ANALYSIS_PLUGIN_ID, 'ffmpeg');

        if (!videoFrameGenerator)
            throw new Error('invalid VideoFrameGenerator');

        try {
            return await videoFrameGenerator.generateVideoFrames(stream, {
                queue: 0,
                ...options
            });
        }
        finally { }
    }
}
