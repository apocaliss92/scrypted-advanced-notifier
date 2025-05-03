// import sdk, { NotifierOptions, MediaObject, Setting, Settings, Notifier } from "@scrypted/sdk";
// import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
// import { StorageSettings } from "@scrypted/sdk/storage-settings";
// import { getTextSettings } from "./utils";
// import HomeAssistantUtilitiesProvider from "./main";
// import { getBaseLogger, getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
// import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";

// export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

// export class AdvancedNotifierBaseMixin extends SettingsMixinDeviceBase<any> implements Settings, Notifier {
//     storageSettings: StorageSettings<any>;
//     mainLoopListener: NodeJS.Timeout;
//     logger: Console;
//     killed: boolean;
//     clientId: string;
//     mqttClient: MqttClient;
//     initializingMqtt: boolean;
//     lastAutoDiscovery: number;

//     constructor(
//         options: SettingsMixinDeviceOptions<any>,
//         public plugin: HomeAssistantUtilitiesProvider
//     ) {
//         super(options);
//         const logger = this.getLogger();

//         this.clientId = `scrypted_an_notifier_${this.id}`;
//         this.plugin.currentNotifierMixinsMap[this.id] = this;
//         this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(logger.log);
//     }

//     async release() {
//         const logger = this.getLogger();
//         logger.info('Releasing mixin');
//         this.killed = true;
//         this.mainLoopListener && clearInterval(this.mainLoopListener);
//         this.mainLoopListener = undefined;
//     }

//     public getLogger(forceNew?: boolean) {
//         if (!this.logger || forceNew) {
//             const newLogger = getBaseLogger({
//                 deviceConsole: this.console,
//                 storage: this.storageSettings,
//                 friendlyName: this.clientId
//             });

//             if (forceNew) {
//                 return newLogger;
//             } else {
//                 this.logger = newLogger;
//             }
//         }

//         return this.logger;
//     }

//     public async startStop(enabled: boolean) {
//         const logger = this.getLogger();

//         if (enabled) {
//             await this.startCheckInterval();
//         } else {
//             await this.release();
//         }
//     }

//     async getMqttClient() {
//         if (!this.mqttClient && !this.initializingMqtt) {
//             const { mqttEnabled, useMqttPluginCredentials, pluginEnabled, mqttHost, mqttUsename, mqttPassword } = this.plugin.storageSettings.values;
//             if (mqttEnabled && pluginEnabled) {
//                 this.initializingMqtt = true;
//                 const logger = this.getLogger();

//                 try {
//                     this.mqttClient = await getMqttBasicClient({
//                         logger,
//                         useMqttPluginCredentials,
//                         mqttHost,
//                         mqttUsename,
//                         mqttPassword,
//                         clientId: this.clientId,
//                         configTopicPattern: `homeassistant/+/${idPrefix}-${this.id}/+/config`
//                     });
//                     await this.mqttClient?.getMqttClient();
//                 } catch (e) {
//                     logger.error('Error setting up MQTT client', e);
//                 } finally {
//                     this.initializingMqtt = false;
//                 }
//             }
//         }

//         return this.mqttClient;
//     }

//     async startCheckInterval() {
//         const logger = this.getLogger();

//         const funct = async () => {
//             try {
//                 if (isActiveForMqttReporting) {
//                     const mqttClient = await this.getMqttClient();
//                     if (mqttClient) {
//                         // Every 60 minutes repeat the autodiscovery
//                         if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
//                             logger.log('Starting MQTT autodiscovery');
//                             setupCameraAutodiscovery({
//                                 mqttClient,
//                                 device: this.cameraDevice,
//                                 console: logger,
//                                 rules: allAvailableRules,
//                                 occupancyEnabled: !!occupancyCheckInterval,
//                                 withAudio: checkSoundPressure,
//                             }).then(async (activeTopics) => {
//                                 await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
//                             }).catch(logger.error);

//                             logger.debug(`Subscribing to mqtt topics`);
//                             subscribeToDeviceMqttTopics({
//                                 mqttClient,
//                                 rules: allAvailableRules,
//                                 device: this.cameraDevice,
//                                 console: logger,
//                                 activationRuleCb: async ({ active, ruleName, ruleType }) => {
//                                     const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
//                                     logger.debug(`Setting ${ruleType} rule ${ruleName} to ${active}`);
//                                     await this.storageSettings.putSetting(`${enabledKey}`, active);
//                                 },
//                                 switchNotificationsEnabledCb: async (active) => {
//                                     logger.debug(`Setting notifications active to ${!active}`);
//                                     await this.storageSettings.putSetting(`notificationsEnabled`, active);
//                                 },
//                                 switchRecordingCb: this.cameraDevice.interfaces.includes(ScryptedInterface.VideoRecorder) ?
//                                     async (active) => {
//                                         logger.debug(`Setting NVR privacy mode to ${!active}`);
//                                         await this.enableRecording(this.cameraDevice, active);
//                                     } :
//                                     undefined,
//                                 rebootCb: this.cameraDevice.interfaces.includes(ScryptedInterface.Reboot) ?
//                                     async () => {
//                                         logger.log(`Rebooting camera`);
//                                         await this.cameraDevice.reboot();
//                                     } :
//                                     undefined,
//                                 ptzCommandCb: this.cameraDevice.interfaces.includes(ScryptedInterface.PanTiltZoom) ?
//                                     (async (ptzCommand: PanTiltZoomCommand) => {
//                                         logger.log(`Executing ptz command: ${JSON.stringify(ptzCommand)}`);

//                                         if (ptzCommand.preset) {
//                                             const presetId = Object.entries(this.cameraDevice.ptzCapabilities?.presets ?? {}).find(([id, name]) => name === ptzCommand.preset)?.[0];
//                                             if (presetId) {
//                                                 await this.cameraDevice.ptzCommand({ preset: presetId });
//                                             }
//                                         } else {
//                                             await this.cameraDevice.ptzCommand(ptzCommand);
//                                         }
//                                     }) :
//                                     undefined
//                             }).catch(logger.error);

//                             this.lastAutoDiscovery = now;
//                         }

//                         const settings = await this.mixinDevice.getSettings();
//                         const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;

//                         reportDeviceValues({
//                             console: logger,
//                             device: this.cameraDevice,
//                             mqttClient,
//                             notificationsEnabled,
//                             isRecording,
//                             rulesToEnable,
//                             rulesToDisable
//                         }).catch(logger.error);
//                     }
//                 }
//             } catch (e) {
//                 logger.log('Error in startCheckInterval funct', e);
//             }
//         };

//         this.mainLoopListener && clearInterval(this.mainLoopListener);
//         this.mainLoopListener = setInterval(async () => {
//             try {
//                 if (this.killed) {
//                     await this.release();
//                 } else {
//                     await funct();
//                 }
//             } catch (e) {
//                 logger.log('Error in mainLoopListener', e);
//             }
//         }, 1000 * 2);
//     }

//     sendNotification(title: string, options?: NotifierOptions, media?: MediaObject | string, icon?: MediaObject | string): Promise<void> {
//         let canNotify = true;

//         const cameraDevice = sdk.systemManager.getDeviceByName(title);
//         const notifierDevice = sdk.systemManager.getDeviceByName(this.id);
//         if (cameraDevice) {
//             const cameraMixin = this.plugin.currentCameraMixinsMap[cameraDevice.id];
//             if (cameraMixin) {
//                 const logger = this.plugin.getLogger();
//                 const notificationsEnabled = cameraMixin.storageSettings.values.notificationsEnabled;

//                 if (!notificationsEnabled) {
//                     canNotify = false;
//                     logger.log(`Skipping NVR notification for ${cameraDevice.name} from notifier ${notifierDevice.name} because disabled`);
//                 }
//             }

//         }

//         if (canNotify) {
//             return this.mixinDevice.sendNotification(title, options, media, icon);
//         }
//     }

//     async getMixinSettings(): Promise<Setting[]> {
//         const settings: Setting[] = await this.storageSettings.getSettings();

//         return settings;
//     }

//     async putMixinSetting(key: string, value: string) {
//         this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
//     }
// }