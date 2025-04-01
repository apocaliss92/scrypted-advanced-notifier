import sdk, { Camera, EventListenerRegister, FFmpegInput, Image, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionResult, ObjectDetector, ObjectsDetected, PanTiltZoom, PanTiltZoomCommand, Reboot, RequestPictureOptions, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, VideoFrame, VideoFrameGenerator, VideoFrameGeneratorOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep } from "lodash";
import { filterOverlappedDetections } from '../../scrypted-basic-object-detector/src/util';
import { RtpPacket } from "../../scrypted/external/werift/packages/rtp/src/rtp/rtp";
import { startRtpForwarderProcess } from '../../scrypted/plugins/webrtc/src/rtp-forwarders';
import { detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { publishOccupancy, publishRelevantDetections, publishResetDetectionsEntities, publishRuleData, reportDeviceValues, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { AudioRule, BaseRule, DetectionRule, DeviceInterface, EventType, ObserveZoneData, OccupancyRule, RuleSource, RuleType, TimelapseRule, ZoneMatchType, addBoundingBoxes, convertSettingsToStorageSettings, filterAndSortValidDetections, getAudioRulesSettings, getDetectionRulesSettings, getFrameGenerator, getMixinBaseSettings, getOccupancyRulesSettings, getRuleKeys, getTimelapseRulesSettings, getWebookUrls, getWebooks, isDeviceEnabled, pcmU8ToDb } from "./utils";

const { systemManager } = sdk;

interface MatchRule { match: ObjectDetectionResult, rule: (DetectionRule | TimelapseRule), dataToReport: any }
interface OccupancyData {
    lastOccupancy: boolean,
    occupancyToConfirm?: boolean,
    confirmationStart?: number,
    lastChange: number,
    lastCheck: number,
    objectsDetected: number,
    detectedResult: ObjectsDetected,
    image: MediaObject
}

export type OccupancyRuleData = {
    rule: OccupancyRule;
    occupies: boolean;
    image?: MediaObject;
    b64Image?: string;
    triggerTime: number;
};

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<string> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            isCamera: true,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of seconds to wait until a notification is sent for the same detection type',
            type: 'number',
            defaultValue: 15,
        },
        minSnapshotDelay: {
            subgroup: 'Notifier',
            title: 'Minimum snapshot acquisition delay',
            description: 'Minimum amount of seconds to wait until a new snapshot is taken from the camera',
            type: 'number',
            defaultValue: 5
        },
        motionDuration: {
            title: 'Off motion duration',
            type: 'number',
            defaultValue: 10
        },
        snapshotWidth: {
            subgroup: 'Notifier',
            title: 'Snapshot width',
            type: 'number',
            defaultValue: 1280,
            placeholder: '1280',
        },
        snapshotHeight: {
            subgroup: 'Notifier',
            title: 'Snapshot height',
            type: 'number',
            defaultValue: 720,
            placeholder: '720',
        },
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            description: 'If checked, the detections reported by the camera will be ignored. Make sure to have an object detector mixin enabled',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
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
        occupancyState: {
            json: true,
            hide: true,
        }
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    cameraDevice: DeviceInterface;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForAudioDetections: boolean;
    isActiveForMqttReporting: boolean;
    lastAutoDiscovery: number;
    isActiveForNvrNotifications: boolean;
    lastDetectionMap: Record<string, number> = {};
    logger: Console;
    killed: boolean;
    occupancyRules: OccupancyRule[] = [];
    detectionRules: DetectionRule[] = [];
    timelapseRules: TimelapseRule[] = [];
    audioRules: AudioRule[] = [];
    allTimelapseRules: TimelapseRule[] = [];
    nvrDetectionRules: DetectionRule[] = [];
    occupancyRulesDiscovered: string[] = [];
    audioListeners: Record<string, {
        inProgress: boolean;
        lastDetection?: number;
        lastNotification?: number;
        resetInterval?: NodeJS.Timeout;
    }> = {};
    detectionRuleListeners: Record<string, {
        disableNvrRecordingTimeout?: NodeJS.Timeout;
    }> = {};
    lastPicture?: MediaObject;
    lastPictureTaken: number;
    lastFrameAnalysis: number;
    lastObserveZonesFetched: number;
    observeZoneData: ObserveZoneData[];
    occupancyState: Record<string, OccupancyData> = {};
    timelapseLastCheck: Record<string, number> = {};
    latestFrame?: Buffer;
    audioForwarder: ReturnType<typeof startRtpForwarderProcess>;
    lastAudioDetected: number;
    processedDetectionIds: string[] = [];
    allRules: BaseRule[] = [];

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.storageSettings.settings.room.onGet = async () => {
            const rooms = this.plugin.storageSettings.getItem('fetchedRooms');
            return {
                choices: rooms ?? []
            }
        }
        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.storageSettings.getItem('fetchedEntities');
            return {
                choices: entities ?? []
            }
        }

        this.cameraDevice = systemManager.getDeviceById<DeviceInterface>(this.id);

        this.initValues().then().catch(logger.log);

        this.plugin.currentMixinsMap[this.name] = this;

        if (this.storageSettings.values.room && !this.room) {
            sdk.systemManager.getDeviceById<ScryptedDevice>(this.id).setRoom(this.storageSettings.values.room);
        }

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    public async startStop(enabled: boolean) {
        const logger = this.getLogger();

        if (enabled) {
            await this.startCheckInterval();
        } else {
            await this.release();
        }
    }

    async enableRecording(device: Settings, enabled: boolean) {
        await device.putSetting(`recording:privacyMode`, !enabled)
    }

    async startCheckInterval() {
        const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase & Settings & Reboot & PanTiltZoom>(this.id);
        const logger = this.getLogger();

        const funct = async () => {
            try {
                const {
                    isActiveForMqttReporting,
                    detectionRules,
                    nvrRules,
                    skippedDetectionRules,
                    isActiveForAudioDetections,
                    isActiveForNotifications,
                    isActiveForNvrNotifications,
                    occupancyRules,
                    skippedOccupancyRules,
                    allOccupancyRules,
                    allDetectionRules,
                    timelapseRules,
                    skippedTimelapseRules,
                    allTimelapseRules,
                    allAudioRules,
                    audioRules,
                    skippedAudioRules,
                } = await isDeviceEnabled({
                    device: this.cameraDevice,
                    console: logger,
                    plugin: this.plugin,
                    deviceStorage: this.storageSettings
                });

                const timelapseRulesToEnable = (timelapseRules || []).filter(newRule => !this.timelapseRules?.some(currentRule => currentRule.name === newRule.name));
                const timelapseRulesToDisable = (this.timelapseRules || []).filter(currentRule => !timelapseRules?.some(newRule => newRule.name === currentRule.name));

                const detectionRulesToEnable = (detectionRules || []).filter(newRule => !this.detectionRules?.some(currentRule => currentRule.name === newRule.name));
                const detectionRulesToDisable = (this.detectionRules || []).filter(currentRule => !detectionRules?.some(newRule => newRule.name === currentRule.name));

                const nvrDetectionRulesToEnable = (nvrRules || []).filter(newRule => !this.nvrDetectionRules?.some(currentRule => currentRule.name === newRule.name));
                const nvrDetectionRulesToDisable = (this.nvrDetectionRules || []).filter(currentRule => !nvrRules?.some(newRule => newRule.name === currentRule.name));

                const occupancyRulesToEnable = (occupancyRules || []).filter(newRule => !this.occupancyRules?.some(currentRule => currentRule.name === newRule.name));
                const occupancyRulesToDisable = (this.occupancyRules || []).filter(currentRule => !occupancyRules?.some(newRule => newRule.name === currentRule.name));

                const audioRulesToEnable = (audioRules || []).filter(newRule => !this.audioRules?.some(currentRule => currentRule.name === newRule.name));
                const audioRulesToDisable = (this.audioRules || []).filter(currentRule => !audioRules?.some(newRule => newRule.name === currentRule.name));

                logger.debug(`Detected rules: ${JSON.stringify({
                    detectionRules,
                    skippedDetectionRules,
                    occupancyRules,
                    skippedOccupancyRules,
                    nvrRules,
                    isActiveForMqttReporting,
                    isActiveForAudioDetections,
                    allDetectionRules,
                    timelapseRules,
                    skippedTimelapseRules,
                    timelapseRulesToEnable,
                    timelapseRulesToDisable,
                    detectionRulesToEnable,
                    detectionRulesToDisable,
                    audioRulesToEnable,
                    audioRulesToDisable,
                    skippedAudioRules,
                })}`);

                const rulesToEnable = [
                    ...detectionRulesToEnable,
                    ...nvrDetectionRulesToEnable,
                    ...occupancyRulesToEnable,
                    ...timelapseRulesToEnable,
                    ...audioRulesToEnable
                ];
                const rulesToDisable = [
                    ...detectionRulesToDisable,
                    ...nvrDetectionRulesToDisable,
                    ...occupancyRulesToDisable,
                    ...timelapseRulesToDisable,
                    ...audioRulesToDisable,
                ];
                const allRules = [
                    ...allDetectionRules,
                    ...allOccupancyRules,
                    ...allTimelapseRules,
                    ...allAudioRules,
                ];

                if (rulesToEnable?.length) {
                    for (const rule of rulesToEnable) {
                        const { ruleType, name } = rule;
                        logger.log(`${ruleType} rule started: ${name}`);

                        if (!rule.currentlyActive) {
                            if (ruleType === RuleType.Timelapse) {
                                await this.plugin.timelapseRuleStarted({
                                    rule,
                                    device,
                                    logger,
                                });
                            }
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        this.putMixinSetting(currentlyActiveKey, 'true');
                    }
                }

                if (rulesToDisable?.length) {
                    for (const rule of rulesToDisable) {
                        const { ruleType, name } = rule;
                        logger.log(`${ruleType} rule stopped: ${name}`);

                        if (ruleType === RuleType.Timelapse) {
                            this.plugin.timelapseRuleEnded({
                                rule,
                                device,
                                logger,
                            }).catch(logger.log);
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        this.putMixinSetting(currentlyActiveKey, 'false');
                    }
                }

                this.detectionRules = cloneDeep(detectionRules || []);
                this.nvrDetectionRules = cloneDeep(nvrRules || []);
                this.occupancyRules = cloneDeep(occupancyRules || []);
                this.timelapseRules = cloneDeep(timelapseRules || []);
                this.allTimelapseRules = cloneDeep(allTimelapseRules || []);
                this.audioRules = cloneDeep(audioRules || []);
                this.allRules = cloneDeep(allRules || []);

                this.isActiveForNotifications = isActiveForNotifications;
                this.isActiveForMqttReporting = isActiveForMqttReporting;

                const isCurrentlyRunning = !!this.detectionListener || !!this.motionListener;
                const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

                const now = Date.now();
                if (isActiveForMqttReporting) {
                    const mqttClient = await this.plugin.getMqttClient();
                    if (mqttClient) {

                        // Every 10 minutes repeat the autodiscovery
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 10) {

                            setupDeviceAutodiscovery({
                                mqttClient,
                                device,
                                console: logger,
                                withDetections: true,
                                deviceClass: 'motion',
                                rules: allRules,
                                rulesEnabled: rulesToEnable,
                            }).catch(logger.error);

                            logger.debug(`Subscribing to mqtt topics`);
                            subscribeToDeviceMqttTopics({
                                mqttClient,
                                rules: allRules,
                                device,
                                activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                    const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                    logger.debug(`Setting ${ruleType} rule ${ruleName} to ${active}`);
                                    await this.storageSettings.putSetting(`${enabledKey}`, active);
                                },
                                switchRecordingCb: async (active) => {
                                    logger.debug(`Setting NVR privacy mode to ${!active}`);
                                    await this.enableRecording(device, active);
                                },
                                rebootCb: device.interfaces.includes(ScryptedInterface.Reboot) ?
                                    async () => {
                                        logger.log(`Rebooting camera`);
                                        await device.reboot();
                                    } :
                                    undefined,
                                ptzCommandCb: device.interfaces.includes(ScryptedInterface.PanTiltZoom) ?
                                    (async (ptzCommand: PanTiltZoomCommand) => {
                                        logger.log(`Executing ptz command: ${JSON.stringify(ptzCommand)}`);

                                        if (ptzCommand.preset) {
                                            const presetId = Object.entries(device.ptzCapabilities?.presets ?? {}).find(([id, name]) => name === ptzCommand.preset)?.[0];
                                            if (presetId) {
                                                await device.ptzCommand({ preset: presetId });
                                            }
                                        } else {
                                            await device.ptzCommand(ptzCommand);
                                        }
                                    }) :
                                    undefined
                            }).catch(logger.error);

                            this.lastAutoDiscovery = now;
                        }

                        const settings = await this.mixinDevice.getSettings();
                        const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;

                        reportDeviceValues({ console: logger, device, mqttClient, isRecording, rulesToEnable, rulesToDisable }).catch(logger.error);
                    }
                }

                if (isCurrentlyRunning && !shouldRun) {
                    logger.log('Stopping and cleaning listeners.');
                    this.resetListeners();
                } else if (!isCurrentlyRunning && shouldRun) {
                    logger.log(`Starting ${ScryptedInterface.ObjectDetector}/${ScryptedInterface.MotionSensor} listener: ${JSON.stringify({
                        Notifications: isActiveForNotifications,
                        MQTT: isActiveForMqttReporting,
                    })}`);
                    await this.startListeners();
                }

                if (isActiveForNvrNotifications && !this.isActiveForNvrNotifications) {
                    logger.log(`Starting NVR events listener`);
                } else if (!isActiveForNvrNotifications && this.isActiveForNvrNotifications) {
                    logger.log(`Stopping NVR events listener`);
                }

                if (isActiveForMqttReporting) {
                    await this.checkOutdatedRules();
                }

                if (isActiveForAudioDetections && !this.isActiveForAudioDetections) {
                    logger.log(`Starting Audio listener`);
                    await this.startAudioDetection();
                } else if (!isActiveForAudioDetections && this.isActiveForAudioDetections) {
                    logger.log(`Stopping Audio listener`);
                    this.stopAudioListener();
                }

                this.isActiveForNvrNotifications = isActiveForNvrNotifications;
                this.isActiveForAudioDetections = isActiveForAudioDetections;


                const { entityId } = this.storageSettings.values;
                if (this.plugin.storageSettings.values.haEnabled && entityId && !this.plugin.storageSettings.values.fetchedEntities.includes(entityId)) {
                    logger.debug(`Entity id ${entityId} does not exists on HA`);
                }

                this.processedDetectionIds = [];
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    if (this.plugin.getMqttClient()) {
                        await funct();
                    }
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
            }
        }, 10000);
    }

    resetAudioRule(ruleName: string, lastNotification?: number) {
        const resetInterval = this.audioListeners[ruleName]?.resetInterval;
        resetInterval && clearInterval(resetInterval);
        this.audioListeners[ruleName] = { inProgress: false, resetInterval: undefined, lastDetection: undefined, lastNotification };
    }

    stopAudioListener() {
        this.audioForwarder?.then(f => f.kill());
        this.audioForwarder = undefined;

        for (const ruleName of Object.keys(this.audioListeners)) {
            this.resetAudioRule(ruleName);
        }
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
        this.resetMqttTimeout();
    }

    async initValues() {
        const logger = this.getLogger();
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
        this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);

        await this.refreshSettings();
    }

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
            onRuleToggle: async (ruleName: string, active: boolean) => {
                await this.plugin.updateActivationRuleOnMqtt({
                    active,
                    logger,
                    ruleName,
                    deviceId: this.id,
                    ruleType: RuleType.Detection
                });
            },
        });
        dynamicSettings.push(...detectionRulesSettings);

        const occupancyRulesSettings = await getOccupancyRulesSettings({
            storage: this.storageSettings,
            zones,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
            onRuleToggle: async (ruleName: string, active: boolean) => {
                await this.plugin.updateActivationRuleOnMqtt({
                    active,
                    logger,
                    ruleName,
                    deviceId: this.id,
                    ruleType: RuleType.Occupancy
                });
            },
        });
        dynamicSettings.push(...occupancyRulesSettings);

        const timelapseRulesSettings = await getTimelapseRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
            onCleanDataTimelapse: async (ruleName) => {
                const rule = this.allTimelapseRules?.find(rule => rule.name === ruleName);

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
                this.console.log(ruleName, this.allTimelapseRules);
                const rule = this.allTimelapseRules?.find(rule => rule.name === ruleName);

                if (rule) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);
                    this.plugin.timelapseRuleEnded({
                        rule,
                        device,
                        logger,
                    }).catch(logger.log);
                }
            },
            onRuleToggle: async (ruleName: string, active: boolean) => {
                await this.plugin.updateActivationRuleOnMqtt({
                    active,
                    logger,
                    ruleName,
                    deviceId: this.id,
                    ruleType: RuleType.Timelapse
                });
            },
        });
        dynamicSettings.push(...timelapseRulesSettings);

        const audioRulesSettings = await getAudioRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            onShowMore: this.refreshSettings.bind(this),
            onRuleToggle: async (ruleName: string, active: boolean) => {
                await this.plugin.updateActivationRuleOnMqtt({
                    active,
                    logger,
                    ruleName,
                    deviceId: this.id,
                    ruleType: RuleType.Audio
                });
            },
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

        this.occupancyState = this.storageSettings.values.occupancyState ?? {};
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

            const zoneNames = zonesSetting.filter(zone => {
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
            this.getLogger().log('Error in getObserveZones', e);
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
        this.killed = true;
        this.resetListeners();
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
    }

    private getLogger() {
        const deviceConsole = this.console;

        if (!this.logger) {
            const log = (type: 'log' | 'error' | 'debug' | 'warn', message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (type !== 'debug' || this.storageSettings.getItem('debug')) {
                    deviceConsole.log(` ${now} - `, message, ...optionalParams);
                }
            };
            this.logger = {
                log: (message?: any, ...optionalParams: any[]) => log('log', message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log('debug', message, ...optionalParams),
                error: (message?: any, ...optionalParams: any[]) => log('error', message, ...optionalParams),
                warn: (message?: any, ...optionalParams: any[]) => log('warn', message, ...optionalParams),
            } as Console
        }

        return this.logger;
    }

    async reportDetectionsToMqtt(props: {
        detections: ObjectDetectionResult[],
        triggerTime: number,
        logger: Console,
        device: ScryptedDeviceBase,
        b64Image?: string
        image?: MediaObject
    }) {
        const { detections, device, logger, triggerTime, b64Image, image } = props;
        const { room: settingRoom, motionDuration } = this.storageSettings.values;
        const room = device.room ?? settingRoom;

        const mqttClient = await this.plugin.getMqttClient();

        if (mqttClient) {
            try {
                publishRelevantDetections({
                    mqttClient,
                    console: logger,
                    detections,
                    device,
                    triggerTime,
                    b64Image,
                    image,
                    room,
                    storeImageFn: this.plugin.storeImage
                }).catch(logger.error);
            } catch (e) {
                logger.log(`Error in reportDetectionsToMqtt`, e);
            }

            this.resetMqttTimeout();
            this.mqttDetectionMotionTimeout = setTimeout(async () => {
                publishResetDetectionsEntities({
                    mqttClient,
                    device,
                    allRules: this.allRules
                }).catch(logger.error);
            }, motionDuration * 1000);
        }
    }

    async triggerRule(props: { rule: BaseRule, device: DeviceInterface, b64Image?: string, image?: MediaObject, triggerTime: number }) {
        const logger = this.getLogger();

        try {
            const { rule, b64Image, device, triggerTime, image } = props;

            const mqttClient = await this.plugin.getMqttClient();
            if (mqttClient) {
                try {
                    publishRuleData({
                        mqttClient,
                        device,
                        triggerValue: true,
                        console: logger,
                        b64Image,
                        image,
                        rule,
                        triggerTime,
                        storeImageFn: this.plugin.storeImage
                    }).catch(logger.error);
                } catch (e) {
                    logger.log(`Error in triggerRule`, e);
                }
            }

            if (rule.ruleType === RuleType.Detection) {
                const { disableNvrRecordingSeconds, name } = rule as DetectionRule;
                if (disableNvrRecordingSeconds !== undefined) {
                    const seconds = Number(disableNvrRecordingSeconds);

                    logger.log(`Enabling NVR recordings for ${seconds} seconds`);
                    await this.enableRecording(device, true);

                    if (!this.detectionRuleListeners[name]) {
                        this.detectionRuleListeners[name] = {};
                    }

                    if (this.detectionRuleListeners[name].disableNvrRecordingTimeout) {
                        clearTimeout(this.detectionRuleListeners[name].disableNvrRecordingTimeout);
                        this.detectionRuleListeners[name].disableNvrRecordingTimeout = undefined;
                    }

                    this.detectionRuleListeners[name].disableNvrRecordingTimeout = setTimeout(async () => {
                        logger.log(`Disabling NVR recordings`);
                        await this.enableRecording(device, false);
                    }, seconds * 1000);
                }
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

    private async getImage(reason: RequestPictureOptions['reason'] = 'event') {
        const now = Date.now();
        const { minSnapshotDelay } = this.storageSettings.values;
        try {
            // Images within 0.5 seconds are very recent
            const isVeryRecent = this.lastPicture && this.lastPictureTaken && (now - this.lastPictureTaken) >= 500;
            const timePassed = !this.lastPictureTaken || (now - this.lastPictureTaken) >= 1000 * minSnapshotDelay;

            let image: MediaObject;
            let bufferImage: Buffer;
            let b64Image: string;

            if (isVeryRecent) {
                image = this.lastPicture;
            } else if (timePassed) {
                const objectDetector = this.getObjectDetector();
                image = await objectDetector.takePicture({
                    reason,
                    timeout: 10000,
                    // picture: {
                    //     height: this.storageSettings.values.snapshotHeight,
                    //     width: this.storageSettings.values.snapshotWidth,
                    // },
                });
                this.lastPictureTaken = Date.now();
                this.lastPicture = image;
            }

            if (image) {
                bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
                b64Image = bufferImage?.toString('base64');
            }

            return { image, b64Image, bufferImage };
        } catch (e) {
            this.getLogger().log('Error taking a picture in camera mixin', e);
            return {};
        }
    }

    async startAudioDetection() {
        const logger = this.getLogger();
        if (this.audioForwarder) {
            this.stopAudioListener();
        }

        const mo = await this.cameraDevice.getVideoStream({
            video: null,
            audio: {},
        });
        const ffmpegInput = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);

        const fp = startRtpForwarderProcess(logger, ffmpegInput, {
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
                    if (decibels > 2) {
                        this.processAudioDetection({ decibels }).catch(logger.error);
                    }
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
        });
    }

    async checkOutdatedRules() {
        const now = new Date().getTime();
        const logger = this.getLogger();

        const anyOutdatedOccupancyRule = this.occupancyRules.some(rule => {
            const { forceUpdate, name } = rule;
            const currentState = this.occupancyState[name];
            const shouldForceFrame = !currentState || (now - (currentState?.lastCheck ?? 0)) >= (1000 * forceUpdate);

            logger.debug(`Should force update occupancy: ${JSON.stringify({
                shouldForceFrame,
                lastCheck: currentState?.lastCheck,
                forceUpdate,
                now,
                name
            })}`);

            return shouldForceFrame;
        });

        const timelapsesToRefresh = (this.timelapseRules || []).filter(rule => {
            const { regularSnapshotInterval, name } = rule;
            const lastCheck = this.timelapseLastCheck[name];
            const shouldForceFrame = !lastCheck || (now - (lastCheck ?? 0)) >= (1000 * regularSnapshotInterval);

            logger.debug(`Should force timelapse frame: ${JSON.stringify({
                shouldForceFrame,
                lastCheck,
                regularSnapshotInterval,
                now,
                name
            })}`);

            return shouldForceFrame;
        });
        const anyTimelapseToRefresh = timelapsesToRefresh.length;

        if (anyOutdatedOccupancyRule || anyTimelapseToRefresh) {
            const { image } = await this.getImage('periodic');
            if (image) {
                if (anyOutdatedOccupancyRule) {
                    logger.debug('Forcing update of occupancy data');
                    this.checkOccupancyData(image).catch(logger.log);
                }

                if (anyTimelapseToRefresh) {
                    const device = systemManager.getDeviceById<DeviceInterface>(this.id);

                    for (const rule of timelapsesToRefresh) {
                        logger.debug(`Forcing timelapse image for rule ${rule.name}: ${JSON.stringify({
                            timestamp: now,
                            id: this.id
                        })}`);
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

    async checkOccupancyData(imageParent: MediaObject) {
        if (!imageParent) {
            return;
        }
        const logger = this.getLogger();

        try {
            const now = new Date().getTime();

            const mqttClient = await this.plugin.getMqttClient();

            const occupancyRulesDataMap: Record<string, OccupancyRuleData> = {};
            const zonesData = await this.getObserveZones();

            let objectDetectorParent: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            if (!objectDetectorParent) {
                logger.log(`No detection plugin selected. skipping occupancy`);
                return;
                // logger.log(`No detection plugin selected. Defaulting to first one`);
                // objectDetectorParent = systemManager.getDeviceById<ObjectDetection>(
                //     this.plugin.storageSettings.settings.objectDetectionDevice.choices[0]
                // );
            }

            const detectedResultParent = await objectDetectorParent.detectObjects(imageParent);

            if (objectDetectorParent.name !== 'Scrypted NVR Object Detection') {
                detectedResultParent.detections = filterOverlappedDetections(detectedResultParent.detections);
            }

            for (const occupancyRule of this.occupancyRules) {
                const { name, zoneType, observeZone, scoreThreshold, detectionClass, maxObjects, objectDetector: ruleObjectDetector, captureZone } = occupancyRule;

                let objectDetector = objectDetectorParent;
                let detectedResult = detectedResultParent;

                if (ruleObjectDetector) {
                    objectDetector = systemManager.getDeviceById<ObjectDetection & ScryptedDeviceBase>(ruleObjectDetector);
                }
                let imageToUse = imageParent;

                if (captureZone?.length >= 3) {
                    const zone = zonesData.find(zoneData => zoneData.name === observeZone)?.path;
                    const image = await sdk.mediaManager.convertMediaObject<Image>(imageParent, ScryptedMimeTypes.Image);
                    let left = image.width;
                    let top = image.height;
                    let right = 0;
                    let bottom = 0;
                    for (const point of zone) {
                        left = Math.min(left, point[0]);
                        top = Math.min(top, point[1]);
                        right = Math.max(right, point[0]);
                        bottom = Math.max(bottom, point[1]);
                    }

                    left = left * image.width;
                    top = top * image.height;
                    right = right * image.width;
                    bottom = bottom * image.height;

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
                    width = Math.min(width, image.width - left);
                    height = Math.min(height, image.height - top);

                    const cropped = await image.toImage({
                        crop: {
                            left,
                            top,
                            width,
                            height,
                        },
                    });
                    imageToUse = cropped;
                    detectedResult = await objectDetector.detectObjects(cropped);

                    if (objectDetector.name !== 'Scrypted NVR Object Detection') {
                        detectedResult.detections = filterOverlappedDetections(detectedResult.detections);
                    }

                    // adjust the origin of the bounding boxes for the crop.
                    for (const d of detectedResult.detections) {
                        d.boundingBox[0] += left;
                        d.boundingBox[1] += top;
                    }
                    detectedResult.inputDimensions = [image.width, image.height];
                } else if (ruleObjectDetector && !detectedResult) {
                    detectedResult = await objectDetector.detectObjects(imageParent);
                }

                let objectsDetected = 0;

                for (const detection of detectedResult.detections) {
                    const className = detectionClassesDefaultMap[detection.className];
                    if (detection.score >= scoreThreshold && detectionClass === className) {
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

                this.occupancyState[name] = {
                    ...this.occupancyState[name] ?? {} as OccupancyData,
                    objectsDetected,
                    detectedResult,
                    image: imageToUse
                };

                const existingRule = occupancyRulesDataMap[name];
                if (!existingRule) {
                    occupancyRulesDataMap[name] = {
                        rule: occupancyRule,
                        occupies,
                        triggerTime: now
                    }
                } else if (!existingRule.occupies && occupies) {
                    existingRule.occupies = true;
                }
            }

            const occupancyRulesData: OccupancyRuleData[] = [];
            const rulesToNotNotify: string[] = [];
            for (const occupancyRuleData of Object.values(occupancyRulesDataMap)) {
                const { name, changeStateConfirm } = occupancyRuleData.rule;
                const currentState = this.occupancyState[occupancyRuleData.rule.name];
                const tooOld = currentState && (now - (currentState?.lastChange ?? 0)) >= (1000 * 60 * 60 * 1); // Force an update every hour
                const toConfirm = currentState.occupancyToConfirm != undefined && !!currentState.confirmationStart;

                let occupancyData: Partial<OccupancyData> = {
                    lastCheck: now
                }
                const logPayload: any = {
                    occupancyRuleData,
                    currentState,
                    tooOld,
                };

                // If the zone is not inizialized or last state change is too old, proceed with update regardless
                const image = this.occupancyState[name].image;
                const b64Image = (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64')
                if (!currentState || tooOld) {
                    logger.debug(`Force pushing rule ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);
                    occupancyRulesData.push({
                        ...occupancyRuleData,
                        image,
                        b64Image,
                        triggerTime: now,
                    });

                    occupancyData = {
                        ...occupancyData,
                        lastChange: now,
                        lastOccupancy: occupancyRuleData.occupies,
                    };

                    // Avoid sending a notification if it's just a force updated due to time elpased
                    if (currentState) {
                        rulesToNotNotify.push(occupancyRuleData.rule.name);
                    }
                } else if (toConfirm) {
                    const isConfirmationTimePassed = (now - (currentState?.confirmationStart ?? 0)) >= (1000 * changeStateConfirm);
                    const isStateConfirmed = occupancyRuleData.occupies === currentState.occupancyToConfirm;

                    // If confirmation time is not done but value is changed, discard new state
                    if (!isConfirmationTimePassed) {
                        if (isStateConfirmed) {
                            // Do nothing and wait for next iteration
                            logger.debug(`Confirmation time is not passed yet ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);
                        } else {
                            // Reset confirmation data because the value changed before confirmation time passed
                            logger.log(`Confirmation failed, value changed during confirmation time ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);

                            occupancyData = {
                                ...occupancyData,
                                confirmationStart: undefined,
                                occupancyToConfirm: undefined,
                            };
                        }
                    } else {
                        if (isStateConfirmed) {
                            // Time is passed and value didn't change, update the state
                            occupancyRulesData.push({
                                ...occupancyRuleData,
                                image,
                                b64Image,
                                triggerTime: currentState.confirmationStart,
                            });

                            occupancyData = {
                                ...occupancyData,
                                lastChange: now,
                                lastOccupancy: occupancyRuleData.occupies,
                                confirmationStart: undefined,
                                occupancyToConfirm: undefined,
                            };

                            const stateActuallyChanged = occupancyRuleData.occupies !== currentState.lastOccupancy;

                            if (!stateActuallyChanged) {
                                rulesToNotNotify.push(occupancyRuleData.rule.name);
                            } else {
                                logger.log(`Confirming occupancy rule ${occupancyRuleData.rule.name}: ${JSON.stringify({
                                    occupancyRuleData,
                                    currentState,
                                    logPayload,
                                })}`);
                            }
                        } else {
                            // Time is passed and value changed, restart confirmation flow
                            occupancyData = {
                                ...occupancyData,
                                confirmationStart: now,
                                occupancyToConfirm: occupancyRuleData.occupies
                            };

                            logger.debug(`Restarting confirmation flow for occupancy rule ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);
                        }
                    }
                } else if (occupancyRuleData.occupies !== currentState.lastOccupancy) {
                    logger.debug(`Marking the rule to confirm for next iteration ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);

                    occupancyData = {
                        ...occupancyData,
                        confirmationStart: now,
                        occupancyToConfirm: occupancyRuleData.occupies
                    };
                } else {
                    logger.debug(`Refreshing lastCheck only for rule ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);
                }

                this.occupancyState[name] = {
                    ...this.occupancyState[name],
                    ...occupancyData
                };
            }

            await this.storageSettings.putSetting('occupancyState', JSON.stringify(this.occupancyState));

            if (this.isActiveForMqttReporting && detectedResultParent) {
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
                const currentState = this.occupancyState[rule.name];

                if (!rulesToNotNotify.includes(rule.name)) {
                    let message = occupancyRuleData.occupies ?
                        rule.zoneOccupiedText :
                        rule.zoneNotOccupiedText;

                    if (message) {
                        message = message.toString()
                            .replace('${detectedObjects}', String(currentState.objectsDetected) ?? '')
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
        if (this.isActiveForAudioDetections) {
            logger.log(`Audio detection: ${decibels} dB`);
            const rules = cloneDeep((this.audioRules) ?? []);
            const now = Date.now();

            const { image, b64Image } = await this.getImage();

            for (const rule of rules) {
                const { name, audioDuration, decibelThreshold, customText, minDelay } = rule;
                const { lastDetection, inProgress, lastNotification } = this.audioListeners[name] ?? {};
                const isThresholdMet = decibels >= decibelThreshold;
                const isTimePassed = !audioDuration || (lastDetection && (now - lastDetection) > audioDuration);
                const isTimeForNotificationPassed = !minDelay || (lastNotification && (now - lastNotification) > minDelay);

                logger.debug(`Audio rule: ${JSON.stringify({
                    name,
                    isThresholdMet,
                    isTimePassed,
                    inProgress,
                    audioDuration,
                    decibelThreshold,
                })}`);
                const currentDuration = lastDetection ? (now - lastDetection) / 1000 : 0;

                if (inProgress || !audioDuration) {
                    if (isThresholdMet) {
                        if (isTimePassed && isTimeForNotificationPassed) {
                            logger.debug(`Audio rule ${name} passed: ${JSON.stringify({ currentDuration, decibels })}`);
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

                            if (this.isActiveForMqttReporting) {
                                this.triggerRule({
                                    rule,
                                    b64Image,
                                    device: this.cameraDevice,
                                    triggerTime: now,
                                    image
                                });
                            }

                            this.resetAudioRule(name, now);
                        } else {
                            logger.log(`Audio rule ${name} still in progress ${currentDuration} seconds`);
                            // Do nothing and wait for next detection
                        }
                    } else {
                        logger.log(`Audio rule ${name} didn't hold the threshold, resetting after ${currentDuration} seconds`);
                        this.resetAudioRule(name);
                    }
                } else if (isThresholdMet) {
                    logger.log(`Audio rule ${name} started`);
                    this.audioListeners[name] = {
                        inProgress: true,
                        lastDetection: now,
                        resetInterval: undefined,
                    };
                    // const resetInterval = setInterval(() => {
                    //     if (!this.audioDetected)
                    //         return;
                    //     if (Date.now() - lastAudio < this.storageSettings.values.audioTimeout * 1000)
                    //         return;
                    //     this.audioDetected = false;
                    // }, this.storageSettings.values.audioTimeout * 1000);
                }

            }
        }
    }

    public async processDetections(props: {
        detections: ObjectDetectionResult[],
        triggerTime: number,
        isFromNvr: boolean,
        image?: MediaObject
    }) {
        const device = systemManager.getDeviceById<DeviceInterface>(this.id);
        const { detections, triggerTime, isFromNvr, image: parentImage } = props;
        const logger = this.getLogger();

        if (!detections?.length) {
            return;
        }

        const now = new Date().getTime();

        const {
            minDelayTime,
            ignoreCameraDetections,
            minSnapshotDelay
        } = this.storageSettings.values;

        const { candidates, ids } = filterAndSortValidDetections({
            detections: detections ?? [],
            logger,
            processedIds: []
            // processedIds: this.processedDetectionIds ?? []
        });
        this.processedDetectionIds.push(...ids);

        let image: MediaObject;
        let b64Image: string;

        if (this.isActiveForMqttReporting) {
            const { useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;
            if (isFromNvr && parentImage && useNvrDetectionsForMqtt) {
                image = parentImage;
                b64Image = (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64');
            } else if (!image) {
                const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                image = imageNew;
                b64Image = b64ImageNew;
            }

            const isSleeping = this.cameraDevice.sleeping || !this.cameraDevice.online;

            if (image && !isSleeping) {
                this.checkOccupancyData(image).catch(logger.log);
            }

            this.reportDetectionsToMqtt({ detections: candidates, triggerTime, logger, device, b64Image, image }).catch(logger.error);
        }

        let dataToReport = {};
        try {
            logger.debug(`Detections incoming ${JSON.stringify({
                candidates, detections, minDelayTime,
                ignoreCameraDetections
            })}`);

            const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            const matchRules: MatchRule[] = [];
            let shouldMarkBoundaries = false;

            const rules: (DetectionRule | TimelapseRule)[] = cloneDeep((isFromNvr ? this.nvrDetectionRules : this.detectionRules) ?? []);
            rules.push(...cloneDeep(this.timelapseRules ?? []));
            for (const ruleParent of rules) {
                if (ruleParent.ruleType === RuleType.Detection) {
                    const rule = ruleParent as DetectionRule
                    const { detectionClasses, scoreThreshold, whitelistedZones, blacklistedZones } = rule;

                    if (!detectionClasses.length) {
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
                        matchRules.push({ match, rule, dataToReport });
                        if (rule.markDetections) {
                            shouldMarkBoundaries = true;
                        }
                    }
                } else {
                    if (ruleParent.ruleType === RuleType.Timelapse) {
                        const rule = ruleParent as TimelapseRule;
                        matchRules.push({ match: candidates[0], rule, dataToReport: {} });
                    }
                }
            }

            let imageToNotify = parentImage ?? image;

            let markedImage: MediaObject;
            let markedb64Image: string;
            if (!!matchRules.length) {
                let bufferImage: Buffer;

                if (!imageToNotify) {
                    const { b64Image: b64ImageNew, image: imageNew, bufferImage: bufferImageNew } = await this.getImage();
                    imageToNotify = imageNew;
                    b64Image = b64ImageNew;
                    bufferImage = bufferImageNew;
                }

                if (imageToNotify) {
                    const imageUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(imageToNotify, 'image/jpg');
                    logger.debug(`Updating webook last image URL: ${imageUrl}`);
                    this.storageSettings.putSetting('lastSnapshotImageUrl', imageUrl);
                }

                if (shouldMarkBoundaries && !!objectDetector) {
                    const detectionResult = await objectDetector.detectObjects(imageToNotify);

                    if (objectDetector.name !== 'Scrypted NVR Object Detection') {
                        detectionResult.detections = filterOverlappedDetections(detectionResult.detections);
                    }

                    const { newB64Image, newImage } = await addBoundingBoxes(b64Image, detectionResult.detections);
                    markedb64Image = newB64Image;
                    markedImage = newImage;
                }
            }

            for (const matchRule of matchRules) {
                try {
                    const { match, rule } = matchRule;
                    const lastDetectionkey = this.getLastDetectionkey(matchRule);
                    const lastDetection = this.lastDetectionMap[lastDetectionkey];
                    const delay = rule.minDelay ?? minDelayTime;
                    if (lastDetection && (now - lastDetection) < 1000 * delay) {
                        logger.debug(`Waiting for delay: ${delay - ((now - lastDetection) / 1000)}s`);
                        return false;
                    }
                    this.lastDetectionMap[lastDetectionkey] = now;

                    let imageToUse = imageToNotify;
                    let b64ImageToUse = b64Image;

                    if (rule.ruleType === RuleType.Detection && (rule as DetectionRule).markDetections && markedImage) {
                        imageToUse = markedImage;
                        b64ImageToUse = markedb64Image;
                    }

                    logger.debug(`Matching detections found: ${JSON.stringify({
                        matchRulesMap: matchRules,
                        candidates,
                        b64ImageToUse,
                        imageToUse: !!imageToUse,
                        parentImage: !!parentImage
                    })}`);

                    if (rule.ruleType === RuleType.Detection) {
                        if (this.isActiveForMqttReporting) {
                            this.triggerRule({ rule, b64Image: b64ImageToUse, device, triggerTime, image: imageToUse });
                        }

                        logger.log(`Starting notifiers: ${JSON.stringify({
                            match,
                            rule,
                            eventType: EventType.ObjectDetection,
                            triggerTime,
                        })})}`);
                    }

                    this.plugin.matchDetectionFound({
                        triggerDeviceId: this.id,
                        match,
                        rule,
                        image: imageToUse,
                        logger,
                        eventType: EventType.ObjectDetection,
                        triggerTime,
                    });

                } catch (e) {
                    logger.log(`Error processing matchRule ${JSON.stringify(matchRule)}`, e);
                }
            }
        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }

    resetMqttTimeout() {
        this.mqttDetectionMotionTimeout && clearInterval(this.mqttDetectionMotionTimeout);
        this.mqttDetectionMotionTimeout = undefined;
    }

    async startListeners() {
        try {
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data) => {
                const detection: ObjectsDetected = data;

                const { timestamp } = detection;

                this.processDetections({ detections: detection.detections, triggerTime: timestamp, isFromNvr: false })
            });
            this.motionListener = systemManager.listenDevice(this.id, ScryptedInterface.MotionSensor, async (_, __, data) => {
                if (data) {
                    const timestamp = Date.now();
                    const detection: ObjectDetectionResult = {
                        className: 'motion',
                        score: 1,
                    }
                    this.processDetections({ detections: [detection], triggerTime: timestamp, isFromNvr: false })
                } else {
                    this.resetMqttTimeout();
                    const mqttClient = await this.plugin.getMqttClient();
                    const logger = this.getLogger();

                    publishResetDetectionsEntities({
                        mqttClient,
                        device: this.cameraDevice,
                        allRules: this.allRules
                    }).catch(logger.error);
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startListeners', e);
        }
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
        const model = this.plugin.storageSettings.values.objectDetectionDevice;
        const stream = await this.cameraDevice.getVideoStream({
            prebuffer: model.prebuffer,
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
