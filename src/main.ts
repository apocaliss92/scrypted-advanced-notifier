import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { isEqual, keyBy, sortBy } from 'lodash';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import MqttClient from './mqtt-client';
import { DeviceInterface, ExecuteReportProps, GetNotificationTextProps, NotifyCameraProps, NotificationSource, getWebookSpecs, getTextSettings, getTextKey, EventType } from "./utils";
import sharp from 'sharp';
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { detectionClassesDefaultMap } from "./detecionClasses";

const { systemManager } = sdk;

export default class AdvancedNotifierPlugin extends ScryptedDeviceBase implements MixinProvider, HttpRequestHandler {
    private deviceHaEntityMap: Record<string, string> = {};
    private haEntityDeviceMap: Record<string, string> = {};
    private deviceVideocameraMap: Record<string, string> = {};
    private deviceRoomMap: Record<string, string> = {}
    public mqttClient: MqttClient;
    private doorbellDevices: string[] = [];
    private firstCheckAlwaysActiveDevices = false;
    private mainLogger: Console;
    public currentMixinsMap: Record<string, AdvancedNotifierCameraMixin | AdvancedNotifierSensorMixin> = {};

    storageSettings = new StorageSettings(this, {
        pluginEnabled: {
            title: 'Plugin enabled',
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
        useHaPluginCredentials: {
            group: 'Homeassistant',
            title: 'Use HA plugin credentials',
            type: 'boolean',
            immediate: true,
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
        fetchedEntities: {
            group: 'Homeassistant',
            title: '',
            subgroup: 'Entities',
            multiple: true,
        },
        fetchedRooms: {
            group: 'Homeassistant',
            title: '',
            subgroup: 'Rooms',
            multiple: true,
        },
        fetchedRoomNames: {
            group: 'Homeassistant',
            json: true,
            hide: true,
            defaultValue: {}
        },
        useMqttPluginCredentials: {
            title: 'Use MQTT plugin credentials',
            group: 'MQTT',
            type: 'boolean',
            immediate: true,
        },
        mqttHost: {
            title: 'Host',
            group: 'MQTT',
            description: 'Specify the mqtt address.',
            placeholder: 'mqtt://192.168.1.100',
        },
        mqttUsename: {
            title: 'Username',
            group: 'MQTT',
            description: 'Specify the mqtt username.',
        },
        mqttPassword: {
            title: 'Password',
            group: 'MQTT',
            description: 'Specify the mqtt password.',
            type: 'password',
        },
        mqttActiveEntitiesTopic: {
            title: 'Active entities topic',
            group: 'MQTT',
            description: 'Topic containing the active entities, will trigger the related devices activation for notifications',
        },
        activeDevicesForReporting: {
            group: 'MQTT',
            title: 'Active devices for MQTT reporting',
            multiple: true,
            type: 'string',
            defaultValue: []
        },
        snapshotWidth: {
            group: 'Notifier',
            title: 'Snapshot width',
            type: 'number',
            defaultValue: 1280,
        },
        snapshotHeight: {
            group: 'Notifier',
            title: 'Snapshot height',
            type: 'number',
            defaultValue: 720,
        },
        nvrUrl: {
            title: 'NVR url',
            description: 'Url pointing to the NVR instance, useful to generate direct links to timeline',
            type: 'string',
            defaultValue: 'https://nvr.scrypted.app/',
            placeholder: 'https://nvr.scrypted.app/',
        },
        activeDevicesForNotifications: {
            group: 'Notifier',
            title: 'Active devices for notifications',
            multiple: true,
            type: 'string',
        },
        alwaysActiveDevicesForNotifications: {
            group: 'Notifier',
            title: 'Devices always active for notifications',
            multiple: true,
            type: 'string',
            hide: true,
            defaultValue: [],
        },
        notifiers: {
            group: 'Notifier',
            title: 'Notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
        },
        ...getTextSettings(false) as any,
        testDevice: {
            title: 'Device',
            group: 'Test',
            type: 'string',
            immediate: true,
        },
        testNotifier: {
            group: 'Test',
            title: 'Notiier',
            type: 'device',
            deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
            immediate: true,
        },
        testMessage: {
            group: 'Test',
            title: 'Message key',
            type: 'string',
            immediate: true,
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
        super(nativeId);

        const useHaPluginCredentials = JSON.parse(this.storageSettings.getItem('useHaPluginCredentials') ?? 'false');
        this.storageSettings.settings.accessToken.hide = useHaPluginCredentials;
        this.storageSettings.settings.address.hide = useHaPluginCredentials;
        this.storageSettings.settings.protocol.hide = useHaPluginCredentials;

        const useMqttPluginCredentials = JSON.parse(this.storageSettings.getItem('useMqttPluginCredentials') ?? 'false');
        this.storageSettings.settings.mqttHost.hide = useMqttPluginCredentials;
        this.storageSettings.settings.mqttUsename.hide = useMqttPluginCredentials;
        this.storageSettings.settings.mqttPassword.hide = useMqttPluginCredentials;

        this.storageSettings.settings.useHaPluginCredentials.onPut = async (_, isOn) => {
            this.storageSettings.settings.accessToken.hide = isOn;
            this.storageSettings.settings.address.hide = isOn;
            this.storageSettings.settings.protocol.hide = isOn;
        };

        this.storageSettings.settings.useMqttPluginCredentials.onPut = async (_, isOn) => {
            this.storageSettings.settings.mqttHost.hide = isOn;
            this.storageSettings.settings.mqttUsename.hide = isOn;
            this.storageSettings.settings.mqttPassword.hide = isOn;

            await this.setupMqttClient();
        };
        this.storageSettings.settings.mqttHost.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttUsename.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttPassword.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttActiveEntitiesTopic.onPut = async () => await this.setupMqttClient();

        this.initFlow().then().catch(this.getLogger().log);
    }

    async initFlow() {
        try {
            await this.initPluginSettings();
            await this.refreshDevicesLinks();
            await this.setupMqttClient();
        } catch (e) {
            this.getLogger().log(`Error in initFLow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const decodedUrl = decodeURIComponent(request.url);
        const [_, __, ___, ____, _____, webhook, deviceName, spec] = decodedUrl.split('/');
        const device = sdk.systemManager.getDeviceByName(deviceName) as unknown as (ScryptedDeviceBase & Settings);
        const deviceSettings = await device?.getSettings();
        const deviceSettingsByKey = keyBy(deviceSettings, setting => setting.key);
        try {
            if (deviceSettings) {
                if (webhook === 'snapshots') {
                    const { lastSnapshot } = await getWebookSpecs();
                    const isWebhookEnabled = deviceSettingsByKey['homeassistantMetadata:lastSnapshotWebhook']?.value as boolean;

                    if (spec === lastSnapshot) {
                        if (isWebhookEnabled) {
                            // response.send(`${JSON.stringify(this.storageSettings.getItem('deviceLastSnapshotMap'))}`, {
                            //     code: 404,
                            // });
                            // return;
                            const imageUrl = deviceSettingsByKey['homeassistantMetadata:lastSnapshotImageUrl']?.value as string;

                            if (imageUrl) {
                                const mo = await sdk.mediaManager.createFFmpegMediaObject({
                                    inputArguments: [
                                        '-i', imageUrl,
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
                                response.send(`Last snapshot not found for device ${deviceName} and spec ${spec}`, {
                                    code: 404,
                                });
                                return;
                            }
                        }
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

    private async setupMqttClient() {
        let mqttHost: string;
        let mqttUsename: string;
        let mqttPassword: string;

        const logger = this.getLogger();

        if (this.mqttClient) {
            await this.mqttClient.disconnect();
            this.mqttClient = undefined;
        }

        if (this.storageSettings.getItem('useMqttPluginCredentials')) {
            logger.log(`Using MQTT plugin credentials.`);
            const mqttDevice = systemManager.getDeviceByName('MQTT') as unknown as Settings;
            const mqttSettings = await mqttDevice.getSettings();

            const isInternalBroker = (JSON.parse(mqttSettings.find(setting => setting.key === 'enableBroker')?.value as string || 'false')) as boolean;

            if (isInternalBroker) {
                logger.log(`Internal MQTT broker not supported yet. Please disable useMqttPluginCredentials.`);
            } else {
                mqttHost = mqttSettings.find(setting => setting.key === 'externalBroker')?.value as string;
                mqttUsename = mqttSettings.find(setting => setting.key === 'username')?.value as string;
                mqttPassword = mqttSettings.find(setting => setting.key === 'password')?.value as string;
            }
        } else {
            logger.log(`Using provided credentials.`);

            mqttHost = this.storageSettings.getItem('mqttHost');
            mqttUsename = this.storageSettings.getItem('mqttUsename');
            mqttPassword = this.storageSettings.getItem('mqttPassword');
        }

        const mqttActiveEntitiesTopic = this.storageSettings.getItem('mqttActiveEntitiesTopic');

        if (!mqttHost || !mqttUsename || !mqttPassword) {
            logger.log('MQTT params not provided');
        }

        try {
            this.mqttClient = new MqttClient(mqttHost, mqttUsename, mqttPassword);
            await this.mqttClient.getMqttClient(logger, true);

            if (mqttActiveEntitiesTopic) {
                await this.mqttClient.subscribeToHaTopics(mqttActiveEntitiesTopic, this.getLogger(), async (topic, message) => {
                    if (topic === mqttActiveEntitiesTopic) {
                        this.getLogger().log(`Received update for ${topic} topic: ${JSON.stringify(message)}`);
                        await this.syncHaEntityIds(message);
                    }
                });
            }
        } catch (e) {
            this.getLogger().log('Error setting up MQTT client', e);
        }
    }

    private isDeviceElegible(device: DeviceInterface) {
        return device.mixins?.includes(this.id) && !!device.getSettings;
    }

    private getElegibleDevices() {
        return Object.entries(systemManager.getSystemState()).filter(([deviceId]) => {
            const device = systemManager.getDeviceById(deviceId) as unknown as (DeviceInterface);

            return this.isDeviceElegible(device);
        }).map(([deviceId]) => systemManager.getDeviceById(deviceId) as unknown as (DeviceInterface))
    }

    private async syncHaEntityIds(devices: string[]) {
        const deviceNames: string[] = [];
        for (const device of devices) {
            const deviceNameFromEntity = this.haEntityDeviceMap[device];
            const entityFromDeviceName = this.deviceHaEntityMap[device];

            if (deviceNameFromEntity) {
                deviceNames.push(deviceNameFromEntity);
            } else if (entityFromDeviceName) {
                deviceNames.push(device);
            }
        }

        this.getLogger().log(`SyncHaEntityIds: ${JSON.stringify({
            devices,
            deviceNames,
            stored: this.storageSettings.values.activeDevicesForNotifications ?? [],
            isEqual: isEqual(sortBy(deviceNames), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))
        })}`);

        if (isEqual(sortBy(deviceNames), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))) {
            this.getLogger().log('Devices did not change');
        } else {
            this.storageSettings.putSetting('activeDevicesForNotifications', deviceNames);
        }
    }

    private async initPluginSettings() {
        const cloudPlugin = systemManager.getDeviceByName('Scrypted Cloud') as unknown as Settings;
        const oauthUrl = await (cloudPlugin as any).getOauthUrl();
        const url = new URL(oauthUrl);
        const serverId = url.searchParams.get('server_id');
        this.storageSettings.putSetting('serverId', serverId);
        this.getLogger().log(`Server id found: ${serverId}`);

        const localIp = (await sdk.endpointManager.getLocalAddresses())[0];
        this.storageSettings.putSetting('localIp', localIp);
        this.getLogger().log(`Local IP found: ${localIp}`);

        this.storageSettings.settings.testMessage.choices = Object.keys(getTextSettings(false)).map(key => key);
    }

    private async refreshDevicesLinks() {
        const devices: string[] = [];
        const doorbellDevices: string[] = [];
        const haEntities: string[] = [];
        const deviceHaEntityMap: Record<string, string> = {};
        const haEntityDeviceMap: Record<string, string> = {};
        const deviceVideocameraMap: Record<string, string> = {};
        const deviceRoomMap: Record<string, string> = {};

        const allDevices = this.getElegibleDevices();
        for (const device of allDevices) {
            const deviceName = device.name;
            const deviceType = device.type;
            const settings = await device.getSettings();
            const haEntityId = settings.find(setting => setting.key === 'homeassistantMetadata:entityId')?.value as string;
            const room = settings.find(setting => setting.key === 'homeassistantMetadata:room')?.value as string;
            const linkedCamera = settings.find(setting => setting.key === 'homeassistantMetadata:linkedCamera')?.value as string;

            deviceRoomMap[deviceName] = room;
            if (haEntityId) {
                haEntities.push(haEntityId);
                devices.push(deviceName);

                deviceHaEntityMap[deviceName] = haEntityId;
                haEntityDeviceMap[haEntityId] = deviceName;

                if (deviceType === ScryptedDeviceType.Camera || deviceType === ScryptedDeviceType.Doorbell) {
                    const nearbySensors = settings.find(setting => setting.key === 'recording:nearbySensors')?.value as string[] ?? [];
                    const nearbyLocks = settings.find(setting => setting.key === 'recording:nearbyLocks')?.value as string[] ?? [];

                    const deviceLinkedSensors = [...nearbySensors, ...nearbyLocks];

                    if (deviceLinkedSensors.length) {
                        for (const sensorId of deviceLinkedSensors) {
                            const sensorDevice = systemManager.getDeviceById(sensorId);
                            deviceVideocameraMap[sensorDevice.name] = deviceName;
                        }
                    }
                }

                if (deviceType === ScryptedDeviceType.Doorbell) {
                    const doorbellButtonId = settings.find(setting => setting.key === 'replaceBinarySensor:replaceBinarySensor')?.value as string;
                    if (doorbellButtonId) {
                        const sensorDevice = systemManager.getDeviceById(doorbellButtonId);
                        const sensorName = sensorDevice.name;
                        doorbellDevices.push(sensorName);
                        deviceVideocameraMap[sensorName] = deviceName;
                    }
                }

                if (linkedCamera) {
                    const cameraDevice = systemManager.getDeviceById(linkedCamera);
                    deviceVideocameraMap[deviceName] = cameraDevice.name;
                }
            }
        }

        const sensorsNotMapped = allDevices.filter(device => device.type === ScryptedDeviceType.Sensor && !deviceVideocameraMap[device.name])
            .map(sensor => sensor.name);

        if (sensorsNotMapped.length && !this.firstCheckAlwaysActiveDevices) {
            this.getLogger().log(`Following binary sensors are not mapped to any camera yet: ${sensorsNotMapped}`);
        }

        this.storageSettings.settings.activeDevicesForNotifications.choices = devices;
        this.storageSettings.settings.activeDevicesForReporting.choices = devices;
        this.storageSettings.settings.testDevice.choices = devices;
        this.deviceHaEntityMap = deviceHaEntityMap;
        this.haEntityDeviceMap = haEntityDeviceMap;
        this.deviceVideocameraMap = deviceVideocameraMap;
        this.deviceRoomMap = deviceRoomMap;
        this.doorbellDevices = doorbellDevices;
        this.firstCheckAlwaysActiveDevices = true;
    }

    async getSettings() {
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    fetchHomeassistantData = async () => {
        let accessToken = this.storageSettings.getItem('accessToken');
        let address = this.storageSettings.getItem('address');
        let protocol = this.storageSettings.getItem('protocol');
        const roomNameMap: Record<string, string> = {};

        if (this.storageSettings.getItem('useHaPluginCredentials')) {
            const haDevice = systemManager.getDeviceByName('Home Assistant') as unknown as Settings;
            const haSettings = await haDevice.getSettings();

            accessToken = haSettings.find(setting => setting.key === 'personalAccessToken')?.value;
            address = haSettings.find(setting => setting.key === 'address')?.value;
            protocol = haSettings.find(setting => setting.key === 'protocol')?.value;
        }

        if (!accessToken || !address || !protocol) {
            throw new Error(`HA access params not set correctly: AccessToken: ${accessToken}, Address: ${address}, Protocol: ${protocol}`);
        }

        const url = `${protocol}://${address}`

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
            rooms = sortBy(JSON.parse(roomsResponse.data.replace(new RegExp('\'', 'g'), '"')), elem => elem);

            for (const roomId of rooms) {
                const roomName = await getRoomName(roomId);
                roomNameMap[roomId] = roomName.data;
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
            this.getLogger().log(`Room names found: ${JSON.stringify(roomNameMap)}`);
            await this.storageSettings.putSetting('fetchedEntities', entityIds);
            await this.storageSettings.putSetting('fetchedRooms', rooms);
            await this.storageSettings.putSetting('fetchedRoomNames', roomNameMap as any);
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if (
            [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.BinarySensor,
                ScryptedInterface.Lock,
            ].some(int => interfaces.includes(int))
        ) {
            return [ScryptedInterface.Settings]
        }

        if (interfaces.includes(ScryptedInterface.Notifier)) {
            return [ScryptedInterface.Settings]
            // return [ScryptedInterface.Notifier, ScryptedInterface.Settings]
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

    public getLinkedCamera = async (deviceName: string) => {
        const device = systemManager.getDeviceByName(deviceName) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(device);

        return { device: cameraDevice, isDoorbell: this.doorbellDevices.includes(deviceName) };
    }

    public matchDetectionFound = async (props: {
        image?: MediaObject,
        match?: ObjectDetectionResult,
        candidates?: ObjectDetectionResult[],
        logger: Console,
        eventType: EventType,
        triggerDeviceId: string,
        triggerTime: number,
        shouldNotify?: boolean,
        disabledNotifiers?: string[]
    }) => {
        const {
            eventType,
            logger,
            triggerDeviceId,
            triggerTime,
            match,
            image,
            shouldNotify,
            disabledNotifiers = []
        } = props;
        const triggerDevice = systemManager.getDeviceById(triggerDeviceId) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(triggerDevice);
        const notifiers = this.storageSettings.getItem('notifiers') as string[];

        const textKey = getTextKey({ eventType, classname: match?.className });

        const notifiersPassed: string[] = [];

        for (const notifierId of notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Settings & ScryptedDeviceBase;
            const notifierSettings = await notifier.getSettings();

            let isNotifierEnabled = shouldNotify;
            let enabledByAlwaysClass = false;
            if (!isNotifierEnabled && match) {
                const alwaysClassnamesSetting = notifierSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysClassnames')?.value as string[] || [];

                enabledByAlwaysClass = alwaysClassnamesSetting.includes(detectionClassesDefaultMap[match.className]);
                isNotifierEnabled = enabledByAlwaysClass;
            }

            const disabledByCameraList = disabledNotifiers.includes(notifierId);
            if (disabledByCameraList) {
                isNotifierEnabled = false;
            }

            if (!isNotifierEnabled) {
                logger.debug(`Notifier ${notifier.name} disabled. Skipping notification: ${JSON.stringify({
                    shouldNotify,
                    enabledByAlwaysClass,
                    disabledByCameraList
                })}`);
                continue;
            }

            logger.debug(`Notifier ${notifier.name} enabled: ${JSON.stringify({ shouldNotify, enabledByAlwaysClass })}`);

            try {
                await this.notifyCamera({
                    triggerDevice,
                    cameraDevice,
                    notifierId,
                    time: triggerTime,
                    image,
                    detection: match,
                    source: NotificationSource.DETECTION,
                    textKey,
                    keepImage: !!image,
                    logger,
                    notifierSettings,
                });

                notifiersPassed.push(notifier.name);
            } catch (e) {
                logger.log(`Error on notifier ${notifier.name}`, e);
            }
        }

        if (match) {
            logger.log(`${notifiersPassed.length} notified: ${JSON.stringify({ notifiersPassed, match })}`);
        }
    };

    async getMqttClient() {
        if (!this.mqttClient) {
            await this.setupMqttClient();
        }

        return this.mqttClient;
    }

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
            return new AdvancedNotifierNotifierMixin({
                ...props,
            }, this.sendNotificationToPlugin.bind(this));
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

    private async getNotificationText(
        props: GetNotificationTextProps
    ) {
        const { detection, detectionTime, notifierId, device, externalUrl, textKey, notifierSettings } = props;
        const detectionLabel = detection?.label;

        const room = this.deviceRoomMap[device.name];
        const roomName = this.storageSettings.getItem('fetchedRoomNames')?.[room] ?? room

        const notifierSettingsByKey = keyBy(notifierSettings, 'key');

        const textToUse = notifierSettingsByKey[`homeassistantMetadata:${textKey}`]?.value || this.storageSettings.getItem(textKey as any);


        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const time = eval(detectionTimeText.replace('${time}', detectionTime));

        return textToUse.toString()
            .replace('${time}', time)
            .replace('${nvrLink}', externalUrl)
            .replace('${person}', detectionLabel)
            .replace('${plate}', detectionLabel)
            .replace('${room}', roomName);
    }

    async notifyCamera(props: NotifyCameraProps) {
        const {
            triggerDevice,
            cameraDevice,
            notifierId,
            time,
            image: imageParent,
            detection,
            textKey,
            source,
            keepImage,
            logger,
            notifierSettings
        } = props;

        const device = cameraDevice ?? await this.getCameraDevice(triggerDevice);

        if (!device) {
            logger.log(`There is no camera linked to the device ${triggerDevice.name}`);
            return;
        }

        const deviceSettings = await device.getSettings();
        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

        const { haUrl, externalUrl } = this.getUrls(device.id, time);

        const message = await this.getNotificationText({
            detection,
            externalUrl,
            detectionTime: time,
            notifierId,
            textKey,
            device: triggerDevice,
            notifierSettings
        });

        const notifierSnapshotWidth = this.storageSettings.getItem(`notifier:${notifierId}:snapshotWidth` as any);
        const notifiernapshotHeight = this.storageSettings.getItem(`notifier:${notifierId}:snapshotHeight` as any);

        const { image } = await this.getCameraSnapshot({
            cameraDevice: device,
            snapshotHeight: notifiernapshotHeight,
            snapshotWidth: notifierSnapshotWidth,
            image: imageParent,
            keepImage,
        });

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];

        const notifierOptions: NotifierOptions = {
            body: message,
            data: {
                letGo: true,
                ha: {
                    url: haUrl,
                    clickAction: haUrl,
                    actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined,
                }
            },
        }

        const title = (triggerDevice ?? device).name;

        logger.log(`Finally sending notification ${time} to ${notifier.name}. ${JSON.stringify({
            source,
            title,
            message,
        })}`);
        logger.debug(`${JSON.stringify(notifierOptions)}`);

        await notifier.sendNotification(title, notifierOptions, image, undefined);
    }

    async executeNotificationTest() {
        const testDeviceName = this.storageSettings.getItem('testDevice') as string;
        const testNotifier = this.storageSettings.getItem('testNotifier') as ScryptedDevice & Settings;
        const textKey = this.storageSettings.getItem('testMessage') as string;

        if (testDeviceName && textKey && testNotifier) {
            const currentTime = new Date().getTime();
            const testDevice = systemManager.getDeviceByName(testDeviceName) as unknown as DeviceInterface;
            const notifierId = testNotifier.id;
            const notifierSettings = await testNotifier.getSettings();

            const logger = this.getLogger();
            logger.log(`Sending test notification to ${testNotifier.name} - ${testDevice.name} with key ${textKey}}`);

            this.notifyCamera({
                triggerDevice: testDevice,
                notifierId,
                time: currentTime,
                textKey,
                detection: { label: 'Familiar' } as ObjectDetectionResult,
                source: NotificationSource.TEST,
                logger,
                notifierSettings,
            })
        }
    }

    async getCameraDevice(device: DeviceInterface) {
        const deviceType = device.type;
        const deviceName = device.name;
        const isCamera = [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType);

        if (isCamera) {
            return device;
        }

        const linkedCameraName = this.deviceVideocameraMap[deviceName];
        return systemManager.getDeviceByName(linkedCameraName) as unknown as DeviceInterface;
    }

    async executeReport(props: ExecuteReportProps) {
        const { currentTime, detections, device, b64Image, logger } = props;

        await this.mqttClient.publishRelevantDetections({
            detections,
            device,
            triggerTime: currentTime,
            console: logger,
            b64Image,
        })
    }

    // private async addBoundingToImage(boundingBox: number[], imageBuffer: Buffer, console: Console) {
    //     console.log(`Trying to add boundingBox ${boundingBox}`);

    //     try {
    //         const [x, y, width, height] = boundingBox;
    //         const metadata = await sharp(imageBuffer).metadata();
    //         const svg = `
    //                 <svg width="${metadata.width}" height="${metadata.height}">
    //                     <rect
    //                     x="${x}"
    //                     y="${y}"
    //                     width="${width}"
    //                     height="${height}"
    //                     fill="none"
    //                     stroke="#FF0000"
    //                     stroke-width="3"
    //                     />
    //                 </svg>
    //                 `;

    //         const newImageBuffer = await sharp(imageBuffer)
    //             .composite([
    //                 {
    //                     input: Buffer.from(svg),
    //                     top: 0,
    //                     left: 0,
    //                 },
    //             ]).toBuffer();
    //         const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);
    //         console.log(`Bounding box added ${boundingBox}`);

    //         return { newImageBuffer, newImage };
    //     } catch (e) {
    //         console.log('Error adding bounding box', e);
    //         return {}
    //     }
    // }

    private async getCameraSnapshot(props: {
        cameraDevice: DeviceInterface,
        snapshotWidth: number,
        snapshotHeight: number,
        image?: MediaObject,
        keepImage?: boolean,
    }) {
        const { cameraDevice, snapshotWidth: snapshotWidthParent, snapshotHeight: snapshotHeightParent, image: imageParent, keepImage } = props;
        const snapshotWidth = this.storageSettings.getItem('snapshotWidth') as number;
        const snapshotHeight = this.storageSettings.getItem('snapshotHeight') as number;

        let image = imageParent;

        if (!keepImage && (!image || snapshotHeight !== snapshotHeightParent || snapshotWidth !== snapshotWidthParent)) {
            image = await cameraDevice.takePicture({
                reason: 'event',
                picture: {
                    height: snapshotHeightParent,
                    width: snapshotWidthParent,
                },
            });
        }

        let imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');

        const b64Image = imageBuffer.toString('base64');

        return { image, b64Image };
    }

    private getLogger(): Console {
        if (!this.mainLogger) {
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    this.console.log(`[Advanced notifier] ${now} - `, message, ...optionalParams);
                }
            };

            this.mainLogger = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.mainLogger
    }

    async getAllActiveDevices() {
        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];
        const alwaysActiveDevicesForNotifications = this.storageSettings.getItem('alwaysActiveDevicesForNotifications') as string[];

        const allActiveDevicesForNotifications = [...activeDevicesForNotifications, ...alwaysActiveDevicesForNotifications];

        const allActiveDevices: string[] = [];
        allActiveDevicesForNotifications.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));
        activeDevicesForReporting.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));

        const notifiers = this.storageSettings.getItem('notifiers') as string[];

        return {
            allActiveDevices,
            allActiveDevicesForNotifications,
            activeDevicesForNotifications,
            activeDevicesForReporting,
            alwaysActiveDevicesForNotifications,
            notifiers
        }
    }
}

