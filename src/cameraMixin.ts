import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ObjectDetector, MotionSensor, ScryptedDevice, ObjectsDetected, Camera, MediaObject, ObjectDetectionResult, ScryptedDeviceBase, ObjectDetection, Image, ScryptedMimeTypes, Notifier } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionRule, detectionRulesGroup, DetectionRuleSource, DeviceInterface, detectRuleEnabledRegex, occupancyRuleEnabledRegex, EventType, filterAndSortValidDetections, getDetectionRuleKeys, getDetectionRulesSettings, getMixinBaseSettings, getOccupancyRuleKeys, getOccupancyRulesSettings, getWebookUrls, isDeviceEnabled, ObserveZoneData, OccupancyRule, occupancyRulesGroup, ZoneMatchType, TimelapseRule, getTimelapseRulesSettings, timelapseRulesGroup, RuleType, getWebooks, timelapseRuleGenerateRegex, BaseRule, timelapseRuleCleanRegex } from "./utils";
import { detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { discoverDetectionRules, discoverOccupancyRules, getDetectionRuleId, getOccupancyRuleId, publishDeviceState, publishOccupancy, publishRelevantDetections, reportDeviceValues, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { cloneDeep } from "lodash";

const { systemManager } = sdk;
const secondsPerPicture = 5;
const motionDuration = 10;

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
};

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, true, true),
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of seconds to wait until a notification is sent for the same detection type',
            type: 'number',
            defaultValue: 15,
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
            description: 'If checked, only the detections coming from NVR will be used',
            type: 'boolean',
            subgroup: 'Notifier',
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
    });

    detectionListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForMqttReporting: boolean;
    mainAutodiscoveryDone: boolean;
    isActiveForNvrNotifications: boolean;
    mqttReportInProgress: boolean;
    lastDetectionMap: Record<string, number> = {};
    logger: Console;
    killed: boolean;
    nvrEnabled: boolean = true;
    nvrMixinId: string;
    occupancyRules: OccupancyRule[] = [];
    detectionRules: DetectionRule[] = [];
    timelapseRules: TimelapseRule[] = [];
    allTimelapseRules: TimelapseRule[] = [];
    nvrDetectionRules: DetectionRule[] = [];
    rulesDiscovered: string[] = [];
    occupancyRulesDiscovered: string[] = [];
    detectionClassListeners: Record<string, {
        motionTimeout: NodeJS.Timeout;
        motionListener: EventListenerRegister
    }> = {};
    detectionRuleListeners: Record<string, {
        disableNvrRecordingTimeout?: NodeJS.Timeout;
    }> = {};
    lastPictureTaken: number;
    lastFrameAnalysis: number;
    lastObserveZonesFetched: number;
    observeZoneData: ObserveZoneData[];
    occupancyState: Record<string, OccupancyData> = {};
    timelapseLastCheck: Record<string, number> = {};

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

        this.nvrMixinId = systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

        const canUseNvr = this.nvrMixinId && this.mixins.includes(this.nvrMixinId);
        this.nvrEnabled = canUseNvr;

        this.initValues().then().catch(logger.log);
        this.startCheckInterval().then().catch(logger.log);

        this.plugin.currentMixinsMap[this.name] = this;

        this.occupancyState = this.storageSettings.values.occupancyState ?? {};

        if (this.storageSettings.values.room && !this.room) {
            sdk.systemManager.getDeviceById<ScryptedDevice>(this.id).setRoom(this.storageSettings.values.room);
        }
    }

    async enableRecording(device: Settings, enabled: boolean) {
        await device.putSetting(`recording:privacyMode`, !enabled)
    }

    async startCheckInterval() {
        const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase & Settings>(this.id);
        const logger = this.getLogger();

        const funct = async () => {
            try {
                const deviceSettings = await this.getMixinSettings();
                const {
                    isActiveForMqttReporting,
                    isPluginEnabled,
                    detectionRules,
                    nvrRules,
                    skippedRules,
                    isActiveForNotifications,
                    isActiveForNvrNotifications,
                    occupancyRules,
                    skippedOccupancyRules,
                    allOccupancyRules,
                    allPossibleRules,
                    timelapseRules,
                    skippedTimelapseRules,
                } = await isDeviceEnabled(this.id, deviceSettings, this.plugin, logger);

                const timelapseRulesToEnable = (timelapseRules || []).filter(newRule => !this.timelapseRules?.some(currentRule => currentRule.name === newRule.name));
                const timelapseRulesToDisable = (this.timelapseRules || []).filter(currentRule => !timelapseRules?.some(newRule => newRule.name === currentRule.name));

                const detectionRulesToEnable = (detectionRules || []).filter(newRule => !this.detectionRules?.some(currentRule => currentRule.name === newRule.name));
                const detectionRulesToDisable = (this.detectionRules || []).filter(currentRule => !detectionRules?.some(newRule => newRule.name === currentRule.name));

                logger.debug(`Detected rules: ${JSON.stringify({
                    detectionRules,
                    skippedRules,
                    occupancyRules,
                    skippedOccupancyRules,
                    nvrRules,
                    isActiveForMqttReporting,
                    allPossibleRules,
                    timelapseRules,
                    skippedTimelapseRules,
                    timelapseRulesToEnable,
                    timelapseRulesToDisable,
                    detectionRulesToEnable,
                    detectionRulesToDisable,
                })}`);

                if (detectionRulesToEnable?.length) {
                    logger.log(`Detection rules started: ${detectionRulesToEnable.map(rule => rule.name).join(', ')}`);
                }

                if (detectionRulesToDisable?.length) {
                    logger.log(`Detection rules stopped: ${detectionRulesToDisable.map(rule => rule.name).join(', ')}`);
                }

                if (timelapseRulesToEnable?.length) {
                    for (const rule of timelapseRulesToEnable) {
                        logger.log(`Timelapse rule started: ${rule.name}`);

                        await this.plugin.timelapseRuleStarted({
                            rule,
                            device,
                            logger
                        })
                    }
                }

                if (timelapseRulesToDisable?.length) {
                    for (const rule of timelapseRulesToDisable) {
                        logger.log(`Timelapse rule stopped: ${rule.name}`);

                        this.plugin.timelapseRuleEnded({
                            rule,
                            device,
                            logger,
                        }).catch(logger.log);
                    }
                }

                this.detectionRules = cloneDeep(detectionRules || []);
                this.nvrDetectionRules = cloneDeep(nvrRules || []);
                this.occupancyRules = cloneDeep(occupancyRules || []);
                this.timelapseRules = cloneDeep(timelapseRules || []);
                this.allTimelapseRules = [...skippedTimelapseRules, ...timelapseRules];

                this.isActiveForNotifications = isActiveForNotifications;
                this.isActiveForMqttReporting = isActiveForMqttReporting;

                const isCurrentlyRunning = !!this.detectionListener;
                const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

                if (isActiveForMqttReporting) {
                    const mqttClient = await this.plugin.getMqttClient();
                    if (mqttClient) {
                        if (!this.mainAutodiscoveryDone) {
                            await setupDeviceAutodiscovery({
                                mqttClient,
                                device,
                                console: logger,
                                withDetections: true,
                                deviceClass: 'motion',
                                detectionRules: allPossibleRules,
                                occupancyRules: allOccupancyRules,
                            });

                            logger.log(`Subscribing to mqtt topics`);
                            await subscribeToDeviceMqttTopics({
                                mqttClient,
                                detectionRules: allPossibleRules,
                                occupancyRules: allOccupancyRules,
                                device,
                                detectionRuleCb: async ({ active, ruleName }) => {
                                    const { enabledKey } = getDetectionRuleKeys(ruleName);
                                    logger.log(`Setting detection rule ${ruleName} to ${active}`);
                                    await device.putSetting(`homeassistantMetadata:${enabledKey}`, active);
                                },
                                occupancyRuleCb: async ({ active, ruleName }) => {
                                    const { enabledKey } = getOccupancyRuleKeys(ruleName);
                                    logger.log(`Setting occupancy rule ${ruleName} to ${active}`);
                                    await device.putSetting(`homeassistantMetadata:${enabledKey}`, active);
                                },
                                switchRecordingCb: async (active) => {
                                    logger.log(`Setting NVR privacy mode to ${!active}`);
                                    await this.enableRecording(device, active);
                                }
                            });

                            this.mainAutodiscoveryDone = true;
                        }

                        const missingRules = allPossibleRules.filter(rule => !this.rulesDiscovered.includes(getDetectionRuleId(rule)));
                        logger.debug(`Processing missing rules: ${JSON.stringify({
                            missingRules,
                            allPossibleRules,
                            nvrRules,
                        })}`);

                        if (missingRules.length) {
                            await discoverDetectionRules({ mqttClient, console: logger, device, rules: missingRules });
                            this.rulesDiscovered.push(...missingRules.map(rule => getDetectionRuleId(rule)))
                        }

                        const missingOccupancyRules = occupancyRules.filter(rule => !this.occupancyRulesDiscovered.includes(getOccupancyRuleId(rule)));
                        if (missingOccupancyRules.length) {
                            await discoverOccupancyRules({ mqttClient, console: logger, device, rules: missingOccupancyRules });
                            this.occupancyRulesDiscovered.push(...missingOccupancyRules.map(rule => getOccupancyRuleId(rule)))
                        }
                    }
                    const settings = await this.mixinDevice.getSettings();
                    const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;

                    reportDeviceValues({ console: logger, device, mqttClient, isRecording });
                }

                if (isCurrentlyRunning && !shouldRun) {
                    logger.log('Stopping and cleaning listeners.');
                    this.resetListeners();
                } else if (!isCurrentlyRunning && shouldRun) {
                    logger.log(`Starting ${ScryptedInterface.ObjectDetector} listener: ${JSON.stringify({
                        notificationsActive: isActiveForNotifications,
                        mqttReportsActive: isActiveForMqttReporting,
                        isPluginEnabled,
                        isActiveForNvrNotifications,
                        detectionRules,
                    })}`);
                    await this.startListeners();
                }

                if (isActiveForNvrNotifications && !this.isActiveForNvrNotifications) {
                    logger.log(`Starting NVR events listener`);
                } else if (!isActiveForNvrNotifications && this.isActiveForNvrNotifications) {
                    logger.log(`Stopping NVR events listener`);
                }

                if ((isActiveForMqttReporting && !!occupancyRules.length) || !!timelapseRules?.length) {
                    await this.checkOutdatedRules();
                }

                this.isActiveForNvrNotifications = isActiveForNvrNotifications;


                const { entityId } = this.storageSettings.values;
                if (this.plugin.storageSettings.values.haEnabled && entityId && !this.plugin.storageSettings.values.fetchedEntities.includes(entityId)) {
                    logger.log(`Entity id ${entityId} does not exists on HA`);
                }
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
            }
        }, 10000);
    }

    resetTimeouts(detectionClass?: string) {
        if (detectionClass) {
            const { motionListener, motionTimeout } = this.detectionClassListeners[detectionClass] ?? {};

            motionTimeout && clearTimeout(motionTimeout);
            motionListener?.removeListener && motionListener.removeListener();

            this.detectionClassListeners[detectionClass] = { motionListener: undefined, motionTimeout: undefined };
        } else {
            Object.keys(this.detectionClassListeners).forEach(detectionClass => {
                const { motionListener, motionTimeout } = this.detectionClassListeners[detectionClass] ?? {};
                motionTimeout && clearTimeout(motionTimeout);
                motionListener?.removeListener && motionListener.removeListener();

                this.detectionClassListeners[detectionClass] = { motionListener: undefined, motionTimeout: undefined };
            });
        }
    }

    resetListeners() {
        if (this.detectionListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.resetTimeouts();
        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
    }

    async initValues() {
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
        this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
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
            this.storageSettings.settings.ignoreCameraDetections.hide = !this.nvrEnabled;

            const lastSnapshotWebhook = this.storageSettings.values.lastSnapshotWebhook;
            this.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide = !lastSnapshotWebhook;
            this.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide = !lastSnapshotWebhook;

            const settings: Setting[] = await this.storageSettings.getSettings();
            const zones = (await this.getObserveZones()).map(item => item.name);

            const detectionRulesSettings = await getDetectionRulesSettings({
                storage: this.storageSettings,
                zones,
                groupName: detectionRulesGroup,
                withDetection: true,
                enabledRules: [...this.detectionRules, ...this.nvrDetectionRules]
            });
            settings.push(...detectionRulesSettings);

            const occupancyRulesSettings = await getOccupancyRulesSettings({
                storage: this.storageSettings,
                zones,
                groupName: occupancyRulesGroup,
                isNvrEnabled: this.nvrEnabled
            });
            settings.push(...occupancyRulesSettings);

            const timelapseRulesSettings = await getTimelapseRulesSettings({
                storage: this.storageSettings,
                groupName: timelapseRulesGroup,
            });
            settings.push(...timelapseRulesSettings);

            return settings;
        } catch (e) {
            this.getLogger().log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putMixinSetting(key: string, value: string, skipMqtt?: boolean) {
        const logger = this.getLogger();
        const generateTimelapse = timelapseRuleGenerateRegex.exec(key);
        const cleanupData = timelapseRuleCleanRegex.exec(key);
        const enabledResultDetected = detectRuleEnabledRegex.exec(key);
        const enabledResultOccupancy = occupancyRuleEnabledRegex.exec(key);

        if (!skipMqtt) {
            if (enabledResultDetected) {
                const ruleName = enabledResultDetected[1];
                await this.plugin.updateDetectionRuleOnMqtt({
                    active: JSON.parse(value as string ?? 'false'),
                    logger,
                    ruleName,
                    deviceId: this.id,
                });
            } else if (enabledResultOccupancy) {
                const ruleName = enabledResultOccupancy[1];
                await this.plugin.updateOccupancyRuleOnMqtt({
                    active: JSON.parse(value as string ?? 'false'),
                    logger,
                    ruleName,
                    deviceId: this.id
                });
            }
        }

        if (generateTimelapse?.[1]) {
            const ruleName = generateTimelapse[1];
            const rule = this.allTimelapseRules?.find(rule => rule.name === ruleName);
            const device = systemManager.getDeviceById<DeviceInterface>(this.id);

            await this.plugin.timelapseRuleEnded({
                rule,
                device,
                logger,
                manual: true,
            });
        } else if (cleanupData?.[1]) {
            const ruleName = cleanupData[1];
            const rule = this.allTimelapseRules?.find(rule => rule.name === ruleName);
            const device = systemManager.getDeviceById<DeviceInterface>(this.id);

            this.plugin.clearFramesData({
                rule,
                device,
                logger,
            }).catch(logger.log);
        }

        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
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
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    deviceConsole.log(` ${now} - `, message, ...optionalParams);
                }
            };
            this.logger = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
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
        if (!this.mqttReportInProgress) {

            this.mqttDetectionMotionTimeout && clearTimeout(this.mqttDetectionMotionTimeout);

            this.mqttReportInProgress = true;
            const mqttClient = await this.plugin.getMqttClient();

            if (mqttClient) {
                try {
                    await publishRelevantDetections({
                        mqttClient,
                        console: logger,
                        detections,
                        device,
                        triggerTime,
                        b64Image,
                        image,
                        room: this.storageSettings.values.room,
                        storeImageFn: this.plugin.storeImage
                    }).finally(() => this.mqttReportInProgress = false);
                } catch (e) {
                    logger.log(`Error in reportDetectionsToMqtt`, e);
                }

                this.mqttDetectionMotionTimeout = setTimeout(async () => {
                    await publishRelevantDetections({
                        mqttClient,
                        console: logger,
                        device,
                        triggerTime,
                        reset: true,
                    });
                }, motionDuration * 1000);
            }
        }
    }

    async triggerMotion(props: { matchRule: MatchRule, device: DeviceInterface, b64Image?: string, image?: MediaObject, triggerTime: number }) {
        const logger = this.getLogger();
        try {
            const { matchRule, b64Image, device, triggerTime, image } = props;
            const { match: { className }, rule: parentRule } = matchRule;
            const rule = parentRule as DetectionRule;

            const report = async (triggered: boolean) => {
                logger.debug(`Stopping listeners.`);
                this.resetTimeouts(className);
                const mqttClient = await this.plugin.getMqttClient();

                if (mqttClient) {
                    try {
                        const { match } = matchRule;
                        await publishDeviceState({
                            mqttClient,
                            device,
                            triggered,
                            console: logger,
                            b64Image,
                            image,
                            detection: match,
                            resettAllClasses: !triggered,
                            rule: rule as DetectionRule,
                            allRuleIds: this.rulesDiscovered,
                            triggerTime,
                            storeImageFn: this.plugin.storeImage
                        });
                        this.mqttReportInProgress = false
                    } catch (e) {
                        logger.log(`Error in triggerMotion`, e);
                    }
                }

                const { disableNvrRecordingSeconds, name } = rule;
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

            await report(true);

            logger.debug(`Starting motion OFF listeners.`);
            const motionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.MotionSensor,
                watch: true,
            }, async (_, __, data) => {
                if (!data) {
                    logger.debug(`Motion end triggered by the device.`);
                    await report(false);
                }
            });

            const motionTimeout = setTimeout(async () => {
                logger.debug(`Motion end triggered automatically after ${motionDuration}s.`);
                await report(false);
            }, motionDuration * 1000);

            this.detectionClassListeners[className] = {
                motionListener,
                motionTimeout
            }
        } catch (e) {
            logger.log('error in trigger', e);
        }
    }

    getObjectDetector() {
        return systemManager.getDeviceById(this.id) as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
    }

    getLastDetectionkey(matchRule: MatchRule) {
        const { match, rule } = matchRule;
        if (rule.ruleType === RuleType.Timelapse) {
            return `rule_${rule.name}`;
        } else {
            const { className, label } = match;
            let key = className;
            if (label) {
                key += `-${label}`;
            }

            return key;
        }
    }

    private async getImage() {
        const objectDetector = this.getObjectDetector();
        try {
            const image = await objectDetector.takePicture({
                reason: 'event',
                picture: {
                    height: this.storageSettings.values.snapshotHeight,
                    width: this.storageSettings.values.snapshotWidth,
                },
            });
            const b64Image = (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64');

            return { image, b64Image };
        } catch (e) {
            this.getLogger().log('Error taking a picture', e);
            return {};
        }
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
        const anyTimelapseToRefresh = timelapsesToRefresh.length

        if (anyOutdatedOccupancyRule || anyTimelapseToRefresh) {
            const { image } = await this.getImage();
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

            const device = systemManager.getDeviceById<DeviceInterface>(this.id);
            const mqttClient = await this.plugin.getMqttClient();

            const occupancyRulesDataMap: Record<string, OccupancyRuleData> = {};
            const zonesData = await this.getObserveZones();

            let objectDetectorParent: ObjectDetection = this.plugin.storageSettings.values.objectDetectionDevice;

            if (!objectDetectorParent) {
                logger.log(`No detection plugin selected. skipping occupancy`);
                return;
                // logger.log(`No detection plugin selected. Defaulting to first one`);
                // objectDetectorParent = systemManager.getDeviceById<ObjectDetection>(
                //     this.plugin.storageSettings.settings.objectDetectionDevice.choices[0]
                // );
            }

            const detectedResultParent = await objectDetectorParent.detectObjects(imageParent);

            for (const occupancyRule of this.occupancyRules) {
                const { name, zoneType, observeZone, scoreThreshold, detectionClass, maxObjects, objectDetector: ruleObjectDetector, captureZone } = occupancyRule;

                let objectDetector = objectDetectorParent;
                let detectedResult = detectedResultParent;

                if (ruleObjectDetector) {
                    objectDetector = systemManager.getDeviceById<ObjectDetection>(ruleObjectDetector);
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

                    // adjust the origin of the bounding boxes for the crop.
                    for (const d of detectedResult.detections) {
                        d.boundingBox[0] += left;
                        d.boundingBox[1] += top;
                    }
                    detectedResult.inputDimensions = [image.width, image.height];
                } else if (ruleObjectDetector) {
                    detectedResult = await objectDetector.detectObjects(imageParent);
                }

                let objectsDetected = 0;

                for (const detection of detectedResult.detections) {
                    const className = detectionClassesDefaultMap[detection.className];
                    if (detection.score >= scoreThreshold && detectionClass === className) {
                        const boundingBoxInCoords = normalizeBox(detection.boundingBox, detectedResult.inputDimensions);
                        const zone = zonesData.find(zoneData => zoneData.name === observeZone);
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
                            logger.debug(`Confirmation failed, value changed during confirmation time ${occupancyRuleData.rule.name}: ${JSON.stringify(logPayload)}`);

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
                            }

                            logger.debug(`Confirming occupancy rule ${occupancyRuleData.rule.name}: ${JSON.stringify({
                                stateActuallyChanged,
                                ...logPayload,
                            })}`);
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

            await publishOccupancy({
                console: logger,
                device,
                mqttClient,
                objectsDetected: detectedResultParent,
                occupancyRulesData,
                storeImageFn: this.plugin.storeImage,
                triggerTime: now
            });

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

                        await this.plugin.notifyOccupancyEvent({
                            cameraDevice: device,
                            message,
                            rule,
                            triggerTime: now,
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
        } = this.storageSettings.values;

        const { candidates, hasLabel } = filterAndSortValidDetections(detections ?? [], logger);

        let image: MediaObject;
        let b64Image: string;

        if (this.isActiveForMqttReporting) {
            const { useNvrDetectionsForMqtt } = this.plugin.storageSettings.values;
            const timePassed = (now - this.lastPictureTaken) >= 1000 * secondsPerPicture;
            if (isFromNvr && parentImage && useNvrDetectionsForMqtt) {
                b64Image = (await sdk.mediaManager.convertMediaObjectToBuffer(parentImage, 'image/jpeg'))?.toString('base64');
                this.lastPictureTaken = now;
            } else if (
                !useNvrDetectionsForMqtt &&
                (hasLabel ||
                    !this.lastPictureTaken ||
                    timePassed)
            ) {
                this.lastPictureTaken = now;
                logger.debug('Refreshing the image');
                const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                image = imageNew;
                b64Image = b64ImageNew;
            }

            if (timePassed && this.occupancyRules.length) {
                this.checkOccupancyData(image).catch(logger.log);
            }

            this.reportDetectionsToMqtt({ detections: candidates, triggerTime, logger, device, b64Image, image });
        }

        let dataToReport = {};
        try {
            logger.debug(`Detections incoming ${JSON.stringify(candidates)}`);

            const matchRules: MatchRule[] = [];

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
                        if (rule.source === DetectionRuleSource.Device) {
                            const isIncluded = whitelistedZones.length ? zones.some(zone => whitelistedZones.includes(zone)) : true;
                            const isExcluded = blacklistedZones.length ? zones.some(zone => blacklistedZones.includes(zone)) : false;

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
                    }
                } else {
                    if (ruleParent.ruleType === RuleType.Timelapse) {
                        const rule = ruleParent as TimelapseRule;
                        matchRules.push({ match: candidates[0], rule, dataToReport: {} });
                    }
                }
            }

            let imageToNotify = parentImage ?? image;
            if (!!matchRules.length) {
                if (!imageToNotify) {
                    const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                    imageToNotify = imageNew;
                    b64Image = b64ImageNew;
                }

                if (imageToNotify) {
                    const imageUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(imageToNotify, 'image/jpg');
                    logger.debug(`Updating webook last image URL: ${imageUrl}`);
                    this.storageSettings.putSetting('lastSnapshotImageUrl', imageUrl);
                }
            }

            for (const matchRule of matchRules) {
                try {
                    const { match, rule } = matchRule;
                    const lastDetectionkey = this.getLastDetectionkey(matchRule);
                    const lastDetection = this.lastDetectionMap[lastDetectionkey];
                    if (lastDetection && (now - lastDetection) < 1000 * (rule.minDelay ?? minDelayTime)) {
                        logger.debug(`Waiting for delay: ${(now - lastDetection) / 1000}s`);
                        return false;
                    }
                    this.lastDetectionMap[this.getLastDetectionkey(matchRule)] = now;

                    logger.debug(`Matching detections found: ${JSON.stringify({
                        matchRulesMap: matchRules,
                        candidates,
                        b64Image,
                        imageToNotify: !!imageToNotify,
                        parentImage: !!parentImage
                    })}`);

                    if (rule.ruleType === RuleType.Detection) {
                        if (this.isActiveForMqttReporting) {
                            this.triggerMotion({ matchRule, b64Image, device, triggerTime, image: imageToNotify });
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
                        image: imageToNotify,
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

    async startListeners() {
        try {
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data) => {
                const detection: ObjectsDetected = data;

                const { timestamp } = detection;

                this.processDetections({ detections: detection.detections, triggerTime: timestamp, isFromNvr: false })
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
}
