import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ObjectDetector, MotionSensor, ScryptedDevice, ObjectsDetected, Camera, MediaObject, ObjectDetectionResult, ScryptedDeviceBase } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ADVANCED_NOTIFIER_INTERFACE, DetectionRule, DetectionRuleSource, EventType, filterAndSortValidDetections, getDetectionRulesSettings, getMixinBaseSettings, getWebookUrls, isDeviceEnabled } from "./utils";
import { detectionClassesDefaultMap } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { getDetectionRuleId } from "./mqtt-client";

const { systemManager } = sdk;

const snapshotWidth = 1280;
const snapshotHeight = 720;
const secondsPerPicture = 10;
const motionDuration = 10;

interface MatchRule { match: ObjectDetectionResult, rule: DetectionRule, dataToReport: any }

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, this.type),
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of seconds to wait until a notification is sent for the same detection type',
            type: 'number',
            defaultValue: 15,
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
            // TODO: export on common fn
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Local URL',
            readonly: true,
        },
        lastSnapshotImageUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Last image URL',
            readonly: true,
        }
    });

    detectionListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForMqttReporting: boolean;
    mqttReportInProgress: boolean;
    lastDetectionMap: Record<string, number> = {};
    logger: Console;
    mqttAutodiscoverySent: boolean;
    killed: boolean;
    nvrEnabled: boolean = true;
    nvrMixinId: string;
    detectionRules: DetectionRule[];
    rulesDiscovered: string[] = [];
    detectionClassListeners: Record<string, {
        motionTimeout: NodeJS.Timeout;
        motionListener: EventListenerRegister
    }> = {};
    lastPictureTaken: number;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

        setTimeout(() => !this.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE) && this.interfaces.push(ADVANCED_NOTIFIER_INTERFACE), 0);

        this.storageSettings.settings.room.onGet = async () => {
            const rooms = this.plugin.storageSettings.getItem('fetchedRooms');
            // const rooms = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedRooms')?.value as string[];
            return {
                choices: rooms ?? []
            }
        }
        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.storageSettings.getItem('fetchedEntities');
            // const entities = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedEntities')?.value as string[];
            return {
                choices: entities ?? []
            }
        }

        this.nvrMixinId = systemManager.getDeviceByName('Scrypted NVR Object Detection')?.id;

        this.initValues().then().catch(this.console.log);
        this.startCheckInterval().then().catch(this.console.log);

        this.plugin.currentMixinsMap[this.name] = this;
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            const deviceSettings = await this.getMixinSettings();
            const { isActiveForMqttReporting, isPluginEnabled, detectionRules, skippedRules, isActiveForNotifications } = await isDeviceEnabled(this.id, deviceSettings);

            logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedRules })}`);
            this.detectionRules = detectionRules;

            this.isActiveForNotifications = isActiveForNotifications;
            this.isActiveForMqttReporting = isActiveForMqttReporting;

            const isCurrentlyRunning = !!this.detectionListener;
            const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

            if (isActiveForMqttReporting) {
                const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
                const mqttClient = await this.plugin.getMqttClient();
                if (mqttClient) {
                    if (!this.mqttAutodiscoverySent) {
                        await mqttClient.setupDeviceAutodiscovery({
                            device,
                            console: logger,
                            withDetections: true,
                            deviceClass: 'motion'
                        });
                        this.mqttAutodiscoverySent = true;
                    }

                    const missingRules = detectionRules.filter(rule => !this.rulesDiscovered.includes(getDetectionRuleId(rule)));
                    if (missingRules.length) {
                        await mqttClient.discoverDetectionRules({ console: logger, device, rules: missingRules });
                        this.rulesDiscovered.push(...missingRules.map(rule => getDetectionRuleId(rule)))
                    }
                }

                mqttClient.reportDeviceValues(device, logger);
            }

            if (isCurrentlyRunning && !shouldRun) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldRun) {
                logger.log(`Starting ${ScryptedInterface.ObjectDetector} listeners: ${JSON.stringify({
                    notificationsActive: isActiveForNotifications,
                    mqttReportsActive: isActiveForMqttReporting,
                    isPluginEnabled,
                })}`);
                await this.startListeners();
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
        }, 5000);
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
        const settings = await this.mixinDevice.getSettings();
        const zonesSetting = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:zones').test(setting.key))?.value ?? [];

        return zonesSetting.filter(zone => {
            const zoneFilterMode = settings.find((setting: { key: string; }) => new RegExp(`objectdetectionplugin:.*:zoneinfo-filterMode-${zone}`).test(setting.key))?.value;

            return zoneFilterMode === 'observe';

        });
    }

    async getMixinSettings(): Promise<Setting[]> {
        const canUseNvr = this.nvrMixinId && this.mixins.includes(this.nvrMixinId);

        this.nvrEnabled = canUseNvr;
        this.storageSettings.settings.ignoreCameraDetections.hide = !canUseNvr;

        const lastSnapshotWebhook = this.storageSettings.values.lastSnapshotWebhook;
        this.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide = !lastSnapshotWebhook;
        this.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide = !lastSnapshotWebhook;
        this.storageSettings.settings.lastSnapshotImageUrl.hide = !lastSnapshotWebhook;

        const settings: Setting[] = await this.storageSettings.getSettings();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            zones: await this.getObserveZones(),
            groupName: 'Advanced notifier detection rules',
            withDetection: true,
        });
        settings.push(...detectionRulesSettings);

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
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
    }) {
        const { detections, device, logger, triggerTime, b64Image } = props;
        if (!this.mqttReportInProgress) {

            this.mqttDetectionMotionTimeout && clearTimeout(this.mqttDetectionMotionTimeout);

            this.mqttReportInProgress = true;
            const mqttClient = await this.plugin.getMqttClient();

            if (mqttClient) {
                try {
                    await mqttClient.publishRelevantDetections({
                        console: logger,
                        detections,
                        device,
                        triggerTime,
                        b64Image,
                    }).finally(() => this.mqttReportInProgress = false);
                } catch (e) {
                    logger.log(`Error in reportDetectionsToMqtt`, e);
                }

                this.mqttDetectionMotionTimeout = setTimeout(async () => {
                    await mqttClient.publishRelevantDetections({
                        console: logger,
                        device,
                        triggerTime,
                        reset: true
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
                logger.log(`Stopping listeners.`);
                this.resetTimeouts(className);
                const mqttClient = await this.plugin.getMqttClient();

                if (mqttClient) {
                    try {
                        const { match, rule } = matchRule;
                        await mqttClient.publishDeviceState({
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

            logger.log(`Starting listeners.`);
            const motionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.MotionSensor,
                watch: true,
            }, async (_, __, data) => {
                if (!data) {
                    logger.log(`Motion end triggered by the device.`);
                    await report(false);
                }
            });

            const motionTimeout = setTimeout(async () => {
                logger.log(`Motion end triggered automatically after ${motionDuration}s.`);
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
        const image = await objectDetector.takePicture({
            reason: 'event',
            picture: {
                height: snapshotHeight,
                width: snapshotWidth,
            },
        });
        const b64Image = (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64');

        return { image, b64Image };
    }

    public async processDetections(props: { detections: ObjectDetectionResult[], triggerTime: number }) {
        const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
        const { detections, triggerTime } = props;
        const logger = this.getLogger();

        if (!detections?.length) {
            return;
        }
        const now = new Date().getTime();

        const objectDetector = this.getObjectDetector();

        const {
            minDelayTime,
            ignoreCameraDetections,
        } = this.storageSettings.values;

        const candidates = filterAndSortValidDetections(detections ?? [], logger);

        let image: MediaObject;
        let b64Image: string;

        if (this.isActiveForMqttReporting) {
            if (!this.lastPictureTaken || (now - this.lastPictureTaken) >= 1000 * secondsPerPicture) {
                this.lastPictureTaken = now;
                logger.log('Refreshing the image');
                const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                image = imageNew;
                b64Image = b64ImageNew;
            }
            
            this.reportDetectionsToMqtt({ detections: candidates, triggerTime, logger, device, b64Image });
        }

        let dataToReport = {};
        try {
            logger.debug(`Detections incoming ${JSON.stringify(candidates)}`);

            const matchRules: MatchRule[] = [];

            for (const rule of this.detectionRules) {
                const { detectionClasses, scoreThreshold, whitelistedZones, blacklistedZones } = rule;

                const match = candidates.find(d => {
                    if (ignoreCameraDetections && !d.boundingBox) {
                        return false;
                    }

                    const { className: classnameRaw, score, label, zones } = d;
                    const className = detectionClassesDefaultMap[classnameRaw];

                    if (!className) {
                        logger.log(`Classname ${className} not mapped`);

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

                    if (!image) {
                        const { b64Image: b64ImageNew, image: imageNew } = await this.getImage();
                        image = imageNew;
                        b64Image = b64ImageNew;

                        const imageUrl = await sdk.mediaManager.convertMediaObjectToLocalUrl(image, 'image/jpg');
                        logger.debug(`Updating webook last image URL: ${imageUrl}`);
                        this.storageSettings.putSetting('lastSnapshotImageUrl', imageUrl);
                    }

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
                        image,
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
        this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data) => {
            const detection: ObjectsDetected = data;

            const { timestamp } = detection;

            this.processDetections({ detections: detection.detections, triggerTime: timestamp })
        });
    }
}