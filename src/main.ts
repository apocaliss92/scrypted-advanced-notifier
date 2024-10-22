import sdk, { EventListenerRegister, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { sortBy } from 'lodash';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import MqttClient from './mqtt-client';
import { DeviceInterface } from "./types";

const { systemManager, mediaManager, endpointManager } = sdk;

const getWebookSpecs = async () => {
    const lastSnapshot = 'last';

    return {
        lastSnapshot,
    }
}

const getWebookUrls = async (cameraDevice: string, console: Console) => {
    let lastSnapshotCloudUrl: string;
    let lastSnapshotLocalUrl: string;

    const { lastSnapshot } = await getWebookSpecs();

    try {
        const cloudEndpoint = await endpointManager.getPublicCloudEndpoint();
        const localEndpoint = await endpointManager.getPublicLocalEndpoint();

        lastSnapshotCloudUrl = `${localEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
        lastSnapshotLocalUrl = `${cloudEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
    } catch (e) {
        console.log('Error fetching webhookUrls', e);
    }

    return {
        lastSnapshotCloudUrl,
        lastSnapshotLocalUrl,
    }
}

class HomeAssistantUtilitiesMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        // METADATA
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
        // DETECTION
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
            title: 'Always enabled zones',
            description: 'Zones that will trigger a notification, regardless of the device is active or not in the main selector',
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
            defaultValue: ['person']
        },
        motionActiveDuration: {
            subgroup: 'Detection',
            title: 'Motion active duration',
            description: 'How many seconds the motion sensors should stay active',
            type: 'number',
            hide: true,
        },
        scoreThreshold: {
            title: 'Default score threshold',
            subgroup: 'Detection',
            type: 'number',
            readonly: true,
            hide: true,
        },
        // NOTIFIER
        haActions: {
            title: 'HA actions',
            description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true
        },
        minDelayTime: {
            subgroup: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of time to wait until a notification is sent from the same camera, in seconds',
            type: 'number',
        },
        skipDoorbellNotifications: {
            subgroup: 'Notifier',
            title: 'Skip doorbell notifications',
            type: 'boolean',
            defaultValue: false,
            hide: true,
        },
        disableVideoclips: {
            subgroup: 'Notifier',
            title: 'Disable videoclips',
            type: 'boolean',
            hide: true
        },
        videoclipDuration: {
            subgroup: 'Notifier',
            title: 'Videoclip duration',
            type: 'number',
            hide: true
        },
        // WEBHOOKS
        lastSnapshotWebhook: {
            subgroup: 'Webhooks',
            title: 'Last snapshot webhook',
            type: 'boolean',
            immediate: true,
        },
        lastSnapshotWebhookCloudUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Cloud URL',
            // readonly: true,
            // TODO: export on common fn
            onGet: async () => {
                const isWebhookEnabled = this.storageSettings.getItem('lastSnapshotWebhook');
                return {
                    hide: !isWebhookEnabled,
                }
            }
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'string',
            title: 'Local URL',
            // readonly: true,
            onGet: async () => {
                const isWebhookEnabled = this.storageSettings.getItem('lastSnapshotWebhook');
                return {
                    hide: !isWebhookEnabled,
                }
            }
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
                choices.includes('motion') && choices.push('motion');
                return {
                    choices,
                }
            };

            this.storageSettings.settings.whitelistedZones.hide = false;
            this.storageSettings.settings.blacklistedZones.hide = false;
            this.storageSettings.settings.alwaysZones.hide = false;
            this.storageSettings.settings.detectionClasses.hide = false;
            this.storageSettings.settings.motionActiveDuration.hide = false;
            this.storageSettings.settings.scoreThreshold.hide = false;
            this.storageSettings.settings.skipDoorbellNotifications.hide = this.type !== ScryptedDeviceType.Doorbell;

            this.initValues().then().catch(this.console.log)
        }
    }

    async initValues() {
        if (this.interfaces.includes(ScryptedInterface.VideoCamera)) {
            const mainPluginDevice = systemManager.getDeviceByName('Homeassistant utilities') as unknown as Settings;
            const settings = await mainPluginDevice.getSettings() as Setting[];
            const scoreThreshold = settings.find(setting => setting.key === 'scoreThreshold');

            this.storageSettings.putSetting('scoreThreshold', scoreThreshold?.value ?? 0.7);
        }

        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, this.console);
        this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
        this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();

        if (this.interfaces.includes(ScryptedInterface.VideoCamera)) {
            const detectionClasses = this.storageSettings.getItem('detectionClasses') ?? [];
            for (const detectionClass of detectionClasses) {
                const key = `${detectionClass}:scoreThreshold`;
                settings.push({
                    key,
                    title: `Score threshold for ${detectionClass}`,
                    subgroup: 'Detection',
                    type: 'number',
                    value: this.storageSettings.getItem(key as any)
                });
            }
        }

        const mainPluginDevice = systemManager.getDeviceByName('Homeassistant utilities') as unknown as Settings;
        const mainPluginSetttings = await mainPluginDevice.getSettings() as Setting[];
        const activeNotifiers = (mainPluginSetttings.find(setting => setting.key === 'notifiers')?.value || []) as string[];

        activeNotifiers.forEach(notifierId => {
            const notifierDevice = systemManager.getDeviceById(notifierId);
            const key = `notifier-${notifierId}:disabled`;
                settings.push({
                    key,
                    title: `Disable notifier ${notifierDevice.name}`,
                    subgroup: 'Notifier',
                    type: 'boolean',
                    value: JSON.parse(this.storageSettings.getItem(key as any) ?? 'false'),
                });
        })

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}

export default class HomeAssistantUtilitiesProvider extends ScryptedDeviceBase implements MixinProvider, HttpRequestHandler {
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
    private doorbellDevices: string[] = [];
    private init = false;

    storageSettings = new StorageSettings(this, {
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
        scryptedToken: {
            title: 'Scrypted token',
            type: 'string',
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
        // scryptedTokenEntity: {
        //     title: 'Scrypted token entityId',
        //     description: 'Where the scrypted token is stored, the prefix is enough',
        //     type: 'string',
        //     defaultValue: 'sensor.scrypted_token_'
        // },
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
        accessToken: {
            title: 'HAPersonal access token',
            type: 'string',
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
            subgroup: 'Entities',
            readonly: true,
            multiple: true,
        },
        fetchedRooms: {
            group: 'Fetched entities',
            title: '',
            subgroup: 'Rooms',
            readonly: true,
            multiple: true,
        },
        minDelayTime: {
            group: 'Notifier',
            title: 'Minimum notification delay',
            description: 'Minimum amount of time to wait until a notification is sent from the same camera, in seconds',
            type: 'number',
            defaultValue: 30,
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
        ignoreSnapshotIfNoNotifiers: {
            group: 'Notifier',
            title: 'Skip snapshot when no devices active for notifications',
            type: 'boolean',
        },
        // TEXTS
        detectionTimeText: {
            group: 'Texts',
            title: 'Detection time',
            type: 'string',
            description: 'Expression used to render the time shown in notifications. Available arguments ${time}',
            defaultValue: 'new Date(${time}).toLocaleString()'
        },
        motionDetectedText: {
            group: 'Texts',
            title: 'Motion',
            type: 'string',
            description: 'Expression used to render the text when a motion is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: 'Motion detected in ${room}'
        },
        personDetectedText: {
            group: 'Texts',
            title: 'Person detected text',
            type: 'string',
            description: 'Expression used to render the text when a person is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: 'Person detected in ${room}'
        },
        familiarDetectedText: {
            group: 'Texts',
            title: 'Familiar detected text',
            type: 'string',
            description: 'Expression used to render the text when a familiar is detected. Available arguments ${room} ${time} ${person} ${nvrLink}',
            defaultValue: '${person} detected in ${room}'
        },
        animalDetectedText: {
            group: 'Texts',
            title: 'Animal detected text',
            type: 'string',
            description: 'Expression used to render the text when an animal is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: 'Animal detected in ${room}'
        },
        vehicleDetectedText: {
            group: 'Texts',
            title: 'Vehicle detected text',
            type: 'string',
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} ${time} ${nvrLink}',
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
            description: 'Expression used to render the text when a binary sensor opens. Available arguments ${room} $[time} ${nvrLink}',
            defaultValue: 'Door/window opened in ${room}'
        },
        snapshotWidth: {
            group: 'Notifier',
            title: 'Snapshot width',
            type: 'number',
            defaultValue: 1280
        },
        snapshotHeight: {
            group: 'Notifier',
            title: 'Snapshot height',
            type: 'number',
            defaultValue: 720
        },
        sendVideoclip: {
            group: 'Notifier',
            title: 'Send videoclip',
            type: 'boolean',
            defaultValue: false,
            hide: true
        },
        videoclipDuration: {
            group: 'Notifier',
            title: 'Videoclip duration',
            type: 'number',
            defaultValue: 10,
            hide: true
        },
        motionActiveDuration: {
            group: 'Detection',
            title: 'Motion active duration',
            description: 'How many seconds the motion sensors should stay active',
            type: 'number',
            defaultValue: 30,
        },
        requireScryptedNvrDetections: {
            group: 'Detection',
            title: 'Require Scrypted Detections',
            description: 'When enabled, this sensor will ignore onboard camera detections.',
            type: 'boolean',
            defaultValue: true,
        },
        scoreThreshold: {
            title: 'Default score threshold',
            group: 'Detection',
            type: 'number',
            defaultValue: 0.7,
        },
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
        // this.storageSettings.settings.scryptedTokenEntity.onPut = () => start();
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
        this.storageSettings.settings.pluginEnabled.onPut = async () => {
            await this.startEventsListeners();
        };
        this.storageSettings.settings.mqttHost.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttUsename.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttPassword.onPut = () => this.setupMqttClient();
        this.storageSettings.settings.mqttActiveEntitiesTopic.onPut = () => this.setupMqttClient();

        this.setupMqttClient();
        this.initDevices().then(() => start()).catch(console.log);;
        this.startCheckAlwaysActiveDevices().then().catch(console.log);
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
            if (this.storageSettings.getItem('pluginEnabled')) {
                for (const device of this.getElegibleDevices()) {
                    const deviceName = device.name;
                    const settings = await device.getSettings();

                    const alwaysZones = (settings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value as string[]) ?? [];
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

                if (this.storageSettings.getItem('alwaysActiveDevicesForNotifications')?.toString() !== forcedActiveDevices.toString()) {
                    this.console.log('Restarting loop to adjust the devices listeners');
                    this.storageSettings.putSetting('alwaysActiveDevicesForNotifications', forcedActiveDevices);
                }
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
        const doorbellDevices: string[] = [];
        const haEntities: string[] = [];
        const deviceHaEntityMap: Record<string, string> = {};
        const haEntityDeviceMap: Record<string, string> = {};
        const deviceVideocameraMap: Record<string, string> = {};
        const deviceRoomMap: Record<string, string> = {};
        const deviceTypeMap: Record<string, ScryptedDeviceType> = {};

        const cloudPlugin = systemManager.getDeviceByName('Scrypted Cloud') as unknown as Settings;
        const oauthUrl = await (cloudPlugin as any).getOauthUrl();
        const url = new URL(oauthUrl);
        const serverId = url.searchParams.get('server_id');
        this.storageSettings.putSetting('serverId', serverId);
        this.console.log(`Server id found: ${serverId}`);

        const allDevices = this.getElegibleDevices();
        for (const device of allDevices) {
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

                if (deviceType === ScryptedDeviceType.Camera || deviceType === ScryptedDeviceType.Doorbell) {
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
                        const sensorName = sensorDevice.name;
                        doorbellDevices.push(sensorName);
                        deviceVideocameraMap[sensorName] = deviceName;
                    }
                }
            }
        }

        const sensorsNotMapped = allDevices.filter(device => device.type === ScryptedDeviceType.Sensor && !deviceVideocameraMap[device.name])
            .map(sensor => sensor.name);

        if (sensorsNotMapped.length) {
            this.console.log(`Following binary sensors are not mapped to any camera yet: ${sensorsNotMapped}`);
        }

        this.storageSettings.settings.activeDevicesForNotifications.choices = devices;
        this.storageSettings.settings.activeDevicesForReporting.choices = devices;
        this.storageSettings.settings.testDevice.choices = devices;
        this.deviceHaEntityMap = deviceHaEntityMap;
        this.haEntityDeviceMap = haEntityDeviceMap;
        this.deviceVideocameraMap = deviceVideocameraMap;
        this.deviceTypeMap = deviceTypeMap;
        this.deviceRoomMap = deviceRoomMap;
        this.doorbellDevices = doorbellDevices;

        const textSettings = Object.entries(this.storageSettings.settings).filter(([_, setting]) => setting.group === 'Texts').map(([key]) => key);
        this.storageSettings.settings.testMessage.choices = textSettings;

        const mqttActiveEntitiesTopic = this.storageSettings.getItem('mqttActiveEntitiesTopic');
        if (mqttActiveEntitiesTopic) {
            this.mqttClient.subscribeToHaTopics(mqttActiveEntitiesTopic, (topic, message) => {
                if (topic === mqttActiveEntitiesTopic) {
                    this.init = true;
                    this.console.log(`Received update for ${mqttActiveEntitiesTopic} topic: ${JSON.stringify(message)}`);
                    this.syncHaEntityIds(message);
                }
            });
        } else {
            this.init = true;
        }
    }

    async getSettings() {
        const settings: Setting[] = await this.storageSettings.getSettings();

        const notifiers = this.storageSettings.getItem('notifiers') ?? [];
        const textSettings = settings.filter(setting => setting.group === 'Texts');
        const notificationSettings = settings.filter(setting => setting.group === 'Notifier')
            .filter(setting => ['snapshotWidth', 'snapshotHeight', 'videoclipDuration'].includes(setting.key));

        for (const notifierId of notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as ScryptedDeviceBase;
            const notifierName = notifier.name;

            textSettings.forEach(textSetting => {
                const key = `notifier:${notifierId}:${textSetting.key}`;
                settings.push({
                    ...textSetting,
                    value: this.storage.getItem(key),
                    key,
                    subgroup: `${notifierName}`
                });
            });

            notificationSettings.forEach(notificationSetting => {
                const key = `notifier:${notifierId}:${notificationSetting.key}`;
                settings.push({
                    ...notificationSetting,
                    value: this.storage.getItem(key),
                    key,
                    subgroup: `${notifierName}`
                });
            });

            // const disableVideoclipsKey = `notifier:${notifierId}:disableVideoclips`;
            // settings.push({
            //     key: disableVideoclipsKey,
            //     type: 'boolean',
            //     subgroup: `${notifierName}`,
            //     title: 'Disable videoclips',
            //     group: 'Notifier'
            // })
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

        let rooms: string[] = [];
        const roomNameMap: Record<string, string> = {};
        let entityIds: string[] = [];
        // let scryptedToken: string;

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

            // scryptedToken = entitiesResponse.data.find(ent => ent.entity_id.includes(this.storageSettings.getItem('scryptedTokenEntity')))?.state;
        } catch (e) {
            console.log(e);
        } finally {
            await this.storageSettings.putSetting('fetchedEntities', entityIds);
            await this.storageSettings.putSetting('fetchedRooms', rooms);
            // await this.storageSettings.putSetting('scryptedToken', scryptedToken);
            this.roomNameMap = roomNameMap;
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        return [
            ScryptedInterface.Camera,
            ScryptedInterface.VideoCamera,
            ScryptedInterface.BinarySensor,
            ScryptedInterface.Lock
        ].some(int => interfaces.includes(int)) ?
            [
                ScryptedInterface.Settings,
            ] :
            undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new HomeAssistantUtilitiesMixin({
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

    private getAllowedDetectionFinder(deviceName: string, deviceSettings: Setting[]) {
        const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value as string[]) ?? [];
        const whitelistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:whitelistedZones')?.value as string[]) ?? [];
        const blacklistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:blacklistedZones')?.value as string[]) ?? [];
        const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value as string[]) ?? [];

        const requireScryptedNvrDetections = this.storageSettings.getItem('requireScryptedNvrDetections');
        const scoreThreshold = this.storageSettings.getItem('scoreThreshold');

        return (detections: ObjectDetectionResult[]) => {
            const filterByClassNameAndScore = detections.filter(detection => {
                if (requireScryptedNvrDetections && !detection.boundingBox) {
                    return false;
                }

                return detectionClasses.some(detectionClass => {
                    if (detectionClass !== detection.className) {
                        return false;
                    }
                    const detectionClassScoreThreshold = deviceSettings.find(setting => setting.key === `homeassistantMetadata:${detectionClass}:scoreThreshold`)?.value as number;

                    const scoreToUse = detectionClassScoreThreshold || scoreThreshold || 0.7;

                    if (detection.score > scoreToUse) {
                        // this.console.log(`[${deviceName}] Found a detection for class ${detectionClass} with score ${detection.score} (min ${scoreToUse}). Override is ${detectionClassScoreThreshold}`);
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
                    this.console.log(`[${deviceName}] Found detection: ${JSON.stringify({
                        detection,
                        blacklistedZones,
                        whitelistedZones,
                        alwaysZones,
                        detectionClasses
                    })}`);
                    return true;
                }
            })
        }
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
        props: {
            device: DeviceInterface,
            detectionTime: number,
            detection?: ObjectDetectionResult,
            notifierId: string,
            externalUrl: string,
            forceKey?: string,
        }
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

        if (forceKey) {
            textToUse = this.storageSettings.getItem(`notifier:${notifierId}:${forceKey}` as any) || this.storageSettings.getItem(forceKey as any);
        } else {
            const motionDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:motionDetectedText` as any) || this.storageSettings.getItem('motionDetectedText');
            const personDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:personDetectedText` as any) || this.storageSettings.getItem('personDetectedText');
            const familiarDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:familiarDetectedText` as any) || this.storageSettings.getItem('familiarDetectedText');
            const animalDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:animalDetectedText` as any) || this.storageSettings.getItem('animalDetectedText');
            const vehicleDetectedText = this.storageSettings.getItem(`notifier:${notifierId}:vehicleDetectedText` as any) || this.storageSettings.getItem('vehicleDetectedText');
            const doorbellText = this.storageSettings.getItem(`notifier:${notifierId}:doorbellText` as any) || this.storageSettings.getItem('doorbellText');
            const doorWindowText = this.storageSettings.getItem(`notifier:${notifierId}:doorWindowText` as any) || this.storageSettings.getItem('doorWindowText');

            if (isDoorbelButton) {
                textToUse = doorbellText;
            } else if (isBooleanSensor) {
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
            .replace('${room}', roomName);
    }

    async startMotionTimeoutAndPublish(
        props: {
            device: ScryptedDeviceBase & Settings,
            detection?: ObjectDetectionResult,
            image?: MediaObject,
            fullSizeImage?: MediaObject,
            externalUrl: string,
        }
    ) {
        const { detection, device, externalUrl, image } = props;
        const deviceSettings = await device.getSettings();
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
        this.mqttClient.publishDeviceState(device, true, info);
        this.storageSettings.putSetting('deviceLastSnapshotMap', {
            ...this.storageSettings.getItem('deviceLastSnapshotMap') ?? {},
            [name]: { imageUrl }
        });

        const currentTimeout = this.deviceTimeoutMap[id];
        if (currentTimeout) {
            clearTimeout(currentTimeout);
        }

        this.deviceTimeoutMap[id] = setTimeout(() => {
            this.console.log(`[${name}] End motion timeout`);
            this.mqttClient.publishDeviceState(device, false);
        }, motionDuration * 1000);
    }

    checkDeviceLastDetection(deviceName: string, deviceSettings: Setting[]) {
        const currentTime = new Date().getTime();
        const mainMinDelay = this.storageSettings.getItem('minDelayTime') as number;
        const deviceMinDelay = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:minDelayTime')?.value as number;

        const minDelay = deviceMinDelay || mainMinDelay || 30;
        const lastDetection = this.deviceLastDetectionMap[deviceName];
        let delayDone;
        if (lastDetection && (currentTime - lastDetection) < 1000 * minDelay) {
            delayDone = false;
        } else {
            delayDone = true;
        }

        return { delayDone, currentTime }
    }

    // private async checkVideoclipEnabled(deviceSettings: Setting[], notifierId: string) {
    //     const isMainEnabled = this.storageSettings.values.sendVideoclip;

    //     if (isMainEnabled) {
    //         const notifierDisabled = this.storageSettings.getItem(`notifier:${notifierId}:disableVideoclips` as any) as boolean;

    //         if (!notifierDisabled) {
    //             const deviceDisabled = deviceSettings.find(setting => setting.key === 'disableVideoclips')?.value as boolean;

    //             if (!deviceDisabled) {
    //                 return true;
    //             }
    //         }
    //     }

    //     return false;
    // }

    async notifyCamera(props: {
        srcDevice: DeviceInterface,
        notifierId: string,
        time: number,
        image?: MediaObject,
        detection?: ObjectDetectionResult
        forceMessageKey?: string
    }) {
        const { srcDevice, notifierId, time, image: imageParent, detection, forceMessageKey } = props;

        const device = await this.getCameraDevice(srcDevice);

        if (!device) {
            this.console.log(`[${srcDevice.name}] There is no camera linked to the device ${srcDevice.name}`);
            return;
        }

        const deviceName = device.name
        const deviceSettings = await device.getSettings();
        const srcDeviceSettings = await srcDevice.getSettings();
        const disableNotifierSetting = srcDeviceSettings.find(setting => setting.key ===  `homeassistantMetadata:notifier-${notifierId}:disabled`)?.value ?? false;
        const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

        if(disableNotifierSetting) {
            this.console.log(`[${srcDevice.name}] Notifier ${notifier.name} forced disabled.`);
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

        // const shouldSendVideoClip = await this.checkVideoclipEnabled(deviceSettings, notifierId);
        // let imageUrl: string;
        // let videoUrl: string;

        // try {
        // if (shouldSendVideoClip) {
        //     this.console.log(`Videoclip should be sent. Following was found: ${videClipFound}`);
        //     const videoClipMo = await cameraDevice.getVideoClip(videClipFound.videoId);

        //     if (videoClipMo) {
        //         videoUrl = await mediaManager.convertMediaObjectToUrl(videoClipMo, 'video/mp4');
        //     }
        // }

        // } catch (e) {
        //     this.console.log(`[${deviceName}] Error trying to fetch videoClip ${JSON.stringify(videClipFound)}`, e);
        // }

        // try {
        //     if (!videoUrl && image) {
        //         imageUrl = await mediaManager.convertMediaObjectToUrl(image, 'image/jpeg');
        //     }
        // } catch (e) {
        //     this.console.log(`[${deviceName}] Error trying to fetch image ${JSON.stringify(image)}`, e);

        // }

        // this.console.log(`[${deviceName}] The media sent will be the following: ${JSON.stringify({
        //     videClipFound,
        //     shouldSendVideoClip: shouldSendVideoClip,
        //     imageUrl,
        //     videoUrl,
        // })}`)

        const snapshotWidth = this.storageSettings.getItem('snapshotWidth') as number;
        const snapshotHeight = this.storageSettings.getItem('snapshotHeight') as number;
        const notifierSnapshotWidth = this.storageSettings.getItem(`notifier:${notifierId}:snapshotWidth` as any) || snapshotWidth;
        const notifiernapshotHeight = this.storageSettings.getItem(`notifier:${notifierId}:snapshotHeight` as any) || snapshotHeight;

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];
        let image = imageParent;

        if (device.takePicture && (!image || notifierSnapshotWidth !== snapshotWidth || notifiernapshotHeight !== snapshotHeight)) {
            image = await device.takePicture({
                reason: 'event',
                picture: {
                    height: notifiernapshotHeight,
                    width: notifierSnapshotWidth,
                },
            });
        }

        const notifierOptions: NotifierOptions = {
            body: message,
            data: {
                ha: {
                    // image: imageUrl,
                    // video: videoUrl,
                    url: haUrl,
                    clickAction: haUrl,
                    actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined,
                }
            },
        }

        this.console.log(`[${deviceName}] Sending notification to ${notifier.name}: ${JSON.stringify({
            ...notifierOptions,
            snapshotHeight: notifiernapshotHeight || snapshotHeight,
            snapshotWidth: notifierSnapshotWidth || snapshotWidth,
        })}`);

        await notifier.sendNotification((srcDevice ?? device).name, notifierOptions, image);
    }

    async executeNotificationTest() {
        const testDeviceName = this.storageSettings.getItem('testDevice') as string;
        const testNotifier = this.storageSettings.getItem('testNotifier') as ScryptedDevice;
        const testMessageKey = this.storageSettings.getItem('testMessage') as string;

        this.console.log(`[TEST] Start notification test for ${testNotifier.name} - ${testDeviceName} with key ${testMessageKey}`);

        if (testDeviceName && testMessageKey && testNotifier) {
            const currentTime = new Date().getTime();
            const testDevice = systemManager.getDeviceByName(testDeviceName) as unknown as DeviceInterface;
            const notifierId = testNotifier.id;

            this.console.log(`[TEST] Sending test notification to ${testNotifier.name} - ${testDevice.name} with key ${testMessageKey}}`);

            this.notifyCamera({ srcDevice: testDevice, notifierId, time: currentTime, forceMessageKey: testMessageKey })
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
        const deviceType = this.deviceTypeMap[deviceName];

        const isCamera = [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType);
        const isBooleanSensor = deviceType === ScryptedDeviceType.Sensor;

        const cameraDevice = await this.getCameraDevice(device);
        const isDoorbelButton = cameraDevice && isBooleanSensor && this.deviceTypeMap[cameraDevice.name] === ScryptedDeviceType.Doorbell;

        return {
            isCamera,
            isBooleanSensor,
            cameraDevice,
            isDoorbelButton,
            roomName: this.roomNameMap[room] ?? room
        }
    }

    async startEventsListeners() {
        if (!this.init) {
            this.console.log(`Plugin not initialized yed, waiting`);

            return;
        }

        const pluginEnabled = this.storageSettings.getItem('pluginEnabled') as boolean;

        if (!pluginEnabled) {
            this.console.log(`Plugin disabled. Clearing all the active listeners`);
            this.activeListeners.forEach(listener => listener?.listener?.removeListener());

            return;
        }

        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];
        const alwaysActiveDevicesForNotifications = this.storageSettings.getItem('alwaysActiveDevicesForNotifications') as string[];
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
            this.console.log(`Devices: ${JSON.stringify({
                activeDevicesForNotifications,
                alwaysActiveDevicesForNotifications,
                activeDevicesForReporting,
                allActiveDevices,
            })}`);
            for (const deviceName of allActiveDevices) {
                try {
                    const device = systemManager.getDeviceByName(deviceName) as unknown as DeviceInterface;
                    const deviceId = device.id;
                    const deviceSettings = await device.getSettings();
                    if (activeDevicesForReporting.includes(deviceName)) {
                        this.mqttClient?.setupDeviceAutodiscovery(device, deviceName, deviceSettings);
                    }
                    const findAllowedDetection = this.getAllowedDetectionFinder(deviceName, deviceSettings)

                    const {
                        cameraDevice,
                        isBooleanSensor,
                        isCamera,
                        isDoorbelButton,
                    } = await this.getDeviceFlags(device);

                    const event = isCamera ? 'ObjectDetector' : 'BinarySensor';
                    const listener = systemManager.listenDevice(deviceId, event, async (_, __, data) => {
                        const { delayDone, currentTime } = this.checkDeviceLastDetection(deviceName, deviceSettings);
                        if (!delayDone && !isDoorbelButton) {
                            return;
                        }

                        const foundDetection = isCamera ? findAllowedDetection(data.detections) : undefined;

                        // TODO - Add configuration to check the event data
                        if ((isCamera && foundDetection) || ((isBooleanSensor || isDoorbelButton) && data)) {
                            const isNotifierActive = allActiveDevicesForNotifications.includes(deviceName);
                            this.deviceLastDetectionMap[isDoorbelButton ? cameraDevice.name : deviceName] = currentTime;
                            const notifiers = this.storageSettings.getItem('notifiers') as string[];
                            const ignoreSnapshotIfNoNotifiers = this.storageSettings.getItem('ignoreSnapshotIfNoNotifiers') as boolean;
                            const snapshotWidth = this.storageSettings.getItem('snapshotWidth') as number;
                            const snapshotHeight = this.storageSettings.getItem('snapshotHeight') as number;

                            // const videoclipDurationInSeconds = (deviceSettings.find(setting => setting.key === 'videoclipDuration')?.value || this.storageSettings.getItem('videoclipDuration') || 10) as number;
                            // const videClipFound = cameraDevice.getVideoClips && (await cameraDevice.getVideoClips({ startTime: currentTime - (videoclipDurationInSeconds * 60 * 1000) }))?.[0];
                            let image = isNotifierActive || !ignoreSnapshotIfNoNotifiers ? (await cameraDevice.takePicture({
                                reason: 'event',
                                picture: {
                                    height: snapshotHeight,
                                    width: snapshotWidth,
                                },
                            })) : undefined;

                            this.console.log(`[${deviceName}] Received event ${event}: ${JSON.stringify(data)}. ${JSON.stringify({
                                isCamera,
                                isBooleanSensor,
                                isDoorbelButton,
                                linkedCameraName: cameraDevice.name,
                                event,
                                snapshotHeight,
                                snapshotWidth,
                                // videClipFound,
                            })}`);

                            const { externalUrl, haUrl } = this.getUrls(cameraDevice.id, currentTime);
                            this.console.log(`[${deviceName}] URLs built: ${JSON.stringify({
                                externalUrl,
                                haUrl,
                            })}`);

                            if (activeDevicesForReporting.includes(deviceName)) {
                                this.console.log(`[${deviceName}] Starting startMotionTimeoutAndPublish`);
                                await this.startMotionTimeoutAndPublish({
                                    device,
                                    detection: foundDetection,
                                    image,
                                    externalUrl,
                                });
                            } else {
                                this.console.log(`[${deviceName}] Skip startMotionTimeoutAndPublish`);
                            }

                            if (isNotifierActive) {
                                this.console.log(`[${deviceName}] Sending image to ${notifiers.length} notifiers`);
                                for (const notifierId of notifiers) {
                                    try {
                                        await this.notifyCamera({ srcDevice: device, notifierId, time: currentTime, image, detection: foundDetection });
                                    } catch (e) {
                                        this.console.log(`[${deviceName}] Error on notifier ${notifierId}`, e);
                                    }
                                }
                            } else {
                                this.console.log(`[${deviceName}] Skip notify`);
                            }
                        }
                    });
                    this.activeListeners.push({ listener, deviceName });
                } catch (e) {
                    this.console.log(`[${deviceName}] Error in main loop`, e);
                }
            }
        } catch (e) {
            this.console.log(e);
        }
    }


}