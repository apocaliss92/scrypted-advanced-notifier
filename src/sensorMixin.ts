import sdk, { EventListenerRegister, MediaObject, ScryptedDeviceType, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import HomeAssistantUtilitiesProvider from "./main";
import { BinarySensorMetadata, binarySensorMetadataMap, convertSettingsToStorageSettings, DetectionRule, EventType, getDetectionRulesSettings, getMixinBaseSettings, getRuleKeys, getActiveRules, RuleSource, RuleType, splitRules, ScryptedEventSource } from "./utils";
import { cloneDeep } from "lodash";
import { getBaseLogger } from "../../scrypted-apocaliss-base/src/basePlugin";

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
    logger: Console;
    killed: boolean;
    runningDetectionRules: DetectionRule[] = [];
    lastDetection: number;
    metadata: BinarySensorMetadata;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.metadata = binarySensorMetadataMap[this.type];

        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = this.plugin.fetchedEntities;
            return {
                choices: entities ?? []
            }
        }

        this.plugin.currentSensorMixinsMap[this.id] = this;

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
                allowedDetectionRules,
                availableDetectionRules,
                anyAllowedNvrDetectionRule,
                shouldListenDetections,
            } = await getActiveRules({
                device: this,
                console: logger,
                plugin: this.plugin,
                deviceStorage: this.storageSettings
            });

            const [rulesToEnable, rulesToDisable] = splitRules({
                allRules: availableDetectionRules,
                currentlyRunningRules: this.runningDetectionRules,
                rulesToActivate: allowedDetectionRules
            });

            for (const rule of rulesToEnable) {
                const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                this.putMixinSetting(currentlyActiveKey, 'true');
            }

            for (const rule of rulesToDisable) {
                const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: rule.name, ruleType: RuleType.Detection });
                this.putMixinSetting(currentlyActiveKey, 'false');
            }

            logger.debug(`Detected rules: ${JSON.stringify({ availableDetectionRules, allowedDetectionRules })}`);
            this.runningDetectionRules = allowedDetectionRules || [];

            const isCurrentlyRunning = !!this.detectionListener;

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

            if (anyAllowedNvrDetectionRule && !this.isActiveForNvrNotifications) {
                logger.log(`Starting NVR events listeners`);
            } else if (!anyAllowedNvrDetectionRule && this.isActiveForNvrNotifications) {
                logger.log(`Stopping NVR events listeners`);
            }
            this.isActiveForNvrNotifications = anyAllowedNvrDetectionRule;
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
        }, 5 * 1000);
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

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = getBaseLogger({
                deviceConsole: this.console,
                storage: this.storageSettings,
                friendlyName: `scrypted_an_${this.id}`
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
        const isFromNvr = eventSource === ScryptedEventSource.NVR;

        logger.log(`Event received triggered ${triggered} isFromNvr ${!!isFromNvr}`);

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

                const { isDoorbell, device } = await this.plugin.getLinkedCamera(this.id);
                const isDoorlock = this.type === ScryptedDeviceType.Lock;

                const mixinDevice = this.plugin.currentCameraMixinsMap[device.id];

                if (!this.runningDetectionRules.length || !mixinDevice) {
                    return;
                }

                const image = (await mixinDevice.getImage({ image: imageParent }))?.image;

                const eventType = isDoorbell ? EventType.Doorbell : isDoorlock ? EventType.Doorlock : EventType.Contact;

                const rules = cloneDeep(this.runningDetectionRules.filter(rule => isFromNvr ? rule.isNvr : !rule.isNvr)) ?? [];
                for (const rule of rules) {
                    logger.log(`Starting ${rule.notifiers.length} notifiers for event ${eventType}`);
                    logger.info(JSON.stringify({
                        eventType,
                        triggerTime,
                        rule,
                    }));

                    this.plugin.matchDetectionFound({
                        triggerDeviceId: this.id,
                        eventType,
                        triggerTime,
                        rule,
                        image,
                        detectionKey: `sensor_${this.id}`
                    });
                }
            }

        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }
}