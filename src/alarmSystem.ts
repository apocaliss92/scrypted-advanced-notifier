
import sdk, { Lock, Notifier, ScryptedDeviceBase, ScryptedDeviceType, SecuritySystem, SecuritySystemMode, SecuritySystemObstruction, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSetting, StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { getBaseLogger, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { scryptedToHaStateMap } from '../../scrypted-homeassistant/src/types/securitySystem';
import { getAlarmSettings, getModeEntity, supportedAlarmModes } from './alarmUtils';
import AdvancedNotifierPlugin from './main';
import { idPrefix, publishAlarmSystemValues, setupAlarmSystemAutodiscovery, subscribeToAlarmSystemMqttTopics } from './mqtt-utils';
import { binarySensorMetadataMap, convertSettingsToStorageSettings, DeviceInterface, isDeviceSupported } from './utils';

type StorageKeys = 'notifiers' |
    'autoCloseLocks' |
    'debug' |
    'info' |
    'mqttEnabled' |
    'activeMode' |
    'arming' |
    'triggered' |
    'currentlyActiveDevices' |
    'currentlyBypassedDevices' |
    'armingMessage' |
    'preActivationStartMessage' |
    'armingErrorMessage' |
    'triggerMessage' |
    'disarmingMessage' |
    'defuseMessage' |
    'modeHomeText' |
    'modeNightText' |
    'modeAwayText' |
    'noneText';

export class AdvancedNotifierAlarmSystem extends ScryptedDeviceBase implements SecuritySystem, Settings {
    initStorage: StorageSettingsDict<StorageKeys> = {
        notifiers: {
            title: 'Notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: `type === '${ScryptedDeviceType.Notifier}'`,
            defaultValue: [],
            immediate: true,
        },
        autoCloseLocks: {
            title: 'Automatically close open locks when arming',
            description: 'If checked, locks will be automatically bypassed',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        info: {
            title: 'Log info messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
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
            title: 'Arming erorr message',
            description: 'Message sent when the alarm cannot be armed. Available placeholders are ${mode} and ${blockingDevices}',
            type: 'textarea',
            group: 'Texts',
            defaultValue: 'Alarm cannot be armed in "${mode}" mode. Blocking devices: ${blockingDevices}',
        },
        triggerMessage: {
            title: 'Trigger erorr message',
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
    private mainLogger: Console;
    clientId: string;
    killed: boolean;
    mainLoopListener: NodeJS.Timeout;
    activationListener: NodeJS.Timeout;
    disarmListener: NodeJS.Timeout;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);
        const logger = this.getLogger();

        if (!this.securitySystemState) {
            this.securitySystemState = {
                mode: SecuritySystemMode.Disarmed,
                obstruction: undefined,
                triggered: false,
                supportedModes: supportedAlarmModes,
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
                    const logger = this.getLogger();
                    if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                        this.lastAutoDiscovery = now;

                        logger.log('Starting MQTT autodiscovery');
                        setupAlarmSystemAutodiscovery({
                            mqttClient,
                            console: logger,
                        }).then(async (activeTopics) => {
                            await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                        }).catch(logger.error);

                        logger.log(`Subscribing to mqtt topics`);
                        await subscribeToAlarmSystemMqttTopics({
                            mqttClient,
                            console: logger,
                            modeSwitchCb: async (mode) => {
                                logger.log(`Setting mode to ${mode}`);
                                this.armSecuritySystem(mode);
                            },
                        });
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

    async trigger(deviceName: string) {
        if (!this.securitySystemState.triggered) {
            await this.putSetting('triggered', true);
            this.securitySystemState = {
                ...this.securitySystemState,
                triggered: true
            };

            await this.updateMqtt({
                mode: 'triggered',
            });
            await this.sendNotification({
                mode: this.securitySystemState.mode,
                event: 'Trigger',
                activeDevices: [deviceName]
            });
        }
    }

    async defuse(automatically: boolean) {
        if (this.securitySystemState.triggered) {
            await this.putSetting('triggered', false);
            this.securitySystemState = {
                ...this.securitySystemState,
                triggered: false
            };
            await this.sendNotification({
                mode: this.securitySystemState.mode,
                event: automatically ? 'DefuseAuto' : 'DefuseManual',
            });
        }
    }

    async onEventTrigger(props: { triggerDevice: DeviceInterface }) {
        const logger = this.getLogger();

        const { triggerDevice } = props;
        const { currentlyActiveDevices } = this.storageSettings.values;

        if (this.securitySystemState.mode === SecuritySystemMode.Disarmed) {
            return;
        }

        if (currentlyActiveDevices.includes(triggerDevice.name)) {
            logger.log(`Alarm triggered by ${triggerDevice.name}`);
            const { autoDisarmTime } = getModeEntity({ mode: this.securitySystemState.mode, storage: this.storageSettings });

            await this.trigger(triggerDevice.name);

            if (autoDisarmTime) {
                this.resetDisarmListener();
                this.disarmListener = setTimeout(async () => {
                    await this.defuse(true);
                    await this.disarmSecuritySystem();
                }, 1000 * autoDisarmTime);
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

    getLogger(): Console {
        if (!this.mainLogger) {
            this.mainLogger = getBaseLogger({
                deviceConsole: this.console,
                storage: this.storageSettings,
                friendlyName: `Advanced security system`
            });
        }

        return this.mainLogger
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

    async refreshSettings() {
        const logger = this.getLogger();

        const dynamicSettings: StorageSetting[] = [];
        for (const mode of supportedAlarmModes) {
            const modeSettings = getAlarmSettings({ mode });
            dynamicSettings.push(...modeSettings);
        }

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });
    }

    async getSettings(): Promise<Setting[]> {
        const logger = this.getLogger();
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async updateMqtt(props: { mode: string, info?: { activeDevices: string[], bypassedDevices: string[] } }) {
        const { info, mode } = props;
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();

        publishAlarmSystemValues({
            mqttClient,
            mode,
            info,
        }).catch(logger.error);
    }

    async sendNotification(props: {
        mode: SecuritySystemMode,
        event: 'Preactivation' | 'Activate' | 'Blocked' | 'Trigger' | 'DefuseAuto' | 'DefuseManual',
        preactivationSeconds?: number,
        bypassedDevices?: string[],
        activeDevices?: string[],
        blockingDevices?: string[],
        triggerDevices?: string[],
    }) {
        const logger = this.getLogger();

        try {
            const { triggered } = this.securitySystemState;
            const {
                blockingDevices = [],
                event,
                activeDevices = [],
                bypassedDevices = [],
                mode,
                preactivationSeconds,
                triggerDevices = []
            } = props;
            let message: string;

            const {
                preActivationStartMessage,
                defuseMessage,
                disarmingMessage,
                armingErrorMessage,
                armingMessage,
                triggerMessage,
                modeAwayText,
                modeHomeText,
                modeNightText,
                notifiers,
                noneText,
            } = this.storageSettings.values;

            if (mode === SecuritySystemMode.Disarmed) {
                message = triggered ? defuseMessage : disarmingMessage;
            } else {
                switch (event) {
                    case 'Preactivation':
                        message = preActivationStartMessage;
                        break;
                    case 'Blocked':
                        message = armingErrorMessage;
                        break;
                    case 'Activate':
                        message = armingMessage;
                        break;
                    case 'Trigger':
                        message = triggerMessage;
                        break;
                    case 'DefuseAuto':
                    case 'DefuseManual':
                        message = defuseMessage;
                        break;
                }
            }

            const modeText = mode === SecuritySystemMode.AwayArmed ?
                modeAwayText : mode === SecuritySystemMode.HomeArmed ?
                    modeHomeText : mode === SecuritySystemMode.NightArmed ?
                        modeNightText : undefined;

            const renderList = (list: string[]) => list.length > 0 ? list.join(', ') : noneText;

            const text = (message || '')
                .replaceAll('${mode}', modeText)
                .replaceAll('${seconds}', String(preactivationSeconds ?? ''))
                .replaceAll('${bypassedDevices}', renderList(bypassedDevices))
                .replaceAll('${blockingDevices}', renderList(blockingDevices))
                .replaceAll('${triggerDevices}', renderList(triggerDevices))
                .replaceAll('${activeDevicesAmount}', !!activeDevices.length ? String(activeDevices.length) : noneText);

            for (const notifierId of notifiers) {
                const notifier = sdk.systemManager.getDeviceById<Notifier>(notifierId);

                await notifier.sendNotification(this.name, { body: text });
            }
        } catch (e) {
            logger.log(`Error in sendNotification`, e);
        }
    }

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        const logger = this.getLogger();

        this.resetActivationListener();

        if (mode === this.securitySystemState.mode) {
            return;
        }

        this.resetDisarmListener();
        if (this.securitySystemState.triggered) {
            this.defuse(false);
        }

        if (mode === SecuritySystemMode.Disarmed) {
            return await this.disarmSecuritySystem();
        }

        try {
            const { autoCloseLocks } = this.storageSettings.values;

            const entity = getModeEntity({ mode, storage: this.storageSettings });
            logger.log(`Trying to arm into ${mode} mode:`, entity);

            const activeRules = this.plugin.allAvailableRules
                .filter(item => item.securitySystemModes?.includes(mode));

            logger.log(`${activeRules} rules found ${activeRules.map(rule => rule.name).join(', ')}`);

            const activeDevicesSet = new Set<string>();
            const bypassedDevicesSet = new Set<string>();
            const blockingDevicesSet = new Set<string>();
            const locksToLockSet = new Set<string>();

            for (const rule of activeRules) {
                try {
                    for (const deviceId of rule.devices) {
                        const device = sdk.systemManager.getDeviceById<DeviceInterface>(deviceId);

                        const { sensorType, isLock } = isDeviceSupported(device);
                        if (sensorType) {
                            const { isActiveFn } = binarySensorMetadataMap[sensorType];
                            const isActive = isActiveFn(device);

                            if (isActive) {
                                if (isLock && autoCloseLocks) {
                                    locksToLockSet.add(deviceId);
                                    activeDevicesSet.add(deviceId);
                                } else {
                                    if (entity.bypassableDevices.includes(deviceId)) {
                                        bypassedDevicesSet.add(deviceId);
                                        activeDevicesSet.add(deviceId);
                                    } else {
                                        blockingDevicesSet.add(deviceId);
                                    }
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
            const locksToLock = Array.from(locksToLockSet)
                .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);

            const anyBlockers = !!blockingDevices.length;

            logger.log({
                activeDevices,
                bypassedDevices,
                blockingDevices,
                locksToLock,
                anyBlockers,
            });

            if (anyBlockers) {
                await this.putSetting('activeMode', this.securitySystemState.mode);
                this.securitySystemState = {
                    ...this.securitySystemState,
                    obstruction: SecuritySystemObstruction.Sensor,
                    triggered: false,
                };
                await this.sendNotification({
                    mode,
                    blockingDevices,
                    event: 'Blocked',
                });
            } else {
                const activate = async () => {
                    logger.log(`New mode set to ${mode}`);
                    this.securitySystemState = {
                        ...this.securitySystemState,
                        obstruction: undefined,
                        triggered: false,
                        mode,
                    };
                    await this.putSetting('currentlyActiveDevices', activeDevices);
                    await this.putSetting('currentlyBypassedDevices', bypassedDevices);
                    await this.putSetting('activeMode', mode);
                    await this.putSetting('arming', false);
                    await this.updateMqtt({
                        mode: scryptedToHaStateMap[mode],
                        info: {
                            activeDevices,
                            bypassedDevices,
                        }
                    });
                    await this.sendNotification({
                        mode,
                        bypassedDevices,
                        activeDevices,
                        event: 'Activate',
                    });

                    for (const lockName of locksToLock) {
                        const lockDevice = sdk.systemManager.getDeviceByName<Lock>(lockName);
                        await lockDevice.lock();
                    }
                };

                if (entity.preActivationTime) {
                    logger.log(`New mode will be set in ${entity.preActivationTime}`);
                    this.activationListener = setTimeout(async () =>
                        await activate(),
                        entity.preActivationTime * 1000
                    );
                    await this.putSetting('arming', true);
                    await this.updateMqtt({
                        mode: 'arming', info: {
                            activeDevices: [],
                            bypassedDevices: [],
                        }
                    });

                    await this.sendNotification({
                        mode,
                        bypassedDevices,
                        activeDevices,
                        event: 'Preactivation',
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

    async disarmSecuritySystem(): Promise<void> {
        this.resetActivationListener();
        const logger = this.getLogger();
        logger.log(`Disarmed`);
        await this.putSetting('currentlyActiveDevices', []);
        await this.putSetting('currentlyBypassedDevices', []);
        await this.putSetting('arming', false);
        await this.updateMqtt({
            mode: scryptedToHaStateMap[SecuritySystemMode.Disarmed], info: {
                activeDevices: [],
                bypassedDevices: []
            }
        });
        await this.sendNotification({
            mode: SecuritySystemMode.Disarmed,
            event: 'Activate',
        });
        this.securitySystemState = {
            ...this.securitySystemState,
            triggered: false,
            obstruction: undefined,
            mode: SecuritySystemMode.Disarmed
        };
        await this.putSetting('activeMode', SecuritySystemMode.Disarmed);
    }

}
