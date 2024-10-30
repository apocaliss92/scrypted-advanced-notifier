import sdk, { EventListenerRegister, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { isEqual, keyBy, sortBy } from 'lodash';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import MqttClient from './mqtt-client';
import { DeviceInterface, ExecuteReportProps, GetNotificationTextProps, getIsDetectionValid, NotifyCameraProps, parseNotificationMessage, sortDetectionsByPriority, NotificationSource, detectionClassesToPublish, getWebookSpecs, getTextSettings } from "./utils";
import sharp from 'sharp';
import { HomeAssistantUtilitiesNotifierMixin } from "./notifierMixin";
import { HomeAssistantUtilitiesCameraMixin } from "./cameraMixin";

const { systemManager } = sdk;

export default class HomeAssistantUtilitiesProvider extends ScryptedDeviceBase implements MixinProvider, HttpRequestHandler {
    private deviceHaEntityMap: Record<string, string> = {};
    private haEntityDeviceMap: Record<string, string> = {};
    private deviceVideocameraMap: Record<string, string> = {};
    private activeListeners: { listener: EventListenerRegister, deviceName: string }[] = [];
    private deviceRoomMap: Record<string, string> = {}
    private mqttClient: MqttClient;
    private deviceTimeoutMap: Record<string, EventListenerRegister> = {};
    private doorbellDevices: string[] = [];
    private deviceLinkedSensors: Record<string, string[]> = {};
    private mqttInit = false;
    private firstCheckAlwaysActiveDevices = false;
    private initListener: NodeJS.Timeout;
    private deviceLastDetectionsUpdate: Record<string, number> = {};
    private mainLogger: Console;
    private deviceLoggerMap: Record<string, Console> = {};
    private autodiscoveryPublishedMap: Record<string, boolean> = {};
    private nvrNotificationSend: Record<number, boolean> = {};

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
            title: 'Active devices',
            multiple: true,
            type: 'string',
        },
        alwaysActiveDevicesForNotifications: {
            group: 'Notifier',
            title: 'Always active devices',
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
        // TEXTS
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
        deviceLastSnapshotMap: {
            hide: true,
            json: true,
            defaultValue: {}
        }
    });

    constructor(nativeId: string) {
        super(nativeId);

        const start = async () => {
            await this.startEventsListeners();
        };

        const useHaPluginCredentials = JSON.parse(this.storageSettings.getItem('useHaPluginCredentials') ?? 'false');
        this.storageSettings.settings.accessToken.hide = useHaPluginCredentials;
        this.storageSettings.settings.address.hide = useHaPluginCredentials;
        this.storageSettings.settings.protocol.hide = useHaPluginCredentials;

        const useMqttPluginCredentials = JSON.parse(this.storageSettings.getItem('useMqttPluginCredentials') ?? 'false');
        this.storageSettings.settings.mqttHost.hide = useMqttPluginCredentials;
        this.storageSettings.settings.mqttUsename.hide = useMqttPluginCredentials;
        this.storageSettings.settings.mqttPassword.hide = useMqttPluginCredentials;

        this.storageSettings.settings.address.onPut = async () => await start();
        this.storageSettings.settings.protocol.onPut = async () => await start();
        this.storageSettings.settings.accessToken.onPut = async () => await start();
        this.storageSettings.settings.nvrUrl.onPut = async () => await start();
        this.storageSettings.settings.domains.onPut = async () => await start();
        this.storageSettings.settings.useHaPluginCredentials.onPut = async (_, isOn) => {
            this.storageSettings.settings.accessToken.hide = isOn;
            this.storageSettings.settings.address.hide = isOn;
            this.storageSettings.settings.protocol.hide = isOn;
        };

        this.storageSettings.settings.activeDevicesForNotifications.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.activeDevicesForReporting.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.alwaysActiveDevicesForNotifications.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.pluginEnabled.onPut = async () => {
            await this.startEventsListeners();
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
            await this.startRefreshDeviceData();
            await this.setupMqttClient();

            this.initListener = setInterval(async () => {
                await this.startEventsListeners();
            }, 3000)
        } catch (e) {
            this.getLogger().log(`Error in initFLow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const decodedUrl = decodeURIComponent(request.url);
        const [_, __, ___, ____, _____, webhook, deviceName, spec] = decodedUrl.split('/');
        const device = sdk.systemManager.getDeviceByName(deviceName) as unknown as (ScryptedDeviceBase & Settings);
        const deviceSettings = await device?.getSettings();
        try {
            if (deviceSettings) {
                if (webhook === 'snapshots') {
                    const { lastSnapshot } = await getWebookSpecs();
                    const isWebhookEnabled = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:lastSnapshotWebhook')?.value as boolean;

                    if (spec === lastSnapshot) {
                        if (isWebhookEnabled) {
                            // response.send(`${JSON.stringify(this.storageSettings.getItem('deviceLastSnapshotMap'))}`, {
                            //     code: 404,
                            // });
                            // return;
                            const { imageUrl } = this.storageSettings.getItem('deviceLastSnapshotMap')[deviceName] ?? {};

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

        if (this.storageSettings.getItem('useMqttPluginCredentials')) {
            this.getLogger().log(`Using MQTT plugin credentials.`);
            const mqttDevice = systemManager.getDeviceByName('MQTT') as unknown as Settings;
            const mqttSettings = await mqttDevice.getSettings();

            const isInternalBroker = (JSON.parse(mqttSettings.find(setting => setting.key === 'enableBroker')?.value as string || 'false')) as boolean;

            if (isInternalBroker) {
                this.getLogger().log(`Internal MQTT broker not supported yet. Please disable useMqttPluginCredentials.`);
            } else {
                mqttHost = mqttSettings.find(setting => setting.key === 'externalBroker')?.value as string;
                mqttUsename = mqttSettings.find(setting => setting.key === 'username')?.value as string;
                mqttPassword = mqttSettings.find(setting => setting.key === 'password')?.value as string;
            }
        } else {
            this.getLogger().log(`Using provided credentials.`);

            mqttHost = this.storageSettings.getItem('mqttHost');
            mqttUsename = this.storageSettings.getItem('mqttUsename');
            mqttPassword = this.storageSettings.getItem('mqttPassword');
        }

        const mqttActiveEntitiesTopic = this.storageSettings.getItem('mqttActiveEntitiesTopic');

        if (!mqttHost || !mqttUsename || !mqttPassword) {
            this.getLogger().log('MQTT params not provided');
        }

        try {
            this.mqttClient = new MqttClient(mqttHost, mqttUsename, mqttPassword);

            if (mqttActiveEntitiesTopic) {
                await this.mqttClient.subscribeToHaTopics(mqttActiveEntitiesTopic, this.getLogger(), async (topic, message) => {
                    if (topic === mqttActiveEntitiesTopic) {
                        this.mqttInit = true;
                        this.getLogger().log(`Received update for ${topic} topic: ${JSON.stringify(message)}`);
                        await this.syncHaEntityIds(message);
                    }
                });

                setTimeout(() => {
                    if (!this.mqttInit) {
                        this.getLogger().log(`No message received on topic ${mqttActiveEntitiesTopic}. Forcing init`);
                        this.mqttInit = true;
                    }
                }, 10000);
            } else {
                this.mqttInit = true;
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

    private async startRefreshDeviceData() {
        const funct = async () => {
            if (!this.firstCheckAlwaysActiveDevices) {
                this.getLogger().log('Refreshing devices data and devices always active for notifications');
            }
            await this.refreshDevicesLinks();
            this.nvrNotificationSend = {};

            const forcedActiveDevices: string[] = [];
            const pluginEnabled = this.storageSettings.getItem('pluginEnabled');
            if (pluginEnabled) {
                for (const device of this.getElegibleDevices()) {
                    const deviceName = device.name;
                    const deviceSettings = await device.getSettings();

                    const useNvrDetections = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:useNvrDetections')?.value as boolean) ?? false;
                    const alwaysActive = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:triggerAlwaysNotification')?.value as boolean) ?? false;
                    if (alwaysActive && !useNvrDetections) {
                        forcedActiveDevices.push(deviceName);
                    } else {
                        const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value as string[]) ?? [];
                        if (!!alwaysZones?.length) {
                            forcedActiveDevices.push(deviceName);
                        }

                        if (this.doorbellDevices.includes(deviceName)) {
                            const linkedCameraName = this.deviceVideocameraMap[deviceName];
                            const linkedCamera = systemManager.getDeviceByName(linkedCameraName) as unknown as Settings;
                            const linkedCameraSettings = await linkedCamera.getSettings();
                            const skipDoorbellNotifications = linkedCameraSettings.find(setting => setting.key === 'homeassistantMetadata:skipDoorbellNotifications')?.value as boolean;
                            !skipDoorbellNotifications && forcedActiveDevices.push(deviceName);
                        }
                    }
                }

                if (!isEqual(sortBy(this.storageSettings.getItem('alwaysActiveDevicesForNotifications') ?? []), sortBy(forcedActiveDevices ?? []))) {
                    if (!this.firstCheckAlwaysActiveDevices) {
                        this.getLogger().log('Restarting loop to adjust the devices listeners');
                    } else {
                        this.getLogger().log(`Setting forcedActiveDevices: ${JSON.stringify(forcedActiveDevices)}`);
                    }
                    this.storageSettings.putSetting('alwaysActiveDevicesForNotifications', forcedActiveDevices);
                }

                this.firstCheckAlwaysActiveDevices = true;
            } else {
                this.getLogger().log(`Plugin is not enabled`);
            }
        };

        await funct();

        setInterval(async () => {
            await funct();
        }, 10000);
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
        const deviceLinkedSensors: Record<string, string[]> = {};

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

                    deviceLinkedSensors[deviceName] = [...nearbySensors, ...nearbyLocks];

                    if (deviceLinkedSensors[deviceName].length) {
                        for (const sensorId of deviceLinkedSensors[deviceName]) {
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
        this.deviceLinkedSensors = deviceLinkedSensors
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
            return [ScryptedInterface.Notifier, ScryptedInterface.Settings]
        }

        return undefined;
    }

    async sendNotificationToPlugin(notifierId: string, title: string, options?: NotifierOptions, mediaParent?: MediaObject, icon?: MediaObject | string) {
        const triggerTime = options?.recordedEvent?.data.timestamp ?? new Date().getTime();
        const isTheFirstNotifier = !this.nvrNotificationSend[triggerTime];
        this.nvrNotificationSend[triggerTime] = true;
        const deviceSensors = this.deviceLinkedSensors[title];
        const cameraDevice = sdk.systemManager.getDeviceByName(title) as unknown as DeviceInterface;
        const deviceLogger = this.getDeviceLogger(cameraDevice);
        const {
            messageKey,
            detection,
            allDetections,
            isDetection,
            triggerDevice: triggerDeviceParent,
            isDoorbell,
            isOffline,
            isOnline,
        } = await parseNotificationMessage(cameraDevice, deviceSensors, options, deviceLogger);
        const {
            allActiveDevicesForNotifications,
            activeDevicesForReporting,
            notifiers,
        } = await this.getAllActiveDevices();
        const cameraName = cameraDevice.name;

        const triggerDevice = triggerDeviceParent ?? cameraDevice;
        const triggerDeviceName = triggerDevice.name;

        let media = mediaParent;
        let imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        const b64Image = imageBuffer.toString('base64');

        if (isTheFirstNotifier) {
            deviceLogger.log(`Notification ${triggerTime} coming from NVR: ${JSON.stringify({ title, options })}`);

            if (triggerDeviceParent) {
                deviceLogger.debug(`Trigger device found: ${triggerDeviceParent.name}`);
            }

            if (!messageKey) {
                deviceLogger.log('Notification not supported', JSON.stringify({ title, options }));
                return;
            }
            // TODO: Move on top function
            // if (!useNvrImages && detection.boundingBox) {
            //     const { newImage, newImageBuffer } = await this.addBoundingToImage(detection.boundingBox, imageBuffer, deviceLogger);
            //     media = newImage;
            //     imageBuffer = newImageBuffer;
            // } else {
            //     deviceLogger.log(`Not adding boundboxes, ${JSON.stringify({
            //         boundingBox: detection.boundingBox,
            //         useNvrImages
            //     })}`);
            // }
            // const imageWithBoundingMaybe = !useNvrImages ? this.


            if (isDetection && activeDevicesForReporting.includes(triggerDeviceName)) {
                this.getDeviceLogger(triggerDevice).log(`Reporting ${allDetections.length} detections: ${JSON.stringify(allDetections)}`)
                await this.executeReport({
                    currentTime: triggerTime,
                    device: cameraDevice,
                    detections: allDetections,
                    deviceName: cameraName,
                    b64Image
                });
            }
        } else {
            deviceLogger.debug(`Notification ${triggerTime} already reported, skipping MQTT report.`);
        }

        const notifier = systemManager.getDeviceById(notifierId) as unknown as DeviceInterface;

        let isValid = !isDetection;
        let data: any;

        if (!isValid) {
            const isDetectionValid = await getIsDetectionValid(cameraDevice, notifier, deviceLogger);
            const { data: detectData, isValid: isDetectValid } = isDetectionValid(detection);
            isValid = isDetectValid;
            data = detectData;
        }

        if (!isValid) {
            deviceLogger.log(`Detection discarded: ${JSON.stringify(data)}`);
            return;
        }

        const triggerDeviceSettings = await triggerDevice.getSettings();
        const useNvrDetections = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:useNvrDetections`)?.value as boolean ?? false;
        const useNvrImages = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:useNvrImages`)?.value as boolean ?? true;

        const disableNotifierSetting = triggerDeviceSettings.find(setting => setting.key === `homeassistantMetadata:notifier-${notifierId}:disabled`)?.value ?? false;
        const notifierActive = notifiers.includes(notifierId) && !disableNotifierSetting;
        const deviceActiveForNotifications = allActiveDevicesForNotifications.includes(triggerDeviceName);
        const canNotify = notifierActive && deviceActiveForNotifications && useNvrDetections;

        if (isOnline || isOffline || isDoorbell) {
            this.notifyCamera({
                device: triggerDevice,
                notifierId,
                time: triggerTime,
                detection,
                forceMessageKey: messageKey,
                source: NotificationSource.NVR,
            });

            return;
        }

        if (!notifierActive) {
            deviceLogger.debug(`Notifier ${notifier.name} not enabled for notifications`);
        }

        if (!deviceActiveForNotifications) {
            deviceLogger.debug(`Device ${triggerDeviceName} not enabled for notifications`);
        }

        if (!canNotify) {
            deviceLogger.debug(`Skipping notification. ${JSON.stringify({
                notifierActive,
                disableNotifierSetting,
                deviceActiveForNotifications,
                useNvrDetections,
                allActiveDevicesForNotifications,
                cameraName,
                triggerName: triggerDevice?.name,
            })}`);

            return;
        }

        const { externalUrl } = this.getUrls(cameraDevice.id, triggerTime);

        this.startMotionTimeoutAndPublish({
            device: cameraDevice,
            externalUrl,
            b64Image,
            triggered: true,
            triggerTime,
            detection,
            skipMotionCheck: false
        });

        this.notifyCamera({
            device: triggerDevice,
            notifierId,
            time: triggerTime,
            detection,
            forceMessageKey: messageKey,
            image: useNvrImages ? media : undefined,
            source: NotificationSource.NVR,
            keepImage: useNvrImages
        });
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        const props = {
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Homeassistant utilities',
        };

        if (
            [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.BinarySensor,
                ScryptedInterface.Lock,
            ].some(int => mixinDeviceInterfaces.includes(int))
        ) {
            return new HomeAssistantUtilitiesCameraMixin({
                ...props,
                groupKey: 'homeassistantMetadata'
            });
        }

        if (mixinDeviceInterfaces.includes(ScryptedInterface.Notifier)) {
            return new HomeAssistantUtilitiesNotifierMixin({
                ...props,
                groupKey: 'homeassistantNotifierMetadata'
            }, this.sendNotificationToPlugin.bind(this));
        }
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
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
        const { detection, detectionTime, notifierId, device, externalUrl, forceKey } = props;
        const detectionClass = detection?.className;
        const detectionLabel = detection?.label;

        const {
            isBooleanSensor,
            isDoorbelButton,
            roomName,
        } = await this.getDeviceFlags(device);

        let textToUse: string;

        const notifier = systemManager.getDeviceById(notifierId) as unknown as Settings;
        const notifierSettings = await notifier.getSettings();
        const notifierSettingsByKey = keyBy(notifierSettings, 'key');

        if (forceKey) {
            textToUse = notifierSettingsByKey[`homeassistantNotifierMetadata:${forceKey}`]?.value || this.storageSettings.getItem(forceKey as any);
        } else {
            const motionDetectedText = notifierSettingsByKey['homeassistantNotifierMetadata:motionDetectedText']?.value || this.storageSettings.getItem('motionDetectedText');
            const personDetectedText = notifierSettingsByKey['homeassistantNotifierMetadata:personDetectedText']?.value || this.storageSettings.getItem('personDetectedText');
            const familiarDetectedText = notifierSettingsByKey['fhomeassistantNotifierMetadata:amiliarDetectedText']?.value || this.storageSettings.getItem('familiarDetectedText');
            const plateDetectedText = notifierSettingsByKey['homeassistantNotifierMetadata:plateDetectedText']?.value || this.storageSettings.getItem('plateDetectedText');
            const animalDetectedText = notifierSettingsByKey['homeassistantNotifierMetadata:animalDetectedText']?.value || this.storageSettings.getItem('animalDetectedText');
            const vehicleDetectedText = notifierSettingsByKey['vhomeassistantNotifierMetadata:ehicleDetectedText']?.value || this.storageSettings.getItem('vehicleDetectedText');
            const doorbellText = notifierSettingsByKey['homeassistantNotifierMetadata:doorbellText']?.value || this.storageSettings.getItem('doorbellText');
            const doorWindowText = notifierSettingsByKey['homeassistantNotifierMetadata:doorWindowText']?.value || this.storageSettings.getItem('doorWindowText');

            if (isDoorbelButton) {
                textToUse = doorbellText;
            } else if (isBooleanSensor) {
                textToUse = doorWindowText;
            } else {
                switch (detectionClass) {
                    case 'face': {
                        textToUse = familiarDetectedText;
                        break;
                    }
                    case 'plate': {
                        textToUse = plateDetectedText;
                        break;
                    }
                    case 'person': {
                        textToUse = personDetectedText;
                        break;
                    }
                    case 'animal':
                        textToUse = animalDetectedText;
                        break;
                    case 'vehicle':
                        textToUse = vehicleDetectedText;
                        break;
                    case 'motion':
                        textToUse = motionDetectedText;
                        break;
                }
            }
        }


        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const time = eval(detectionTimeText.replace('${time}', detectionTime));

        return textToUse.toString()
            .replace('${time}', time)
            .replace('${nvrLink}', externalUrl)
            .replace('${person}', detectionLabel)
            .replace('${plate}', detectionLabel)
            .replace('${room}', roomName);
    }

    async startMotionTimeoutAndPublish(
        props: {
            device: DeviceInterface,
            detection?: ObjectDetectionResult,
            externalUrl: string,
            triggerTime: number,
            triggered: boolean,
            skipMotionCheck: boolean,
            skipMotion?: boolean,
            b64Image?: string,
            addBoundingBox?: boolean,
        }
    ) {
        const { detection, device, externalUrl, triggerTime, triggered, skipMotionCheck, b64Image } = props;
        const { id } = device;
        const deviceLogger = this.getDeviceLogger(device);

        const info = {
            scryptedUrl: externalUrl,
            detection,
            triggerTime,
            b64Image,
        };

        if (triggered) {
            deviceLogger.log(`Motion activated`);
        } else {
            deviceLogger.log(`Motion finished`);
        }

        await this.mqttClient.publishDeviceState({ device, triggered, info, console: deviceLogger });

        this.deviceTimeoutMap[id]?.removeListener();

        if (!skipMotionCheck) {
            const tmpTimeout = setTimeout(async () => {
                deviceLogger.log(`Trigger end motion by timeout`);
                await this.mqttClient.publishDeviceState({ device, triggered: false, info, console: deviceLogger });
            }, 20 * 1000);

            this.deviceTimeoutMap[id] = systemManager.listenDevice(device.id, ScryptedInterface.MotionSensor, async (_, __, data) => {
                if (!data) {
                    clearTimeout(tmpTimeout);
                    deviceLogger.log(`Trigger end motion by MotionSensor event`);
                    await this.mqttClient.publishDeviceState({ device, triggered: false, info, console: deviceLogger });
                }
            })
        }
    }

    checkDeviceLastDetection(minDelay: number, currentTime: number, lastDetection: number) {
        let delayDetectionDone: boolean;
        if (lastDetection && (currentTime - lastDetection) < 1000 * minDelay) {
            delayDetectionDone = false;
        } else {
            delayDetectionDone = true;
        }

        return { delayDetectionDone }
    }

    async notifyCamera(props: NotifyCameraProps) {
        const { device: srcDevice, notifierId, time, image: imageParent, detection, forceMessageKey, source, keepImage } = props;

        const device = await this.getCameraDevice(srcDevice);
        const deviceLogger = this.getDeviceLogger(device);

        if (!device) {
            deviceLogger.log(`There is no camera linked to the device ${srcDevice.name}`);
            return;
        }

        const deviceSettings = await device.getSettings();
        const srcDeviceSettings = await srcDevice.getSettings();
        const disableNotifierSetting = srcDeviceSettings.find(setting => setting.key === `homeassistantMetadata:notifier-${notifierId}:disabled`)?.value ?? false;
        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

        if (disableNotifierSetting) {
            deviceLogger.log(`Notifier ${notifier.name} forced disabled.`);
            return;
        }

        const { haUrl, externalUrl } = this.getUrls(device.id, time);

        const message = await this.getNotificationText({
            detection,
            externalUrl,
            detectionTime: time,
            notifierId,
            forceKey: forceMessageKey,
            device: srcDevice,
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

        const title = (srcDevice ?? device).name;

        deviceLogger.log(`Finally sending notification ${time} to ${notifier.name}. ${JSON.stringify({
            source,
            title,
            message,
        })}`);
        deviceLogger.debug(`${JSON.stringify(notifierOptions)}`);

        await notifier.sendNotification(title, notifierOptions, image, undefined);
    }

    async executeNotificationTest() {
        const testDeviceName = this.storageSettings.getItem('testDevice') as string;
        const testNotifier = this.storageSettings.getItem('testNotifier') as ScryptedDevice;
        const testMessageKey = this.storageSettings.getItem('testMessage') as string;

        if (testDeviceName && testMessageKey && testNotifier) {
            const currentTime = new Date().getTime();
            const testDevice = systemManager.getDeviceByName(testDeviceName) as unknown as DeviceInterface;
            const notifierId = testNotifier.id;

            this.getLogger().log(`Sending test notification to ${testNotifier.name} - ${testDevice.name} with key ${testMessageKey}}`);

            this.notifyCamera({
                device: testDevice,
                notifierId,
                time: currentTime,
                forceMessageKey: testMessageKey,
                detection: { label: 'Familiar' } as ObjectDetectionResult,
                source: NotificationSource.TEST
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

    private async getDeviceFlags(device: DeviceInterface) {
        const deviceName = device.name;
        const room = this.deviceRoomMap[deviceName];
        const deviceType = device.type;

        const isCamera = [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType);
        const isBooleanSensor = deviceType === ScryptedDeviceType.Sensor;

        const cameraDevice = await this.getCameraDevice(device);
        const isDoorbelButton = cameraDevice && isBooleanSensor && cameraDevice.type === ScryptedDeviceType.Doorbell;

        return {
            isCamera,
            isBooleanSensor,
            cameraDevice,
            isDoorbelButton,
            roomName: this.storageSettings.getItem('fetchedRoomNames')?.[room] ?? room
        }
    }

    async executeReport(props: ExecuteReportProps) {
        const { currentTime, detections, device, b64Image } = props;

        await this.mqttClient.publishRelevantDetections({
            detections,
            device,
            triggerTime: currentTime,
            console: this.getDeviceLogger(device),
            b64Image,
        })
    }

    private async addBoundingToImage(boundingBox: number[], imageBuffer: Buffer, console: Console) {
        console.log(`Trying to add boundingBox ${boundingBox}`);

        try {
            const [x, y, width, height] = boundingBox;
            const metadata = await sharp(imageBuffer).metadata();
            const svg = `
                    <svg width="${metadata.width}" height="${metadata.height}">
                        <rect
                        x="${x}"
                        y="${y}"
                        width="${width}"
                        height="${height}"
                        fill="none"
                        stroke="#FF0000"
                        stroke-width="3"
                        />
                    </svg>
                    `;

            const newImageBuffer = await sharp(imageBuffer)
                .composite([
                    {
                        input: Buffer.from(svg),
                        top: 0,
                        left: 0,
                    },
                ]).toBuffer();
            const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);
            console.log(`Bounding box added ${boundingBox}`);

            return { newImageBuffer, newImage };
        } catch (e) {
            console.log('Error adding bounding box', e);
            return {}
        }
    }

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

    private clearListeners() {
        this.activeListeners.forEach(listener => listener?.listener?.removeListener());
        this.activeListeners = [];
    }

    private getLogger(): Console {
        if (!this.mainLogger) {
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    this.console.log(`[Homeassistant utilities] ${now} - `, message, ...optionalParams);
                }
            };

            this.mainLogger = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.mainLogger
    }

    private getDeviceLogger(device: DeviceInterface): Console {
        const deviceName = device.name;
        const deviceConsole = sdk.deviceManager.getDeviceConsole(device.nativeId);

        if (!this.deviceLoggerMap[deviceName]) {
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    // this.console.log(`[${deviceName}] ${now} - `, message, ...optionalParams);
                    deviceConsole.log(`[${deviceName}] ${now} - `, message, ...optionalParams);
                }
            };
            this.deviceLoggerMap[deviceName] = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.deviceLoggerMap[deviceName];
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

    async startEventsListeners() {
        const pluginEnabled = this.storageSettings.getItem('pluginEnabled') as boolean;

        if (!pluginEnabled) {
            this.getLogger().log(`Plugin disabled. Clearing all the active listeners`);
            this.clearListeners();

            return;
        }

        if (!this.mqttInit || !this.firstCheckAlwaysActiveDevices) {
            this.getLogger().log(`Plugin not initialized yet, waiting. mqttInit is ${this.mqttInit} and firstCheckAlwaysActiveDevices is ${this.firstCheckAlwaysActiveDevices}`);

            return;
        }

        this.initListener && clearTimeout(this.initListener);

        if (this.activeListeners.length) {
            this.getLogger().log(`Clearing ${this.activeListeners.length} listeners before starting a new loop: ${this.activeListeners.map(list => list.deviceName)}`);
            this.clearListeners();
        }

        try {
            const {
                allActiveDevices,
                allActiveDevicesForNotifications,
                activeDevicesForNotifications,
                activeDevicesForReporting,
                alwaysActiveDevicesForNotifications,
                notifiers,
            } = await this.getAllActiveDevices();

            this.getLogger().log(`Starting listeners for ${allActiveDevices.length} with ${allActiveDevicesForNotifications.length} for notifications and ${activeDevicesForReporting.length} for reporting`);
            this.getLogger().log(`Devices: ${JSON.stringify({
                activeDevicesForNotifications,
                alwaysActiveDevicesForNotifications,
                activeDevicesForReporting,
                allActiveDevices,
            })}`);

            const deviceReportLockMap: Record<string, boolean> = {};
            const deviceAccumulatedDetectionsForNotifications: Record<string, ObjectDetectionResult[]> = {};
            const deviceAccumulatedDetectionsForReporting: Record<string, ObjectDetectionResult[]> = {};
            const deviceLastDetectionMap: Record<string, number> = {};
            for (const deviceName of allActiveDevices) {
                const device = systemManager.getDeviceByName(deviceName) as unknown as DeviceInterface;
                const deviceLogger = this.getDeviceLogger(device);
                deviceReportLockMap[deviceName] = false;
                deviceAccumulatedDetectionsForNotifications[deviceName] = [];
                deviceAccumulatedDetectionsForReporting[deviceName] = [];
                const isReportingActive = activeDevicesForReporting.includes(deviceName);
                const isDetectionValid = await getIsDetectionValid(device, undefined, undefined);

                try {
                    if (!device) {
                        this.console.log(`Device ${deviceName} is not available anymore`);
                        continue;
                    }


                    const deviceId = device.id;
                    const deviceSettings = await device.getSettings();

                    const useNvrDetections = deviceSettings.find(setting => setting.key === `homeassistantMetadata:useNvrDetections`)?.value as boolean ?? false;

                    if (isReportingActive && !this.autodiscoveryPublishedMap[deviceName]) {
                        await this.mqttClient?.setupDeviceAutodiscovery({
                            device,
                            deviceSettings,
                            detectionClasses: detectionClassesToPublish,
                            console: deviceLogger,
                            localIp: this.storageSettings.values.localIp,
                            withImage: useNvrDetections
                        });
                        this.autodiscoveryPublishedMap[deviceName] = true;
                    }

                    if (useNvrDetections) {
                        deviceLogger.log(`Using NVR detections. Skipping listener`);
                        continue;
                    }

                    const {
                        cameraDevice,
                        isBooleanSensor,
                        isCamera,
                        isDoorbelButton,
                    } = await this.getDeviceFlags(device);

                    const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value as string[]) ?? [];
                    const isOnlyMotion = isCamera && detectionClasses.length === 1 && detectionClasses[0] === 'motion';
                    const event = isCamera ? isOnlyMotion ? ScryptedInterface.MotionSensor : ScryptedInterface.ObjectDetector : ScryptedInterface.BinarySensor;
                    const minDelay = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:minDelayTime')?.value as number ?? 15;

                    deviceLogger.log(`Starting event listener for ${event}, ${JSON.stringify({
                        isCamera,
                        isOnlyMotion,
                        detectionClasses,
                        event,
                    })}`);

                    const listener = systemManager.listenDevice(deviceId, event, async (_, __, data) => {
                        const currentTime = new Date().getTime();

                        const snapshotWidth = this.storageSettings.getItem('snapshotWidth') as number;
                        const snapshotHeight = this.storageSettings.getItem('snapshotHeight') as number;

                        const relevantDetections = data.detections || [];
                        deviceAccumulatedDetectionsForNotifications[deviceName].push(...sortDetectionsByPriority(relevantDetections));
                        deviceAccumulatedDetectionsForReporting[deviceName].push(...sortDetectionsByPriority(relevantDetections));

                        const isReportLocked = deviceReportLockMap[deviceName] && isReportingActive;

                        try {
                            const accumulatedRelevantDetections = deviceAccumulatedDetectionsForReporting[deviceName];
                            if (!isReportLocked && accumulatedRelevantDetections.length > 0) {
                                deviceReportLockMap[deviceName] = true;
                                this.deviceLastDetectionsUpdate[deviceName] = currentTime;
                                await this.executeReport({ currentTime, device: cameraDevice, detections: accumulatedRelevantDetections, deviceName });
                            } else {
                                // deviceLogger.debug(`Skip executeReport, ${JSON.stringify({ isReportLocked, isReportingActive, accumulatedRelevantDetections })}`);
                            }
                        } finally {
                            deviceReportLockMap[deviceName] = false;
                            deviceAccumulatedDetectionsForReporting[deviceName] = [];
                        }

                        let foundDetection: ObjectDetectionResult;
                        let detectionData: any;

                        // Search for a detection if it's a camera with a classname !== motion
                        if (isCamera && !isOnlyMotion) {
                            for (const detection of deviceAccumulatedDetectionsForNotifications[deviceName]) {
                                const { data, isValid } = isDetectionValid(detection);

                                if (isValid) {
                                    detectionData = data;
                                    foundDetection = detection;

                                    continue;
                                }
                            }

                            // Do not proceed if no detection found
                            if (!foundDetection) {
                                return;
                            }
                        }

                        const keySuffix = isCamera ? foundDetection.className ? isBooleanSensor || isBooleanSensor : 'open' : undefined;
                        const deviceKey = `${isDoorbelButton ? cameraDevice.name : deviceName}-${keySuffix}`;
                        const lastDetection = deviceLastDetectionMap[deviceKey];

                        const { delayDetectionDone } = this.checkDeviceLastDetection(minDelay, currentTime, lastDetection);

                        const canContinue = delayDetectionDone || isDoorbelButton;
                        if (!canContinue) {
                            // deviceLogger.debug(`Skip notifiers, ${JSON.stringify({ delayDetectionDone, isDoorbelButton, canContinue })}`);
                            return;
                        }
                        deviceLogger.log(`Clearing accumulated detections: ${JSON.stringify(deviceAccumulatedDetectionsForNotifications[deviceName].slice(0, 5).map(det => det.className))}`);
                        deviceAccumulatedDetectionsForNotifications[deviceName] = [];

                        // TODO - Add configuration to check the event data
                        if (
                            isOnlyMotion ||
                            (isCamera && foundDetection) ||
                            ((isBooleanSensor || isDoorbelButton) && data)
                        ) {
                            deviceLogger.log(`Allowed detection found`);
                            deviceLogger.log(`${JSON.stringify(detectionData)}`);

                            const alwaysActive = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:triggerAlwaysNotification')?.value as boolean) ?? false;
                            const isNotifierActive = allActiveDevicesForNotifications.includes(deviceName) || alwaysActive;
                            deviceLastDetectionMap[deviceKey] = currentTime;

                            const { image, b64Image } = await this.getCameraSnapshot({ cameraDevice, snapshotHeight, snapshotWidth });

                            const { externalUrl } = this.getUrls(cameraDevice.id, currentTime);

                            if (isReportingActive) {
                                await this.startMotionTimeoutAndPublish({
                                    device,
                                    detection: foundDetection,
                                    b64Image,
                                    externalUrl,
                                    triggerTime: currentTime,
                                    triggered: isOnlyMotion ? data : true,
                                    skipMotionCheck: isOnlyMotion
                                });
                            } else {
                                deviceLogger.log(`Skip startMotionTimeoutAndPublish`);
                            }

                            if (isNotifierActive) {
                                deviceLogger.log(`Sending image to ${notifiers.length} notifiers`);
                                for (const notifierId of notifiers) {
                                    const disableNotifierSetting = deviceSettings.find(setting => setting.key === `homeassistantMetadata:notifier-${notifierId}:disabled`)?.value ?? false;

                                    if (disableNotifierSetting) {
                                        deviceLogger.log(`Notifier ${notifierId} forced disabled`);
                                        continue;
                                    }
                                    try {
                                        await this.notifyCamera({
                                            device,
                                            notifierId,
                                            time: currentTime,
                                            image, detection:
                                                foundDetection,
                                            source: NotificationSource.DETECTION
                                        });
                                    } catch (e) {
                                        deviceLogger.log(`Error on notifier ${notifierId}`, e);
                                    }
                                }
                            } else {
                                deviceLogger.log(`Device is not active for notifications. Skip notify`);
                            }
                        }

                    });
                    this.activeListeners.push({ listener, deviceName });
                } catch (e) {
                    deviceLogger.log(`Error in main loop`, e);
                }
            }
        } catch (e) {
            this.getLogger().log(e);
        }
    }


}

