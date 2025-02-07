import sdk, { EventListenerRegister, LockState, MediaObject, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import HomeAssistantUtilitiesProvider from "./main";
import { discoveryRuleTopics, getDetectionRuleId, publishDeviceState, setupDeviceAutodiscovery, subscribeToDeviceMqttTopics } from "./mqtt-utils";
import { convertSettingsToStorageSettings, DetectionRule, EventType, getDetectionRulesSettings, getMixinBaseSettings, getRuleKeys, isDeviceEnabled, RuleSource, RuleType } from "./utils";

const { systemManager } = sdk;

export class AdvancedNotifierSensorMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<string> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            isCamera: false,
            refreshSettings: this.refreshSettings
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

        if (this.storageSettings.values.room && !this.room) {
            sdk.systemManager.getDeviceById<ScryptedDevice>(this.id).setRoom(this.storageSettings.values.room);
        }
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            const {
                isActiveForMqttReporting,
                isPluginEnabled,
                detectionRules,
                skippedRules,
                isActiveForNotifications,
                isActiveForNvrNotifications,
                nvrRules,
                allDeviceRules,
            } = await isDeviceEnabled({
                device: this,
                console: logger,
                plugin: this.plugin,
                deviceStorage: this.storageSettings
            });

            const detectionRulesToEnable = (detectionRules || []).filter(newRule => !this.detectionRules?.some(currentRule => currentRule.name === newRule.name));
            const detectionRulesToDisable = (this.detectionRules || []).filter(currentRule => !detectionRules?.some(newRule => newRule.name === currentRule.name));

            if (detectionRulesToEnable?.length) {
                for (const rule of detectionRulesToEnable) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'true');
                }
                logger.log(`Detection rules started: ${detectionRulesToEnable.map(rule => rule.name).join(', ')}`);
            }

            if (detectionRulesToDisable?.length) {
                for (const rule of detectionRulesToEnable) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'false');
                }
                logger.log(`Detection rules stopped: ${detectionRulesToDisable.map(rule => rule.name).join(', ')}`);
            }

            logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedRules })}`);
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
                            detectionRules: allDeviceRules,
                        });

                        this.getLogger().log(`Subscribing to mqtt topics`);
                        await subscribeToDeviceMqttTopics({
                            mqttClient,
                            detectionRules: allDeviceRules,
                            device,
                            activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                logger.log(`Setting ${ruleType} rule ${ruleName} for device ${device.name} to ${active}`);
                                await this.storageSettings.putSetting(`${enabledKey}`, active);
                            },
                        });

                        this.mainAutodiscoveryDone = true;
                    }

                    const missingRules = detectionRules.filter(rule => !this.rulesDiscovered.includes(getDetectionRuleId(rule)));
                    if (missingRules.length) {
                        await discoveryRuleTopics({ mqttClient, console: logger, device, rules: missingRules });
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
        const settings: Setting[] = await new StorageSettings(this, this.initStorage).getSettings();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            isCamera: false,
            ruleSource: RuleSource.Device,
            onShowMore: async () => await this.refreshSettings(),
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
        settings.push(...detectionRulesSettings);

        this.storageSettings = convertSettingsToStorageSettings({
            device: this,
            settings,
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
                    logger.debug(`Waiting for delay: ${minDelayTime - ((triggerTime - this.lastDetection) / 1000)}s`);
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