import sdk, { MediaObject, Notifier, NotifierOptions, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import HomeAssistantUtilitiesProvider from "./main";
import { idPrefix, reportNotifierValues, setupNotifierAutodiscovery, subscribeToNotifierMqttTopics } from "./mqtt-utils";
import { convertSettingsToStorageSettings, DetectionRule, DeviceInterface, GetImageReason, getMixinBaseSettings, getTextSettings, getWebHookUrls, isSchedulerActive, MixinBaseSettingKey, moToB64, NVR_NOTIFIER_INTERFACE, parseNvrNotificationMessage, TextSettingKey } from "./utils";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

type NotifierSettingKey =
    | 'enabled'
    | 'enableTranslations'
    | 'postNotificationWebhook'
    | 'aiEnabled'
    | 'schedulerEnabled'
    | 'startTime'
    | 'endTime'
    | TextSettingKey
    | MixinBaseSettingKey;

export class AdvancedNotifierNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings, Notifier {
    initStorage: StorageSettingsDict<NotifierSettingKey> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        enabled: {
            title: 'Enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        aiEnabled: {
            title: 'AI descriptions',
            description: 'Use configured AI to generate descriptions',
            type: 'boolean',
            immediate: true,
            defaultValue: false,
            onPut: async () => await this.refreshSettings()
        },
        enableTranslations: {
            title: 'Translations',
            description: 'Use the plugin configured Texts to provide notifications text',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        postNotificationWebhook: {
            subgroup: 'Webhooks',
            type: 'html',
            description: 'POST with body containing: cameraId, imageUrl, timestamp, message, hash (identifier of the webhook call)',
            title: 'Cloud URL',
            readonly: true,
        },
        schedulerEnabled: {
            type: 'boolean',
            title: 'Scheduler',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        startTime: {
            title: 'Start time',
            type: 'time',
            immediate: true,
        },
        endTime: {
            title: 'End time',
            type: 'time',
            immediate: true,
        },
        ...getTextSettings({ forMixin: true }),
    };
    storageSettings = new StorageSettings(this, this.initStorage);

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

        this.initValues().then().catch(logger.log);

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    async initValues() {
        const logger = this.getLogger();
        try {
            if (this.plugin.hasCloudPlugin) {
                const { postNotificationUrl } = await getWebHookUrls({
                    cameraIdOrAction: this.id,
                    console: logger,
                    device: this.notifierDevice,
                });

                await this.storageSettings.putSetting('postNotificationWebhook', postNotificationUrl);
            }
        } catch { };

        await this.refreshSettings();
        await this.refreshSettings();
    }

    async refreshSettings() {
        const logger = this.getLogger();
        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings: [],
            initStorage: this.initStorage
        });

        const { schedulerEnabled, aiEnabled } = this.storageSettings.values;

        if (this.storageSettings.settings.startTime) {
            this.storageSettings.settings.startTime.hide = !schedulerEnabled;
        }
        if (this.storageSettings.settings.endTime) {
            this.storageSettings.settings.endTime.hide = !schedulerEnabled;
        }
        if (this.storageSettings.settings.enabled) {
            this.storageSettings.settings.enabled.hide = this.isNvrNotifier;
        }
        if (this.storageSettings.settings.enableTranslations) {
            this.storageSettings.settings.enableTranslations.hide = !this.isNvrNotifier;
        }
        if (this.storageSettings.settings.enableTranslations) {
            this.storageSettings.settings.enableTranslations.hide = aiEnabled;
        }
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

                            logger.log(`Subscribing to mqtt topics`);
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
                                snoozeCb: async (props) => {
                                    const { cameraId, snoozeTime, snoozeId } = props;

                                    const deviceMixin = this.plugin.currentCameraMixinsMap[cameraId];
                                    if (deviceMixin) {
                                        deviceMixin.snoozeNotification({ snoozeId, snoozeTime });
                                    }
                                },
                            }).catch(logger.error);

                            this.lastAutoDiscovery = now;
                        }

                        if (this.plugin.storageSettings.values.mqttEnabled) {
                            const notificationsEnabled = this.isNvrNotifier ? this.on : enabled;
                            reportNotifierValues({
                                console: logger,
                                device: this.notifierDevice,
                                mqttClient,
                                notificationsEnabled,
                            }).catch(logger.error);
                        }
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

    async sendNotification(title: string, options?: NotifierOptions, media?: MediaObject | string, icon?: MediaObject | string): Promise<void> {
        const logger = this.getLogger();

        const { isNotificationFromAnPlugin, cameraId, snoozeId } = options?.data ?? {};
        const isNotificationFromNvr = options.tag || options.recordedEvent;

        if (isNotificationFromAnPlugin || isNotificationFromNvr) {
            try {
                let canNotify = true;

                const {
                    schedulerEnabled,
                    startTime,
                    endTime,
                    enabled,
                    enableTranslations,
                    aiEnabled,
                } = this.storageSettings.values;

                if (!enabled) {
                    canNotify = false;
                    logger.log(`Skipping Notification because notifier is disabled`);
                }

                const pluginNotificationsEnabled = this.plugin.storageSettings.values.notificationsEnabled;

                if (!pluginNotificationsEnabled) {
                    logger.log(`Skipping notification because plugin notifications disabled`);
                    canNotify = false;
                }

                let cameraDevice = cameraId ? sdk.systemManager.getDeviceById<DeviceInterface>(cameraId) : undefined;
                if (!cameraDevice) {
                    cameraDevice = sdk.systemManager.getDeviceByName<DeviceInterface>(title);
                }
                const cameraMixin = cameraDevice ? this.plugin.currentCameraMixinsMap[cameraDevice.id] : undefined;

                if (canNotify && cameraDevice) {
                    if (cameraMixin) {
                        const notificationsEnabled = cameraMixin.storageSettings.values.notificationsEnabled;

                        if (!notificationsEnabled) {
                            canNotify = false;
                            logger.log(`Skipping Notification because camera ${cameraDevice?.name} is disabled`);
                        }
                        const {
                            schedulerEnabled,
                            startTime,
                            endTime,
                        } = cameraMixin.storageSettings.values;

                        if (schedulerEnabled) {
                            const schedulerActive = isSchedulerActive({ endTime, startTime });

                            if (!schedulerActive) {
                                canNotify = false;
                                logger.log(`Skipping Notification because camera scheduler is not active`);
                            }
                        }
                    }

                    if (schedulerEnabled) {
                        const schedulerActive = isSchedulerActive({ endTime, startTime });

                        if (!schedulerActive) {
                            canNotify = false;
                            logger.log(`Skipping Notification because notifier scheduler is not active`);
                        }
                    }

                    if (isNotificationFromAnPlugin) {
                        const now = Date.now();
                        const lastSnoozed = cameraMixin.snoozeUntilDic[snoozeId];
                        const isSnoozed = lastSnoozed && now < lastSnoozed;

                        if (isSnoozed) {
                            logger.log(`Skipping Notification because ${snoozeId} still snoozed for ${(lastSnoozed - now) / 1000} seconds`);
                            canNotify = false;
                        }
                    }
                }

                if (canNotify) {
                    let titleToUse = title;
                    if (!isNotificationFromAnPlugin && (enableTranslations || aiEnabled) && cameraDevice) {
                        const deviceSensors = this.plugin.videocameraDevicesMap[cameraDevice.id] ?? [];
                        const { eventType, detection, triggerTime } = await parseNvrNotificationMessage(cameraDevice, deviceSensors, options, logger);

                        const image = typeof media === 'string' ? (await sdk.mediaManager.createMediaObjectFromUrl(media)) : media;

                        let b64Image: string;
                        if (cameraMixin) {
                            b64Image = (await cameraMixin.getImage({ image, reason: GetImageReason.FromNvr }))?.b64Image;
                        } else if (image) {
                            b64Image = await moToB64(image);
                        }

                        const { message } = await this.plugin.getNotificationContent({
                            device: cameraDevice,
                            notifier: this.notifierDevice,
                            triggerTime,
                            logger,
                            b64Image,
                            detection,
                            eventType,
                        });
                        const tapToViewText = this.plugin.getTextKey({ notifierId: this.id, textKey: 'tapToViewText' });

                        options.subtitle = message;
                        options.bodyWithSubtitle = tapToViewText;

                        logger.log(`Content modified to ${message} ${tapToViewText}`);
                    }

                    await this.mixinDevice.sendNotification(titleToUse, options, media, icon);
                }
            } catch (e) {
                logger.log('Error in sendNotification', e);
            }
        } else {
            await this.mixinDevice.sendNotification(title, options, media, icon);
        }
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
}