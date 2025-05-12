
import sdk, { ScryptedDeviceBase, SecuritySystem, SecuritySystemMode, SecuritySystemObstruction, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSetting, StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { getBaseLogger, getMqttBasicClient } from '../../scrypted-apocaliss-base/src/basePlugin';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { getAlarmKeys, getAlarmSettings, getModeEntity, supportedAlarmModes } from './alarmUtils';
import AdvancedNotifierPlugin from './main';
import { idPrefix } from './mqtt-utils';
import { ALARM_SYSTEM_NATIVE_ID, binarySensorMetadataMap, convertSettingsToStorageSettings, DeviceInterface, isDeviceSupported } from './utils';

export class AdvancedNotifierAlarmSystem extends ScryptedDeviceBase implements SecuritySystem, Settings {
    initStorage: StorageSettingsDict<string> = {
        activeMode: {
            title: 'Active mode',
            type: 'string',
            combobox: true,
            immediate: true,
            choices: Object.values(SecuritySystemMode),
            defaultValue: SecuritySystemMode.Disarmed,
            onPut: async (_, mode) => await this.armSecuritySystem(mode)
        },
        currentlyActiveDevices: {
            title: `Currently active devices`,
            type: 'string',
            defaultValue: [],
            choices: [],
            multiple:true,
            combobox: true,
            readonly: true
        },
        currentlyBypassedDevices: {
            title: `Currently bypassed devices`,
            type: 'string',
            defaultValue: [],
            choices: [],
            multiple:true,
            combobox: true,
            readonly: true
        },
    };

    storageSettings = new StorageSettings(this, this.initStorage);
    public mqttClient: MqttClient;
    private mainLogger: Console;
    clientId: string;
    killed: boolean;
    mainLoopListener: NodeJS.Timeout;
    activationListener: NodeJS.Timeout;
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

        this.clientId = `scrypted_an_alarm_syster_${this.id}`;

        this.initValues().then().catch(logger.log);

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    public async startStop(enabled: boolean) {
        const logger = this.getLogger();
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
                    const currentSystem = this.plugin.storageSettings.values.securitySystem;
                    if (currentSystem?.nativeId === ALARM_SYSTEM_NATIVE_ID) {
                        await funct();
                    } else {
                        // if (this.securitySystemState.mode !== SecuritySystemMode.Disarmed) {
                        //     await this.disarmSecuritySystem();
                        // }
                    }
                }
            } catch (e) {
                logger.log('Error in mainLoopListener', e);
            }
        }, 1000 * 2);
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

    resetListeners() {
        this.resetActivationListener();
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

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        this.resetActivationListener();

        if (mode === SecuritySystemMode.Disarmed) {
            return await this.disarmSecuritySystem();
        }

        if (mode === this.securitySystemState.mode) {
            return;
        }

        const logger = this.getLogger();
        logger.log(`Trying to arm into ${mode} mode`);
        const entity = getModeEntity({ mode, storage: this.storageSettings });
        logger.log('Mode configurations', entity);

        const activeRules = this.plugin.allAvailableRules
            .filter(item => item.securitySystemModes?.includes(mode));

        const allActiveDevicesSet = new Set<string>();
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
                                allActiveDevicesSet.add(deviceId);
                            } else {
                                blockingDevicesSet.add(deviceId);
                            }
                        } else {
                            allActiveDevicesSet.add(deviceId);
                        }
                    } else {
                        allActiveDevicesSet.add(deviceId);
                    }
                }
            } catch (e) {
                logger.log(`Error in checking rule ${rule.name}`, e.message);
            }
        }

        const allActiveDevices = Array.from(allActiveDevicesSet)
            .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);
        const bypassedDevices = Array.from(bypassedDevicesSet)
            .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);
        const blockingDevices = Array.from(blockingDevicesSet)
            .map(deviceId => sdk.systemManager.getDeviceById(deviceId)?.name);

        const anyBlockers = !!blockingDevices.length;

        logger.log({
            allActiveDevices,
            bypassedDevices,
            blockingDevices,
            anyBlockers,
        });

        if (anyBlockers) {
            await this.putSetting('activeMode', this.securitySystemState.mode);
            this.securitySystemState = {
                ...this.securitySystemState,
                // Scale when need to support more types
                obstruction: SecuritySystemObstruction.Sensor,
                triggered: false,
            };
        } else {
            const activate = async () => {
                logger.log(`New mode set to ${mode}`);
                this.securitySystemState = {
                    ...this.securitySystemState,
                    obstruction: undefined,
                    triggered: false,
                    mode,
                };
                await this.putSetting('currentlyActiveDevices', allActiveDevices);
                await this.putSetting('currentlyBypassedDevices', bypassedDevices);
            };

            if (entity.preActivationTime) {
                logger.log(`New mode will be set in ${entity.preActivationTime}`);
                this.activationListener = setTimeout(async () =>
                    await activate(),
                    entity.preActivationTime * 1000
                );
            } else {
                await activate();
            }
        }
    }

    async disarmSecuritySystem(): Promise<void> {
        this.resetActivationListener();
        const logger = this.getLogger();
        logger.log(`Disarmed`);
        this.securitySystemState = {
            ...this.securitySystemState,
            triggered: false,
            obstruction: undefined,
            mode: SecuritySystemMode.Disarmed
        };
        await this.putSetting('currentlyActiveDevices', []);
        await this.putSetting('currentlyBypassedDevices', []);
    }

}
