// import sdk, { ScryptedInterface, Setting, Settings, EventListenerRegister, ObjectDetector, MotionSensor, ScryptedDevice, ObjectsDetected, Camera, MediaObject, ObjectDetectionResult, ScryptedDeviceBase } from "@scrypted/sdk";
// import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
// import { StorageSettings } from "@scrypted/sdk/storage-settings";
// import { EventType, getMixinBaseSettings, getWebookUrls, isDeviceEnabled, mainPluginName, NotifyNotifiersFn, sortDetectionsByPriority } from "./utils";
// import MqttClient from "./mqtt-client";
// import { uniq, uniqBy } from "lodash";
// import { defaultDetectionClasses, isLabelDetection } from "./detecionClasses";

// const { systemManager } = sdk;

// const snapshotWidth = 1280;
// const snapshotHeight = 720;

// export class HomeAssistantUtilitiesCommonMixin extends SettingsMixinDeviceBase<any> implements Settings {
//     storageSettings = new StorageSettings(this, {
//         debug: {
//             title: 'Log debug messages',
//             type: 'boolean',
//             defaultValue: false,
//             immediate: true,
//         },
//         room: {
//             title: 'Room',
//             type: 'string',
//         },
//         entityId: {
//             title: 'EntityID',
//             type: 'string',
//             defaultValue: getDefaultEntityId(name)
//         },
//         haDeviceClass: {
//             title: 'Device class',
//             type: 'string',
//             defaultValue: 'motion'
//         },
//         // DETECTION
//         useNvrDetections: {
//             title: 'Use NVR detections',
//             description: 'If enabled, the NVR notifications will be used. Make sure to extend the notifiers with this extension',
//             type: 'boolean',
//             subgroup: 'Detection',
//             immediate: true,
//             defaultValue: type === ScryptedDeviceType.Camera
//         },
//         useNvrImages: {
//             title: 'Use NVR images',
//             description: 'If enabled, the NVR images coming from NVR will be used, otherwise the one defined in the plugin',
//             type: 'boolean',
//             subgroup: 'Detection',
//             defaultValue: true,
//             immediate: true,
//         },
//         // NOTIFIER
//         triggerAlwaysNotification: {
//             title: 'Always enabled',
//             description: 'Enable to always check this entity for notifications, regardles of it\'s activation',
//             subgroup: 'Notifier',
//             type: 'boolean',
//             defaultValue: false,
//         },
//         haActions: {
//             title: 'HA actions',
//             description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
//             subgroup: 'Notifier',
//             type: 'string',
//             multiple: true
//         },
//         minDelayTime: {
//             subgroup: 'Notifier',
//             title: 'Minimum notification delay',
//             description: 'Minimum amount of sedonds to wait until a notification is sent for the same detection type',
//             type: 'number',
//             defaultValue: 15,
//         }
//     });

//     detectionListener: EventListenerRegister;
//     mainLoopListener: NodeJS.Timeout;
//     isActiveForNotifications: boolean;
//     isActiveForMqttReporting: boolean;
//     lastDetectionMap: Record<string, number> = {};
//     logger: Console;
//     mqttAutodiscoverySent: boolean;

//     constructor(
//         options: SettingsMixinDeviceOptions<any>,
//         private getMqttClient: () => Promise<MqttClient>,
//         private notifyNotifiers: NotifyNotifiersFn,
//     ) {
//         super(options);

//         const mainPluginDevice = systemManager.getDeviceByName(mainPluginName) as unknown as Settings;

//         this.storageSettings.settings.room.onGet = async () => {
//             const rooms = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedRooms')?.value as string[];
//             return {
//                 choices: rooms ?? []
//             }
//         }
//         this.storageSettings.settings.entityId.onGet = async () => {
//             const entities = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedEntities')?.value as string[];
//             return {
//                 choices: entities ?? []
//             }
//         }

//         this.initValues().then().catch(this.console.log);
//         const logger = this.getLogger();

//         this.startCheckInterval().then().catch(this.console.log);
//     }

//     async startCheckInterval() {
//         const logger = this.getLogger();

//         const funct = async () => {
//             const useNvrDetections = this.storageSettings.values.useNvrDetections;
//             const { isActiveForMqttReporting, isActiveForNotifications, isPluginEnabled } = await isDeviceEnabled(this.name);

//             const triggerAlwaysNotification = this.storageSettings.values.triggerAlwaysNotification;
//             const alwaysActiveByAlwaysZones = !!this.storageSettings.values.alwaysZones?.length;

//             const newIsCameraActiveForNotifications = isPluginEnabled && !useNvrDetections && (isActiveForNotifications || triggerAlwaysNotification || alwaysActiveByAlwaysZones);
//             const newIsCameraActiveForMqttReporting = isPluginEnabled && !useNvrDetections && isActiveForMqttReporting;

//             this.isActiveForNotifications = newIsCameraActiveForNotifications;
//             this.isActiveForMqttReporting = newIsCameraActiveForMqttReporting;

//             const isCurrentlyRunning = !!this.detectionListener;
//             const shouldRun = this.isActiveForMqttReporting || this.isActiveForNotifications;

//             if (!this.mqttAutodiscoverySent) {
//                 const mqttClient = await this.getMqttClient()
//                 if (mqttClient) {
//                     const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase & Settings;
//                     const deviceSettings = await device.getSettings();
//                     await mqttClient.setupDeviceAutodiscovery({
//                         device,
//                         deviceSettings,
//                         detectionClasses: defaultDetectionClasses,
//                         console: logger,
//                         // localIp: this.storageSettings.values.localIp,
//                         withImage: true
//                     });

//                     this.mqttAutodiscoverySent = true;
//                 }
//             }

//             if (isCurrentlyRunning && !shouldRun) {
//                 logger.log('Stoppin and cleaning listeners.');
//                 this.resetListeners();
//             } else if (!isCurrentlyRunning && shouldRun) {
//                 logger.log(`Starting listeners: ${JSON.stringify({
//                     notificationsActive: newIsCameraActiveForNotifications,
//                     mqttReportsActive: newIsCameraActiveForMqttReporting,
//                     notificationsAlwaysActive: alwaysActiveByAlwaysZones,
//                     useNvrDetections,
//                     isPluginEnabled,
//                 })}`);
//                 await this.startListeners();
//             }
//         };

//         this.mainLoopListener = setInterval(async () => {
//             try {
//                 await funct();
//             } catch (e) {
//                 logger.log('Error in startCheckInterval', e);
//             }
//         }, 5000);
//     }

//     resetListeners() {
//         if (this.detectionListener) {
//             this.getLogger().log('Resetting listeners.');
//         }

//         // this.resetTimeouts();
//         this.detectionListener?.removeListener && this.detectionListener.removeListener();
//         this.detectionListener = undefined;
//     }

//     async initValues() {
//         const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
//         this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
//         this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
//     }

//     async getMixinSettings(): Promise<Setting[]> {
//         const useNvrDetections = this.storageSettings.values.useNvrDetections;
//         this.storageSettings.settings.scoreThreshold.hide = useNvrDetections;
//         const settings: Setting[] = await this.storageSettings.getSettings();

//         if (this.interfaces.includes(ScryptedInterface.VideoCamera) && !useNvrDetections) {
//             const detectionClasses = this.storageSettings.getItem('detectionClasses') ?? [];
//             for (const detectionClass of detectionClasses) {
//                 const key = `${detectionClass}:scoreThreshold`;
//                 settings.push({
//                     key,
//                     title: `Score threshold for ${detectionClass}`,
//                     subgroup: 'Detection',
//                     type: 'number',
//                     value: this.storageSettings.getItem(key as any)
//                 });
//             }
//         }

//         // const mainPluginDevice = systemManager.getDeviceByName(mainPluginName) as unknown as Settings;
//         // const mainPluginSetttings = await mainPluginDevice.getSettings() as Setting[];
//         // const activeNotifiers = (mainPluginSetttings.find(setting => setting.key === 'notifiers')?.value || []) as string[];

//         // activeNotifiers.forEach(notifierId => {
//         //     const notifierDevice = systemManager.getDeviceById(notifierId);
//         //     const key = `notifier-${notifierId}:disabled`;
//         //     settings.push({
//         //         key,
//         //         title: `Disable notifier ${notifierDevice.name}`,
//         //         subgroup: 'Notifier',
//         //         type: 'boolean',
//         //         value: JSON.parse(this.storageSettings.getItem(key as any) ?? 'false'),
//         //     });
//         // })

//         return settings;
//     }

//     async putMixinSetting(key: string, value: string) {
//         this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
//     }

//     async release() {
//         this.resetListeners();
//         this.mainLoopListener && clearInterval(this.mainLoopListener);
//         this.mainLoopListener = undefined;
//     }

//     private getLogger() {
//         const deviceConsole = sdk.deviceManager.getMixinConsole(this.id, this.nativeId);

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

//     async reportDetectionsToMqtt(detections: ObjectDetectionResult[], triggerTime: number, logger: Console, mqttImage?: MediaObject) {
//         if (!this.mqttReportInProgress) {
//             this.mqttReportInProgress = true;
//             const mqttClient = await this.getMqttClient();
//             const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;

//             let b64Image: string;
//             if (mqttImage) {
//                 const imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(mqttImage, 'image/jpeg');
//                 b64Image = imageBuffer.toString('base64');
//             }

//             try {
//                 await mqttClient.publishRelevantDetections({
//                     console: logger,
//                     detections,
//                     device,
//                     triggerTime,
//                     b64Image
//                 }).finally(() => this.mqttReportInProgress = false);
//             } catch (e) {
//                 logger.log(`Error in reportDetectionsToMqtt`, e);
//             }
//         }
//     }

//     async reportTriggerToMqtt(props: { detection: ObjectDetectionResult, triggerTime: number, b64Image?: string, triggered: boolean }) {
//         const { detection, triggerTime, b64Image, triggered } = props;
//         const logger = this.getLogger();

//         const mqttClient = await this.getMqttClient();
//         const device = systemManager.getDeviceById(this.id) as unknown as ScryptedDeviceBase;

//         const info = {
//             // scryptedUrl: externalUrl,
//             detection,
//             triggerTime,
//             b64Image,
//         };

//         try {
//             await mqttClient.publishDeviceState({
//                 device,
//                 triggered,
//                 info,
//                 console: logger
//             }).finally(() => this.mqttReportInProgress = false);
//         } catch (e) {
//             logger.log(`Error in reportDetectionsToMqtt`, e);
//         }
//     }

//     async triggerMotion(detection: ObjectDetectionResult, triggerTime: number, image?: MediaObject) {
//         const objectDetector = this.getObjectDetector();

//         const report = async (triggered: boolean) => {
//             this.resetTimeouts();
//             this.isCameraActiveForMqttReporting && await this.reportTriggerToMqtt({ detection, triggerTime, b64Image, triggered });
//             this.motionInProgress = triggered;
//         }

//         const b64Image = image ? (await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'))?.toString('base64') : undefined;
//         await report(true);

//         const logger = this.getLogger();
//         const minDelayTime = this.storageSettings.values.minDelayTime;

//         this.motionListener = objectDetector.listen({
//             event: ScryptedInterface.MotionSensor,
//             watch: true,
//         }, async (_, __, data) => {
//             if (!data) {
//                 logger.log(`Motion end triggered by the device.`);
//                 await report(false);
//             }
//         });
        
//         this.motionTimeout = setTimeout(async () => {
//             logger.log(`Motion end triggered automatically after ${minDelayTime}s.`);
//             await report(false);
//         }, minDelayTime * 1000);
//     }

//     getObjectDetector() {
//         return this.mixinDevice as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
//         // return systemManager.getDeviceById(this.id) as (ObjectDetector & MotionSensor & ScryptedDevice & Camera);
//     }

//     getLastDetectionkey(detection: ObjectDetectionResult) {
//         const { className, label } = detection;
//         let key = className;
//         if (label) {
//             key += `-${label}`;
//         }

//         return key;
//     }

//     async startListeners() {
//         const logger = this.getLogger();
//         const objectDetector = this.getObjectDetector();

//         if (!objectDetector) {
//             logger.log(`Device ${this.name}-${this.id} not found`);
//             return;
//         }

//         this.detectionListener = objectDetector.listen(ScryptedInterface.ObjectDetector, async (_, details, data) => {
//             const detection: ObjectsDetected = data;

//             if (!detection.detections?.length) {
//                 return;
//             }

//             const { timestamp } = detection;

//             const {
//                 alwaysZones = [],
//                 blacklistedZones = [],
//                 whitelistedZones = [],
//                 detectionClasses = [],
//                 scoreThreshold = 0.7,
//                 useNvrImages,
//                 minDelayTime = 10
//             } = this.storageSettings.values;

//             const innerDetections = detection.detections ?? [];
//             const uniqueSortedDetections = uniqBy(sortDetectionsByPriority(innerDetections), det => det.className);

//             // const mqttImage = detection.detectionId ? await objectDetector.getDetectionInput(detection.detectionId, details.eventId) : undefined;

//             // const mqttImage = await objectDetector.takePicture({
//             //     reason: 'event',
//             //     picture: {
//             //         height: snapshotHeight,
//             //         width: snapshotWidth,
//             //     },
//             // });
//             if (this.isCameraActiveForMqttReporting) {
//                 this.reportDetectionsToMqtt(uniqueSortedDetections, timestamp, logger);
//             }

//             let dataToReport = {};
//             try {
//                 logger.debug(`Detections incoming ${JSON.stringify(uniqueSortedDetections)}`);
//                 const match = uniqueSortedDetections.find(d => {
//                     const { className, score, label, zones } = d;

//                     if (detectionClasses?.length && !detectionClasses.includes(className)) {
//                         logger.debug(`Classname ${className} not contained in ${detectionClasses}`);
//                         return false;
//                     }
//                     const lastDetectionkey = this.getLastDetectionkey(d);
//                     const lastDetection = this.lastDetectionMap[lastDetectionkey];
//                     if (lastDetection && (timestamp - lastDetection) < 1000 * minDelayTime) {
//                         logger.debug(`Waiting for delay`);
//                         return false;
//                     }

//                     if (isLabelDetection(className) && !label) {
//                         logger.debug(`Label ${label} not valid`);
//                         return false;
//                     }

//                     const scoreToUse = this.storageSettings.getItem(`${className}:scoreThreshold` as any) || scoreThreshold;
//                     const scoreOk = !score || score > scoreToUse;

//                     if (!scoreOk) {
//                         logger.debug(`Score ${score} not ok ${scoreToUse}`);
//                         return false;
//                     }

//                     const isAlwaysIncluded = alwaysZones.length ? zones.some(zone => alwaysZones.includes(zone)) : false;
//                     const isIncluded = whitelistedZones.length ? zones.some(zone => whitelistedZones.includes(zone)) : true;
//                     const isExcluded = blacklistedZones.length ? zones.some(zone => blacklistedZones.includes(zone)) : false;

//                     const zonesOk = isAlwaysIncluded || (isIncluded && !isExcluded);

//                     if (!zonesOk) {
//                         logger.debug(`Zones ${zones} not ok`);
//                         return false;
//                     }

//                     dataToReport = {
//                         isAlwaysIncluded,
//                         isIncluded,
//                         isExcluded,
//                         zones,
//                         zonesOk,

//                         score,
//                         scoreToUse,
//                         scoreOk,

//                         className,
//                         detectionClasses
//                     };

//                     return true;
//                 });

//                 if (match) {
//                     this.lastDetectionMap[this.getLastDetectionkey(match)] = timestamp;

//                     let image: MediaObject;
//                     // const useDetectorImage = useNvrImages && !!detection.detectionId;
//                     // if (useDetectorImage) {
//                     //     image = await objectDetector.getDetectionInput(detection.detectionId, details.eventId);
//                     // } else {
//                     image = await objectDetector.takePicture({
//                         reason: 'event',
//                         picture: {
//                             height: snapshotHeight,
//                             width: snapshotWidth,
//                         },
//                     });
//                     // }

//                     logger.log(`Matching detection found: ${JSON.stringify({
//                         match,
//                         ...dataToReport,
//                         // useDetectorImage,
//                     })}`);

//                     this.triggerMotion(match, timestamp, image)

//                     // Object.entries(this.storageSettings.settings).filter(([key]) => key.match('notifier-${notifierId}:disabled'))
//                     if (this.isCameraActiveForNotifications) {
//                         this.notifyNotifiers({
//                             triggerDeviceId: this.id,
//                             cameraDeviceId: this.id,
//                             detection: match,
//                             image,
//                             logger,
//                             eventType: EventType.ObjectDetection,
//                             triggerTime: timestamp,
//                         });
//                     }
//                 }
//             } catch (e) {
//                 logger.log('Error finding a match', e);
//             }
//         });
//     }
// }