import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ScryptedDeviceBase, ScryptedDeviceType, MediaObject, LockState } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionRule, enabledRegex, EventType, getDetectionRuleKeys, getDetectionRulesSettings, getMixinBaseSettings, isDeviceEnabled } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";
import { discoverDetectionRules, getDetectionRuleId, publishDeviceState, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";

const { systemManager } = sdk;

export class AdvancedNotifierSensorMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, this.type),
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of seconds to wait until a notification is sent. Set 0 to disable',
            type: 'number',
            defaultValue: 0,
        },
        linkedCamera: {
            title: 'Linked camera',
            type: 'device',
            subgroup: 'Notifier',
            deviceFilter: `(type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}')`,
            immediate: true,
        },
    });

    detectionListener: EventListenerRegister;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForNvrNotifications: boolean;
    isActiveForMqttReporting: boolean;
    mainAutodiscoveryDone: boolean;
    mqttReportInProgress: boolean;
    logger: Console;
    killed: boolean;
    detectionRules: DetectionRule[];
    nvrDetectionRules: DetectionRule[];
    rulesDiscovered: string[] = [];
    lastDetection: number;
    event: ScryptedInterface;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

        const isLock = this.type === ScryptedDeviceType.Lock;
        this.event = isLock ? ScryptedInterface.Lock : ScryptedInterface.BinarySensor;

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

        this.startCheckInterval().then().catch(this.console.log);

        this.plugin.currentMixinsMap[this.name] = this;
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            const deviceSettings = await this.getMixinSettings();
            const {
                isActiveForMqttReporting,
                isPluginEnabled,
                detectionRules,
                skippedRules,
                isActiveForNotifications,
                isActiveForNvrNotifications,
                nvrRules,
                allDeviceRules
            } = await isDeviceEnabled(this.id, deviceSettings, this.plugin, this.type);

            logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedRules })}`);
            this.detectionRules = detectionRules;
            this.nvrDetectionRules = nvrRules;

            this.isActiveForNotifications = isActiveForNotifications;
            this.isActiveForMqttReporting = isActiveForMqttReporting;

            const isCurrentlyRunning = !!this.detectionListener;
            const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

            if (isActiveForMqttReporting) {
                const mqttClient = await this.plugin.getMqttClient();
                if (mqttClient) {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
                    if (!this.mainAutodiscoveryDone) {
                        await setupDeviceAutodiscovery({
                            mqttClient,
                            device,
                            console: logger,
                            withDetections: true,
                            deviceClass: this.storageSettings.values.haDeviceClass || 'window',
                            detectionRules: allDeviceRules
                        });

                        this.getLogger().log(`Subscribing to mqtt topics`);
                        await subscribeToDeviceMqttTopics({
                            mqttClient,
                            detectionRules: allDeviceRules,
                            device,
                            ruleCb: async ({ active, ruleName }) => {
                                const { enabledKey } = getDetectionRuleKeys(ruleName);
                                logger.log(`Setting rule ${ruleName} for device ${device.name} to ${active}`);
                                await device.putSetting(`homeassistantMetadata:${enabledKey}`, active);
                            },
                        });

                        this.mainAutodiscoveryDone = true;
                    }

                    const missingRules = detectionRules.filter(rule => !this.rulesDiscovered.includes(getDetectionRuleId(rule)));
                    if (missingRules.length) {
                        await discoverDetectionRules({
                            mqttClient,
                            console: logger,
                            device,
                            rules: missingRules
                        });
                        this.rulesDiscovered.push(...missingRules.map(rule => getDetectionRuleId(rule)))
                    }
                }
            }

            if (isCurrentlyRunning && !shouldRun) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldRun) {
                logger.log(`Starting ${this.event} listener: ${JSON.stringify({
                    notificationsActive: isActiveForNotifications,
                    mqttReportsActive: isActiveForMqttReporting,
                    isPluginEnabled,
                })}`);
                await this.startListeners();
            }
            if (isActiveForNvrNotifications && !this.isActiveForNvrNotifications) {
                logger.log(`Starting listener for NVR events`);
            } else if (!isActiveForNvrNotifications && this.isActiveForNvrNotifications) {
                logger.log(`Stopping listener for NVR events`);
            }

            this.isActiveForNvrNotifications = isActiveForNvrNotifications;
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

    resetListeners() {
        if (this.detectionListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.detectionListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();


        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            groupName: 'Advanced notifier detection rules',
        });
        settings.push(...detectionRulesSettings);

        return settings;
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
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
        this.resetListeners();
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

    async startListeners() {
        this.detectionListener = systemManager.listenDevice(this.id, this.event, async (_, __, triggered) => {
            const timestamp = new Date().getTime();

            const isTriggered = triggered ===
                (this.event === ScryptedInterface.Lock ? LockState.Unlocked : true);
            this.processEvent({ triggered: isTriggered, triggerTime: timestamp, isFromNvr: false })
        });
    }

    public async processEvent(props: {
        triggerTime: number,
        isFromNvr: boolean,
        triggered: boolean,
        image?: MediaObject
    }) {
        const { minDelayTime } = this.storageSettings.values;
        const { isFromNvr, triggerTime, triggered, image: imageParent } = props;
        const logger = this.getLogger();

        const shouldExecute = (isFromNvr && this.isActiveForNvrNotifications) || (!isFromNvr && this.isActiveForNotifications);

        if (!shouldExecute) {
            return;
        }

        try {
            if (minDelayTime) {
                if (this.lastDetection && (triggerTime - this.lastDetection) < 1000 * minDelayTime) {
                    logger.debug(`Waiting for delay: ${(triggerTime - this.lastDetection) / 1000}s`);
                    return;
                }

                this.lastDetection = triggerTime;
            }

            logger.log(`Sensor triggered: ${triggered}`);

            const mqttClient = await this.plugin.getMqttClient();

            if (mqttClient) {
                try {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
                    publishDeviceState({
                        mqttClient,
                        device,
                        triggered,
                        console: logger,
                        resettAllClasses: false,
                        allRuleIds: []
                    }).finally(() => this.mqttReportInProgress = false);
                } catch (e) {
                    logger.log(`Error in reportDetectionsToMqtt`, e);
                }
            }

            if (triggered) {
                const { isDoorbell, device } = await this.plugin.getLinkedCamera(this.id);
                const isDoorlock = this.type === ScryptedDeviceType.Lock;

                const enabledRules = (isFromNvr ? this.nvrDetectionRules : this.detectionRules) ?? [];

                if (!enabledRules.length) {
                    return;
                }

                let image = imageParent;

                try {
                    if (!image) {
                        const deviceSettings = await device.getSettings();
                        const cameraSnapshotHeight = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotHeight')?.value as number) ?? 720;
                        const cameraSnapshotWidth = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotWidth')?.value as number) ?? 1280;

                        image = await device.takePicture({
                            reason: 'event',
                            picture: {
                                height: cameraSnapshotHeight,
                                width: cameraSnapshotWidth,
                            },
                        });
                    }
                } catch (e) {
                    logger.log('Error taking a picture', e);
                }

                const eventType = isDoorbell ? EventType.Doorbell : isDoorlock ? EventType.Doorlock : EventType.Contact;

                for (const rule of enabledRules) {
                    logger.log(`Starting notifiers: ${JSON.stringify({
                        eventType,
                        triggerTime,
                        rule,
                    })})}`);

                    this.plugin.matchDetectionFound({
                        triggerDeviceId: this.id,
                        logger,
                        eventType,
                        triggerTime,
                        rule,
                        image,
                    });
                }
            }

        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }
}