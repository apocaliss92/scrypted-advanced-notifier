import sdk, { Camera, EventDetails, EventListenerRegister, FFmpegInput, Image, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionResult, ObjectDetector, ObjectsDetected, PanTiltZoomCommand, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, VideoFrame, VideoFrameGenerator, VideoFrameGeneratorOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep, uniq, uniqBy } from "lodash";
import { getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { filterOverlappedDetections } from '../../scrypted-basic-object-detector/src/util';
import { FrigateObjectDetection } from '../../scrypted-frigate-object-detector/src/utils';
import { RtpPacket } from "../../scrypted/external/werift/packages/rtp/src/rtp/rtp";
import { startRtpForwarderProcess } from '../../scrypted/plugins/webrtc/src/rtp-forwarders';
import { Deferred } from "../../scrypted/server/src/deferred";
import { sleep } from "../../scrypted/server/src/sleep";
import { name as pluginName } from '../package.json';
import { DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { ClassnameImage, idPrefix, publishAudioPressureValue, publishBasicDetectionData, publishClassnameImages, publishOccupancy, publishResetDetectionsEntities, publishResetRuleEntities, publishRuleData, publishRuleEnabled, reportDeviceValues, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { AudioRule, BaseRule, DetectionRule, DeviceInterface, EventType, ObserveZoneData, OccupancyRule, RuleSource, RuleType, SNAPSHOT_WIDTH, ScryptedEventSource, TimelapseRule, ZoneMatchType, convertSettingsToStorageSettings, filterAndSortValidDetections, getActiveRules, getAudioRulesSettings, getDetectionRulesSettings, getFrameGenerator, getMinutes, getMixinBaseSettings, getOccupancyRulesSettings, getRuleKeys, getTimelapseRulesSettings, getWebookUrls, getWebooks, pcmU8ToDb, splitRules } from "./utils";
import moment from "moment";

const { systemManager } = sdk;

interface MatchRule { match?: ObjectDetectionResult, rule: BaseRule, dataToReport?: any }
interface CurrentOccupancyState {
    occupancyToConfirm?: boolean,
    confirmationStart?: number,
    lastChange: number,
    lastCheck: number,
    score: number,
    image: MediaObject;
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
    image: undefined,
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

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<string> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            isCamera: true,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        enabledToMqtt: {
            title: 'Report to MQTT',
            description: 'Autodiscovery this camera on MQTT',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
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
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of seconds to wait until a notification is sent for the same detection type',
            type: 'number',
            defaultValue: 15,
        },
        motionDuration: {
            title: 'Off motion duration',
            type: 'number',
            defaultValue: 10
        },
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            description: 'If checked, the detections reported by the camera will be ignored. Make sure to have an object detector mixin enabled',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
        },
        occupancyCheckInterval: {
            title: 'Check objects occupancy in seconds',
            description: 'Regularly check objects presence and report it to MQTT, performance intensive. Set to 0 to disable',
            type: 'number',
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
            title: 'Last snapshot webhook',
            type: 'boolean',
            immediate: true,
        },
        lastSnapshotWebhookCloudUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Cloud URL',
            readonly: true,
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Local URL',
            readonly: true,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    mqttClient: MqttClient;
    cameraDevice: DeviceInterface;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForMqttReporting: boolean;
    isActiveForNvrNotifications: boolean;
    isActiveForAudioDetections: boolean;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    lastRuleNotifiedMap: Record<string, number> = {};
    lastRulePublishedMap: Record<string, number> = {};
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
    lastFrame?: Buffer;
    lastFrameAcquired?: number;
    lastB64Image?: string;
    lastPictureTaken?: number;
    lastOccupancyRegularCheck?: number;
    lastOccupancyRuleNotified: Record<string, number> = {};

    accumulatedDetections: AccumulatedDetection[] = [];
    accumulatedRules: MatchRule[] = [];
    processDetectionsInterval: NodeJS.Timeout;
    processingAccumulatedDetections = false;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.fetchedEntities;
            return {
                choices: entities ?? []
            }
        }

        this.cameraDevice = systemManager.getDeviceById<DeviceInterface>(this.id);

        this.initValues().then().catch(logger.log);

        this.plugin.currentMixinsMap[this.name] = this;

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
                        clientId: `scrypted_an_${this.id}`,
                        configTopicPattern: `homeassistant/+/${idPrefix}-${this.id}/+/config`
                    });
                    await this.mqttClient?.getMqttClient();
                } catch (e) {
                    logger.error('Error setting up MQTT client', e.message);
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
                    anyAllowedNvrDetectionRule
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
                            const { common: { endTimeKey }, timelapse: { lastGeneratedKey } } = getRuleKeys({
                                ruleType,
                                ruleName: rule.name,
                            });
                            // const endTime = this.storageSettings.getItem(endTimeKey) as number;
                            // const referenceEnd = moment(Number(endTime));
                            // const endMinutes = getMinutes(referenceEnd);
                            // const nowMoment = moment();

                            // Make sure to not spam generate timelapses if any issue occurs deferring by 1 hour
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

                const { entityId, occupancyCheckInterval = 0, checkSoundPressure, useFramesGenerator } = this.storageSettings.values;

                // logger.log(JSON.stringify({ allDetectionRules, detectionRules }))
                if (isActiveForMqttReporting) {
                    const mqttClient = await this.getMqttClient();
                    if (mqttClient) {
                        // Every 60 minutes repeat the autodiscovery
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                            logger.log('Starting MQTT autodiscovery');
                            setupDeviceAutodiscovery({
                                mqttClient,
                                device: this.cameraDevice,
                                console: logger,
                                rules: allAvailableRules,
                                occupancyEnabled: !!occupancyCheckInterval,
                                withAudio: checkSoundPressure,
                            }).then(async (activeTopics) => {
                                await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                            }).catch(logger.error);

                            logger.debug(`Subscribing to mqtt topics`);
                            subscribeToDeviceMqttTopics({
                                mqttClient,
                                rules: allAvailableRules,
                                device: this.cameraDevice,
                                console: logger,
                                activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                    const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                    logger.debug(`Setting ${ruleType} rule ${ruleName} to ${active}`);
                                    await this.storageSettings.putSetting(`${enabledKey}`, active);
                                },
                                switchRecordingCb: this.cameraDevice.interfaces.includes(ScryptedInterface.VideoRecorder) ?
                                    async (active) => {
                                        logger.debug(`Setting NVR privacy mode to ${!active}`);
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

                        reportDeviceValues({
                            console: logger,
                            device: this.cameraDevice,
                            mqttClient,
                            isRecording,
                            rulesToEnable,
                            rulesToDisable
                        }).catch(logger.error);
                    }
                }

                if (isDetectionListenerRunning && !shouldListenDetections) {
                    logger.log('Stopping and cleaning listeners.');
                    this.resetListeners();
                } else if (!isDetectionListenerRunning && shouldListenDetections) {
                    logger.log(`Starting ${ScryptedInterface.ObjectDetector}/${ScryptedInterface.MotionSensor} listeners: ${JSON.stringify({
                        Detections: shouldListenDetections,
                        MQTT: isActiveForMqttReporting,
                        NotificationRules: allAllowedRules.length ? allAllowedRules.map(rule => rule.name).join(', ') : 'None',
                    })}`);
                    await this.startListeners();
                }

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


                const { haEnabled, useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;

                if (haEnabled && entityId && !this.plugin.fetchedEntities.includes(entityId)) {
                    logger.debug(`Entity id ${entityId} does not exists on HA`);
                }

                if (!this.processDetectionsInterval) {
                    logger.log('Starting processing of accumulated detections');
                    this.startAccumulatedDetectionsInterval();
                }
                //  else if (useNvrDetectionsForMqtt && this.processDetectionsInterval) {
                //     logger.log('Stopping processing of accumulated detections');
                //     this.stopAccumulatedDetectionsInterval();
                // }

                if (this.framesGeneratorSignal.finished && useFramesGenerator) {
                    logger.log(`Starting frames generator`);
                    this.startFramesGenerator().catch(logger.log);
                } else if (!this.framesGeneratorSignal.finished && !useFramesGenerator) {
                    this.stopFramesGenerator();
                }
                // Restart frame generator every minute
                if (!this.framesGeneratorSignal.finished && this.frameGenerationStartTime && (now - this.frameGenerationStartTime) >= 1000 * 60 * 1) {
                    logger.log(`Restarting frames generator`);
                    this.stopFramesGenerator();
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
            this.frameGenerationStartTime = Date.now();
            this.framesGeneratorSignal = new Deferred();
            const frameGenerator = this.createFrameGenerator();
            const generator = await sdk.connectRPCObject(frameGenerator);

            for await (const frame of generator) {
                try {
                    if (this.framesGeneratorSignal.finished) {
                        logger.log('Release decoder');
                        break;
                    }

                    const now = Date.now();

                    this.lastFrame = await frame.image.toBuffer({
                        format: 'jpg',
                    });
                    this.lastFrameAcquired = now;

                    await sleep(500);
                } catch (e) {
                    logger.log(`Error acquiring a frame from generator`, e.message);
                    this.lastFrame = undefined;
                }
            }
        } else {
            logger.log('Streams generator not yet released');
        }
    }

    stopFramesGenerator() {
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
                logger.log('Error in startCheckInterval', e);
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

    resetListeners() {
        if (this.detectionListener || this.motionListener || this.audioForwarder) {
            this.getLogger().log('Resetting listeners.');
        }

        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
        this.motionListener?.removeListener && this.motionListener.removeListener();
        this.motionListener = undefined;
        this.stopAudioListener();
        this.resetMqttMotionTimeout();
        // this.processDetectionsInterval && clearInterval(this.processDetectionsInterval);
        // this.processDetectionsInterval = undefined;
        Object.keys(this.detectionRuleListeners).forEach(ruleName => {
            const { disableNvrRecordingTimeout, turnOffTimeout } = this.detectionRuleListeners[ruleName];
            disableNvrRecordingTimeout && clearTimeout(disableNvrRecordingTimeout);
            turnOffTimeout && clearTimeout(turnOffTimeout);
        })
    }

    async initValues() {
        const logger = this.getLogger();
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);

        await this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        await this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);

        await this.refreshSettings();
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

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            zones,
            isCamera: true,
            logger,
            ruleSource: RuleSource.Device,
            onShowMore: this.refreshSettings.bind(this),
            onRuleToggle: async (ruleName: string, enabled: boolean) => this.toggleRule(ruleName, RuleType.Detection, enabled),
        });
        dynamicSettings.push(...detectionRulesSettings);

        const occupancyRulesSettings = await getOccupancyRulesSettings({
            storage: this.storageSettings,
            zones,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
            onRuleToggle: async (ruleName: string, enabled: boolean) => this.toggleRule(ruleName, RuleType.Occupancy, enabled),
        });
        dynamicSettings.push(...occupancyRulesSettings);

        const timelapseRulesSettings = await getTimelapseRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
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
            onRuleToggle: async (ruleName: string, enabled: boolean) => this.toggleRule(ruleName, RuleType.Timelapse, enabled),
        });
        dynamicSettings.push(...timelapseRulesSettings);

        const audioRulesSettings = await getAudioRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
            onRuleToggle: async (ruleName: string, enabled: boolean) => this.toggleRule(ruleName, RuleType.Audio, enabled),
        });
        dynamicSettings.push(...audioRulesSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        const lastSnapshotWebhook = this.storageSettings.values.lastSnapshotWebhook;

        if (this.storageSettings.settings.lastSnapshotWebhookCloudUrl) {
            this.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide = !lastSnapshotWebhook;
        }
        if (this.storageSettings.settings.lastSnapshotWebhookLocalUrl) {
            this.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide = !lastSnapshotWebhook;
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
            const { enabledToMqtt } = this.storageSettings.values;
            this.storageSettings.settings.minMqttPublishDelay.hide = !enabledToMqtt;
            this.storageSettings.settings.checkSoundPressure.hide = !enabledToMqtt;
            this.storageSettings.settings.occupancyCheckInterval.hide = !enabledToMqtt;
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
        const deviceConsole = this.console;

        if (!this.logger || forceNew) {
            const log = (type: 'log' | 'error' | 'debug' | 'warn' | 'info', message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();

                let canLog = false;
                if (type === 'debug') {
                    canLog = this.storageSettings.getItem('debug')
                } else if (type === 'info') {
                    canLog = this.storageSettings.getItem('info')
                } else {
                    canLog = true;
                }

                if (canLog) {
                    deviceConsole.log(` ${now} - `, message, ...optionalParams);
                }
            };
            const newLogger = {
                log: (message?: any, ...optionalParams: any[]) => log('log', message, ...optionalParams),
                info: (message?: any, ...optionalParams: any[]) => log('info', message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log('debug', message, ...optionalParams),
                error: (message?: any, ...optionalParams: any[]) => log('error', message, ...optionalParams),
                warn: (message?: any, ...optionalParams: any[]) => log('warn', message, ...optionalParams),
            } as Console;

            if (forceNew) {
                return newLogger;
            } else {
                this.logger = newLogger;
            }
        }

        return this.logger;
    }

    async triggerRule(props: {
        rule: BaseRule,
        device: DeviceInterface,
        b64Image?: string,
        imageUrl?: string,
        image?: MediaObject,
        triggerTime: number,
        skipMqttImage?: boolean,
        skipTrigger?: boolean,
    }) {
        const logger = this.getLogger();

        try {
            const { rule, b64Image, device, triggerTime, image, imageUrl, skipMqttImage, skipTrigger } = props;

            const mqttClient = await this.getMqttClient();
            if (mqttClient) {
                try {
                    publishRuleData({
                        mqttClient,
                        device,
                        triggerValue: !skipTrigger ? true : undefined,
                        console: logger,
                        b64Image,
                        image,
                        rule,
                        triggerTime,
                        imageUrl,
                        skipMqttImage,
                        storeImageFn: this.plugin.storeImage,
                    }).catch(logger.error);
                } catch (e) {
                    logger.log(`Error in publishRuleData`, e);
                }
            }

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

    getLastDetectionkey(matchRule: MatchRule) {
        const { match, rule } = matchRule;
        let key = `rule-${rule.name}`;
        if (rule.ruleType === RuleType.Timelapse) {
            return key;
        } else {
            const { label } = match;
            const className = detectionClassesDefaultMap[match.className];
            key = `${key}-${className}`;
            if (label) {
                key += `-${label}`;
            }

            return key;
        }
    }

    public async getImage(props?: {
        preferLatest?: boolean,
        preferSnapshot?: boolean,
        fallbackToLatest?: boolean,
        detectionId?: string,
        eventId?: string,
        image?: MediaObject
    }) {
        const { preferLatest, fallbackToLatest, detectionId, eventId, image: imageParent, preferSnapshot } = props ?? {};
        const logger = this.getLogger();
        const now = Date.now();
        const { minSnapshotDelay, useFramesGenerator } = this.storageSettings.values;

        let image: MediaObject = imageParent;
        let bufferImage: Buffer;
        let b64Image: string;
        let imageUrl: string;
        let imageSource: 'Snapshot' | 'Latest because requested' | 'Latest because very recent' | 'Detector mixin' | 'Decoder';

        const msPassed = now - this.lastPictureTaken;
        const isVeryRecent = msPassed && msPassed <= 500;
        const isLatestPreferred = msPassed && msPassed <= 2000;

        const findFromSnapshot = async () => {
            const timePassed = !this.lastPictureTaken || msPassed >= 1000 * minSnapshotDelay;

            if (timePassed || preferSnapshot) {
                try {
                    this.lastPictureTaken = now;
                    this.lastImage = undefined;
                    const objectDetector = this.getObjectDetector();
                    image = await objectDetector.takePicture({
                        reason: 'event',
                        timeout: 5000,
                        picture: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                    logger.info(`Image taken from snapshot because time is passed`);
                    imageSource = 'Snapshot';
                } catch (e) {
                    logger.log(`Error taking a snapshot`, e.message);
                    this.lastPictureTaken = undefined;
                }
            }
        }

        try {
            if (!image) {
                const isLastFrameRecent = !this.lastFrameAcquired || (now - this.lastFrameAcquired) <= 500;
                if (useFramesGenerator && this.lastFrame && isLastFrameRecent) {
                    const tmp = await sdk.mediaManager.createMediaObject(this.lastFrame, 'image/jpeg');
                    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(tmp, ScryptedMimeTypes.Image);
                    image = await convertedImage.toImage({
                        format: 'jpg',
                        resize: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                    imageSource = 'Decoder';
                    logger.info(`Image taken from decoder`);
                } else if (preferLatest && isLatestPreferred) {
                    image = this.lastImage;
                    logger.info(`Last used image taken because periodic`);
                    imageSource = 'Latest because requested';
                } else if (isVeryRecent && this.lastImage) {
                    image = this.lastImage;
                    b64Image = this.lastB64Image;
                    logger.info(`Last used image taken because very recent`);
                    imageSource = 'Latest because very recent';
                } else if (detectionId && eventId) {
                    try {
                        this.lastPictureTaken = now;
                        this.lastImage = undefined;
                        const detectImage = await this.cameraDevice.getDetectionInput(detectionId, eventId);
                        const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(detectImage, ScryptedMimeTypes.Image);
                        image = await convertedImage.toImage({
                            resize: {
                                width: SNAPSHOT_WIDTH,
                            },
                        });
                        logger.info(`Image taken from the detector mixin`);
                        imageSource = 'Detector mixin';
                    } catch (e) {
                        logger.log(`Error finding the image from the detector mixin`, e.message);

                        await findFromSnapshot();
                    }
                } else {
                    await findFromSnapshot();
                }
            }

            if (!image && fallbackToLatest) {
                image = this.lastImage;
            }

            if (image) {
                bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
                b64Image = bufferImage?.toString('base64');
                // imageUrl = await sdk.mediaManager.convertMediaObjectToInsecureLocalUrl(image, 'image/jpeg');
            }
        } catch (e) {
            logger.log(`Error during getImage`, e);
        } finally {
            if (!imageParent) {
                this.lastImage = image;
                this.lastB64Image = b64Image;
            }

            return { image, b64Image, bufferImage, imageUrl, imageSource };
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
                        const decibels = pcmU8ToDb(packet.payload);
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
            const shouldForceFrame = !currentState || (now - (currentState?.lastCheck ?? 0)) >= (1000 * (forceUpdate - 1));

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
        }) || this.storageSettings.values.occupancyCheckInterval;

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
            const { image, b64Image } = await this.getImage({ fallbackToLatest: true });
            if (image && b64Image) {
                if (anyOutdatedOccupancyRule) {
                    this.checkOccupancyData({ image, b64Image, source: 'MainFlow' }).catch(logger.log);
                }

                if (anyTimelapseToRefresh) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);

                    for (const rule of timelapsesToRefresh) {
                        logger.log(`Adding frame to the timelapse rule ${rule.name}`);
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

        const logger = this.getLogger();

        try {
            const now = new Date().getTime();
            const minDelayInSeconds = !!this.runningOccupancyRules.length ? 1 : (this.storageSettings.values.occupancyCheckInterval || 0);

            if (!minDelayInSeconds) {
                return;
            }

            const timePassed = !this.lastOccupancyRegularCheck || (now - this.lastOccupancyRegularCheck) > (1000 * minDelayInSeconds);

            if (!timePassed) {
                return;
            }

            logger.info(`Checking occupancy for reason ${source}`);

            const mqttClient = await this.getMqttClient();

            const occupancyRulesDataMap: Record<string, OccupancyRuleData> = {};
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
                    image,
                    score: maxScore
                };

                this.occupancyState[name] = updatedState;

                const existingRule = occupancyRulesDataMap[name];
                if (!existingRule) {
                    occupancyRulesDataMap[name] = {
                        rule: occupancyRule,
                        occupies,
                        triggerTime: now,
                        objectsDetected: objectsDetected
                    }
                } else if (!existingRule.occupies && occupies) {
                    existingRule.occupies = true;
                }
            }

            const occupancyRulesData: OccupancyRuleData[] = [];
            const rulesToNotNotify: string[] = [];
            for (const occupancyRuleData of Object.values(occupancyRulesDataMap)) {
                const { name, changeStateConfirm } = occupancyRuleData.rule;
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

                if (occupancyRuleData.rule.detectedObjects !== occupancyRuleData.objectsDetected) {
                    await this.storageSettings.putSetting(detectedObjectsKey, occupancyRuleData.objectsDetected);
                }

                let occupancyData: Partial<CurrentOccupancyState> = {
                    ...(currentState ?? initOccupancyState),
                    lastCheck: now,
                };

                // If last state change is too old, proceed with update regardless
                const image = currentState?.image;
                if (tooOld) {
                    logger.info(`Force pushing rule ${name}, last change ${lastChangeElpasedMs / 1000} seconds ago`);
                    occupancyRulesData.push({
                        ...occupancyRuleData,
                        image,
                        triggerTime: now,
                    });

                    occupancyData = {
                        ...occupancyData,
                        lastChange: now,
                    };

                    rulesToNotNotify.push(occupancyRuleData.rule.name);
                } else if (toConfirm) {
                    const elpasedTimeMs = now - (currentState?.confirmationStart ?? 0);
                    const isConfirmationTimePassed = elpasedTimeMs >= (1000 * changeStateConfirm);
                    const isStateConfirmed = occupancyRuleData.occupies === currentState.occupancyToConfirm;

                    // If confirmation time is not done but value is changed, discard new state
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

                            const stateActuallyChanged = occupancyRuleData.occupies !== occupancyRuleData.rule.occupies;

                            if (!stateActuallyChanged) {
                                rulesToNotNotify.push(occupancyRuleData.rule.name);
                            } else {
                                logger.log(`Confirming occupancy rule ${name}: ${occupancyRuleData.occupies} ${occupancyRuleData.objectsDetected}`);
                                logger.log(JSON.stringify({
                                    occupancyRuleData,
                                    currentState,
                                    occupancyData,
                                }));
                            }

                            occupancyRulesData.push({
                                ...occupancyRuleData,
                                image,
                                triggerTime: currentState.confirmationStart,
                                changed: stateActuallyChanged
                            });

                            await this.storageSettings.putSetting(occupiesKey, occupancyRuleData.occupies);

                        } else {
                            // Time is passed and value changed, restart confirmation flow
                            occupancyData = {
                                ...occupancyData,
                                confirmationStart: now,
                                occupancyToConfirm: occupancyRuleData.occupies
                            };

                            logger.log(`Restarting confirmation flow (because time is passed and value changed) for occupancy rule ${name}: toConfirm ${occupancyRuleData.occupies}`);
                        }
                    }
                } else if (occupancyRuleData.occupies !== occupancyRuleData.rule.occupies) {
                    logger.log(`Marking the rule to confirm ${occupancyRuleData.occupies} for next iteration ${name}: ${occupancyRuleData.objectsDetected} objects, score ${currentState.score}`);

                    occupancyData = {
                        ...occupancyData,
                        confirmationStart: now,
                        confirmedFrames: 0,
                        rejectedFrames: 0,
                        score: 0,
                        occupancyToConfirm: occupancyRuleData.occupies
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
                logger.info(`Publishing occupancy data from source ${source}`);
                publishOccupancy({
                    console: logger,
                    device: this.cameraDevice,
                    mqttClient,
                    objectsDetected: detectedResultParent,
                    occupancyRulesData,
                    storeImageFn: this.plugin.storeImage,
                }).catch(logger.error);
            }

            for (const occupancyRuleData of occupancyRulesData) {
                const rule = occupancyRuleData.rule;
                const timePassed = this.isDelayPassed({ type: 'OccupancyNotification', matchRule: { rule } });

                if (!rulesToNotNotify.includes(rule.name) && timePassed) {
                    const currentState = this.occupancyState[rule.name];

                    let message = occupancyRuleData.occupies ?
                        rule.zoneOccupiedText :
                        rule.zoneNotOccupiedText;

                    if (message) {
                        message = message.toString()
                            .replace('${detectedObjects}', String(occupancyRuleData.objectsDetected) ?? '')
                            .replace('${maxObjects}', String(rule.maxObjects) ?? '')

                        const triggerTime = (occupancyRuleData?.triggerTime ?? now) - 5000;

                        await this.plugin.notifyOccupancyEvent({
                            cameraDevice: this.cameraDevice,
                            message,
                            rule,
                            triggerTime,
                            image: currentState?.image ?? imageParent
                        });
                    }
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

        const { image, b64Image, imageUrl } = await this.getImage({ preferLatest: true });

        for (const rule of (this.runningAudioRules ?? [])) {
            const { name, audioDuration, decibelThreshold, customText, minDelay } = rule;
            const { lastDetection, inProgress, lastNotification } = this.audioListeners[name] ?? {};
            const isThresholdMet = decibels >= decibelThreshold;
            const isTimePassed = !lastDetection || (now - lastDetection) > audioDuration;
            const isTimeForNotificationPassed = !minDelay || !lastNotification || (now - lastNotification) > (minDelay * 1000);

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

                if (this.isActiveForMqttReporting) {
                    this.triggerRule({
                        rule,
                        b64Image,
                        device: this.cameraDevice,
                        triggerTime: now,
                        image,
                        imageUrl
                    });
                }

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

    async processAccumulatedDetections() {
        if (!this.accumulatedDetections.length && !this.accumulatedRules.length) {
            return;
        }

        const logger = this.getLogger();

        const dataToAnalyze = this.accumulatedDetections.map(det => ({
            triggerTime: det.detect.timestamp,
            detectionId: det.detect.detectionId,
            eventId: det.eventId,
            classnamesData: det.detect.detections.map(innerDet => ({
                classname: innerDet.className,
                label: innerDet.label
            })) as ClassnameImage[]
        }));
        const rulesToUpdate = cloneDeep(this.accumulatedRules);

        // Clearing the buckets right away to not lose too many detections
        this.accumulatedDetections = [];
        this.accumulatedRules = [];

        const triggerTime = dataToAnalyze[0]?.triggerTime;
        const { detectionId, eventId } = dataToAnalyze.find(item => item.detectionId && item.eventId) ?? {};
        const classnamesData: ClassnameImage[] = uniqBy(dataToAnalyze.flatMap(item => item.classnamesData), item => `${item.classname}-${item.label}`);

        const isOnlyMotion = classnamesData.length === 1 && detectionClassesDefaultMap[classnamesData[0]?.classname] === DetectionClass.Motion;

        logger.info(`Accumulated data to analyze: ${JSON.stringify({ triggerTime, detectionId, eventId, classnamesData, rules: rulesToUpdate.map(rule => rule.rule.name) })}`);

        const { image, b64Image, imageSource } = await this.getImage({
            detectionId,
            eventId,
            preferLatest: isOnlyMotion
        });

        if (image && b64Image) {
            try {
                const mqttClient = await this.getMqttClient();

                if (mqttClient) {
                    logger.info(`Updating classname images ${classnamesData.map(item => `${item.classname}-${item.label}`).join(', ')} with image source ${imageSource}`);

                    const allowedClassnames = classnamesData.filter(classname => this.isDelayPassed({
                        classname: classname.classname,
                        label: classname.label,
                        type: 'BasicDetection'
                    }));

                    allowedClassnames.length && await publishClassnameImages({
                        mqttClient,
                        console: logger,
                        classnamesData: allowedClassnames,
                        device: this.cameraDevice,
                        b64Image,
                        image,
                        triggerTime,
                        storeImageFn: this.plugin.storeImage
                    }).catch(logger.error);

                    logger.info(`Updating rules ${rulesToUpdate.map(rule => rule.rule.name).join(', ')} with image source ${imageSource}`);
                    for (const matchRule of rulesToUpdate) {
                        const timePassedForImageUpdate = this.isDelayPassed({
                            type: 'RuleImageUpdate',
                            matchRule
                        });
                        const { rule, match } = matchRule;

                        if (this.isActiveForMqttReporting && timePassedForImageUpdate) {
                            logger.info(`Publishing accumulated detection rule ${rule.name} data, b64Image ${b64Image?.substring(0, 10)} skipMqttImage ${!timePassedForImageUpdate}`);

                            this.triggerRule({
                                rule,
                                skipTrigger: true,
                                b64Image,
                                device: this.cameraDevice,
                                triggerTime,
                                image,
                            });
                        }

                        const timePassedForNotification = this.isDelayPassed({ type: 'RuleNotification', matchRule });

                        if (timePassedForNotification) {
                            logger.log(`Starting notifiers for detection rule ${rule.name}, b64Image ${b64Image?.substring(0, 10)}`);

                            this.plugin.matchDetectionFound({
                                triggerDeviceId: this.id,
                                match,
                                rule,
                                image,
                                eventType: EventType.ObjectDetection,
                                triggerTime,
                            });
                        }
                    }
                }

                this.checkOccupancyData({
                    image,
                    b64Image,
                    source: 'Detections'
                }).catch(logger.log);

                if (!isOnlyMotion && this.runningTimelapseRules?.length) {
                    for (const rule of this.runningTimelapseRules) {
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

    isDelayPassed(props: {
        classname?: string;
        label?: string;
        eventSource?: ScryptedEventSource;
        type: 'BasicDetection' | 'RuleImageUpdate' | 'RuleNotification' | 'OccupancyNotification',
        matchRule?: MatchRule
    }) {
        const { classname, type, eventSource = ScryptedEventSource.RawDetection, label, matchRule } = props;

        const { useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;
        const { minDelayTime } = this.storageSettings.values;

        if (useNvrDetectionsForMqtt) {
            return true;
        }
        const now = Date.now();

        if (type === 'BasicDetection' && classname) {
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
        } else if (type === 'RuleImageUpdate' && matchRule) {
            const lastDetectionkey = this.getLastDetectionkey(matchRule);

            const lastPublished = this.lastRulePublishedMap[lastDetectionkey];
            const timePassed = !lastPublished || !matchRule.rule.minMqttPublishDelay || (now - lastPublished) >= (matchRule.rule.minMqttPublishDelay) * 1000;

            if (timePassed) {
                this.lastRulePublishedMap[lastDetectionkey] = now;
            }

            return timePassed;
        } else if (type === 'RuleNotification' && matchRule) {
            const lastDetectionkey = this.getLastDetectionkey(matchRule);

            const lastNotified = this.lastRuleNotifiedMap[lastDetectionkey];
            const delay = matchRule.rule.minDelay ?? minDelayTime;

            const timePassed = !lastNotified || (now - lastNotified) >= delay * 1000;

            if (timePassed) {
                this.lastRuleNotifiedMap[lastDetectionkey] = now;
            }

            return timePassed;
        } else if (type === 'OccupancyNotification') {
            const ruleName = matchRule.rule.name;
            const lastNotified = this.lastOccupancyRuleNotified[ruleName];
            const delay = 5;

            const timePassed = !lastNotified || (now - lastNotified) >= delay * 1000;

            if (timePassed) {
                this.lastOccupancyRuleNotified[ruleName] = now;
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
            if (this.isActiveForMqttReporting) {
                // The MQTT image should be updated only if:
                // - the image comes already from NVR and the user wants MQTT detections to be used

                if ((isFromNvr && parentImage) || isFromFrigate) {
                    const classnames = uniq(detections.map(d => d.className));
                    const { b64Image: b64ImageNew, image: imageNew } = await this.getImage({
                        detectionId,
                        eventId,
                        image: parentImage
                    });
                    image = imageNew;
                    b64Image = b64ImageNew;

                    logger.log(`NVR detections received, classnames ${classnames.join(', ')}. b64Image ${b64Image?.substring(0, 10)}`);
                }

                const mqttClient = await this.getMqttClient();

                if (mqttClient) {
                    let detectionsToUpdate = candidates;

                    // In case a non-NVR detection came in and user wants NVR detections to be used, just update the motion
                    if (useNvrDetectionsForMqtt && eventSource === ScryptedEventSource.RawDetection) {
                        logger.info(`Only updating motion, non-NVR detection incoming and using NVR detections for MQTT`);
                        detectionsToUpdate = [{ className: DetectionClass.Motion, score: 1 }];
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

                        if (b64Image) {
                            const timePassed = this.isDelayPassed({
                                classname: className,
                                label,
                                eventSource,
                                type: 'BasicDetection'
                            });

                            if (timePassed) {
                                logger.info(`Updating image for classname ${className} source: ${eventSource ? 'NVR' : 'Decoder'}`);

                                publishClassnameImages({
                                    mqttClient,
                                    console: logger,
                                    classnamesData: [{ classname: className, label }],
                                    device: this.cameraDevice,
                                    b64Image,
                                    image,
                                    triggerTime,
                                    imageSuffix: !isRawDetection ? eventSource : undefined,
                                    skipMqtt: !canUpdateMqttImage,
                                    storeImageFn: this.plugin.storeImage,
                                }).catch(logger.error);
                            }
                        }
                    }

                    this.resetDetectionEntities('Timeout').catch(logger.log);
                }
            }
        } catch (e) {
            logger.log('Error parsing detections', e);
        }

        let dataToReport = {};
        try {
            const matchRules: MatchRule[] = [];
            // const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;
            // let shouldMarkBoundaries = false;

            const rules = cloneDeep(this.runningDetectionRules.filter(rule => isFromNvr ? rule.isNvr : !rule.isNvr)) ?? [];
            logger.debug(`Detections incoming ${JSON.stringify({
                candidates,
                detect,
                minDelayTime,
                ignoreCameraDetections,
                rules,
            })}`);

            for (const ruleParent of rules) {
                const rule = ruleParent as DetectionRule
                const { detectionClasses, scoreThreshold, whitelistedZones, blacklistedZones } = rule;

                if (!detectionClasses.length || !rule.currentlyActive) {
                    return;
                }

                const match = candidates.find(d => {
                    if (ignoreCameraDetections && !d.boundingBox) {
                        return false;
                    }

                    const { className: classnameRaw, score, zones } = d;
                    const className = detectionClassesDefaultMap[classnameRaw];

                    if (!className) {
                        logger.log(`Classname ${classnameRaw} not mapped. Candidates ${JSON.stringify(candidates)}`);

                        return;
                    }

                    if (!detectionClasses.includes(className)) {
                        logger.debug(`Classname ${className} not contained in ${detectionClasses}`);
                        return false;
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
                        const canUpdateMqttImage = isFromNvr && rule.isNvr && this.isDelayPassed({ type: 'RuleImageUpdate', matchRule, eventSource });

                        if (this.isActiveForMqttReporting) {
                            logger.info(`Publishing detection rule ${matchRule.rule.name} data, b64Image ${b64Image?.substring(0, 10)} skipMqttImage ${!canUpdateMqttImage}`);

                            this.triggerRule({
                                rule,
                                b64Image,
                                device: this.cameraDevice,
                                triggerTime,
                                image,
                                skipMqttImage: !canUpdateMqttImage,
                            });
                        }

                        if (isFromNvr && rule.isNvr && this.isDelayPassed({ type: 'RuleNotification', matchRule, eventSource })) {
                            if (rule.ruleType === RuleType.Detection) {
                                logger.log(`Starting notifiers for detection rule ${rule.name}, b64Image ${b64Image?.substring(0, 10)}`);
                            }

                            this.plugin.matchDetectionFound({
                                triggerDeviceId: this.id,
                                match,
                                rule,
                                image,
                                eventType: EventType.ObjectDetection,
                                triggerTime,
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

    async startListeners() {
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
                if (data) {
                    const timestamp = Date.now();
                    const detections: ObjectDetectionResult[] = [{
                        className: 'motion',
                        score: 1,
                    }];
                    this.processDetections({ detect: { timestamp, detections }, eventSource: ScryptedEventSource.RawDetection }).catch(logger.log);
                } else {
                    this.resetDetectionEntities('MotionSensor').catch(logger.log);
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startListeners', e);
        }
    }

    async resetDetectionEntities(resetSource: 'MotionSensor' | 'Timeout') {
        const isFromSensor = resetSource === 'MotionSensor';
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();

        const funct = async () => {
            logger.log(`Reset detections signal coming from ${resetSource}`);

            await publishResetDetectionsEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger
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

    public async getTimelapseWebhookUrl(props: {
        ruleName: string,
        timelapseName: string,
    }) {
        const { ruleName, timelapseName } = props;
        const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        const [endpoint, parameters] = cloudEndpoint.split('?') ?? '';
        const { timelapseDownload, timelapseStream, timelapseThumbnail } = await getWebooks();
        const encodedName = encodeURIComponent(this.name);
        const encodedRuleName = encodeURIComponent(ruleName);

        const paramString = parameters ? `?${parameters}` : '';

        const streameUrl = `${endpoint}${timelapseStream}/${encodedName}/${encodedRuleName}/${timelapseName}${paramString}`;
        const downloadUrl = `${endpoint}${timelapseDownload}/${encodedName}/${encodedRuleName}/${timelapseName}${paramString}`;
        const thumbnailUrl = `${endpoint}${timelapseThumbnail}/${encodedName}/${encodedRuleName}/${timelapseName}${paramString}`;

        return { streameUrl, downloadUrl, thumbnailUrl };
    }

    async createFrameGenerator(options?: VideoFrameGeneratorOptions): Promise<AsyncGenerator<VideoFrame, any, unknown>> {
        const destination: MediaStreamDestination = 'local-recorder';
        // const model = this.plugin.storageSettings.values.objectDetectionDevice;
        const stream = await this.cameraDevice.getVideoStream({
            // prebuffer: model.prebuffer,
            destination,
        });

        const frameGenerator = getFrameGenerator();
        const videoFrameGenerator = systemManager.getDeviceById<VideoFrameGenerator>(frameGenerator);
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
