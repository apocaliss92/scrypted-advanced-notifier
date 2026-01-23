
import sdk, { Notifier, NotifierOptions, ScryptedDeviceBase, ScryptedDeviceType, SecuritySystem, SecuritySystemMode, SecuritySystemObstruction, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSetting, StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { getMqttBasicClient, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { scryptedToHaStateMap } from '../../scrypted-homeassistant/src/types/securitySystem';
import { AlarmEvent, getAlarmModeSequences, getAlarmSequenceNames, getAlarmSettings, getAlarmWebhookUrls, getModeEntity } from './alarmUtils';
import AdvancedNotifierPlugin from './main';
import { idPrefix, publishAlarmSystemValues, setupAlarmSystemAutodiscovery, subscribeToAlarmSystemMqttTopics } from './mqtt-utils';
import { BaseRule, binarySensorMetadataMap, convertSettingsToStorageSettings, DeviceInterface, HOMEASSISTANT_PLUGIN_ID, isDeviceSupported, NotificationPriority, NTFY_PLUGIN_ID, NVR_PLUGIN_ID, PUSHOVER_PLUGIN_ID, safeParseJson, TELEGRAM_PLUGIN_ID, ZENTIK_PLUGIN_ID } from './utils';

type StorageKeys = 'notifiers' |
    'logeLevel' |
    'mqttEnabled' |
    'enabledModes' |
    'activeMode' |
    'arming' |
    'triggered' |
    'currentlyActiveDevices' |
    'currentlyBypassedDevices' |
    'activeRules' |
    'activeNotifiers' |
    'useRuleNotifiers' |
    'armingMessage' |
    'preActivationStartMessage' |
    'armingErrorMessage' |
    'triggerMessage' |
    'disarmingMessage' |
    'defuseMessage' |
    'defuseMessageAutomatic' |
    'deactivateMessage' |
    'modeHomeText' |
    'modeNightText' |
    'modeAwayText' |
    'triggerCriticalNotifications' |
    'setModeMessage' |
    'noneText';

export class AdvancedNotifierAlarmSystem extends ScryptedDeviceBase implements SecuritySystem, Settings {
    initStorage: StorageSettingsDict<StorageKeys> = {
        enabledModes: {
            title: 'Enable modes',
            type: 'string',
            defaultValue: [
                SecuritySystemMode.AwayArmed,
                SecuritySystemMode.HomeArmed,
                SecuritySystemMode.NightArmed,
            ],
            choices: [
                SecuritySystemMode.AwayArmed,
                SecuritySystemMode.HomeArmed,
                SecuritySystemMode.NightArmed,
            ],
            multiple: true,
            combobox: true,
            immediate: true,
            onPut: async (_, modes) => {
                this.securitySystemState = {
                    ...this.securitySystemState,
                    supportedModes: modes,
                }

                await this.refreshSettings();
                this.lastAutoDiscovery = undefined;
            }
        },
        useRuleNotifiers: {
            title: 'Use rule notifiers',
            description: 'If checked, the notifiers will be automatically picked from the active rules, with same settings',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        triggerCriticalNotifications: {
            title: 'Send critical notifications on triggers',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        activeNotifiers: {
            title: `Currently active notifiers`,
            type: 'string',
            defaultValue: [],
            choices: [],
            multiple: true,
            combobox: true,
            readonly: true
        },
        notifiers: {
            title: 'Notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: `type === '${ScryptedDeviceType.Notifier}'`,
            defaultValue: [],
            immediate: true,
        },
        logeLevel: logLevelSetting,
        mqttEnabled: {
            title: 'MQTT enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        activeMode: {
            title: 'Active mode',
            type: 'string',
            group: 'Status',
            combobox: true,
            immediate: true,
            choices: Object.values(SecuritySystemMode),
            defaultValue: SecuritySystemMode.Disarmed,
            onPut: async (_, mode) => await this.armSecuritySystem(mode)
        },
        arming: {
            title: 'Arming',
            type: 'boolean',
            group: 'Status',
            readonly: true,
        },
        triggered: {
            title: 'Triggered',
            type: 'boolean',
            group: 'Status',
            readonly: true,
        },
        currentlyActiveDevices: {
            title: `Currently active devices`,
            type: 'string',
            group: 'Status',
            defaultValue: [],
            choices: [],
            multiple: true,
            combobox: true,
            readonly: true
        },
        currentlyBypassedDevices: {
            title: `Currently bypassed devices`,
            type: 'string',
            group: 'Status',
            defaultValue: [],
            choices: [],
            multiple: true,
            combobox: true,
            readonly: true
        },
        activeRules: {
            title: `Currently active rules`,
            type: 'string',
            group: 'Status',
            defaultValue: [],
            choices: [],
            multiple: true,
            combobox: true,
            readonly: true
        },
        armingMessage: {
            title: 'Arming message',
            description: 'Message sent when the alarm is armed. Available placeholders are ${mode}, ${bypassedDevices}, ${activeDevicesAmount}',
            type: 'textarea',
            group: 'Texts',
            defaultValue: 'Alarm armed in "${mode}" mode. ${activeDevicesAmount} active devices. Bypassed devices: ${bypassedDevices}',
        },
        preActivationStartMessage: {
            title: 'Preactivation message',
            description: 'Message sent when the alarm starts the preactivation. Available placeholders are ${mode}, ${bypassedDevices}, ${activeDevicesAmount} and ${seconds}',
            type: 'textarea',
            group: 'Texts',
            defaultValue: 'Alarm will be armed in "${mode}" mode in ${seconds} seconds. ${activeDevicesAmount} active devices. Bypassed devices: ${bypassedDevices}',
        },
        armingErrorMessage: {
            title: 'Arming message',
            description: 'Message sent when the alarm cannot be armed. Available placeholders are ${mode} and ${blockingDevices}',
            type: 'textarea',
            group: 'Texts',
            defaultValue: 'Alarm cannot be armed in "${mode}" mode. Blocking devices: ${blockingDevices}',
        },
        triggerMessage: {
            title: 'Trigger message',
            description: 'Message sent when the alarm is triggered. Available placeholders are ${triggerDevices}',
            type: 'textarea',
            group: 'Texts',
            defaultValue: 'Alarm fired by ${triggerDevices}',
        },
        disarmingMessage: {
            title: 'Disarming message',
            description: 'Message sent when the alarm is disarmed',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Alarm disarmed',
        },
        defuseMessage: {
            title: 'Defuse message',
            description: 'Message sent when the alarm is disarmed while triggered',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Alarm defused',
        },
        defuseMessageAutomatic: {
            title: 'Automatic Defuse message',
            description: 'Message sent when the alarm is automatically disarmed while triggered',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Alarm defused automatically after ${seconds} seconds',
        },
        deactivateMessage: {
            title: 'Text for notifications to disable the alarm',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Deactivate',
        },
        setModeMessage: {
            title: 'Text for notifications to set a mode',
            description: 'Placeholder ${mode}',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Set: ${mode}',
        },
        modeHomeText: {
            title: 'Text for mode HomeArmed',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Home',
        },
        modeNightText: {
            title: 'Text for mode NightArmed',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Night',
        },
        modeAwayText: {
            title: 'Text for mode AwayArmed',
            type: 'string',
            group: 'Texts',
            defaultValue: 'Away',
        },
        noneText: {
            title: 'Text for None(s)',
            description: 'Used when device lists used are empty',
            type: 'string',
            group: 'Texts',
            defaultValue: 'None',
        },
    };

    storageSettings = new StorageSettings(this, this.initStorage);
    public mqttClient: MqttClient;
    clientId: string;
    killed: boolean;
    mainLoopListener: NodeJS.Timeout;
    activationListener: NodeJS.Timeout;
    disarmListener: NodeJS.Timeout;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    activeRules: BaseRule[];
    logger: Console;
    lastMqttCommandReceived: number;

    private async triggerAlarmManually(source: string) {
        const logger = this.getLogger();

        if (this.securitySystemState.mode === SecuritySystemMode.Disarmed) {
            logger.log(`Ignoring manual trigger while disarmed (${source})`);
            return;
        }

        if (this.securitySystemState.triggered) {
            return;
        }

        this.storageSettings.values.triggered = true;
        this.securitySystemState = {
            ...this.securitySystemState,
            triggered: true
        };

        await this.updateMqtt({
            mode: 'triggered',
        });

        await this.sendNotification({
            event: AlarmEvent.Trigger,
            triggerDevices: [source]
        });

        const { trigger: triggerSequences } = getAlarmModeSequences({
            mode: this.securitySystemState.mode,
            alarmStorage: this.storageSettings,
            pluginStorage: this.plugin.storageSettings,
        });
        this.plugin.triggerRuleSequences({
            sequences: triggerSequences,
            postFix: `alarm-trigger-${this.securitySystemState.mode}`,
            rule: {
                name: `alarm:${this.securitySystemState.mode}:trigger`,
            } as BaseRule,
        }).catch(logger.error);

        const { autoDisarmTime, autoRiarmTime } = getModeEntity({
            mode: this.securitySystemState.mode,
            storage: this.storageSettings
        });

        if (autoRiarmTime) {
            this.resetDisarmListener();
            this.disarmListener = setTimeout(async () => {
                await this.riarm();
            }, 1000 * autoRiarmTime);
        } else if (autoDisarmTime) {
            this.resetDisarmListener();
            this.disarmListener = setTimeout(async () => {
                await this.disarmSecuritySystemInternal(AlarmEvent.DefuseAuto);
            }, 1000 * autoDisarmTime);
        }
    }

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);
        const logger = this.getLogger();

        if (!this.securitySystemState) {
            this.securitySystemState = {
                mode: SecuritySystemMode.Disarmed,
                obstruction: undefined,
                triggered: false,
                supportedModes: this.storageSettings.values.enabledModes,
            }
        }

        this.clientId = `scrypted_an_alarm_system_${this.id}`;

        this.initValues().then().catch(logger.log);

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    public async startStop(enabled: boolean) {
        const activeMode = this.securitySystemState.mode;

        if (activeMode !== this.storageSettings.values.activeMode) {
            await this.armSecuritySystem(activeMode);
        }

        if (enabled) {
            await this.startCheckInterval();
        } else {
            await this.release();
        }
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
                const now = Date.now();

                const { mqttEnabled } = this.storageSettings.values;
                if (mqttEnabled) {
                    const mqttClient = await this.getMqttClient();
                    if (mqttClient) {
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                            this.lastAutoDiscovery = now;

                            logger.log('Starting MQTT autodiscovery');
                            setupAlarmSystemAutodiscovery({
                                mqttClient,
                                console: logger,
                                supportedModes: this.securitySystemState.supportedModes,
                            }).catch(logger.error);

                            logger.log(`Subscribing to mqtt topics`);
                            await subscribeToAlarmSystemMqttTopics({
                                mqttClient,
                                console: logger,
                                modeSwitchCb: async (mode) => {
                                    const now = Date.now();
                                    if (!this.lastMqttCommandReceived || (now - this.lastMqttCommandReceived) > (1000 * 2)) {
                                        logger.log(`Setting mode to ${mode} (currently ${this.securitySystemState.mode})`);

                                        this.lastMqttCommandReceived = now;
                                        await this.armSecuritySystem(mode);
                                    }
                                },
                                triggerCb: async () => {
                                    const now = Date.now();
                                    if (!this.lastMqttCommandReceived || (now - this.lastMqttCommandReceived) > (1000 * 2)) {
                                        this.lastMqttCommandReceived = now;
                                        await this.triggerAlarmManually('MQTT');
                                    }
                                }
                            });
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

    async onEventTrigger(props: {
        triggerDevice: DeviceInterface,
    }) {
        const logger = this.getLogger();

        const { triggerDevice } = props;
        const { currentlyActiveDevices } = this.storageSettings.values;

        if (this.securitySystemState.mode === SecuritySystemMode.Disarmed) {
            return;
        }

        if (currentlyActiveDevices.includes(triggerDevice.name)) {
            logger.log(`Alarm triggered by ${triggerDevice.name}`);

            if (!this.securitySystemState.triggered) {
                this.storageSettings.values.triggered = true;
                this.securitySystemState = {
                    ...this.securitySystemState,
                    triggered: true
                };

                await this.updateMqtt({
                    mode: 'triggered',
                });

                await this.sendNotification({
                    event: AlarmEvent.Trigger,
                    triggerDevices: [triggerDevice?.name]
                });

                const { trigger: triggerSequences } = getAlarmModeSequences({
                    mode: this.securitySystemState.mode,
                    alarmStorage: this.storageSettings,
                    pluginStorage: this.plugin.storageSettings,
                });
                this.plugin.triggerRuleSequences({
                    sequences: triggerSequences,
                    postFix: `alarm-trigger-${this.securitySystemState.mode}`,
                    rule: {
                        name: `alarm:${this.securitySystemState.mode}:trigger`,
                    } as BaseRule,
                }).catch(logger.error);

                const { autoDisarmTime, autoRiarmTime } = getModeEntity({
                    mode: this.securitySystemState.mode,
                    storage: this.storageSettings
                });

                if (autoRiarmTime) {
                    this.resetDisarmListener();
                    this.disarmListener = setTimeout(async () => {
                        await this.riarm();
                    }, 1000 * autoRiarmTime);
                } else if (autoDisarmTime) {
                    this.resetDisarmListener();
                    this.disarmListener = setTimeout(async () => {
                        await this.disarmSecuritySystemInternal(AlarmEvent.DefuseAuto);
                    }, 1000 * autoDisarmTime);
                }
            }
        }
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing device');
        this.killed = true;

        this.mqttClient && this.mqttClient.disconnect();
        this.resetListeners();
    }

    resetActivationListener() {
        this.activationListener && clearTimeout(this.activationListener);
        this.activationListener = undefined;
    }

    resetDisarmListener() {
        this.disarmListener && clearTimeout(this.disarmListener);
        this.disarmListener = undefined;
    }

    resetListeners() {
        this.resetActivationListener();
        this.resetDisarmListener();
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
    }

    async initValues() {
        const logger = this.getLogger();
        try {
        } catch { };

        await this.refreshSettings();
        await this.refreshSettings();
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
                        cache: this.plugin.storageSettings.values.mqttMemoryCacheEnabled,
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

    async refreshSettings() {
        const sequenceNames = getAlarmSequenceNames({ pluginStorage: this.plugin.storageSettings });
        const dynamicSettings: StorageSetting[] = [];

        // Disarmed è sempre disponibile: aggiungo sempre le sue settings (solo sequenze).
        dynamicSettings.push(...getAlarmSettings({ mode: SecuritySystemMode.Disarmed, sequenceNames }));

        for (const mode of this.storageSettings.values.enabledModes) {
            const modeSettings = getAlarmSettings({ mode, sequenceNames });
            dynamicSettings.push(...modeSettings);
        }

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });
    }

    async getSettings(): Promise<Setting[]> {
        const { useRuleNotifiers } = this.storageSettings.values;
        this.storageSettings.settings.notifiers.hide = useRuleNotifiers;
        this.storageSettings.settings.activeNotifiers.hide = !useRuleNotifiers;
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async updateMqtt(props: { mode: string, info?: { activeDevices: string[], bypassedDevices: string[] } }) {
        const { info, mode } = props;
        const mqttClient = await this.getMqttClient();

        if (mqttClient) {
            const logger = this.getLogger();

            publishAlarmSystemValues({
                mqttClient,
                mode,
                info,
            }).catch(logger.error);
        }
    }

    async sendNotification(props: {
        mode?: SecuritySystemMode,
        event?: AlarmEvent,
        preactivationSeconds?: number,
        autoDefuseSeconds?: number,
        bypassedDevices?: string[],
        activeDevices?: string[],
        blockingDevices?: string[],
        triggerDevices?: string[],
    }) {
        const logger = this.getLogger();

        try {
            const {
                blockingDevices = [],
                event,
                activeDevices = [],
                bypassedDevices = [],
                mode = this.securitySystemState.mode,
                preactivationSeconds,
                autoDefuseSeconds,
                triggerDevices = []
            } = props;
            let message: string;

            const {
                preActivationStartMessage,
                defuseMessage,
                defuseMessageAutomatic,
                disarmingMessage,
                armingErrorMessage,
                armingMessage,
                triggerMessage,
                modeAwayText,
                modeHomeText,
                modeNightText,
                notifiers,
                useRuleNotifiers,
                noneText,
                setModeMessage,
                deactivateMessage,
                triggerCriticalNotifications,
            } = this.storageSettings.values;

            switch (event) {
                case AlarmEvent.Activate:
                case AlarmEvent.RiarmAuto:
                    message = armingMessage;
                    break;
                case AlarmEvent.Preactivation:
                    message = preActivationStartMessage;
                    break;
                case AlarmEvent.Disarm:
                    message = disarmingMessage;
                    break;
                case AlarmEvent.Blocked:
                    message = armingErrorMessage;
                    break;
                case AlarmEvent.Trigger:
                    message = triggerMessage;
                    break;
                case AlarmEvent.DefuseAuto:
                    message = defuseMessageAutomatic;
                    break;
                case AlarmEvent.DefuseManual:
                    message = defuseMessage;
                    break;
            }

            const modeText = mode === SecuritySystemMode.AwayArmed ?
                modeAwayText : mode === SecuritySystemMode.HomeArmed ?
                    modeHomeText : mode === SecuritySystemMode.NightArmed ?
                        modeNightText : String(mode);

            const renderList = (list: string[]) => list.length > 0 ? list.join(', ') : noneText;

            const text = (message || '')
                .replaceAll('${mode}', modeText)
                .replaceAll('${seconds}', String(preactivationSeconds ?? autoDefuseSeconds ?? ''))
                .replaceAll('${bypassedDevices}', renderList(bypassedDevices))
                .replaceAll('${blockingDevices}', renderList(blockingDevices))
                .replaceAll('${triggerDevices}', renderList(triggerDevices))
                .replaceAll('${activeDevicesAmount}', String(activeDevices.length));

            const alarmActions = await getAlarmWebhookUrls({
                deactivateMessage,
                modeAwayText,
                modeHomeText,
                modeNightText,
                setModeMessage,
                plugin: this.plugin
            });

            const notifierPriority: Record<string, NotificationPriority> = {};
            let notifiersToUse = notifiers;
            if (useRuleNotifiers) {
                const notifiersSet = new Set<string>();
                for (const rule of (this.activeRules ?? [])) {
                    for (const notifierId of rule.notifiers) {
                        notifiersSet.add(notifierId);
                        notifierPriority[notifierId] = rule.notifierData[notifierId]?.priority;
                    }
                }

                notifiersToUse = Array.from(notifiersSet);
            }

            if (!notifiersToUse.length) {
                notifiersToUse = notifiers;
            }

            for (const notifierId of notifiersToUse) {
                let additionalMessageText = '';
                const notifier = sdk.systemManager.getDeviceById<Notifier & ScryptedDeviceBase>(notifierId);

                let payload: any = {
                    data: {}
                };

                const supPriority = notifierPriority[notifierId];
                const isSupPriorityLow = supPriority && [NotificationPriority.Low, NotificationPriority.SuperLow].includes(supPriority);
                const isCritical = triggerCriticalNotifications && event === 'Trigger'
                if (notifier.pluginId === PUSHOVER_PLUGIN_ID) {
                    const priority = isSupPriorityLow ?
                        (supPriority === NotificationPriority.Low ? -1 : -2)
                        : isCritical ? 1 : 0;

                    payload.data.pushover = {
                        priority,
                        html: 1,
                    };

                    additionalMessageText += '\n';
                    for (const { title, url } of alarmActions) {
                        additionalMessageText += `<a href="${url}">${title}</a>\n`;
                    }
                } else if (notifier.pluginId === HOMEASSISTANT_PLUGIN_ID) {
                    payload.data.ha = {};

                    const haActions: any[] = [];
                    for (const { action, icon, title } of alarmActions) {
                        haActions.push({
                            action,
                            icon,
                            title,
                        })
                    }
                    payload.data.ha.actions = haActions;

                    if (isCritical && !isSupPriorityLow) {
                        payload.data.ha.push = {
                            'interruption-level': 'critical',
                            sound: {
                                name: 'default',
                                critical: 1,
                                volume: 1.0
                            }
                        };
                    }
                } else if (notifier.pluginId === ZENTIK_PLUGIN_ID) {
                    payload.data.zentik = {};
                    const zentikActions = [];

                    for (const { url, icon, title } of alarmActions) {
                        zentikActions.push({
                            title,
                            type: 'BACKGROUND_CALL',
                            value: `POST::${url}`,
                            icon,
                        });
                    }

                    const tapAction = {
                        type: 'OPEN_NOTIFICATION',
                        title: 'Open',
                    }

                    payload.data.zentik = {
                        priority: isCritical && !isSupPriorityLow ? 'CRITICAL' : 'NORMAL',
                        addMarkAsReadAction: true,
                        addOpenNotificationAction: true,
                        addDeleteAction: true,
                        actions: zentikActions,
                        tapAction
                    };
                } else if (notifier.pluginId === NTFY_PLUGIN_ID) {
                    const ntfyActions: any[] = [];

                    ntfyActions.push(...alarmActions.slice(0, 3).map(action => ({
                        action: 'http',
                        label: action.title,
                        url: action.url,
                        method: 'GET',
                    })));

                    const priority = isSupPriorityLow ?
                        (supPriority === NotificationPriority.Low ? 2 : 1)
                        : isCritical ? 5 : 3;
                    payload.data.ntfy = {
                        actions: ntfyActions,
                        priority,
                    };
                } else if (notifier.pluginId === NVR_PLUGIN_ID) {
                    if (isCritical && !isSupPriorityLow) {
                        payload.critical = true;
                    }
                } else if (notifier.pluginId === TELEGRAM_PLUGIN_ID) {
                    payload.data.telegram = {};

                    const telegramActions: any[] = [];
                    for (const { action, url, title } of alarmActions) {
                        telegramActions.push({
                            action,
                            title,
                            url,
                        })
                    }
                    payload.data.telegram.actions = telegramActions;
                }

                const notifierOptions: NotifierOptions = {
                    body: text + additionalMessageText,
                    ...payload,
                }

                await notifier.sendNotification(this.name, notifierOptions);
            }
        } catch (e) {
            logger.log(`Error in sendNotification`, e);
        }
    }

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        const logger = this.getLogger();

        const shouldStopArming = mode === SecuritySystemMode.Disarmed && this.storageSettings.values.arming;

        if (mode === this.securitySystemState.mode && !shouldStopArming) {
            return;
        }

        this.resetActivationListener();
        this.resetDisarmListener();

        if (mode === SecuritySystemMode.Disarmed) {
            return await this.disarmSecuritySystem();
        } else {
            try {
                const entity = getModeEntity({ mode, storage: this.storageSettings });
                logger.log(`Trying to arm into ${mode} mode:`, JSON.stringify(entity));

                const activeRules = this.plugin.allAvailableRules
                    .filter(item => item.securitySystemModes?.includes(mode));

                const activeRuleNames = activeRules.map(rule => rule.name);
                logger.log(`${activeRules.length} rules found ${activeRuleNames.join(', ')}`);
                this.storageSettings.values.activeRules = activeRuleNames;
                this.activeRules = activeRules;

                const activeNotifiers = new Set<string>();
                for (const rule of activeRules) {
                    for (const notifierId of rule.notifiers) {
                        const notifier = sdk.systemManager.getDeviceById(notifierId);
                        activeNotifiers.add(notifier.name);
                    }
                }
                this.storageSettings.values.activeNotifiers = Array.from(activeNotifiers);

                const activeDevicesSet = new Set<string>();
                const bypassedDevicesSet = new Set<string>();
                const blockingDevicesSet = new Set<string>();

                for (const rule of activeRules) {
                    try {
                        for (const deviceId of rule.devices) {
                            const device = sdk.systemManager.getDeviceById<DeviceInterface>(deviceId);

                            const { sensorType } = isDeviceSupported(device);
                            if (sensorType) {
                                const { isActiveFn } = binarySensorMetadataMap[sensorType];
                                const isActive = isActiveFn(device);

                                if (isActive) {
                                    if (entity.bypassableDevices.includes(deviceId)) {
                                        bypassedDevicesSet.add(deviceId);
                                        activeDevicesSet.add(deviceId);
                                    } else {
                                        blockingDevicesSet.add(deviceId);
                                    }
                                } else {
                                    activeDevicesSet.add(deviceId);
                                }
                            } else {
                                activeDevicesSet.add(deviceId);
                            }
                        }
                    } catch (e) {
                        logger.log(`Error in checking rule ${rule.name}`, e.message);
                    }
                }

                const activeDevices = Array.from(activeDevicesSet)
                    .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);
                const bypassedDevices = Array.from(bypassedDevicesSet)
                    .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);
                const blockingDevices = Array.from(blockingDevicesSet)
                    .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);

                const anyBlockers = !!blockingDevices.length;

                logger.log(JSON.stringify({
                    activeDevices,
                    bypassedDevices,
                    blockingDevices,
                    anyBlockers,
                }));

                if (anyBlockers) {
                    this.storageSettings.values.activeMode = this.securitySystemState.mode;
                    this.securitySystemState = {
                        ...this.securitySystemState,
                        obstruction: SecuritySystemObstruction.Sensor,
                        triggered: false,
                    };
                    await this.sendNotification({
                        mode,
                        blockingDevices,
                        event: AlarmEvent.Blocked,
                    });
                } else {
                    const activate = async () => {
                        const previousMode = this.securitySystemState.mode;
                        logger.log(`New mode set to ${mode}`);
                        this.securitySystemState = {
                            ...this.securitySystemState,
                            obstruction: undefined,
                            triggered: false,
                            mode,
                        };
                        this.storageSettings.values.currentlyActiveDevices = activeDevices;
                        this.storageSettings.values.currentlyBypassedDevices = bypassedDevices;
                        this.storageSettings.values.activeMode = mode;
                        this.storageSettings.values.arming = false;
                        await this.updateMqtt({
                            mode: scryptedToHaStateMap[mode],
                            info: {
                                activeDevices,
                                bypassedDevices,
                            }
                        });

                        // Deactivation sequences della modalità precedente (incl. Disarmed) solo quando il cambio è effettivo.
                        if (previousMode && previousMode !== mode) {
                            const { deactivation: previousDeactivationSequences } = getAlarmModeSequences({
                                mode: previousMode,
                                alarmStorage: this.storageSettings,
                                pluginStorage: this.plugin.storageSettings,
                            });
                            this.plugin.triggerRuleSequences({
                                sequences: previousDeactivationSequences,
                                postFix: `alarm-deactivate-${previousMode}`,
                                rule: {
                                    name: `alarm:${previousMode}:deactivate`,
                                } as BaseRule,
                            }).catch(logger.error);
                        }

                        if (mode) {
                            await this.sendNotification({
                                mode,
                                bypassedDevices,
                                activeDevices,
                                event: AlarmEvent.Activate,
                            });

                            const { activation: activationSequences } = getAlarmModeSequences({
                                mode,
                                alarmStorage: this.storageSettings,
                                pluginStorage: this.plugin.storageSettings,
                            });
                            this.plugin.triggerRuleSequences({
                                sequences: activationSequences,
                                postFix: `alarm-activate-${mode}`,
                                rule: {
                                    name: `alarm:${mode}:activate`,
                                } as BaseRule,
                            }).catch(logger.error);
                        }
                    };

                    if (entity.preActivationTime) {
                        logger.log(`New mode will be set in ${entity.preActivationTime}`);
                        this.activationListener = setTimeout(async () =>
                            await activate(),
                            entity.preActivationTime * 1000
                        );
                        this.storageSettings.values.arming = true;
                        await this.updateMqtt({
                            mode: 'arming',
                            info: {
                                activeDevices: [],
                                bypassedDevices: [],
                            }
                        });

                        await this.sendNotification({
                            mode,
                            bypassedDevices,
                            activeDevices,
                            event: AlarmEvent.Preactivation,
                            preactivationSeconds: entity.preActivationTime,
                        });
                    } else {
                        await activate();
                    }
                }
            } catch (e) {
                logger.log(`Error in armSecuritySystem`, e);
            }
        }
    }

    async riarm() {
        const logger = this.getLogger();
        const mode = this.securitySystemState.mode;
        logger.log(`Riarming alarm in mode ${mode}`);

        await this.sendNotification({
            event: AlarmEvent.RiarmAuto,
        });

        await this.updateMqtt({
            mode: scryptedToHaStateMap[mode],
        });

        this.securitySystemState = {
            ...this.securitySystemState,
            triggered: false,
            obstruction: undefined,
            mode
        };
    }

    async disarmSecuritySystemInternal(event: AlarmEvent) {
        this.resetActivationListener();
        const logger = this.getLogger();
        const previousMode = this.securitySystemState.mode;
        logger.log(`Disarmed from event ${event}`);

        await this.sendNotification({
            mode: SecuritySystemMode.Disarmed,
            event,
        });

        this.activeRules = [];

        await this.updateMqtt({
            mode: scryptedToHaStateMap[SecuritySystemMode.Disarmed],
            info: {
                activeDevices: [],
                bypassedDevices: []
            }
        });

        this.securitySystemState = {
            ...this.securitySystemState,
            triggered: false,
            obstruction: undefined,
            mode: SecuritySystemMode.Disarmed
        };

        this.storageSettings.values.currentlyActiveDevices = [];
        this.storageSettings.values.currentlyBypassedDevices = [];
        this.storageSettings.values.activeRules = [];
        this.storageSettings.values.arming = false;
        this.storageSettings.values.triggered = false;
        this.storageSettings.values.activeMode = SecuritySystemMode.Disarmed;

        // Disarmed può avere sequenze: activation quando si passa effettivamente a Disarmed.
        if (previousMode && previousMode !== SecuritySystemMode.Disarmed) {
            const { deactivation: deactivationSequences } = getAlarmModeSequences({
                mode: previousMode,
                alarmStorage: this.storageSettings,
                pluginStorage: this.plugin.storageSettings,
            });
            this.plugin.triggerRuleSequences({
                sequences: deactivationSequences,
                postFix: `alarm-deactivate-${previousMode}`,
                rule: {
                    name: `alarm:${previousMode}:deactivate`,
                } as BaseRule,
            }).catch(logger.error);

            const { activation: disarmedActivationSequences } = getAlarmModeSequences({
                mode: SecuritySystemMode.Disarmed,
                alarmStorage: this.storageSettings,
                pluginStorage: this.plugin.storageSettings,
            });
            this.plugin.triggerRuleSequences({
                sequences: disarmedActivationSequences,
                postFix: `alarm-activate-${SecuritySystemMode.Disarmed}`,
                rule: {
                    name: `alarm:${SecuritySystemMode.Disarmed}:activate`,
                } as BaseRule,
            }).catch(logger.error);
        }
    }

    async disarmSecuritySystem(): Promise<void> {
        await this.disarmSecuritySystemInternal(AlarmEvent.Disarm);
    }
}
