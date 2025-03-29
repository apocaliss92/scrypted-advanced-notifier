import sdk, { EventListenerRegister, MediaObject, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import HomeAssistantUtilitiesProvider from "./main";
import { publishDeviceState, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import { BinarySensorMetadata, binarySensorMetadataMap, convertSettingsToStorageSettings, DetectionRule, EventType, getDetectionRulesSettings, getMixinBaseSettings, getRuleKeys, isDeviceEnabled, RuleSource, RuleType } from "./utils";

const { systemManager } = sdk;

export class AdvancedNotifierSensorMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<string> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            isCamera: false,
            refreshSettings: this.refreshSettings.bind(this)
        }),
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
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    detectionListener: EventListenerRegister;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    isActiveForNvrNotifications: boolean;
    isActiveForMqttReporting: boolean;
    mainAutodiscoveryDone: boolean;
    mqttReportInProgress: boolean;
    logger: Console;
    killed: boolean;
    detectionRules: DetectionRule[] = [];
    nvrDetectionRules: DetectionRule[] = [];
    rulesDiscovered: string[] = [];
    lastDetection: number;
    metadata: BinarySensorMetadata;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.metadata = binarySensorMetadataMap[this.type];

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

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            const {
                isActiveForMqttReporting,
                isPluginEnabled,
                detectionRules,
                skippedDetectionRules,
                isActiveForNotifications,
                isActiveForNvrNotifications,
                nvrRules,
                allDeviceDetectionRules,
                allDetectionRules,
            } = await isDeviceEnabled({
                device: this,
                console: logger,
                plugin: this.plugin,
                deviceStorage: this.storageSettings
            });

            const detectionRulesToEnable = (detectionRules || []).filter(newRule => !allDetectionRules?.some(currentRule => currentRule.name === newRule.name));
            const detectionRulesToDisable = (allDetectionRules || []).filter(currentRule => !detectionRules?.some(newRule => newRule.name === currentRule.name));

            if (detectionRulesToEnable?.length) {
                for (const rule of detectionRulesToEnable) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'true');
                }
            }

            if (detectionRulesToDisable?.length) {
                for (const rule of detectionRulesToEnable) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'false');
                }
            }

            logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedDetectionRules })}`);
            this.detectionRules = detectionRules || [];
            this.nvrDetectionRules = nvrRules || [];

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
                            rules: allDeviceDetectionRules,
                        });

                        this.getLogger().log(`Subscribing to mqtt topics`);
                        await subscribeToDeviceMqttTopics({
                            mqttClient,
                            rules: allDeviceDetectionRules,
                            device,
                            activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                logger.log(`Setting ${ruleType} rule ${ruleName} for device ${device.name} to ${active}`);
                                await this.storageSettings.putSetting(`${enabledKey}`, active);
                            },
                        });

                        this.mainAutodiscoveryDone = true;
                    }
                }
            }

            if (isCurrentlyRunning && !shouldRun) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldRun) {
                logger.log(`Starting ${this.metadata.interface} listener: ${JSON.stringify({
                    Notifications: isActiveForNotifications,
                    MQTT: isActiveForMqttReporting,
                })}`);
                await this.startListeners();
            }
            if (isActiveForNvrNotifications && !this.isActiveForNvrNotifications) {
                logger.log(`Starting NVR events listeners`);
            } else if (!isActiveForNvrNotifications && this.isActiveForNvrNotifications) {
                logger.log(`Stopping NVR events listeners`);
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

    async refreshSettings() {
        const logger = this.getLogger();
        const dynamicSettings: StorageSetting[] = [];

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            isCamera: false,
            ruleSource: RuleSource.Device,
            logger,
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

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage,
        });
    }

    async getMixinSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putMixinSetting(key: string, value: string) {
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
        this.detectionListener = systemManager.listenDevice(this.id, this.metadata.interface, async (_, __, data) => {
            const timestamp = new Date().getTime();

            const isTriggered = this.metadata.isActiveFn(undefined, data);
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
                    logger.debug(`Waiting for delay: ${minDelayTime - ((triggerTime - this.lastDetection) / 1000)}s`);
                    return;
                }

                this.lastDetection = triggerTime;
            }

            logger.log(`Sensor triggered: ${JSON.stringify({ triggered })}`);

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
                        allRuleIds: [],
                        triggerTime,
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
                    logger.log('Error taking a picture in sensor mixin', e);
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