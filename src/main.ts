import sdk, { Camera, EventListenerRegister, MediaObject, MixinProvider, Notifier, ObjectDetectionResult, ObjectDetector, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { sortBy } from 'lodash';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import MqttClient from './mqtt-client';

const { systemManager, mediaManager } = sdk;

class DeviceMetadataMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        room: {
            title: 'Room',
            type: 'string',
            subgroup: 'Metadata'
        },
        entityId: {
            title: 'EntityID',
            type: 'string',
            subgroup: 'Metadata',
            defaultValue: `binary_sensor.${this.mixinDevice.name}_triggered`
        },
        haDeviceClass: {
            title: 'Device class',
            type: 'string',
            subgroup: 'Metadata',
            defaultValue: 'motion'
        },
        whitelistedZones: {
            title: 'Whitelisted zones',
            description: 'Zones that will trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
        },
        blacklistedZones: {
            title: 'Blacklisted zones',
            description: 'Zones that will not trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
        },
        alwaysZones: {
            title: 'Always zones',
            description: 'Zones that will trigger a notification, regardless of the active devices',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
        },
        detectionClasses: {
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
        },
        motionActiveDuration: {
            subgroup: 'Detection',
            title: 'Motion active duration',
            description: 'How many seconds the motion sensors should stay active',
            type: 'number',
        },
        personThreshold: {
            title: 'Person threshold',
            subgroup: 'Detection',
            type: 'number',
        },
        animalThreshold: {
            title: 'Animal threshold',
            subgroup: 'Detection',
            type: 'number',
        },
        vehicleThreshold: {
            title: 'Vehicle threshold',
            subgroup: 'Detection',
            type: 'number',
        },
        haActions: {
            title: 'HA actions',
            description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true
        },
    });

    constructor(options: SettingsMixinDeviceOptions<any>) {
        super(options);

        const mainPluginDevice = systemManager.getDeviceByName('Homeassistant utilities') as unknown as Settings;

        this.storageSettings.settings.room.onGet = async () => {
            const rooms = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedRooms')?.value as string[];
            return {
                choices: rooms ?? []
            }
        }
        this.storageSettings.settings.entityId.onGet = async () => {
            const entities = (await mainPluginDevice.getSettings()).find(setting => setting.key === 'fetchedEntities')?.value as string[];
            return {
                choices: entities ?? []
            }
        }

        if (this.interfaces.includes(ScryptedInterface.VideoCamera)) {
            const getZones = async () => {
                const settings = await this.mixinDevice.getSettings();
                const zonesSetting = settings.find(setting => new RegExp('objectdetectionplugin:.*:zones').test(setting.key));

                return {
                    choices: zonesSetting?.value ?? []
                }
            }
            this.storageSettings.settings.whitelistedZones.onGet = async () => await getZones();
            this.storageSettings.settings.blacklistedZones.onGet = async () => await getZones();
            this.storageSettings.settings.alwaysZones.onGet = async () => await getZones();
            this.storageSettings.settings.detectionClasses.onGet = async () => {
                const settings = await this.mixinDevice.getSettings();
                const detectionClasses = settings.find(setting => new RegExp('objectdetectionplugin:.*:allowList').test(setting.key));
                const choices = detectionClasses?.value ?? [];
                return {
                    choices,
                    defaultValue: choices.includes('person') ? ['person'] : [],
                }
            };

            this.storageSettings.settings.whitelistedZones.hide = false;
            this.storageSettings.settings.blacklistedZones.hide = false;
            this.storageSettings.settings.alwaysZones.hide = false;
            this.storageSettings.settings.detectionClasses.hide = false;
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}

export default class DeviceMetadataProvider extends ScryptedDeviceBase implements MixinProvider {
    private deviceHaEntityMap: Record<string, string> = {};
    private haEntityDeviceMap: Record<string, string> = {};
    private deviceVideocameraMap: Record<string, string> = {};
    private deviceTypeMap: Record<string, ScryptedDeviceType> = {};
    private activeListeners: { listener: EventListenerRegister, deviceName: string }[] = [];
    private deviceLastDetectionMap: Record<string, number> = {};
    private deviceRoomMap: Record<string, string> = {}
    private roomNameMap: Record<string, string> = {}
    private mqttClient: MqttClient;
    private deviceTimeoutMap: Record<string, NodeJS.Timeout> = {};

    storageSettings = new StorageSettings(this, {
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
        scryptedToken: {
            title: 'Scrypted token',
            type: 'string',
            hide: true,
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
            title: 'Active devices',
            multiple: true,
            type: 'string',
            defaultValue: []
        },
        accessToken: {
            title: 'Personal access token',
            type: 'string',
        },
        scryptedTokenEntity: {
            title: 'HA sensor entityId',
            description: 'Where the scrypted token is stored, the prefix is enough',
            type: 'string',
            defaultValue: 'sensor.scrypted_token_'
        },
        nvrUrl: {
            title: 'NVR url',
            description: 'Url pointing to the NVR instance, useful to generate direct links to timeline',
            type: 'string',
            defaultValue: 'https://nvr.scrypted.app/'
        },
        useHaPluginCredentials: {
            title: 'Use HA plugin credentials',
            type: 'boolean',
            immediate: true,
        },
        address: {
            title: 'Address',
            type: 'string',
        },
        protocol: {
            title: 'Protocol',
            type: 'string',
            choices: ['http', 'https'],
            defaultValue: ['http'],
        },
        domains: {
            title: 'Entity regex patterns',
            description: 'Regex to filter out entities fetched',
            type: 'string',
            multiple: true,
        },
        fetchedEntities: {
            group: 'Fetched entities',
            title: '',
            subgroup: 'Rooms',
            readonly: true,
            multiple: true,
        },
        fetchedRooms: {
            group: 'Fetched entities',
            title: '',
            subgroup: 'Entities',
            readonly: true,
            multiple: true,
        },
        minDelayTime: {
            group: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of time to wait until a notification is send from the same camera, in seconds',
            type: 'number',
            defaultValue: 10,
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
        detectionTimeText: {
            group: 'Texts',
            title: 'Detection time',
            type: 'string',
            description: 'Expression used to render the time shown in notifications. Available arguments ${time}',
            defaultValue: 'new Date(${time}).toLocaleString()'
        },
        personDetectedText: {
            group: 'Texts',
            title: 'Person detected text',
            type: 'string',
            description: 'Expression used to render the text when a person is detected. Available arguments ${room} ${time}',
            defaultValue: 'Person detected in ${room}'
        },
        familiarDetectedText: {
            group: 'Texts',
            title: 'Familiar detected text',
            type: 'string',
            description: 'Expression used to render the text when a familiar is detected. Available arguments ${room} ${time} ${person}',
            defaultValue: '${person} detected in ${room}'
        },
        animalDetectedText: {
            group: 'Texts',
            title: 'Animal detected text',
            type: 'string',
            description: 'Expression used to render the text when an animal is detected. Available arguments ${room} ${time}',
            defaultValue: 'Animal detected in ${room}'
        },
        vehicleDetectedText: {
            group: 'Texts',
            title: 'Vehicle detected text',
            type: 'string',
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} ${time}',
            defaultValue: 'Vehicle detected in ${room}'
        },
        doorbellText: {
            group: 'Texts',
            title: 'Doorbell ringing text',
            type: 'string',
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} $[time}',
            defaultValue: 'Someone at the door'
        },
        doorWindowText: {
            group: 'Texts',
            title: 'Door/Window open text',
            type: 'string',
            description: 'Expression used to render the text when a binary sensor opens. Available arguments ${room} $[time}',
            defaultValue: 'Door/window opened in ${room}'
        },
        motionActiveDuration: {
            group: 'Detection',
            title: 'Motion active duration',
            description: 'How many seconds the motion sensors should stay active',
            type: 'number',
            defaultValue: 30,
        },
        personThreshold: {
            group: 'Detection',
            title: 'Person threshold',
            type: 'number',
            defaultValue: 0.8
        },
        animalThreshold: {
            group: 'Detection',
            title: 'Animal threshold',
            type: 'number',
            defaultValue: 0.7
        },
        vehicleThreshold: {
            group: 'Detection',
            title: 'Vehicle threshold',
            type: 'number',
            defaultValue: 0.7
        },
        requireScryptedNvrDetections: {
            group: 'Detection',
            title: 'Require Scrypted Detections',
            description: 'When enabled, this sensor will ignore onboard camera detections.',
            type: 'boolean',
            defaultValue: true,
        },
    });

    constructor(nativeId: string) {
        super(nativeId);

        const start = () => {
            this.start().catch(e => this.console.log(e));
            this.startEventsListeners().catch(e => this.console.log(e));
        };

        const useHaPluginCredentials = Boolean(this.storageSettings.getItem('useHaPluginCredentials') ?? false);
        this.storageSettings.settings.accessToken.hide = useHaPluginCredentials;
        this.storageSettings.settings.address.hide = useHaPluginCredentials;
        this.storageSettings.settings.protocol.hide = useHaPluginCredentials;

        this.storageSettings.settings.address.onPut = () => start();
        this.storageSettings.settings.protocol.onPut = () => start();
        this.storageSettings.settings.accessToken.onPut = () => start();
        this.storageSettings.settings.nvrUrl.onPut = () => start();
        this.storageSettings.settings.scryptedTokenEntity.onPut = () => start();
        this.storageSettings.settings.domains.onPut = () => start();
        this.storageSettings.settings.useHaPluginCredentials.onPut = ((_, isOn) => {
            this.storageSettings.settings.accessToken.hide = isOn;
            this.storageSettings.settings.address.hide = isOn;
            this.storageSettings.settings.protocol.hide = isOn;
            start();
        });
        this.storageSettings.settings.activeDevicesForNotifications.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.activeDevicesForReporting.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.alwaysActiveDevicesForNotifications.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.minDelayTime.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.mqttHost.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttUsename.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttPassword.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttActiveEntitiesTopic.onPut = () => this.setupMqttClient();

        this.setupMqttClient();
        this.initDevices().then(() => start());
        this.startCheckAlwaysActiveDevices().then().catch(console.log);
    }

    private setupMqttClient() {
        const mqttHost = this.storageSettings.getItem('mqttHost');
        const mqttUsename = this.storageSettings.getItem('mqttUsename');
        const mqttPassword = this.storageSettings.getItem('mqttPassword');

        if (!mqttHost || !mqttUsename || !mqttPassword) {
            this.console.log('MQTT params not provided');
        }

        try {
            this.mqttClient = new MqttClient(mqttHost, mqttUsename, mqttPassword, this.console);
        } catch (e) {
            this.console.log('Error setting up MQTT client', e);
        }
    }

    private getElegibleDevices() {
        return Object.entries(systemManager.getSystemState()).filter(([deviceId]) => {
            const device = systemManager.getDeviceById(deviceId) as unknown as (Settings & ScryptedDeviceBase);

            return device.mixins?.includes(this.id) && !!device.getSettings;
        }).map(([deviceId]) => systemManager.getDeviceById(deviceId) as unknown as (Settings & ScryptedDeviceBase))
    }

    private async startCheckAlwaysActiveDevices() {
        const funct = async () => {
            const forcedActiveDevices: string[] = [];
            for (const device of this.getElegibleDevices()) {
                const settings = await device.getSettings();
                const alwaysZones = (settings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value as string[]) ?? [];
                if (!!alwaysZones?.length) {
                    forcedActiveDevices.push(device.name);
                }
            }

            if (this.storageSettings.getItem('alwaysActiveDevicesForNotifications')?.toString() !== forcedActiveDevices.toString()) {
                this.console.log('Restarting loop to adjust the forced devices listeners');
                this.storageSettings.putSetting('alwaysActiveDevicesForNotifications', forcedActiveDevices);
            }
        };
        await funct();
        setInterval(async () => {
            await funct();
        }, 20000);
    }

    private syncHaEntityIds(devices: string[]) {
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
        this.storageSettings.putSetting('activeDevicesForNotifications', deviceNames);
    }

    private async initDevices() {
        const devices: string[] = [];
        const haEntities: string[] = [];
        const deviceHaEntityMap: Record<string, string> = {};
        const haEntityDeviceMap: Record<string, string> = {};
        const deviceVideocameraMap: Record<string, string> = {};
        const deviceRoomMap: Record<string, string> = {};
        const deviceTypeMap: Record<string, ScryptedDeviceType> = {};

        const cloudPlugin = systemManager.getDeviceByName('Scrypted Cloud') as unknown as Settings;
        const oauthUrl = await (cloudPlugin as any).getOauthUrl();
        const url = new URL(oauthUrl);
        this.storageSettings.putSetting('serverId', url.searchParams.get('server_id'));

        for (const device of this.getElegibleDevices()) {
            const deviceName = device.name;
            const deviceType = device.type;
            const settings = await device.getSettings();
            const haEntityId = settings.find(setting => setting.key === 'homeassistantMetadata:entityId')?.value as string;
            const room = settings.find(setting => setting.key === 'homeassistantMetadata:room')?.value as string;

            deviceRoomMap[deviceName] = room;
            if (haEntityId) {
                haEntities.push(haEntityId);
                devices.push(deviceName);
                deviceTypeMap[deviceName] = deviceType;

                deviceHaEntityMap[deviceName] = haEntityId;
                haEntityDeviceMap[haEntityId] = deviceName;

                if (deviceType === ScryptedDeviceType.Camera) {
                    const nearbySensors = settings.find(setting => setting.key === 'recording:nearbySensors')?.value as string[];
                    if (nearbySensors) {
                        for (const sensorId of nearbySensors) {
                            const sensorDevice = systemManager.getDeviceById(sensorId);
                            deviceVideocameraMap[sensorDevice.name] = deviceName;
                        }
                    }
                }

                if (deviceType === ScryptedDeviceType.Doorbell) {
                    const doorbellButtonId = settings.find(setting => setting.key === 'replaceBinarySensor:replaceBinarySensor')?.value as string;
                    if (doorbellButtonId) {
                        const sensorDevice = systemManager.getDeviceById(doorbellButtonId);
                        deviceVideocameraMap[sensorDevice.name] = deviceName;
                    }
                }
            }
        }

        this.storageSettings.settings.activeDevicesForNotifications.choices = devices;
        this.storageSettings.settings.activeDevicesForReporting.choices = devices;
        this.deviceHaEntityMap = deviceHaEntityMap;
        this.haEntityDeviceMap = haEntityDeviceMap;
        this.deviceVideocameraMap = deviceVideocameraMap;
        this.deviceTypeMap = deviceTypeMap;
        this.deviceRoomMap = deviceRoomMap;
        // this.console.log(deviceHaEntityMap, haEntityDeviceMap, deviceVideocameraMap, deviceTypeMap);

        const mqttActiveEntitiesTopic = this.storageSettings.getItem('mqttActiveEntitiesTopic');
        if (mqttActiveEntitiesTopic) {
            this.mqttClient.subscribeToHaTopics(mqttActiveEntitiesTopic, (topic, message) => {
                if (topic === mqttActiveEntitiesTopic) {
                    this.syncHaEntityIds(message);
                }
            });
        }
    }

    async getSettings() {
        const settings: Setting[] = await this.storageSettings.getSettings();

        const notifiers = this.storageSettings.getItem('notifiers') ?? [];
        const textSettings = settings.filter(setting => setting.group === 'Texts');

        for (const notifierId of notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as ScryptedDeviceBase;
            const notifierName = notifier.name;

            const key = `notifier:${notifierId}:addNvrLink`;
            settings.push({
                key,
                title: 'Add NVR link as body',
                type: 'boolean',
                group: 'Notifier',
                subgroup: `${notifierName}`,
                value: this.storage.getItem(key),
            });

            textSettings.forEach(textSetting => {
                const key = `notifier:${notifierId}:${textSetting.key}`;
                settings.push({
                    ...textSetting,
                    value: this.storage.getItem(key),
                    key,
                    subgroup: `${notifierName}`
                });
            })
        }

        return settings;
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    start = async () => {
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

        if (!accessToken || !address || !protocol) {
            throw new Error(`HA access params not set correctly: AccessToken: ${accessToken}, Address: ${address}, Protocol: ${protocol}`);
        }

        const url = `${protocol}://${address}`

        const domains = this.storageSettings.getItem('domains') as string[];

        // console.log(url, domains);

        let rooms: string[] = [];
        const roomNameMap: Record<string, string> = {};
        let entityIds: string[] = [];
        let scryptedToken: string;

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

            scryptedToken = entitiesResponse.data.find(ent => ent.entity_id.includes(this.storageSettings.getItem('scryptedTokenEntity')))?.state;

            // console.log(rooms, entityIds);
        } catch (e) {
            console.log(e);
        } finally {
            await this.storageSettings.putSetting('fetchedEntities', entityIds);
            await this.storageSettings.putSetting('fetchedRooms', rooms);
            await this.storageSettings.putSetting('scryptedToken', scryptedToken);
            this.roomNameMap = roomNameMap;
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        return [
            ScryptedInterface.Camera,
            ScryptedInterface.VideoCamera,
            ScryptedInterface.BinarySensor,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.Lock
        ].some(int => interfaces.includes(int)) ?
            [
                ScryptedInterface.Settings,
            ] :
            undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new DeviceMetadataMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Homeassistant utilities',
            groupKey: 'homeassistantMetadata',
        });
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    }

    private getAllowedDetectionFinder(deviceSettings: Setting[]) {
        const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value as string[]) ?? [];
        const whitelistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:whitelistedZones')?.value as string[]) ?? [];
        const blacklistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:blacklistedZones')?.value as string[]) ?? [];
        const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value as string[]) ?? [];

        const deviceVehicleThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:vehicleThreshold')?.value as number);
        const devicePersonThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:personThreshold')?.value as number);
        const deviceAnimalThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:animalThreshold')?.value as number);
        const mainVehicleThreshold = this.storageSettings.getItem('vehicleThreshold');
        const mainPersonThreshold = this.storageSettings.getItem('personThreshold');
        const mainAnimalThreshold = this.storageSettings.getItem('animalThreshold');
        const requireScryptedNvrDetections = this.storageSettings.getItem('requireScryptedNvrDetections');

        const personThreshold = devicePersonThreshold || mainPersonThreshold || 0.8;
        const vehicleThreshold = deviceVehicleThreshold || mainVehicleThreshold || 0.7;
        const animalThreshold = deviceAnimalThreshold || mainAnimalThreshold || 0.7;

        return (detections: ObjectDetectionResult[]) => {
            const filterByClassNameAndScore = detections.filter(detection => {
                if (requireScryptedNvrDetections && !detection.boundingBox) {
                    return false;
                }

                return detectionClasses.some(detectionClass => {
                    if (detectionClass !== detection.className) {
                        return false;
                    }

                    const scoreToUse = detectionClass === 'person' ? personThreshold :
                        detectionClass === 'animal' ? animalThreshold :
                            detectionClass === 'vehicle' ? vehicleThreshold : 0.7;

                    if (detection.score > scoreToUse) {
                        this.console.log(`Found a detection for class ${detectionClass} with score ${detection.score} (min ${scoreToUse})`);
                        return true;
                    }

                })
            });

            return filterByClassNameAndScore.find(detection => {
                const detectionZones = detection.zones;
                const isAlwaysIncluded = alwaysZones.length ? detectionZones.some(zone => alwaysZones.includes(zone)) : false;
                const isIncluded = whitelistedZones.length ? detectionZones.some(zone => whitelistedZones.includes(zone)) : true;
                const isExcluded = blacklistedZones.length ? detectionZones.some(zone => blacklistedZones.includes(zone)) : false;

                if (isAlwaysIncluded || (isIncluded && !isExcluded)) {
                    this.console.log(`Detection found because zones ${detection.zones} and alwaysZones ${alwaysZones}, whitelisted ${whitelistedZones}, blacklisted ${blacklistedZones}. Detection is ${JSON.stringify(detection)}`);
                    return true;
                }
            })
        }
    }

    private getUrls(cameraId: string, time: number) {
        const serverId = this.storageSettings.getItem('serverId');
        const nvrUrl = this.storageSettings.getItem('nvrUrl');
        const scryptedToken = this.storageSettings.getItem('scryptedToken');

        const timelinePart = `#/timeline/${cameraId}?time=${time}&from=notification&serverId=24bc664f9d49dbf1&disableTransition=true`;
        const haUrl = `/api/scrypted/${scryptedToken}/endpoint/@scrypted/nvr/public/${timelinePart}`
        const externalUrl = `${nvrUrl}/${timelinePart}`
        return { externalUrl: externalUrl, haUrl: `/scrypted_${scryptedToken}?url=${encodeURIComponent(haUrl)}` }
    }

    private replaceVariables(
        props: {
            room: string,
            detectionTime: number,
            detection?: ObjectDetectionResult,
            isDoorbell?: boolean,
            isBooleanSensor?: boolean,
            notifierId: string
        }
    ) {
        const { detection, detectionTime, isDoorbell, notifierId, room, isBooleanSensor } = props;
        const detectionClass = detection?.className;
        const detectionLabel = detection?.label;

        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const personDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:personDetectedText` as any) || this.storageSettings.getItem('personDetectedText');
        const familiarDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:familiarDetectedText` as any) || this.storageSettings.getItem('familiarDetectedText');
        const animalDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:animalDetectedText` as any) || this.storageSettings.getItem('animalDetectedText');
        const vehicleDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:vehicleDetectedText` as any) || this.storageSettings.getItem('vehicleDetectedText');
        const doorbellText = this.storageSettings.getItem(`notifier:${notifierId}:doorbellText` as any) || this.storageSettings.getItem('doorbellText');
        const doorWindowText = this.storageSettings.getItem(`notifier:${notifierId}:doorWindowText` as any) || this.storageSettings.getItem('doorWindowText');

        let textToUse: string;

        if (isDoorbell) {
            textToUse = doorbellText;
        } if (isBooleanSensor) {
            textToUse = doorWindowText;
        } else {
            switch (detectionClass) {
                case 'person': {
                    if (detectionLabel) {
                        textToUse = familiarDetectedText;
                    } else {
                        textToUse = personDetectedText;
                    }
                    break;
                }
                case 'animal':
                    textToUse = animalDetectedText;
                    break;
                case 'vehicle':
                    textToUse = vehicleDetectedText;
                    break;
            }
        }

        const time = eval(detectionTimeText.replace('${time}', detectionTime));
        return textToUse.toString()
            .replace('${time}', time)
            .replace('${person}', detectionLabel)
            .replace('${room}', room);
    }

    async startMotionTimeoutAndPublish(
        props: {
            device: ScryptedDeviceBase,
            detection: ObjectDetectionResult | undefined,
            deviceSettings: Setting[],
            image: MediaObject,
            externalUrl: string,
        }
    ) {
        const { detection, device, deviceSettings, externalUrl, image } = props;
        const { id, name } = device;
        const mainMotionDuration = this.storageSettings.getItem('motionActiveDuration');
        const deviceMotionDuration = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:motionActiveDuration')?.value;
        const motionDuration = deviceMotionDuration ?? mainMotionDuration ?? 30;

        const imageUrl = await mediaManager.convertMediaObjectToUrl(image, 'image/jpg');
        const localImageUrl = await mediaManager.convertMediaObjectToLocalUrl(image, 'image/jpg');
        const info = {
            imageUrl,
            localImageUrl,
            scryptedUrl: externalUrl,
            detection,
        };
        this.mqttClient.publishDeviceState(id, true, info);

        const currentTimeout = this.deviceTimeoutMap[id];
        if (currentTimeout) {
            clearTimeout(currentTimeout);
        }

        this.deviceTimeoutMap[id] = setTimeout(() => {
            this.mqttClient.publishDeviceState(id, false, info);
        }, motionDuration * 1000);
    }

    checkDeviceLastDetection(deviceName: string, minDelay: number) {
        const currentTime = new Date().getTime();
        const lastDetection = this.deviceLastDetectionMap[deviceName];
        let delayDone;
        if (lastDetection && (currentTime - lastDetection) < 1000 * minDelay) {
            delayDone = false;
        } else {
            delayDone = true;
        }

        return { delayDone, currentTime }
    }

    async startEventsListeners() {
        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];
        const alwaysActiveDevicesForNotifications = this.storageSettings.getItem('alwaysActiveDevicesForNotifications') as string[];
        const minDelay = this.storageSettings.getItem('minDelayTime') as number;
        if (this.activeListeners.length) {
            this.console.log(`Clearing ${this.activeListeners.length} listeners before starting a new loop: ${this.activeListeners.map(list => list.deviceName)}`);
            this.activeListeners.forEach(listener => listener?.listener?.removeListener());
            this.activeListeners = [];
        }

        try {
            const allActiveDevicesForNotifications = [...activeDevicesForNotifications, ...alwaysActiveDevicesForNotifications];

            const allActiveDevices: string[] = [];
            allActiveDevicesForNotifications.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));
            activeDevicesForReporting.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));

            this.console.log(`Starting listeners for ${allActiveDevices.length} with ${allActiveDevicesForNotifications.length} for notifications and ${activeDevicesForReporting.length} for reporting`);
            for (const deviceName of allActiveDevices) {
                try {
                    const device = systemManager.getDeviceByName(deviceName) as unknown as (Camera & ScryptedDeviceBase & Settings);
                    const deviceId = device.id;
                    const deviceSettings = await device.getSettings();
                    if (activeDevicesForReporting.includes(deviceName)) {
                        this.mqttClient?.setupDeviceAutodiscovery(deviceId, deviceName, deviceSettings);
                    }
                    const room = this.deviceRoomMap[deviceName];
                    const deviceType = this.deviceTypeMap[deviceName];
                    const findAllowedDetection = this.getAllowedDetectionFinder(deviceSettings)
                    if ([ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType)) {
                        const listener = systemManager.listenDevice(deviceId, 'ObjectDetector', async (source, details, data) => {
                            const { delayDone, currentTime } = this.checkDeviceLastDetection(deviceName, minDelay);
                            if (!delayDone) {
                                return;
                            }

                            const foundDetection = findAllowedDetection(data.detections);

                            if (foundDetection) {
                                this.deviceLastDetectionMap[deviceName] = currentTime;
                                const notifiers = this.storageSettings.getItem('notifiers') as string[];
                                const image = await device.takePicture();
                                const { externalUrl, haUrl } = this.getUrls(device.id, currentTime);

                                if (activeDevicesForReporting.includes(deviceName)) {
                                    await this.startMotionTimeoutAndPublish({
                                        device,
                                        detection: foundDetection,
                                        deviceSettings,
                                        image,
                                        externalUrl
                                    });
                                }

                                if (activeDevicesForNotifications.includes(deviceName)) {
                                    this.console.log(`${deviceName}: sending image to ${notifiers.length} notifiers`);
                                    for (const notifierId of notifiers) {
                                        const eventDescription = this.replaceVariables({
                                            detection: foundDetection,
                                            detectionTime: currentTime,
                                            notifierId: notifierId,
                                            room: this.roomNameMap[room]
                                        });
                                        const addNvrLink = JSON.parse(this.storageSettings.getItem(`notifier:${notifierId}:addNvrLink` as any) || 'false');
                                        const body = addNvrLink ? `${eventDescription} - ${externalUrl}` : eventDescription;
                                        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

                                        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];

                                        await notifier.sendNotification(deviceName, {
                                            body,
                                            data: {
                                                ha: {
                                                    url: haUrl,
                                                    clickAction: haUrl,
                                                    actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined,
                                                }
                                            }
                                        }, image)
                                    }
                                }
                            }
                        });
                        this.activeListeners.push({ listener, deviceName });
                    } else if (deviceType === ScryptedDeviceType.Sensor) {
                        const linkedCameraName = this.deviceVideocameraMap[deviceName];
                        if (linkedCameraName) {
                            const linkedCamera = systemManager.getDeviceByName(linkedCameraName) as unknown as (Camera);
                            const listener = systemManager.listenDevice(deviceId, 'BinarySensor', async (_, __, isActive) => {
                                if (!isActive) {
                                    return;
                                }
                                const { delayDone, currentTime } = this.checkDeviceLastDetection(deviceName, minDelay);
                                if (!delayDone) {
                                    return;
                                }

                                this.deviceLastDetectionMap[deviceName] = currentTime;
                                const isDoorbellButton = this.deviceTypeMap[linkedCameraName] === ScryptedDeviceType.Doorbell;


                                const notifiers = this.storageSettings.getItem('notifiers') as string[];
                                const image = await linkedCamera.takePicture();
                                const { externalUrl, haUrl } = this.getUrls(device.id, currentTime);

                                // if (activeDevicesForReporting.includes(deviceName)) {
                                //     await this.startMotionTimeoutAndPublish(device, foundDetection, deviceSettings, image, externalUrl);
                                // }

                                if (activeDevicesForNotifications.includes(deviceName)) {
                                    this.console.log(`${deviceName}: sending image to ${notifiers.length} notifiers`);
                                    for (const notifierId of notifiers) {
                                        const eventDescription = this.replaceVariables({
                                            detectionTime: currentTime,
                                            notifierId: notifierId,
                                            room: this.roomNameMap[room],
                                            isDoorbell: isDoorbellButton,
                                            isBooleanSensor: !isDoorbellButton,
                                        });
                                        const addNvrLink = JSON.parse(this.storageSettings.getItem(`notifier:${notifierId}:addNvrLink` as any) || 'false');
                                        const body = addNvrLink ? `${eventDescription} - ${externalUrl}` : eventDescription;
                                        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

                                        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];

                                        await notifier.sendNotification(deviceName, {
                                            body,
                                            data: {
                                                ha: {
                                                    url: haUrl,
                                                    clickAction: haUrl,
                                                    actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined,
                                                }
                                            }
                                        }, image)
                                    }
                                }

                            });
                            this.activeListeners.push({ listener, deviceName });
                        }
                    }
                } catch (e) {
                    this.console.log(e);
                }
            }
        } catch (e) {
            this.console.log(e);
        }
    }


}