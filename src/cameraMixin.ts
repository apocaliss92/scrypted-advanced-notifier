import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ObjectDetector, MotionSensor, ScryptedDevice, ObjectsDetected, Camera, MediaObject, ObjectDetectionResult, ScryptedDeviceBase, ObjectDetection, Point } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionRule, detectionRulesGroup, DetectionRuleSource, DeviceInterface, enabledRegex, EventType, filterAndSortValidDetections, getDetectionRuleKeys, getDetectionRulesSettings, getMixinBaseSettings, getOccupancyRulesSettings, getWebookUrls, isDeviceEnabled, normalizeBoxToClipPath, ObserveZoneClasses, ObserveZoneData, OccupancyRule, OccupancyRuleData, occupancyRulesGroup, ZoneMatchType } from "./utils";
import { DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { detectionClassForObjectsReporting, discoverDetectionRules, discoverOccupancyRules, getDetectionRuleId, getOccupancyRuleId, publishDeviceState, publishOccupancy, publishRelevantDetections, reportDeviceValues, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import polygonClipping from 'polygon-clipping';

const { systemManager } = sdk;
const secondsPerPicture = 5;
const motionDuration = 10;

interface MatchRule { match: ObjectDetectionResult, rule: DetectionRule, dataToReport: any }

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, true),
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
        lastOccupancyResult: {
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
    occupancyRules: OccupancyRule[];
    detectionRules: DetectionRule[];
    nvrDetectionRules: DetectionRule[];
    rulesDiscovered: string[] = [];
    occupancyRulesDiscovered: string[] = [];
    detectionClassListeners: Record<string, {
        motionTimeout: NodeJS.Timeout;
        motionListener: EventListenerRegister
    }> = {};
    lastPictureTaken: number;
    lastFrameAnalysis: number;
    lastObserveZonesFetched: number;
    observeZoneData: ObserveZoneData[];
    lastOccupancyResult: Record<string, { lastOccupancy: boolean, lastChange: number, lastCheck: number }> = {};

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

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

        this.initValues().then().catch(this.console.log);
        this.startCheckInterval().then().catch(this.console.log);

        this.plugin.currentMixinsMap[this.name] = this;

        this.lastOccupancyResult = this.storageSettings.values.lastOccupancyResult ?? {};
    }

    async startCheckInterval() {
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
                    allDeviceRules,
                    occupancyRules,
                    skippedOccupancyRules,
                } = await isDeviceEnabled(this.id, deviceSettings, this.plugin);

                logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedRules, occupancyRules, skippedOccupancyRules })}`);
                this.detectionRules = detectionRules;
                this.nvrDetectionRules = nvrRules;
                this.occupancyRules = occupancyRules;

                this.isActiveForNotifications = isActiveForNotifications;
                this.isActiveForMqttReporting = isActiveForMqttReporting;

                const isCurrentlyRunning = !!this.detectionListener;
                const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

                if (isActiveForMqttReporting) {
                    const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase & Settings>(this.id);
                    const mqttClient = await this.plugin.getMqttClient();
                    if (mqttClient) {
                        if (!this.mainAutodiscoveryDone) {
                            await setupDeviceAutodiscovery({
                                mqttClient,
                                device,
                                console: logger,
                                withDetections: true,
                                deviceClass: 'motion',
                                detectionRules: allDeviceRules,
                                observeZoneData: await this.getObserveZones()
                            });

                            this.getLogger().log(`Subscribing to mqtt topics`);
                            await subscribeToDeviceMqttTopics({
                                mqttClient,
                                detectionRules: allDeviceRules,
                                device,
                                ruleCb: async ({ active, ruleName }) => {
                                    const { enabledKey } = getDetectionRuleKeys(ruleName);
                                    logger.log(`Setting rule ${ruleName} to ${active}`);
                                    await device.putSetting(`homeassistantMetadata:${enabledKey}`, active);
                                },
                                switchRecordingCb: async (active) => {
                                    logger.log(`Setting NVR privacy mode to ${!active}`);
                                    await device.putSetting(`recording:privacyMode`, !active);
                                }
                            });

                            this.mainAutodiscoveryDone = true;
                        }

                        const missingRules = detectionRules.filter(rule => !this.rulesDiscovered.includes(getDetectionRuleId(rule)));
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
                    logger.log(`Starting ${ScryptedInterface.ObjectDetector} listeners: ${JSON.stringify({
                        notificationsActive: isActiveForNotifications,
                        mqttReportsActive: isActiveForMqttReporting,
                        isPluginEnabled,
                        isActiveForNvrNotifications,
                    })}`);
                    await this.startListeners();
                }

                if (isActiveForNvrNotifications && !this.isActiveForNvrNotifications) {
                    logger.log(`Starting listener for NVR events`);
                } else if (!isActiveForNvrNotifications && this.isActiveForNvrNotifications) {
                    logger.log(`Stopping listener for NVR events`);
                }

                if (isActiveForMqttReporting && !!occupancyRules.length) {
                    await this.forceOccupancyCheck();
                }

                this.isActiveForNvrNotifications = isActiveForNvrNotifications;
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
            const canUseNvr = this.nvrMixinId && this.mixins.includes(this.nvrMixinId);

            this.nvrEnabled = canUseNvr;
            this.storageSettings.settings.ignoreCameraDetections.hide = !canUseNvr;

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
            });
            settings.push(...detectionRulesSettings);

            const occupancyRulesSettings = await getOccupancyRulesSettings({
                storage: this.storageSettings,
                zones,
                groupName: occupancyRulesGroup,
            });
            settings.push(...occupancyRulesSettings);

            return settings;
        } catch (e) {
            this.getLogger().log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putMixinSetting(key: string, value: string, skipMqtt?: boolean) {
        if (!skipMqtt) {
            const enabledResult = enabledRegex.exec(key);
            if (enabledResult) {
                const ruleName = enabledResult[1];
                await this.plugin.updateRuleOnMqtt({
                    active: JSON.parse(value as string ?? 'false'),
                    logger: this.getLogger(),
                    ruleName,
                    deviceId: this.id
                })
            }
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
        const deviceConsole = sdk.deviceManager.getMixinConsole(this.id, this.nativeId);

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
                        room: this.storageSettings.values.room
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

    async triggerMotion(props: { matchRule: MatchRule, device: ScryptedDeviceBase, b64Image?: string }) {
        const logger = this.getLogger();
        try {
            const { matchRule, b64Image, device } = props;
            const { match: { className } } = matchRule;

            const report = async (triggered: boolean) => {
                logger.debug(`Stopping listeners.`);
                this.resetTimeouts(className);
                const mqttClient = await this.plugin.getMqttClient();

                if (mqttClient) {
                    try {
                        const { match, rule } = matchRule;
                        await publishDeviceState({
                            mqttClient,
                            device,
                            triggered,
                            console: logger,
                            b64Image,
                            detection: match,
                            resettAllClasses: !triggered,
                            rule,
                            allRuleIds: this.rulesDiscovered,
                        });
                        this.mqttReportInProgress = false
                    } catch (e) {
                        logger.log(`Error in reportDetectionsToMqtt`, e);
                    }
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

    getLastDetectionkey(detection: ObjectDetectionResult) {
        const { className, label } = detection;
        let key = className;
        if (label) {
            key += `-${label}`;
        }

        return key;
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

    async forceOccupancyCheck() {
        const now = new Date().getTime();
        const logger = this.getLogger();
        const anyOutdatedRule = this.occupancyRules.some(rule => {
            const { forceUpdate, name } = rule;
            const lastResult = this.lastOccupancyResult[name];

            logger.debug(`Should force update occupancy: ${!lastResult || (now - (lastResult?.lastCheck ?? 0)) >= (1000 * forceUpdate)}, ${JSON.stringify({
                lastCheck: lastResult.lastCheck,
                forceUpdate,
                now,
                name
            })}`);

            return !lastResult || (now - (lastResult?.lastCheck ?? 0)) >= (1000 * forceUpdate);
        });

        if (anyOutdatedRule) {
            logger.log('Forcing update of occupancy data');
            const { image } = await this.getImage();
            if (image) {
                this.checkOccupancyData(image).catch(logger.log);
            }
        }
    }

    async checkOccupancyData(image: MediaObject) {
        try {
            const logger = this.getLogger();
            const now = new Date().getTime();
            const objectDetection: ObjectDetection = this.storageSettings.values.objectDetectionDevice ??
                this.plugin.storageSettings.values.objectDetectionDevice;

            if (!objectDetection) {
                logger.log('No detection plugin selected');
                return;
            }

            const detected = await objectDetection.detectObjects(image);
            const device = systemManager.getDeviceById<DeviceInterface>(this.id);
            const mqttClient = await this.plugin.getMqttClient();

            // const observeZonesClasses: ObserveZoneClasses = {};
            const occupancyRulesDataMap: Record<string, OccupancyRuleData> = {};
            const zonesData = await this.getObserveZones();

            // zonesData.forEach(({ name }) => {
            //     observeZonesClasses[name] = {};
            //     detectionClassForObjectsReporting.forEach(className => {
            //         observeZonesClasses[name][className] = 0;
            //     })
            // });
            // const scoreThreshold = this.storageSettings.values.objectOccupancyThreshold ?? 0.5;
            // const intersectedZones = zonesData.filter(zone => !!polygonClipping.intersection([boundingBoxInCoords], [zone.path]).length);

            // if (detection.score >= scoreThreshold) {
            //     intersectedZones.forEach(intersectedZone => {
            //         if (detectionClassForObjectsReporting.includes(className)) {
            //             observeZonesClasses[intersectedZone.name][className] += 1;
            //         }
            //     });
            // }
            for (const occupancyRule of this.occupancyRules) {
                const { name, zoneType, observeZone, scoreThreshold, detectionClass, maxObjects = 1 } = occupancyRule;

                let objectsDetected = 0;

                for (const detection of detected.detections) {
                    const className = detectionClassesDefaultMap[detection.className];
                    if (detection.score >= scoreThreshold && detectionClass === className) {
                        const boundingBoxInCoords = normalizeBoxToClipPath(detection.boundingBox, detected.inputDimensions);
                        const zone = zonesData.find(zoneData => zoneData.name === observeZone);
                        let zoneMatches = false;

                        if (zoneType === ZoneMatchType.Intersect) {
                            zoneMatches = !!polygonClipping.intersection([boundingBoxInCoords], [zone.path]).length;
                        } else {
                            zoneMatches = zone.path.some(point => !polygonClipping.intersection([boundingBoxInCoords], [[point, [point[0] + 1, point[1]], [point[0] + 1, point[1] + 1]]]).length);
                        }

                        if (zoneMatches) {
                            objectsDetected += 1;
                        }
                    }
                }

                const occupies = (maxObjects - objectsDetected) <= 0;

                logger.log(JSON.stringify({
                    maxObjects,
                    name,
                    objectsDetected
                }))
                const existingRule = occupancyRulesDataMap[name];
                if (!existingRule) {
                    occupancyRulesDataMap[name] = {
                        rule: occupancyRule,
                        occupies
                    }
                } else if (!existingRule.occupies && occupies) {
                    existingRule.occupies = true;
                }
            }

            const occupancyRulesData: OccupancyRuleData[] = [];
            const rulesToNotNotify: string[] = [];
            Object.values(occupancyRulesDataMap).forEach(occupancyRuleData => {
                const { changeStateConfirm = 30, name } = occupancyRuleData.rule;
                const lastResult = this.lastOccupancyResult[occupancyRuleData.rule.name];
                const stateChanged = lastResult?.lastOccupancy !== occupancyRuleData.occupies;
                const timeoutOk = (now - (lastResult?.lastChange ?? 0)) >= (1000 * changeStateConfirm);
                const tooOld = lastResult && (now - (lastResult?.lastChange ?? 0)) >= (1000 * 60 * 60 * 1); // Force an update every hour

                const shouldUpdate = !lastResult || (stateChanged && timeoutOk);

                if (shouldUpdate || tooOld) {
                    occupancyRulesData.push(occupancyRuleData);
                    this.lastOccupancyResult[name] = {
                        lastChange: now,
                        lastCheck: now,
                        lastOccupancy: occupancyRuleData.occupies
                    };

                    logger.log(`Updating occupancy rule ${occupancyRuleData.rule.name}: ${JSON.stringify({
                        stateChanged,
                        timeoutOk,
                        occupancyRuleData,
                        lastResult,
                        detected,
                    })}`);

                    if (tooOld && !shouldUpdate) {
                        rulesToNotNotify.push(occupancyRuleData.rule.name);
                    }
                } else {
                    logger.log(`Not updating occupancy rule ${occupancyRuleData.rule.name}: ${JSON.stringify({
                        stateChanged,
                        timeoutOk,
                        occupancyRuleData,
                        lastResult,
                        detected,
                    })}`);

                    this.lastOccupancyResult[name] = {
                        ...this.lastOccupancyResult[name],
                        lastCheck: now,
                    };
                }
            });

            await this.storageSettings.putSetting('lastOccupancyResult', JSON.stringify(this.lastOccupancyResult));

            await publishOccupancy({
                console: logger,
                device,
                mqttClient,
                objectsDetected: detected,
                observeZonesClasses: {},
                occupancyRulesData
            });

            for (const occupancyRuleData of occupancyRulesData) {
                const rule = occupancyRuleData.rule;

                if (!rulesToNotNotify.includes(rule.name)) {
                    const message = occupancyRuleData.occupies ?
                        rule.zoneOccupiedText :
                        rule.zoneNotOccupiedText;

                    if (message) {
                        await this.plugin.notifyOccupancyEvent({
                            cameraDevice: device,
                            message,
                            rule,
                            triggerTime: now,
                            image
                        });
                    }
                }
            }
        }
        catch (e) {
            this.console.error('Error in checkOccupancyData', e);
        }
    }

    public async processDetections(props: {
        detections: ObjectDetectionResult[],
        triggerTime: number,
        isFromNvr: boolean,
        image?: MediaObject
    }) {
        const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
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
            if (hasLabel ||
                !this.lastPictureTaken ||
                (now - this.lastPictureTaken) >= 1000 * secondsPerPicture
            ) {
                this.lastPictureTaken = now;
                logger.debug('Refreshing the image');
                const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                image = imageNew;
                b64Image = b64ImageNew;
                this.checkOccupancyData(image).catch(logger.log);
            }

            this.reportDetectionsToMqtt({ detections: candidates, triggerTime, logger, device, b64Image, image });
        }

        let dataToReport = {};
        try {
            logger.debug(`Detections incoming ${JSON.stringify(candidates)}`);

            const matchRules: MatchRule[] = [];

            const rules = (isFromNvr ? this.nvrDetectionRules : this.detectionRules) ?? [];
            for (const rule of rules) {
                const { detectionClasses, scoreThreshold, whitelistedZones, blacklistedZones } = rule;

                const match = candidates.find(d => {
                    if (ignoreCameraDetections && !d.boundingBox) {
                        return false;
                    }

                    const { className: classnameRaw, score, zones } = d;
                    const className = detectionClassesDefaultMap[classnameRaw];

                    if (!className) {
                        logger.log(`Classname ${classnameRaw} not mapped`);

                        return;
                    }

                    if (detectionClasses?.length && !detectionClasses.includes(className)) {
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
                    matchRules.push({ match, rule, dataToReport })
                }
            }

            let imageToNotify = parentImage ?? image;
            if (!!matchRules.length) {
                if (!imageToNotify) {
                    const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                    imageToNotify = imageNew;
                    b64Image = b64ImageNew;
                }

                const imageUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(imageToNotify, 'image/jpg');
                logger.debug(`Updating webook last image URL: ${imageUrl}`);
                this.storageSettings.putSetting('lastSnapshotImageUrl', imageUrl);
            }

            for (const matchRule of matchRules) {
                try {
                    const { match, rule } = matchRule;
                    const lastDetectionkey = this.getLastDetectionkey(match);
                    const lastDetection = this.lastDetectionMap[lastDetectionkey];
                    if (lastDetection && (now - lastDetection) < 1000 * minDelayTime) {
                        logger.debug(`Waiting for delay: ${(now - lastDetection) / 1000}s`);
                        return false;
                    }
                    this.lastDetectionMap[this.getLastDetectionkey(match)] = now;

                    if (this.isActiveForMqttReporting) {
                        this.triggerMotion({ matchRule, b64Image, device });
                    }


                    logger.log(`Matching detections found: ${JSON.stringify({
                        matchRulesMap: matchRules,
                        candidates,
                    })}`);

                    logger.log(`Starting notifiers: ${JSON.stringify({
                        match,
                        rule,
                        eventType: EventType.ObjectDetection,
                        triggerTime,
                    })})}`);

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
}
