import sdk, { NotifierOptions, MediaObject, Setting, Settings, Notifier, ScryptedInterface } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DeviceInterface, getTextSettings, NVR_NOTIFIER_INTERFACE } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";
import { getBaseLogger, getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { idPrefix, reportNotifierValues, setupNotifierAutodiscovery, subscribeToNotifierMqttTopics } from "./mqtt-utils";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

export class AdvancedNotifierNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings, Notifier {
    storageSettings = new StorageSettings(this, {
        enabled: {
            title: 'Enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        addSnoozeActions: {
            title: 'Add snoozing actions',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        enabledToMqtt: {
            title: 'Report to MQTT',
            description: 'Autodiscovery this notifier on MQTT',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        ...getTextSettings(true) as any,
    });
    mainLoopListener: NodeJS.Timeout;
    logger: Console;
    killed: boolean;
    clientId: string;
    mqttClient: MqttClient;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    notifierDevice: DeviceInterface;
    isNvrNotifier: boolean;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();
        this.notifierDevice = sdk.systemManager.getDeviceById<DeviceInterface>(this.id);
        this.isNvrNotifier = this.interfaces.includes(NVR_NOTIFIER_INTERFACE) &&
            this.interfaces.includes(ScryptedInterface.OnOff);

        this.clientId = `scrypted_an_notifier_${this.id}`;
        this.plugin.currentNotifierMixinsMap[this.id] = this;
        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing mixin');
        this.killed = true;
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = getBaseLogger({
                deviceConsole: this.console,
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
            try {
                const { enabledToMqtt, enabled } = this.storageSettings.values;
                if (enabledToMqtt) {
                    const now = Date.now();
                    const mqttClient = await this.getMqttClient();
                    if (mqttClient) {
                        // Every 60 minutes repeat the autodiscovery
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                            logger.log('Starting MQTT autodiscovery');
                            setupNotifierAutodiscovery({
                                mqttClient,
                                device: this.notifierDevice,
                                console: logger,
                            }).then(async (activeTopics) => {
                                await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                            }).catch(logger.error);

                            logger.debug(`Subscribing to mqtt topics`);
                            subscribeToNotifierMqttTopics({
                                mqttClient,
                                device: this.notifierDevice,
                                console: logger,
                                switchNotificationsEnabledCb: async (active) => {
                                    logger.log(`Setting notifications active to ${!active}`);

                                    if (this.isNvrNotifier) {
                                        if (active) {
                                            this.notifierDevice.turnOn();
                                        } else {
                                            this.notifierDevice.turnOff();
                                        }
                                    } else {
                                        await this.storageSettings.putSetting(`enabled`, active);
                                    }
                                },
                            }).catch(logger.error);

                            this.lastAutoDiscovery = now;
                        }

                        const notificationsEnabled = this.isNvrNotifier ? this.on : enabled;
                        reportNotifierValues({
                            console: logger,
                            device: this.notifierDevice,
                            mqttClient,
                            notificationsEnabled,
                        }).catch(logger.error);
                    }
                }
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.log('Error in mainLoopListener', e);
            }
        }, 1000 * 2);
    }

    sendNotification(title: string, options?: NotifierOptions, media?: MediaObject | string, icon?: MediaObject | string): Promise<void> {
        let canNotify = true;

        const cameraDevice = sdk.systemManager.getDeviceByName(title);
        const notifierDevice = sdk.systemManager.getDeviceByName(this.id);
        if (cameraDevice) {
            const cameraMixin = this.plugin.currentCameraMixinsMap[cameraDevice.id];
            if (cameraMixin) {
                const logger = this.plugin.getLogger();
                const notificationsEnabled = cameraMixin.storageSettings.values.notificationsEnabled;

                if (!notificationsEnabled) {
                    canNotify = false;
                    logger.log(`Skipping NVR notification for ${cameraDevice.name} from notifier ${notifierDevice.name} because disabled`);
                }
            }

        }

        if (canNotify) {
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        if (this.storageSettings.settings.enabled) {
            this.storageSettings.settings.enabled.hide = this.isNvrNotifier;
        }
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}