// import { EventListenerRegister, ScryptedDeviceType, Settings } from "@scrypted/sdk";
// import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
// import { StorageSettings } from "@scrypted/sdk/storage-settings";
// import { DetectionRule, getMixinBaseSettings } from "./utils";
// import HomeAssistantUtilitiesProvider from "./main";

// export class AdvancedNotifierBaseMixin extends SettingsMixinDeviceBase<any> implements Settings {
//     storageSettings = new StorageSettings(this, {
//         ...getMixinBaseSettings({
//             plugin: this.plugin,
//             mixin: this,
//             isCamera: [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(this.type),
//         }),
//     });

//     storageSettingsUpdated: StorageSettings<string>;
//     detectionListener: EventListenerRegister;
//     mainLoopListener: NodeJS.Timeout;
//     isActiveForNotifications: boolean;
//     isActiveForNvrNotifications: boolean;
//     isActiveForMqttReporting: boolean;
//     mainAutodiscoveryDone: boolean;
//     mqttReportInProgress: boolean;
//     logger: Console;
//     killed: boolean;
//     detectionRules: DetectionRule[] = [];
//     nvrDetectionRules: DetectionRule[] = [];
//     rulesDiscovered: string[] = [];

//     constructor(
//         options: SettingsMixinDeviceOptions<any>,
//         public plugin: HomeAssistantUtilitiesProvider
//     ) {
//         super(options);
//         const logger = this.getLogger();

//         this.storageSettings.settings.room.onGet = async () => {
//             const rooms = this.plugin.storageSettings.getItem('fetchedRooms');
//             return {
//                 choices: rooms ?? []
//             }
//         }
//         this.storageSettings.settings.entityId.onGet = async () => {
//             const entities = this.plugin.storageSettings.getItem('fetchedEntities');
//             return {
//                 choices: entities ?? []
//             }
//         }

//         this.startCheckInterval().then().catch(logger.log);

//         this.plugin.currentMixinsMap[this.name] = this;

//         this.occupancyState = this.storageSettings.values.occupancyState ?? {};

//         if (this.storageSettings.values.room && !this.room) {
//             sdk.systemManager.getDeviceById<ScryptedDevice>(this.id).setRoom(this.storageSettings.values.room);
//         }
//     }

//     private getLogger() {
//         const deviceConsole = this.console;

//         if (!this.logger) {
//             const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
//                 const now = new Date().toLocaleString();
//                 if (!debug || this.storageSettings.getItem('debug')) {
//                     deviceConsole.log(` ${now} - `, message, ...optionalParams);
//                 }
//             };
//             this.logger = {
//                 log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
//                 debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
//             } as Console
//         }

//         return this.logger;
//     }
// }