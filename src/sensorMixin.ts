import sdk, { EventListenerRegister, MediaObject, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep } from "lodash";
import { getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import HomeAssistantUtilitiesProvider from "./main";
import { idPrefix, reportSensorValues, setupSensorAutodiscovery, subscribeToSensorMqttTopics } from "./mqtt-utils";
import { BinarySensorMetadata, binarySensorMetadataMap, cameraFilter, convertSettingsToStorageSettings, DetectionRule, DeviceInterface, getActiveRules, getDetectionRulesSettings, GetImageReason, getMixinBaseSettings, getRuleKeys, MixinBaseSettingKey, NotifyRuleSource, RuleSource, RuleType, ScryptedEventSource, splitRules, SupportedSensorType } from "./utils";
import { DetectionClass } from "./detectionClasses";

const { systemManager } = sdk;

type SensorSettingKey =
    | 'linkedCamera'
    | MixinBaseSettingKey;

export class AdvancedNotifierSensorMixin extends SettingsMixinDeviceBase<any> implements Settings {
    initStorage: StorageSettingsDict<SensorSettingKey> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        linkedCamera: {
            title: 'Linked camera',
            type: 'device',
            deviceFilter: cameraFilter,
            immediate: true,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    detectionListener: EventListenerRegister;
    mainLoopListener: NodeJS.Timeout;
    isActiveForNotifications: boolean;
    logger: Console;
    killed: boolean;
    runningDetectionRules: DetectionRule[] = [];
    lastDetection: number;
    metadata: BinarySensorMetadata;
    supportedSensorType: SupportedSensorType;
    clientId: string;
    mqttClient: MqttClient;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    sensorDevice: DeviceInterface;
    hasVideoclipRules = false;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        supportedSensorType: SupportedSensorType,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();
        this.plugin.currentSensorMixinsMap[this.id] = this;
        this.sensorDevice = sdk.systemManager.getDeviceById<DeviceInterface>(this.id);

        this.supportedSensorType = supportedSensorType;

        this.metadata = binarySensorMetadataMap[supportedSensorType];

        this.refreshSettings().catch(logger.log);

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

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            const { enabledToMqtt } = this.storageSettings.values;
            const {
                allowedDetectionRules,
                availableDetectionRules,
                shouldListenDetections: shouldListenDetectionsParent,
                hasClips
            } = await getActiveRules({
                device: this,
                console: logger,
                plugin: this.plugin,
                deviceStorage: this.storageSettings
            });

            const [rulesToEnable, rulesToDisable] = splitRules({
                allRules: availableDetectionRules,
                currentlyRunningRules: this.runningDetectionRules,
                rulesToActivate: allowedDetectionRules,
                device: this.sensorDevice
            });

            for (const rule of rulesToEnable) {
                if (!rule.currentlyActive) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'true');
                }
            }

            for (const rule of rulesToDisable) {
                if (rule.currentlyActive) {
                    const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                    this.putMixinSetting(currentlyActiveKey, 'false');
                }
            }

            logger.debug(`Detected rules: ${JSON.stringify({ availableDetectionRules, allowedDetectionRules })}`);
            this.runningDetectionRules = cloneDeep(allowedDetectionRules || []);
            this.hasVideoclipRules = hasClips;

            const isCurrentlyRunning = !!this.detectionListener;

            const shouldListenDetections = shouldListenDetectionsParent || this.plugin.storageSettings.values.storeEvents;

            if (isCurrentlyRunning && !shouldListenDetections) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldListenDetections) {
                logger.log(`Starting ${this.metadata.interface} listener: ${JSON.stringify({
                    Detections: shouldListenDetections,
                    NotificationRules: allowedDetectionRules.length
                })}`);
                await this.startListeners();
            }


            if (enabledToMqtt) {
                const now = Date.now();
                const mqttClient = await this.getMqttClient();
                if (mqttClient) {
                    // Every 60 minutes repeat the autodiscovery
                    if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                        logger.log('Starting MQTT autodiscovery');
                        setupSensorAutodiscovery({
                            mqttClient,
                            device: this.sensorDevice,
                            console: logger,
                            rules: availableDetectionRules
                        }).then(async (activeTopics) => {
                            await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                        }).catch(logger.error);

                        logger.debug(`Subscribing to mqtt topics`);
                        subscribeToSensorMqttTopics({
                            mqttClient,
                            device: this.sensorDevice,
                            console: logger,
                            // switchNotificationsEnabledCb: async (active) => {
                            //     logger.log(`Setting notifications active to ${!active}`);

                            //     if (this.isNvrNotifier) {
                            //         if (active) {
                            //             this.notifierDevice.turnOn();
                            //         } else {
                            //             this.notifierDevice.turnOff();
                            //         }
                            //     } else {
                            //         await this.storageSettings.putSetting(`enabled`, active);
                            //     }
                            // },
                        }).catch(logger.error);

                        this.lastAutoDiscovery = now;
                    }

                    reportSensorValues({
                        console: logger,
                        device: this.sensorDevice,
                        mqttClient,
                    }).catch(logger.error);
                }
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
        }, 2 * 1000);
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
            device: this,
            logger,
            ruleSource: RuleSource.Device,
            refreshSettings: this.refreshSettings.bind(this),
        });
        dynamicSettings.push(...detectionRulesSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });
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
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
        this.resetListeners();

        delete this.plugin.currentSensorMixinsMap[this.id];
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = this.plugin.getLoggerInternal({
                console: this.console,
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

    async startListeners() {
        this.detectionListener = systemManager.listenDevice(this.id, this.metadata.interface, async (_, __, data) => {
            const timestamp = new Date().getTime();

            const isTriggered = this.metadata.isActiveFn(undefined, data);
            this.processEvent({ triggered: isTriggered, triggerTime: timestamp, eventSource: ScryptedEventSource.RawDetection })
        });
    }

    public async processEvent(props: {
        triggerTime: number,
        triggered: boolean,
        image?: MediaObject,
        eventSource: ScryptedEventSource
    }) {
        const { minDelayTime } = this.storageSettings.values;
        const { triggerTime, triggered, image: imageParent, eventSource } = props;
        const logger = this.getLogger();

        try {
            logger.log(`Sensor triggered: ${JSON.stringify({ triggered })}`);
            if (triggered) {
                if (minDelayTime) {
                    if (this.lastDetection && (triggerTime - this.lastDetection) < 1000 * minDelayTime) {
                        logger.info(`Waiting for delay: ${minDelayTime - ((triggerTime - this.lastDetection) / 1000)}s`);
                        return;
                    }

                    this.lastDetection = triggerTime;
                }

                const { device } = await this.plugin.getLinkedCamera(this.id);

                if (!device) {
                    logger.log(`There is no camera linked to this device`);
                    return;
                }

                const mixinDevice = this.plugin.currentCameraMixinsMap[device.id];

                if (!mixinDevice) {
                    return;
                }

                const { image, b64Image, imageSource } = (await mixinDevice.getImage({
                    image: imageParent,
                    reason: GetImageReason.Sensor,
                }));

                const { device: cameraDevice } = await this.plugin.getLinkedCamera(this.id);
                this.plugin.storeEventImage({
                    b64Image,
                    detections: [{ className: DetectionClass.Sensor, score: 1 }],
                    device: cameraDevice,
                    triggerDevice: this.sensorDevice,
                    eventSource: ScryptedEventSource.RawDetection,
                    logger,
                    timestamp: triggerTime,
                    image,
                }).catch(logger.error);

                if (!this.runningDetectionRules.length) {
                    return;
                }

                const rules = cloneDeep(this.runningDetectionRules);
                for (const rule of rules) {
                    logger.log(`Event ${this.supportedSensorType} will be proxied to the device ${device.name}`);
                    logger.info(JSON.stringify({
                        eventType: this.supportedSensorType,
                        triggerTime,
                        rule,
                    }));

                    this.plugin.notifyDetectionEvent({
                        triggerDeviceId: this.id,
                        eventSource: NotifyRuleSource.Sensor,
                        eventType: this.supportedSensorType,
                        triggerTime,
                        matchRule: {
                            rule,
                        },
                        imageData: {
                            fullFrameImage: image,
                            image: image,
                            imageSource
                        }
                    }).catch(logger.error);
                }
            }

        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }
}