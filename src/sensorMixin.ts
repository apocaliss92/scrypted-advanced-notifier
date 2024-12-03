import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ScryptedDeviceBase, ScryptedDeviceType } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionRule, EventType, getDetectionRulesSettings, getMixinBaseSettings, isDeviceEnabled } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";
import { discoverDetectionRules, getDetectionRuleId, publishDeviceState, setupDeviceAutodiscovery } from "./mqtt-utils";

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
    isActiveForMqttReporting: boolean;
    mqttReportInProgress: boolean;
    logger: Console;
    mqttAutodiscoverySent: boolean;
    killed: boolean;
    detectionRules: DetectionRule[];
    rulesDiscovered: string[] = [];
    lastDetection: number;

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

        this.startCheckInterval().then().catch(this.console.log)
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
                isActiveForNotifications
            } = await isDeviceEnabled(this.id, deviceSettings, this.plugin);

            logger.debug(`Detected rules: ${JSON.stringify({ detectionRules, skippedRules })}`);
            this.detectionRules = detectionRules;

            this.isActiveForNotifications = isActiveForNotifications;
            this.isActiveForMqttReporting = isActiveForMqttReporting;

            const isCurrentlyRunning = !!this.detectionListener;
            const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

            if (isActiveForMqttReporting) {
                const mqttClient = await this.plugin.getMqttClient();
                if (mqttClient) {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
                    if (!this.mqttAutodiscoverySent) {
                        await setupDeviceAutodiscovery({
                            mqttClient,
                            device,
                            console: logger,
                            withDetections: true,
                            deviceClass: this.storageSettings.values.haDeviceClass || 'window'
                        });
                        this.mqttAutodiscoverySent = true;
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
                logger.log(`Starting ${ScryptedInterface.BinarySensor} listeners: ${JSON.stringify({
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
        const logger = this.getLogger();

        this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.BinarySensor, async (_, __, triggered) => {
            const { minDelayTime } = this.storageSettings.values;

            const now = new Date().getTime();

            try {
                if (minDelayTime) {
                    if (this.lastDetection && (now - this.lastDetection) < 1000 * minDelayTime) {
                        logger.debug(`Waiting for delay: ${(now - this.lastDetection) / 1000}s`);
                        return;
                    }

                    this.lastDetection = now;
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
                    const deviceSettings = await device.getSettings();
                    const cameraSnapshotHeight = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotHeight')?.value as number) ?? 720;
                    const cameraSnapshotWidth = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotWidth')?.value as number) ?? 1280;

                    let image;

                    try {
                        image = await device.takePicture({
                            reason: 'event',
                            picture: {
                                height: cameraSnapshotHeight,
                                width: cameraSnapshotWidth,
                            },
                        });
                    } catch (e) {
                        logger.log('Error taking a picture', e);
                    }

                    for (const rule of this.detectionRules) {
                        logger.log(`Starting notifiers: ${JSON.stringify({
                            eventType: isDoorbell ? EventType.Doorbell : EventType.Contact,
                            triggerTime: now,
                            rule,
                        })})}`);
                        this.plugin.matchDetectionFound({
                            triggerDeviceId: this.id,
                            logger,
                            eventType: isDoorbell ? EventType.Doorbell : EventType.Contact,
                            triggerTime: now,
                            rule,
                            image,
                        });
                    }
                }

            } catch (e) {
                logger.log('Error finding a match', e);
            }
        });
    }
}