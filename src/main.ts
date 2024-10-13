import sdk, { Camera, EventListenerRegister, MixinProvider, Notifier, ObjectDetectionResult, ObjectDetector, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
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
        },
        whitelistedZones: {
            title: 'Whitelisted zones',
            description: 'Zones that will trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
        },
        blacklistedZones: {
            title: 'Blacklisted zones',
            description: 'Zones that will not trigger a notification',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
        },
        alwaysZones: {
            title: 'Always zones',
            description: 'Zones that will trigger a notification, regardless of the active devices',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
        },
        detectionClasses: {
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
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
            title: 'Domains to fetch',
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
        activeDevices: {
            group: 'Notifier',
            title: 'Active devices',
            subgroup: 'Devices',
            multiple: true,
            type: 'string',
        },
        alwaysActiveDevices: {
            group: 'Notifier',
            title: 'Always active devices',
            subgroup: 'Devices',
            multiple: true,
            type: 'string',
            hide: true,
            defaultValue: [],
        },
        activeHaEntities: {
            group: 'Notifier',
            title: 'Active ha entities',
            subgroup: 'Devices',
            multiple: true,
            type: 'string',
            readonly: true,
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
        this.storageSettings.settings.activeDevices.onPut = async () => {
            this.syncHaEntityIds();
            await this.startEventsListeners();
        };
        this.storageSettings.settings.alwaysActiveDevices.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.minDelayTime.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.mqttHost.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttUsename.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttPassword.onPut = () => this.setupMqttClient();

        this.initDevices().then(() => start());
        this.startCheckAlwaysActiveDevices().then().catch(console.log);
    }

    private setupMqttClient() {
        const mqttHost = this.storageSettings.getItem('mqttHost');
        const mqttUsename = this.storageSettings.getItem('mqttUsename');
        const mqttPassword = this.storageSettings.getItem('mqttPassword');

        if(!mqttHost || !mqttUsename || !mqttPassword) {
            this.console.log('MQTT params not provided');
        }

        try {
            this.mqttClient = new MqttClient(mqttHost, mqttUsename, mqttPassword, this.console);
        } catch(e) {
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

            if (this.storageSettings.getItem('alwaysActiveDevices')?.toString() !== forcedActiveDevices.toString()) {
                this.console.log('Restarting loop to adjust the forced devices listeners');
                this.storageSettings.putSetting('alwaysActiveDevices', forcedActiveDevices);
            }
        };
        await funct();
        setInterval(async () => {
            await funct();
        }, 20000);
    }

    private syncHaEntityIds() {
        this.storageSettings.putSetting('activeHaEntities', this.storageSettings
            .getItem('activeDevices')
            .map(deviceName => this.deviceHaEntityMap[deviceName]));
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

        this.storageSettings.settings.activeDevices.choices = devices;
        this.storageSettings.settings.activeHaEntities.choices = devices;
        this.deviceHaEntityMap = deviceHaEntityMap;
        this.haEntityDeviceMap = haEntityDeviceMap;
        this.deviceVideocameraMap = deviceVideocameraMap;
        this.deviceTypeMap = deviceTypeMap;
        this.deviceRoomMap = deviceRoomMap;
        // this.console.log(deviceHaEntityMap, haEntityDeviceMap, deviceVideocameraMap, deviceTypeMap);
        this.syncHaEntityIds();
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
                    .filter(entityStatus => domains.length > 0 ? domains.includes(entityStatus.entity_id?.split('.')[0]) : true),
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

        return (detections: ObjectDetectionResult[]) => {
            const filterByClassName = detections.filter(detection => detectionClasses.includes(detection.className));
            return filterByClassName.find(detection => {
                const detectionZones = detection.zones;
                const isAlwaysIncluded = alwaysZones.length ? detectionZones.some(zone => alwaysZones.includes(zone)) : false;
                const isIncluded = whitelistedZones.length ? detectionZones.some(zone => whitelistedZones.includes(zone)) : true;
                const isExcluded = blacklistedZones.length ? detectionZones.some(zone => blacklistedZones.includes(zone)) : false;
                return isAlwaysIncluded || (isIncluded && !isExcluded);
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

    private replaceVariables(room: string, detectionTime: number, detection: ObjectDetectionResult, isDoorbell: boolean, notifierId: string) {
        const detectionClass = detection.className;
        const detectionLabel = detection.label;

        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const personDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:personDetectedText` as any) || this.storageSettings.getItem('personDetectedText');
        const familiarDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:familiarDetectedText` as any) || this.storageSettings.getItem('familiarDetectedText');
        const animalDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:animalDetectedText` as any) || this.storageSettings.getItem('animalDetectedText');
        const vehicleDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:vehicleDetectedText` as any) || this.storageSettings.getItem('vehicleDetectedText');
        const doorbellText = this.storageSettings.getItem(`notifier:${notifierId}:doorbellText` as any) || this.storageSettings.getItem('doorbellText');

        let textToUse: string;

        if (isDoorbell) {
            textToUse = doorbellText;
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

    async startEventsListeners() {
        const activeDevices = this.storageSettings.getItem('activeDevices') as string[];
        const alwaysActiveDevices = this.storageSettings.getItem('alwaysActiveDevices') as string[];
        const minDelay = this.storageSettings.getItem('minDelayTime') as number;
        if (this.activeListeners.length) {
            this.console.log(`Clearing ${this.activeListeners.length} listeners before starting a new loop: ${this.activeListeners.map(list => list.deviceName)}`);
            this.activeListeners.forEach(listener => listener?.listener?.removeListener());
            this.activeListeners = [];
        }

        try {
            const allActiveDevices = [...activeDevices, ...alwaysActiveDevices];
            this.console.log(`Starting listeners for ${allActiveDevices.length} devices: ${allActiveDevices}`);
            for (const deviceName of allActiveDevices) {
                try {
                    const device = systemManager.getDeviceByName(deviceName) as unknown as (Camera & ScryptedDeviceBase & Settings);
                    const deviceSettings = await device.getSettings();
                    const room = this.deviceRoomMap[deviceName];
                    const deviceType = this.deviceTypeMap[deviceName];
                    const findAllowedDetection = this.getAllowedDetectionFinder(deviceSettings)
                    if ([ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType)) {
                        const listener = systemManager.listenDevice(device.id, 'ObjectDetector', async (source, details, data) => {
                            const currentTime = new Date().getTime();
                            const lastDetection = this.deviceLastDetectionMap[deviceName];
                            if (lastDetection && (currentTime - lastDetection) < 1000 * minDelay) {
                                return;
                            }

                            const foundDetection = findAllowedDetection(data.detections);

                            if (foundDetection) {
                                this.deviceLastDetectionMap[deviceName] = currentTime;
                                const notifiers = this.storageSettings.getItem('notifiers') as string[];
                                const image = await device.takePicture();
                                const { externalUrl, haUrl } = this.getUrls(device.id, currentTime);
                                this.console.log(`${deviceName}: sending image to ${notifiers.length} notifiers. Detection ${JSON.stringify(foundDetection)}. Ha URL is ${haUrl} and external url is ${externalUrl}`);
                                for (const notifierId of notifiers) {
                                    const eventDescription = this.replaceVariables(this.roomNameMap[room], currentTime, foundDetection, false, notifierId);

                                    const addNvrLink = JSON.parse(this.storageSettings.getItem(`notifier:${notifierId}:addNvrLink` as any) || 'false');

                                    const body = addNvrLink ? `${eventDescription} - ${externalUrl}` : eventDescription;

                                    const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

                                    await notifier.sendNotification(deviceName, {
                                        body,
                                        data: {
                                            ha: {
                                                url: haUrl,
                                                clickAction: haUrl
                                            }
                                        }
                                    }, image)
                                }
                            }
                        });
                        this.activeListeners.push({ listener, deviceName });
                    } else if (deviceType === ScryptedDeviceType.Sensor) {
                        const linkedCamera = this.deviceVideocameraMap[deviceName];
                        if (!linkedCamera) {
                            const isCameraDoorbell = this.deviceTypeMap[linkedCamera] === ScryptedDeviceType.Doorbell;
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