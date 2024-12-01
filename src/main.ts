import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { isEqual, keyBy, sortBy } from 'lodash';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DeviceInterface, NotificationSource, getWebooks, getTextSettings, getTextKey, EventType, detectionRulesKey, getDetectionRulesSettings, DetectionRule, getElegibleDevices, deviceFilter, notifierFilter, ADVANCED_NOTIFIER_INTERFACE, getWebookUrls, NotificationPriority, getFolderPaths } from "./utils";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { setupPluginAutodiscovery, subscribeToHaTopics } from "./mqtt-utils";
import path from 'path';

const { systemManager } = sdk;

export default class AdvancedNotifierPlugin extends BasePlugin implements MixinProvider, HttpRequestHandler {
    private deviceHaEntityMap: Record<string, string> = {};
    private haEntityDeviceMap: Record<string, string> = {};
    private deviceVideocameraMap: Record<string, string> = {};
    public deviceRoomMap: Record<string, string> = {}
    private doorbellDevices: string[] = [];
    private firstCheckAlwaysActiveDevices = false;
    public currentMixinsMap: Record<string, AdvancedNotifierCameraMixin | AdvancedNotifierSensorMixin> = {};
    private haProviderId: string;
    private pushoverProviderId: string;

    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => this.startStop(enabled),
        }),
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        haEnabled: {
            title: 'Homeassistent enabled',
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
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
        localIp: {
            title: 'Server local ip',
            type: 'string',
            hide: true,
        },
        scryptedToken: {
            title: 'Scrypted token',
            type: 'string',
        },
        nvrUrl: {
            title: 'NVR url',
            description: 'Url pointing to the NVR instance, useful to generate direct links to timeline',
            type: 'string',
            defaultValue: 'https://nvr.scrypted.app/',
            placeholder: 'https://nvr.scrypted.app/',
        },
        useHaPluginCredentials: {
            group: 'Homeassistant',
            title: 'Use HA plugin credentials',
            type: 'boolean',
            immediate: true,
        },
        accessToken: {
            group: 'Homeassistant',
            title: 'HAPersonal access token',
            type: 'string',
        },
        address: {
            group: 'Homeassistant',
            title: 'Address',
            type: 'string',
        },
        protocol: {
            group: 'Homeassistant',
            title: 'Protocol',
            type: 'string',
            choices: ['http', 'https'],
            defaultValue: ['http'],
        },
        domains: {
            group: 'Homeassistant',
            title: 'Entity regex patterns',
            description: 'Regex to filter out entities fetched',
            type: 'string',
            multiple: true,
        },
        fetchHaEntities: {
            group: 'Homeassistant',
            title: 'Fetch entities from HA',
            type: 'button',
            onPut: async () => await this.fetchHomeassistantData()
        },
        mqttActiveEntitiesTopic: {
            title: 'Active entities topic',
            group: 'MQTT',
            description: 'Topic containing the active entities, will trigger the related devices activation for notifications',
            onPut: async () => {
                await this.setupMqttEntities();
            },
        },
        activeDevicesForReporting: {
            group: 'MQTT',
            title: 'Active devices for MQTT reporting',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: deviceFilter,
        },
        fetchedEntities: {
            group: 'Metadata',
            title: '',
            subgroup: 'Entities',
            multiple: true,
        },
        fetchedRooms: {
            group: 'Metadata',
            title: '',
            subgroup: 'Rooms',
            multiple: true,
        },
        notifiers: {
            group: 'Notifier',
            title: 'Active notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: notifierFilter,
        },
        ...getTextSettings(false) as any,
        [detectionRulesKey]: {
            title: 'Rules',
            group: 'Detection rules',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [],
            defaultValue: [],
        },
        activeDevicesForNotifications: {
            title: '"OnActive" devices',
            group: 'Detection rules',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: deviceFilter,
        },
        testDevice: {
            title: 'Device',
            group: 'Test',
            immediate: true,
            type: 'device',
            deviceFilter: deviceFilter,
        },
        testNotifier: {
            group: 'Test',
            title: 'Notiier',
            type: 'device',
            deviceFilter: notifierFilter,
            immediate: true,
        },
        testMessage: {
            group: 'Test',
            title: 'Message key',
            type: 'string',
            immediate: true,
        },
        testPriority: {
            group: 'Test',
            title: 'Pushover priority',
            type: 'string',
            immediate: true,
            choices: [NotificationPriority.VeryLow, NotificationPriority.Low, NotificationPriority.Normal, NotificationPriority.High],
            defaultValue: NotificationPriority.Normal
        },
        testButton: {
            group: 'Test',
            title: 'Send notification',
            type: 'button',
            onPut: async () => {
                await this.executeNotificationTest();
            },
        },
    });


    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Advanced notifier'
        });

        this.start().then().catch(this.getLogger().log);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            // await this.stop(true);
        }
    }

    async start() {
        try {
            await this.initPluginSettings();
            await this.refreshDevicesLinks();
            await this.setupMqttEntities();

            setInterval(async () => await this.refreshDevicesLinks(), 5000);
        } catch (e) {
            this.getLogger().log(`Error in initFLow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const decodedUrl = decodeURIComponent(request.url);
        const [_, __, ___, ____, _____, webhook, deviceNameOrAction] = decodedUrl.split('/');
        try {
            const { lastSnapshot, haAction } = await getWebooks();

            if (webhook === haAction) {
                const { url, accessToken } = await this.getHaApiUrl();

                await axios.post(`${url}/api/events/mobile_app_notification_action`,
                    { "action": deviceNameOrAction },
                    {
                        headers: {
                            'Authorization': 'Bearer ' + accessToken,
                        }
                    });

                response.send(`Action ${deviceNameOrAction} executed`, {
                    code: 200,
                });
                return;
            } else if (webhook === lastSnapshot) {
                const device = this.currentMixinsMap[deviceNameOrAction] as AdvancedNotifierCameraMixin;
                const isWebhookEnabled = device?.storageSettings.getItem('lastSnapshotWebhook');

                if (isWebhookEnabled) {
                    // response.send(`${JSON.stringify(this.storageSettings.getItem('deviceLastSnapshotMap'))}`, {
                    //     code: 404,
                    // });
                    // return;
                    const { snapshotsFolder } = await getFolderPaths(device.id);

                    const lastSnapshotFilePath = path.join(snapshotsFolder, `${webhook}.jpg`);

                    if (lastSnapshotFilePath) {
                        const mo = await sdk.mediaManager.createFFmpegMediaObject({
                            inputArguments: [
                                '-i', lastSnapshotFilePath,
                            ]
                        });
                        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                        response.send(jpeg, {
                            headers: {
                                'Content-Type': 'image/jpeg',
                            }
                        });
                        return;
                    } else {
                        response.send(`Last snapshot not found for device ${deviceNameOrAction}`, {
                            code: 404,
                        });
                        return;
                    }
                }
            }
        } catch (e) {
            response.send(`${JSON.stringify(e)}, ${e.message}`, {
                code: 400,
            });

            return;
        }

        response.send(`Webhook not found`, {
            code: 404,
        });

        return;
    }

    private async setupMqttEntities() {
        const { mqttEnabled, mqttActiveEntitiesTopic } = this.storageSettings.values;
        if (mqttEnabled) {
            try {
                const mqttClient = await this.getMqttClient();
                const logger = this.getLogger();
                const objDetectionPlugin = systemManager.getDeviceByName('Scrypted NVR Object Detection') as unknown as Settings;
                const settings = await objDetectionPlugin.getSettings();
                const knownPeople = settings?.find(setting => setting.key === 'knownPeople')?.choices
                    ?.filter(choice => !!choice)
                    .map(person => person.trim());

                await setupPluginAutodiscovery({ mqttClient, people: knownPeople, console: logger });

                if (mqttActiveEntitiesTopic) {
                    this.getLogger().log(`Subscribing to ${mqttActiveEntitiesTopic}`);
                    await subscribeToHaTopics({
                        entitiesActiveTopic: mqttActiveEntitiesTopic,
                        mqttClient,
                        cb: async (topic, message) => {
                            if (topic === mqttActiveEntitiesTopic) {
                                this.getLogger().log(`Received update for ${topic} topic: ${JSON.stringify(message)}`);
                                await this.syncHaEntityIds(message);
                            }
                        }
                    });
                }
            } catch (e) {
                this.getLogger().log('Error setting up MQTT client', e);
            }
        }
    }

    private async syncHaEntityIds(devices: string[]) {
        const deviceIds: string[] = [];
        for (const device of devices) {
            const deviceNameFromEntity = this.haEntityDeviceMap[device];
            const entityFromDeviceName = this.deviceHaEntityMap[device];

            if (deviceNameFromEntity) {
                deviceIds.push(deviceNameFromEntity);
            } else if (entityFromDeviceName) {
                deviceIds.push(device);
            }
        }

        this.getLogger().log(`SyncHaEntityIds: ${JSON.stringify({
            devices,
            deviceIds,
            stored: this.storageSettings.values.activeDevicesForNotifications ?? [],
            isEqual: isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))
        })}`);

        if (isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))) {
            this.getLogger().log('Devices did not change');
        } else {
            super.putSetting('activeDevicesForNotifications', deviceIds);
        }
    }

    private async initPluginSettings() {
        const logger = this.getLogger();
        const cloudPlugin = systemManager.getDeviceByName('Scrypted Cloud') as unknown as Settings;
        const oauthUrl = await (cloudPlugin as any).getOauthUrl();
        const url = new URL(oauthUrl);
        const serverId = url.searchParams.get('server_id');
        super.putSetting('serverId', serverId);
        logger.log(`Server id found: ${serverId}`);

        const localIp = (await sdk.endpointManager.getLocalAddresses())[0];
        super.putSetting('localIp', localIp);
        logger.log(`Local IP found: ${localIp}`);

        const pushoverPlugin = systemManager.getDeviceByName('Pushover Plugin') as unknown as ScryptedDeviceBase;
        const haPlugin = systemManager.getDeviceByName('Notify Service') as unknown as ScryptedDeviceBase;

        this.haProviderId = haPlugin?.id
        this.pushoverProviderId = pushoverPlugin?.id
        logger.log(`HA providerId: ${this.haProviderId} and Pushover providerId: ${this.pushoverProviderId}`);
    }

    private async refreshDevicesLinks() {
        const logger = this.getLogger();
        try {
            const doorbellDevices: string[] = [];
            const haEntities: string[] = [];
            const deviceHaEntityMap: Record<string, string> = {};
            const haEntityDeviceMap: Record<string, string> = {};
            const deviceVideocameraMap: Record<string, string> = {};
            const deviceRoomMap: Record<string, string> = {};

            const allDevices = getElegibleDevices();
            for (const device of allDevices) {
                const deviceId = device.id;
                const deviceType = device.type;
                const settings = await device.getSettings();
                const haEntityId = settings.find(setting => setting.key === 'homeassistantMetadata:entityId')?.value as string;
                const room = settings.find(setting => setting.key === 'homeassistantMetadata:room')?.value as string;
                const linkedCamera = settings.find(setting => setting.key === 'homeassistantMetadata:linkedCamera')?.value as string;

                deviceRoomMap[deviceId] = room;
                if (haEntityId) {
                    haEntities.push(haEntityId);

                    deviceHaEntityMap[deviceId] = haEntityId;
                    haEntityDeviceMap[haEntityId] = deviceId;

                    if (deviceType === ScryptedDeviceType.Doorbell) {
                        const doorbellButtonId = settings.find(setting => setting.key === 'replaceBinarySensor:replaceBinarySensor')?.value as string;
                        if (doorbellButtonId) {
                            doorbellDevices.push(doorbellButtonId);
                            deviceVideocameraMap[doorbellButtonId] = deviceId;
                        }
                    }

                    if (linkedCamera) {
                        const cameraDevice = systemManager.getDeviceById(linkedCamera);
                        if (cameraDevice) {
                            deviceVideocameraMap[deviceId] = cameraDevice.id;
                        } else {
                            logger.log(`Device ${device.name} is linked to the cameraId ${linkedCamera}, not available anymore`);
                        }
                    }
                }
            }

            const sensorsNotMapped = allDevices.filter(device => device.type === ScryptedDeviceType.Sensor && !deviceVideocameraMap[device.id])
                .map(sensor => sensor.name);

            if (sensorsNotMapped.length && !this.firstCheckAlwaysActiveDevices) {
                logger.log(`Following binary sensors are not mapped to any camera yet: ${sensorsNotMapped}`);
            }

            this.deviceHaEntityMap = deviceHaEntityMap;
            this.haEntityDeviceMap = haEntityDeviceMap;
            this.deviceVideocameraMap = deviceVideocameraMap;
            this.deviceRoomMap = deviceRoomMap;
            this.doorbellDevices = doorbellDevices;
            this.firstCheckAlwaysActiveDevices = true;
        } catch (e) {
            logger.log('Error in refreshDevicesLinks', e);
        }
    }

    async getSettings() {
        const { haEnabled, useHaPluginCredentials } = this.storageSettings.values;
        if (!haEnabled) {
            this.storageSettings.settings.accessToken.hide = true;
            this.storageSettings.settings.address.hide = true;
            this.storageSettings.settings.protocol.hide = true;
            this.storageSettings.settings.domains.hide = true;
            this.storageSettings.settings.fetchHaEntities.hide = true;
            this.storageSettings.settings.useHaPluginCredentials.hide = true;
        } else {
            this.storageSettings.settings.accessToken.hide = useHaPluginCredentials;
            this.storageSettings.settings.address.hide = useHaPluginCredentials;
            this.storageSettings.settings.protocol.hide = useHaPluginCredentials;
            this.storageSettings.settings.domains.hide = false;
            this.storageSettings.settings.fetchHaEntities.hide = false;
            this.storageSettings.settings.useHaPluginCredentials.hide = false;
        }

        this.storageSettings.settings.testMessage.choices = Object.keys(getTextSettings(false)).map(key => key);

        const settings: Setting[] = await super.getSettings();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            groupName: 'Detection rules',
            withDevices: true,
            withDetection: true,
        });
        settings.push(...detectionRulesSettings);

        return settings;

    }

    getHaApiUrl = async () => {
        let accessToken = this.storageSettings.getItem('accessToken');
        let address = this.storageSettings.getItem('address');
        let protocol = this.storageSettings.getItem('protocol');

        if (this.storageSettings.getItem('useHaPluginCredentials')) {
            const haDevice = systemManager.getDeviceByName('Home Assistant') as unknown as Settings;
            const haSettings = await haDevice.getSettings();

            accessToken = haSettings.find(setting => setting.key === 'personalAccessToken')?.value;
            address = haSettings.find(setting => setting.key === 'address')?.value;
            protocol = haSettings.find(setting => setting.key === 'protocol')?.value;
        }

        const url = `${protocol}://${address}`;

        return {
            accessToken,
            address,
            protocol,
            url,
        }
    }

    fetchHomeassistantData = async () => {
        const { accessToken, address, protocol, url } = await this.getHaApiUrl();
        if (!accessToken || !address || !protocol) {
            throw new Error(`HA access params not set correctly: AccessToken: ${accessToken}, Address: ${address}, Protocol: ${protocol}`);
        }

        const domains = this.storageSettings.getItem('domains') as string[];

        this.getLogger().log(`Start data fetching from HA: ${JSON.stringify({
            accessToken,
            address,
            protocol,
            url,
            domains
        })}`);

        let rooms: string[] = [];
        let entityIds: string[] = [];

        try {
            const roomsResponse = await axios.post<string>(`${url}/api/template`,
                { "template": "{{ areas() }}" },
                {
                    headers: {
                        'Authorization': 'Bearer ' + accessToken,
                    }
                });

            const getRoomName = async (areaId: string) => {
                return await axios.post<string>(`${url}/api/template`,
                    { "template": `{{ area_name('${areaId}') }}` },
                    {
                        headers: {
                            'Authorization': 'Bearer ' + accessToken,
                        }
                    });
            }

            const entitiesResponse = await axios.get<{ entity_id: string, state: string }[]>(`${url}/api/states`,
                {
                    headers: {
                        'Authorization': 'Bearer ' + accessToken,
                    }
                });
            const roomIds = sortBy(JSON.parse(roomsResponse.data.replace(new RegExp('\'', 'g'), '"')), elem => elem);

            for (const roomId of roomIds) {
                const roomName = await getRoomName(roomId);
                rooms.push(roomName.data);
            }

            entityIds = sortBy(
                entitiesResponse.data
                    .filter(entityStatus => domains.length > 0 ? domains.some(domain => new RegExp(domain).test(entityStatus.entity_id)) : true),
                elem => elem.entity_id)
                .map(entityStatus => entityStatus.entity_id);
        } catch (e) {
            this.getLogger().log(e);
        } finally {
            this.getLogger().log(`Entities found: ${JSON.stringify(entityIds)}`);
            this.getLogger().log(`Rooms found: ${JSON.stringify(rooms)}`);
            await super.putSetting('fetchedEntities', entityIds);
            await super.putSetting('fetchedRooms', rooms);
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if (
            [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.BinarySensor,
                ScryptedInterface.Lock,
                ScryptedInterface.Notifier,
            ].some(int => interfaces.includes(int))
        ) {
            return [ScryptedInterface.Settings, ADVANCED_NOTIFIER_INTERFACE]
        }

        return undefined;
    }

    async sendNotificationToPlugin(notifierId: string, title: string, options?: NotifierOptions, mediaParent?: MediaObject, icon?: MediaObject | string) {
        //     const triggerTime = options?.recordedEvent?.data.timestamp ?? new Date().getTime();
        //     const isTheFirstNotifier = !this.nvrNotificationSend[triggerTime];
        //     this.nvrNotificationSend[triggerTime] = true;
        //     const deviceSensors = this.deviceLinkedSensors[title];
        //     const cameraDevice = sdk.systemManager.getDeviceByName(title) as unknown as DeviceInterface;
        //     const deviceLogger = this.getDeviceLogger(cameraDevice);
        //     const {
        //         textKey,
        //         detection,
        //         allDetections,
        //         isDetection,
        //         triggerDevice: triggerDeviceParent,
        //         isDoorbell,
        //         isOffline,
        //         isOnline,
        //     } = await parseNotificationMessage(cameraDevice, deviceSensors, options, deviceLogger);
        //     const {
        //         allActiveDevicesForNotifications,
        //         activeDevicesForReporting,
        //         notifiers,
        //     } = await this.getAllActiveDevices();
        //     const cameraName = cameraDevice.name;

        //     const triggerDevice = triggerDeviceParent ?? cameraDevice;
        //     const triggerDeviceName = triggerDevice.name;

        //     let media = mediaParent;
        //     let imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        //     const b64Image = imageBuffer.toString('base64');

        //     if (isTheFirstNotifier) {
        //         deviceLogger.log(`Notification ${triggerTime} coming from NVR: ${JSON.stringify({ title, options })}`);

        //         if (triggerDeviceParent) {
        //             deviceLogger.debug(`Trigger device found: ${triggerDeviceParent.name}`);
        //         }

        //         if (!textKey) {
        //             deviceLogger.log('Notification not supported', JSON.stringify({ title, options }));
        //             return;
        //         }
        //         // TODO: Move on top function
        //         // if (!useNvrImages && detection.boundingBox) {
        //         //     const { newImage, newImageBuffer } = await this.addBoundingToImage(detection.boundingBox, imageBuffer, deviceLogger);
        //         //     media = newImage;
        //         //     imageBuffer = newImageBuffer;
        //         // } else {
        //         //     deviceLogger.log(`Not adding boundboxes, ${JSON.stringify({
        //         //         boundingBox: detection.boundingBox,
        //         //         useNvrImages
        //         //     })}`);
        //         // }
        //         // const imageWithBoundingMaybe = !useNvrImages ? this.


        //         if (isDetection && activeDevicesForReporting.includes(triggerDeviceName)) {
        //             this.getDeviceLogger(triggerDevice).log(`Reporting ${allDetections.length} detections: ${JSON.stringify(allDetections)}`)
        //             await this.executeReport({
        //                 currentTime: triggerTime,
        //                 device: cameraDevice,
        //                 detections: allDetections,
        //                 deviceName: cameraName,
        //                 b64Image
        //             });
        //         }
        //     } else {
        //         deviceLogger.debug(`Notification ${triggerTime} already reported, skipping MQTT report.`);
        //     }

        //     const notifier = systemManager.getDeviceById(notifierId) as unknown as DeviceInterface;

        //     let isValid = !isDetection;
        //     let data: any;

        //     if (!isValid) {
        //         const isDetectionValid = await getIsDetectionValid(cameraDevice, notifier, deviceLogger);
        //         const { data: detectData, isValid: isDetectValid } = isDetectionValid(detection);
        //         isValid = isDetectValid;
        //         data = detectData;
        //     }

        //     if (!isValid) {
        //         deviceLogger.log(`Detection discarded: ${JSON.stringify(data)}`);
        //         return;
        //     }

        //     const triggerDeviceSettings = await triggerDevice.getSettings();
        //     const useNvrDetections = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:useNvrDetections`)?.value as boolean ?? false;
        //     const useNvrImages = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:useNvrImages`)?.value as boolean ?? true;

        //     const disableNotifierSetting = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:notifier-${notifierId}:disabled`)?.value ?? false;
        //     const notifierActive = notifiers.includes(notifierId) && !disableNotifierSetting;
        //     const deviceActiveForNotifications = allActiveDevicesForNotifications.includes(triggerDeviceName);
        //     const canNotify = notifierActive && deviceActiveForNotifications && useNvrDetections;

        //     if (isOnline || isOffline || isDoorbell) {
        //         this.notifyCamera({
        //             triggerDevice,
        //             notifierId,
        //             time: triggerTime,
        //             detection,
        //             textKey,
        //             source: NotificationSource.NVR,
        //         });

        //         return;
        //     }

        //     if (!notifierActive) {
        //         deviceLogger.debug(`Notifier ${notifier.name} not enabled for notifications`);
        //     }

        //     if (!deviceActiveForNotifications) {
        //         deviceLogger.debug(`Device ${triggerDeviceName} not enabled for notifications`);
        //     }

        //     if (!canNotify) {
        //         deviceLogger.debug(`Skipping notification. ${JSON.stringify({
        //             notifierActive,
        //             disableNotifierSetting,
        //             deviceActiveForNotifications,
        //             useNvrDetections,
        //             allActiveDevicesForNotifications,
        //             cameraName,
        //             triggerName: triggerDevice?.name,
        //         })}`);

        //         return;
        //     }

        //     const { externalUrl } = this.getUrls(cameraDevice.id, triggerTime);

        //     this.startMotionTimeoutAndPublish({
        //         device: cameraDevice,
        //         externalUrl,
        //         b64Image,
        //         triggered: true,
        //         triggerTime,
        //         detection,
        //         skipMotionCheck: false
        //     });

        //     this.notifyCamera({
        //         triggerDevice,
        //         notifierId,
        //         time: triggerTime,
        //         detection,
        //         textKey,
        //         image: useNvrImages ? media : undefined,
        //         source: NotificationSource.NVR,
        //         keepImage: useNvrImages
        //     });
    }

    public getLinkedCamera = async (deviceId: string) => {
        const device = systemManager.getDeviceById(deviceId) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(device);

        if (!device || !cameraDevice) {
            this.getLogger().log(`Camera device for ID ${deviceId} not found. Device found: ${!!device} and camera was found: ${!!cameraDevice}`);
        }

        return { device: cameraDevice, isDoorbell: this.doorbellDevices.includes(deviceId) };
    }

    public matchDetectionFound = async (props: {
        image?: MediaObject,
        match?: ObjectDetectionResult,
        rule: DetectionRule,
        logger: Console,
        eventType: EventType,
        triggerDeviceId: string,
        triggerTime: number,
    }) => {
        const {
            eventType,
            logger,
            triggerDeviceId,
            triggerTime,
            match,
            image,
            rule,
        } = props;
        const triggerDevice = systemManager.getDeviceById(triggerDeviceId) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(triggerDevice);

        const textKey = getTextKey({ eventType, classname: match?.className });
        logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ match, rule })}`);

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Settings & ScryptedDeviceBase;
            const notifierSettings = await notifier.getSettings();

            this.notifyCamera({
                triggerDevice,
                cameraDevice,
                notifierId,
                time: triggerTime,
                image,
                detection: match,
                source: NotificationSource.DETECTION,
                textKey,
                logger,
                notifierSettings,
                rule,
            }).catch(e => logger.log(`Error on notifier ${notifier.name}`, e));
        }
    };

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        const props = {
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Advanced notifier',
            groupKey: 'homeassistantMetadata'
        };

        if (
            [ScryptedInterface.Camera, ScryptedInterface.VideoCamera,].some(int => mixinDeviceInterfaces.includes(int))
        ) {
            return new AdvancedNotifierCameraMixin(
                props,
                this
            );
        } else if (
            [ScryptedInterface.BinarySensor, ScryptedInterface.Lock].some(int => mixinDeviceInterfaces.includes(int))
        ) {
            return new AdvancedNotifierSensorMixin(
                props,
                this
            );
        } else if (mixinDeviceInterfaces.includes(ScryptedInterface.Notifier)) {
            return new AdvancedNotifierNotifierMixin(
                props,
                this
            );
        }
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }

    private getUrls(cameraId: string, time: number) {
        const serverId = this.storageSettings.getItem('serverId');
        const nvrUrl = this.storageSettings.getItem('nvrUrl');
        const scryptedToken = this.storageSettings.getItem('scryptedToken');

        const timelinePart = `#/timeline/${cameraId}?time=${time}&from=notification&serverId=${serverId}&disableTransition=true`;
        const haUrl = `/api/scrypted/${scryptedToken}/endpoint/@scrypted/nvr/public/${timelinePart}`
        const externalUrl = `${nvrUrl}/${timelinePart}`
        return { externalUrl: externalUrl, haUrl: `/scrypted_${scryptedToken}?url=${encodeURIComponent(haUrl)}` }
    }

    private getTriggerZone = (detection: ObjectDetectionResult, rule: DetectionRule) => {
        const { zones } = detection ?? {};
        let zone: string;
        if (rule?.whitelistedZones) {
            zone = detection?.zones?.find(zoneInner => rule.whitelistedZones.includes(zoneInner));
        } else {
            zone = zones?.[0];
        }

        return zone;
    }

    private async getNotificationText(
        props: {
            device: DeviceInterface,
            detectionTime: number,
            detection?: ObjectDetectionResult,
            notifierId: string,
            externalUrl: string,
            textKey: string,
            rule?: DetectionRule,
            notifierSettings: Setting[],
        }
    ) {
        const { detection, detectionTime, notifierId, device, externalUrl, textKey, notifierSettings, rule } = props;
        const { label, className, zones } = detection ?? {};

        const roomName = this.deviceRoomMap[device.id];

        let textToUse;
        if (rule?.customText) {
            textToUse = rule?.customText
        } else {
            const notifierSettingsByKey = keyBy(notifierSettings, 'key');
            textToUse = notifierSettingsByKey[`homeassistantMetadata:${textKey}`]?.value || this.storageSettings.getItem(textKey as any);
        }

        const classNameParsed = detectionClassesDefaultMap[className];
        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const detectionClassText = classNameParsed === DetectionClass.Person ? this.storageSettings.getItem('personText') :
            className === DetectionClass.Animal ? this.storageSettings.getItem('animalText') :
                className === DetectionClass.Vehicle ? this.storageSettings.getItem('vehicleText') :
                    className
        const time = eval(detectionTimeText.replace('${time}', detectionTime));

        const zone = this.getTriggerZone(detection, rule);

        return textToUse.toString()
            .replace('${time}', time)
            .replace('${nvrLink}', externalUrl)
            .replace('${person}', label ?? '')
            .replace('${plate}', label ?? '')
            .replace('${label}', label ?? '')
            .replace('${class}', detectionClassText)
            .replace('${zone}', zone ?? '')
            .replace('${room}', roomName ?? '');
    }

    async notifyCamera(props: {
        cameraDevice?: DeviceInterface,
        triggerDevice: DeviceInterface,
        notifierId: string,
        time: number,
        image?: MediaObject,
        detection?: ObjectDetectionResult
        textKey: string,
        rule?: DetectionRule,
        source?: NotificationSource,
        notifierSettings: Setting[],
        logger: Console,
    }) {
        const {
            triggerDevice,
            cameraDevice,
            notifierId,
            time,
            image: imageParent,
            detection,
            textKey,
            source,
            logger,
            notifierSettings,
            rule,
        } = props;

        const device = cameraDevice ?? await this.getCameraDevice(triggerDevice);

        if (!device) {
            logger.log(`There is no camera linked to the device ${triggerDevice.name}`);
            return;
        }

        const deviceSettings = await device.getSettings();
        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

        const { haUrl, externalUrl } = this.getUrls(device.id, time);

        let message = await this.getNotificationText({
            detection,
            externalUrl,
            detectionTime: time,
            notifierId,
            textKey,
            device: triggerDevice,
            notifierSettings,
            rule,
        });

        const notifierSnapshotScale = this.storageSettings.getItem(`notifier:${notifierId}:snapshotScale` as any) ?? 1;
        const cameraSnapshotHeight = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotHeight')?.value as number) ?? 720;
        const cameraSnapshotWidth = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotWidth')?.value as number) ?? 1280;

        const { image } = await this.getCameraSnapshot({
            cameraDevice: device,
            snapshotHeight: cameraSnapshotHeight * notifierSnapshotScale,
            snapshotWidth: cameraSnapshotWidth * notifierSnapshotScale,
            image: notifierSnapshotScale === 1 ? imageParent : undefined,
        });
        const { priority, actions } = rule;

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];
        if (actions) {
            haActions.push(...actions);
        }
        let data: any = {};

        if (notifier.providerId === this.pushoverProviderId) {
            // message += '\n';
            // for (const stringifiedAction of haActions) {
            //     const { action, title } = JSON.parse(stringifiedAction);
            //     const { haActionUrl } = await getWebookUrls(action, logger);
            //     message += `<a href="${haActionUrl}">${title}</a>\n`;
            // }

            data.pushover = {
                timestamp: time,
                url: externalUrl,
                html: 1,
                priority: priority === NotificationPriority.High ? 1 :
                    priority === NotificationPriority.Normal ? 0 :
                        priority === NotificationPriority.Low ? -1 :
                            -2
            };
        } else if (notifier.providerId === this.haProviderId) {
            data.ha = {
                url: haUrl,
                clickAction: haUrl,
                actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined
            }

        }
        const notifierOptions: NotifierOptions = {
            body: message,
            data,
        }

        let title = (triggerDevice ?? device).name;

        const zone = this.getTriggerZone(detection, rule);
        if (zone) {
            title += ` (${zone})`;
        }

        logger.log(`Finally sending notification ${time} to ${notifier.name}. ${JSON.stringify({
            notifierOptions,
            source,
            title,
            message,
            rule,
            detection,
        })}`);

        await notifier.sendNotification(title, notifierOptions, image, undefined);
    }

    async executeNotificationTest() {
        const testDevice = this.storageSettings.getItem('testDevice') as DeviceInterface;
        const testNotifier = this.storageSettings.getItem('testNotifier') as DeviceInterface;
        const textKey = this.storageSettings.getItem('testMessage') as string;
        const testPriority = this.storageSettings.getItem('testPriority') as NotificationPriority;

        if (testDevice && textKey && testNotifier) {
            const currentTime = new Date().getTime();
            const testNotifierId = testNotifier.id
            const notifierSettings = await testNotifier.getSettings();

            const logger = this.getLogger();
            logger.log(`Sending test notification to ${testNotifier.name} - ${testDevice.name} with key ${textKey}}`);

            this.notifyCamera({
                triggerDevice: testDevice,
                notifierId: testNotifierId,
                time: currentTime,
                textKey,
                detection: { label: 'Familiar' } as ObjectDetectionResult,
                source: NotificationSource.TEST,
                logger,
                notifierSettings,
                rule: { priority: testPriority } as DetectionRule
            })
        }
    }

    async getCameraDevice(device: DeviceInterface) {
        const deviceType = device.type;
        const deviceId = device.id;
        const isCamera = [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType);

        if (isCamera) {
            return device;
        }

        const linkedCameraId = this.deviceVideocameraMap[deviceId];
        return systemManager.getDeviceById(linkedCameraId) as unknown as DeviceInterface;
    }

    private async getCameraSnapshot(props: {
        cameraDevice: DeviceInterface,
        snapshotWidth: number,
        snapshotHeight: number,
        image?: MediaObject,
    }) {
        const { cameraDevice, snapshotWidth, snapshotHeight, image: imageParent } = props;

        let image = imageParent;

        if (!image) {
            try {
                image = await cameraDevice.takePicture({
                    reason: 'event',
                    picture: {
                        height: snapshotHeight,
                        width: snapshotWidth,
                    },
                });
            } catch (e) {
                this.getLogger().log('Error taking a picture', e);
            }
        }

        let imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');

        const b64Image = imageBuffer.toString('base64');

        return { image, b64Image };
    }

    async getAllActiveDevices() {
        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];

        const allActiveDevicesForNotifications = [...activeDevicesForNotifications];

        const allActiveDevices: string[] = [];
        allActiveDevicesForNotifications.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));
        activeDevicesForReporting.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));

        const notifiers = this.storageSettings.getItem('notifiers') as string[];

        return {
            allActiveDevices,
            allActiveDevicesForNotifications,
            activeDevicesForNotifications,
            activeDevicesForReporting,
            notifiers
        }
    }

    // updateDevice(providerNativeId: string,nativeId: string, name: string, interfaces: string[], type: ScryptedDeviceType) {
    //     return sdk.deviceManager.onDeviceDiscovered({
    //         nativeId,
    //         providerNativeId,
    //         name,
    //         interfaces,
    //         type,
    //         info: sdk.deviceManager.getNativeIds().includes(nativeId) ? sdk.deviceManager.getDeviceState(nativeId)?.info : undefined,
    //     });
    // }
}

