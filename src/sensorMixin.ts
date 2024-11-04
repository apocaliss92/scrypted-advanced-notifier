import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ScryptedDeviceBase, ScryptedDeviceType } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { EventType, getMixinBaseSettings, getWebookUrls, isDeviceEnabled } from "./utils";
import { defaultDetectionClasses } from "./detecionClasses";
import HomeAssistantUtilitiesProvider from "./main";

const { systemManager } = sdk;

export class AdvancedNotifierSensorMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        ...getMixinBaseSettings(this.name, this.type),
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
    // lastDetection: number;
    // disabledNotifiers: string[] = [];
    logger: Console;
    mqttAutodiscoverySent: boolean;
    killed: boolean;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

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

        this.initValues().then(() =>
            this.startCheckInterval().then().catch(this.console.log)
        ).catch(this.console.log);
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            // const useNvrDetections = this.storageSettings.values.useNvrDetections;
            const useNvrDetections = false;
            const { isActiveForMqttReporting, isActiveForNotifications, isPluginEnabled } = await isDeviceEnabled(this.name);

            const triggerAlwaysNotification = this.storageSettings.values.triggerAlwaysNotification;

            const newIsCameraActiveForNotifications = !useNvrDetections && (isActiveForNotifications || triggerAlwaysNotification);
            const newIsCameraActiveForMqttReporting = !useNvrDetections && isActiveForMqttReporting;

            if (!isPluginEnabled && (newIsCameraActiveForNotifications || newIsCameraActiveForMqttReporting)) {
                logger.log('Plugin is not enabled.');
            }

            this.isActiveForNotifications = isPluginEnabled && newIsCameraActiveForNotifications;
            this.isActiveForMqttReporting = isPluginEnabled && newIsCameraActiveForMqttReporting;

            const isCurrentlyRunning = !!this.detectionListener;
            const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

            if (newIsCameraActiveForMqttReporting && !this.mqttAutodiscoverySent) {
                const mqttClient = await this.plugin.getMqttClient()
                if (mqttClient) {
                    const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
                    await mqttClient.setupDeviceAutodiscovery({
                        device,
                        console: logger,
                        withDetections: false,
                        deviceClass: this.storageSettings.getItem('haDeviceClass') || 'window'
                    });

                    this.mqttAutodiscoverySent = true;
                }
            }

            if (isCurrentlyRunning && !shouldRun) {
                logger.log('Stopping and cleaning listeners.');
                this.resetListeners();
            } else if (!isCurrentlyRunning && shouldRun) {
                logger.log(`Starting ${ScryptedInterface.BinarySensor} listeners: ${JSON.stringify({
                    notificationsActive: newIsCameraActiveForNotifications,
                    mqttReportsActive: newIsCameraActiveForMqttReporting,
                    useNvrDetections,
                    isPluginEnabled,
                    isCurrentlyRunning,
                    shouldRun,
                })}`);
                try {
                    await this.startListeners();
                } catch (e) {
                    logger.log('error in main loop', e);
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
        }, 5000);
    }

    resetListeners() {
        if (this.detectionListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.detectionListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
    }

    async initValues() {
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
        this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();
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
            // const { minDelayTime } = this.storageSettings.values;

            const now = new Date().getTime();

            try {
                // if (this.lastDetection && (now - this.lastDetection) < 1000 * minDelayTime) {
                //     logger.debug(`Waiting for delay: ${(now - this.lastDetection) / 1000}s`);
                //     return;
                // }

                // this.lastDetection = now;
                logger.log(`Sensor triggered: ${triggered}`);

                const mqttClient = await this.plugin.getMqttClient();

                if (mqttClient) {
                    try {
                        const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;
                        await mqttClient.publishDeviceState({
                            device,
                            triggered,
                            console: logger,
                            resettAllClasses: false,
                        }).finally(() => this.mqttReportInProgress = false);
                    } catch (e) {
                        logger.log(`Error in reportDetectionsToMqtt`, e);
                    }
                }

                if (triggered) {
                    const { isDoorbell } = await this.plugin.getLinkedCamera(this.name);

                    this.plugin.matchDetectionFound({
                        triggerDeviceId: this.id,
                        logger,
                        eventType: isDoorbell ? EventType.Doorbell : EventType.Contact,
                        triggerTime: now,
                        shouldNotify: this.isActiveForNotifications,
                        disabledNotifiers: this.storageSettings.values.disabledNotifiers,
                    });
                }

            } catch (e) {
                logger.log('Error finding a match', e);
            }
        });
    }
}