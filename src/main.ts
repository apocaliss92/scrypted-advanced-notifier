import sdk, { Camera, EventDetails, EventListenerRegister, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, VideoClips, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { sortBy, uniqBy } from 'lodash';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import MqttClient from './mqtt-client';

const { systemManager, mediaManager, endpointManager } = sdk;

type DeviceInterface = Camera & ScryptedDeviceBase & Settings;

const getWebookSpecs = async () => {
    const lastSnapshot = 'last';

    return {
        lastSnapshot,
    }
}

const classnamePrio = {
    face: 1,
    plate: 1,
    person: 3,
    vehicle: 3,
    animal: 3,
    package: 3,
    motion: 5,
}

const defaultDetectionClasses = [
    'motion',
    'person',
    'vehicle',
    'animal',
    'package',
    'face',
    'plate'
]

const detectionClassesToPublish = [
    'motion',
    'person',
    'vehicle',
    'animal',
]

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

const getDefaultEntityId = (name: string) => {
    const convertedName = name?.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_') ?? 'not_set';

    return `binary_sensor.${convertedName}_triggered`;
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
            defaultValue: getDefaultEntityId(this.name)
        },
        haDeviceClass: {
            title: 'Device class',
            type: 'string',
            subgroup: 'Metadata',
            defaultValue: 'motion'
        },
        // DETECTION
        linkedCamera: {
            title: 'Linked camera',
            type: 'device',
            subgroup: 'Detection',
            deviceFilter: `(type === '${ScryptedDeviceType.Camera}')`,
            hide: true,
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
        requireScryptedNvrDetections: {
            subgroup: 'Detection',
            title: 'Require Scrypted Detections',
            description: 'When enabled, this sensor will ignore onboard camera detections.',
            type: 'boolean',
            defaultValue: true,
        },
        scoreThreshold: {
            title: 'Default score threshold',
            subgroup: 'Detection',
            type: 'number',
            defaultValue: 0.7,
            hide: true,
        },
        // NOTIFIER
        triggerAlwaysNotification: {
            title: 'Always enabled',
            description: 'Enable to always check this entity for notifications, regardles of it\'s activation',
            subgroup: 'Notifier',
            type: 'boolean',
            defaultValue: false,
        },
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
            defaultValue: 30,
        },
        skipDoorbellNotifications: {
            subgroup: 'Notifier',
            title: 'Skip doorbell notifications',
            type: 'boolean',
            defaultValue: false,
            hide: true,
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
                const zonesSetting = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:zones').test(setting.key));

                return {
                    choices: zonesSetting?.value ?? []
                }
            }
            this.storageSettings.settings.whitelistedZones.onGet = async () => await getZones();
            this.storageSettings.settings.blacklistedZones.onGet = async () => await getZones();
            this.storageSettings.settings.alwaysZones.onGet = async () => await getZones();
            this.storageSettings.settings.detectionClasses.onGet = async () => {
                const settings = await this.mixinDevice.getSettings();
                const detectionClasses = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:allowList').test(setting.key));
                const choices = detectionClasses?.value ?? defaultDetectionClasses;

                return {
                    choices,
                }
            };

            this.storageSettings.settings.whitelistedZones.hide = false;
            this.storageSettings.settings.blacklistedZones.hide = false;
            this.storageSettings.settings.alwaysZones.hide = false;
            this.storageSettings.settings.detectionClasses.hide = false;
            this.storageSettings.settings.scoreThreshold.hide = false;
            this.storageSettings.settings.skipDoorbellNotifications.hide = this.type !== ScryptedDeviceType.Doorbell;

            this.initValues().then().catch(this.console.log)
        }

        if ([ScryptedInterface.BinarySensor, ScryptedInterface.Lock].some(int => this.interfaces.includes(int))) {
            this.storageSettings.settings.linkedCamera.hide = false;
        }
    }

    async initValues() {
        const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebookUrls(this.name, console);
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
    private mqttClient: MqttClient;
    private deviceTimeoutMap: Record<string, EventListenerRegister> = {};
    private doorbellDevices: string[] = [];
    private mqttInit = false;
    private firstCheckAlwaysActiveDevices = false;
    private initListener: NodeJS.Timeout;
    private deviceLastDetectionsUpdate: Record<string, number> = {};
    private mainLogger: Console;
    private deviceLoggerMap: Record<string, Console> = {};
    private autodiscoveryPublishedMap: Record<string, boolean> = {};

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
            group: 'HA fetched data',
            title: 'Entity regex patterns',
            description: 'Regex to filter out entities fetched',
            type: 'string',
            multiple: true,
        },
        fetchHaEntities: {
            group: 'HA fetched data',
            title: 'Fetch entities from HA',
            type: 'button',
            onPut: async () => await this.fetchHomeassistantData()
        },
        fetchedEntities: {
            group: 'HA fetched data',
            title: '',
            subgroup: 'Entities',
            readonly: true,
            multiple: true,
        },
        fetchedRooms: {
            group: 'HA fetched data',
            title: '',
            subgroup: 'Rooms',
            readonly: true,
            multiple: true,
        },
        fetchedRoomNames: {
            group: 'HA fetched data',
            json: true,
            hide: true,
            defaultValue: {}
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

        const useHaPluginCredentials = Boolean(this.storageSettings.getItem('useHaPluginCredentials') ?? false);
        this.storageSettings.settings.accessToken.hide = useHaPluginCredentials;
        this.storageSettings.settings.address.hide = useHaPluginCredentials;
        this.storageSettings.settings.protocol.hide = useHaPluginCredentials;

        this.storageSettings.settings.address.onPut = async () => await start();
        this.storageSettings.settings.protocol.onPut = async () => await start();
        this.storageSettings.settings.accessToken.onPut = async () => await start();
        this.storageSettings.settings.nvrUrl.onPut = async () => await start();
        this.storageSettings.settings.domains.onPut = async () => await start();
        this.storageSettings.settings.useHaPluginCredentials.onPut = async (_, isOn) => {
            this.storageSettings.settings.accessToken.hide = isOn;
            this.storageSettings.settings.address.hide = isOn;
            this.storageSettings.settings.protocol.hide = isOn;
            await start();
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
        this.storageSettings.settings.mqttHost.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttUsename.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttPassword.onPut = async () => await this.setupMqttClient();
        this.storageSettings.settings.mqttActiveEntitiesTopic.onPut = async () => await this.setupMqttClient();

        this.initFlow().then().catch(this.getLogger().log);
    }

    async initFlow() {
        try {
            await this.initPluginSettings();
            await this.setupMqttClient();
            await this.startRefreshDeviceData();

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
        const mqttHost = this.storageSettings.getItem('mqttHost');
        const mqttUsename = this.storageSettings.getItem('mqttUsename');
        const mqttPassword = this.storageSettings.getItem('mqttPassword');
        const mqttActiveEntitiesTopic = this.storageSettings.getItem('mqttActiveEntitiesTopic');

        if (!mqttHost || !mqttUsename || !mqttPassword) {
            this.getLogger().log('MQTT params not provided');
        }

        try {
            this.mqttClient = new MqttClient(mqttHost, mqttUsename, mqttPassword);

            if (mqttActiveEntitiesTopic) {
                this.mqttClient.subscribeToHaTopics(mqttActiveEntitiesTopic, this.getLogger(), (topic, message) => {
                    if (topic === mqttActiveEntitiesTopic) {
                        this.mqttInit = true;
                        this.getLogger().log(`Received update for ${mqttActiveEntitiesTopic} topic: ${JSON.stringify(message)}`);
                        this.syncHaEntityIds(message);
                    }
                });

                setTimeout(() => {
                    if (!this.mqttInit) {
                        this.getLogger().log(`No message received on topic ${mqttActiveEntitiesTopic}. Forcing init`);
                        this.mqttInit = true;
                    }
                }, 10000);

                // systemManager.listen((async (eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) => {
                //     const deviceName = eventSource.name;
                //     if(eventSource && this.isDeviceElegible(eventSource as unknown as DeviceInterface) && !this.autodiscoveryPublishedMap[deviceName]) {
                //         if (activeDevicesForReporting.includes(deviceName) && !this.autodiscoveryPublishedMap[deviceName]) {
                //             await this.mqttClient?.setupDeviceAutodiscovery({
                //                 device,
                //                 deviceSettings,
                //                 detectionClasses: detectionClassesToPublish,
                //                 console: deviceLogger,
                //                 localIp: this.storageSettings.values.localIp,
                //             });
                //             this.autodiscoveryPublishedMap[deviceName] = true;
                //         }
                //     }
                // }));
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

            const forcedActiveDevices: string[] = [];
            const pluginEnabled = this.storageSettings.getItem('pluginEnabled');
            if (pluginEnabled) {
                for (const device of this.getElegibleDevices()) {
                    const deviceName = device.name;
                    const settings = await device.getSettings();

                    const alwaysActive = (settings.find(setting => setting.key === 'homeassistantMetadata:triggerAlwaysNotification')?.value as boolean) ?? false;
                    if (alwaysActive) {
                        forcedActiveDevices.push(deviceName);
                    } else {
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
                }

                if (this.storageSettings.getItem('alwaysActiveDevicesForNotifications')?.toString() !== forcedActiveDevices.toString()) {
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

        const textSettings = Object.entries(this.storageSettings.settings).filter(([_, setting]) => setting.group === 'Texts').map(([key]) => key);
        this.storageSettings.settings.testMessage.choices = textSettings;
    }

    private async refreshDevicesLinks() {
        const devices: string[] = [];
        const doorbellDevices: string[] = [];
        const haEntities: string[] = [];
        const deviceHaEntityMap: Record<string, string> = {};
        const haEntityDeviceMap: Record<string, string> = {};
        const deviceVideocameraMap: Record<string, string> = {};
        const deviceRoomMap: Record<string, string> = {};
        const deviceTypeMap: Record<string, ScryptedDeviceType> = {};

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
                deviceTypeMap[deviceName] = deviceType;

                deviceHaEntityMap[deviceName] = haEntityId;
                haEntityDeviceMap[haEntityId] = deviceName;

                if (deviceType === ScryptedDeviceType.Camera || deviceType === ScryptedDeviceType.Doorbell) {
                    const nearbySensors = settings.find(setting => setting.key === 'recording:nearbySensors')?.value as string[] ?? [];
                    const nearbyLocks = settings.find(setting => setting.key === 'recording:nearbyLocks')?.value as string[] ?? [];

                    const linkedSensors = [...nearbySensors, ...nearbyLocks];

                    if (linkedSensors.length) {
                        for (const sensorId of linkedSensors) {
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
        this.deviceTypeMap = deviceTypeMap;
        this.deviceRoomMap = deviceRoomMap;
        this.doorbellDevices = doorbellDevices;
    }

    async getSettings() {
        const settings: Setting[] = await this.storageSettings.getSettings();

        const notifiers = this.storageSettings.getItem('notifiers') ?? [];
        const textSettings = settings.filter(setting => setting.group === 'Texts');

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

            const widthKey = `notifier:${notifierId}:snapshotWidth`;
            settings.push({
                title: 'Snapshot width',
                group: 'Notifier',
                subgroup: `${notifierName}`,
                type: 'number',
                value: this.storage.getItem(widthKey) || 1280,
                key: widthKey,
            });

            const heightKey = `notifier:${notifierId}:snapshotHeight`;
            settings.push({
                title: 'Snapshot height',
                group: 'Notifier',
                subgroup: `${notifierName}`,
                type: 'number',
                value: this.storage.getItem(heightKey) || 720,
                key: heightKey,
            });
        }

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

    private getAllowedDetectionFinder(device: DeviceInterface, deviceSettings: Setting[]) {
        const deviceName = device.name;
        const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value ?? []) as string[];
        const whitelistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:whitelistedZones')?.value ?? []) as string[];
        const blacklistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:blacklistedZones')?.value ?? []) as string[];
        const requireScryptedNvrDetections = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:requireScryptedNvrDetections')?.value as boolean) ?? true;
        const scoreThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:scoreThreshold')?.value as number) || 0.7;
        const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value ?? []) as string[];
        const deviceLogger = this.getDeviceLogger(device);

        const pickElegibleDetections = (detections: ObjectDetectionResult[]) => {
            let relevantDetections: ObjectDetectionResult[] = [];

            if (detections?.length) {
                const sortedDetectionsByPriority = sortBy(detections, (detection) => detection.className ? classnamePrio[detection.className] : 100);
                deviceLogger.debug(`Detections ordered by priority: ${JSON.stringify(sortedDetectionsByPriority)}. Originals: ${JSON.stringify(detections)}`);

                relevantDetections = sortedDetectionsByPriority.filter(detection => {
                    if (requireScryptedNvrDetections && !detection.boundingBox) {
                        return false;
                    }

                    const scoreToUse = deviceSettings.find(setting => setting.key === `homeassistantMetadata:${detection.className}:scoreThreshold`)?.value as number
                        || scoreThreshold;

                    deviceLogger.debug(`Found a detection for class ${detection.className} with score ${detection.score} (min ${scoreToUse}).`);
                    return detection.score > scoreToUse
                });
            }

            return relevantDetections;

        }

        const findAllowedDetection = (detections: ObjectDetectionResult[]) => {
            let foundDetection: ObjectDetectionResult | undefined;

            if (detections?.length) {
                const filterByClassName = detections.filter(detection => detectionClasses.includes(detection.className));

                foundDetection = filterByClassName.find(detection => {
                    const detectionZones = detection.zones;
                    const isAlwaysIncluded = alwaysZones.length ? detectionZones.some(zone => alwaysZones.includes(zone)) : false;
                    const isIncluded = whitelistedZones.length ? detectionZones.some(zone => whitelistedZones.includes(zone)) : true;
                    const isExcluded = blacklistedZones.length ? detectionZones.some(zone => blacklistedZones.includes(zone)) : false;

                    if (isAlwaysIncluded || (isIncluded && !isExcluded)) {
                        deviceLogger.debug(`Found detection: ${JSON.stringify({
                            detection,
                            blacklistedZones,
                            whitelistedZones,
                            alwaysZones,
                            detectionClasses
                        })}`);
                        return true;
                    }
                });
            }

            return foundDetection;

        }

        return { pickElegibleDetections, findAllowedDetection }
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
            device: DeviceInterface,
            detection?: ObjectDetectionResult,
            externalUrl: string,
            triggerTime: number,
            triggered: boolean,
            skipMotionCheck: boolean,
            b64Image?: string,
            imageUrl: string,
        }
    ) {
        const { detection, device, externalUrl, triggerTime, triggered, skipMotionCheck, b64Image, imageUrl } = props;
        const { id, name } = device;
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

        if (imageUrl) {
            this.storageSettings.putSetting('deviceLastSnapshotMap', {
                ...this.storageSettings.getItem('deviceLastSnapshotMap') ?? {},
                [name]: { imageUrl }
            });
        }

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

    checkDeviceLastDetection(deviceName: string, minDelay: number, currentTime: number) {

        const lastDetection = this.deviceLastDetectionMap[deviceName];
        let delayDetectionDone: boolean;
        if (lastDetection && (currentTime - lastDetection) < 1000 * minDelay) {
            delayDetectionDone = false;
        } else {
            delayDetectionDone = true;
        }

        return { delayDetectionDone }
    }

    async notifyCamera(props: {
        device: DeviceInterface,
        notifierId: string,
        time: number,
        image?: MediaObject,
        detection?: ObjectDetectionResult
        forceMessageKey?: string
    }) {
        const { device: srcDevice, notifierId, time, image: imageParent, detection, forceMessageKey } = props;

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
            image: imageParent
        });

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];

        const notifierOptions: NotifierOptions = {
            body: message,
            data: {
                ha: {
                    url: haUrl,
                    clickAction: haUrl,
                    actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined,
                }
            },
        }

        deviceLogger.log(`Sending notification to ${notifier.name}`);
        deviceLogger.debug(`${JSON.stringify(notifierOptions)}`);

        await notifier.sendNotification((srcDevice ?? device).name, notifierOptions, image);
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

            this.notifyCamera({ device: testDevice, notifierId, time: currentTime, forceMessageKey: testMessageKey })
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
            roomName: this.storageSettings.getItem('fetchedRoomNames')?.[room] ?? room
        }
    }

    async executeReport(props: { currentTime: number, deviceName: string, detections: ObjectDetectionResult[], device: DeviceInterface }) {
        const { currentTime, detections, device } = props;

        this.getDeviceLogger(device).debug(`Reporting ${detections.length} detections: ${JSON.stringify(detections)}`)
        await this.mqttClient.publishRelevantDetections({
            detections,
            device,
            triggerTime: currentTime,
            console: this.getDeviceLogger(device)
        })
    }

    private async getCameraSnapshot(props: { cameraDevice: DeviceInterface, snapshotWidth: number, snapshotHeight: number, image?: MediaObject }) {
        const { cameraDevice, snapshotWidth: snapshotWidthParent, snapshotHeight: snapshotHeightParent, image: imageParent } = props;
        const snapshotWidth = this.storageSettings.getItem('snapshotWidth') as number;
        const snapshotHeight = this.storageSettings.getItem('snapshotHeight') as number;

        let image = imageParent;

        if (!image || snapshotHeight !== snapshotHeightParent || snapshotWidth !== snapshotWidthParent) {
            image = await cameraDevice.takePicture({
                reason: 'event',
                picture: {
                    height: snapshotHeightParent,
                    width: snapshotWidthParent,
                },
            });
        }

        const imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
        const b64Image = imageBuffer.toString('base64');

        return { image, b64Image };
    }

    private clearListeners() {
        this.activeListeners.forEach(listener => listener?.listener?.removeListener());
        this.activeListeners = [];
    }

    private getLogger(): Console {
        if (!this.mainLogger) {
            const isDebugEnabled = this.storageSettings.getItem('debug');

            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || isDebugEnabled) {
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
            const isDebugEnabled = this.storageSettings.getItem('debug');

            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || isDebugEnabled) {
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

        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];
        const alwaysActiveDevicesForNotifications = this.storageSettings.getItem('alwaysActiveDevicesForNotifications') as string[];

        if (this.activeListeners.length) {
            this.getLogger().log(`Clearing ${this.activeListeners.length} listeners before starting a new loop: ${this.activeListeners.map(list => list.deviceName)}`);
            this.clearListeners();
        }

        try {
            const allActiveDevicesForNotifications = [...activeDevicesForNotifications, ...alwaysActiveDevicesForNotifications];

            const allActiveDevices: string[] = [];
            allActiveDevicesForNotifications.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));
            activeDevicesForReporting.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));

            this.getLogger().log(`Starting listeners for ${allActiveDevices.length} with ${allActiveDevicesForNotifications.length} for notifications and ${activeDevicesForReporting.length} for reporting`);
            this.getLogger().log(`Devices: ${JSON.stringify({
                activeDevicesForNotifications,
                alwaysActiveDevicesForNotifications,
                activeDevicesForReporting,
                allActiveDevices,
            })}`);

            const deviceReportLockMap: Record<string, boolean> = {};
            for (const deviceName of allActiveDevices) {
                const device = systemManager.getDeviceByName(deviceName) as unknown as DeviceInterface;
                const deviceLogger = this.getDeviceLogger(device);
                deviceReportLockMap[deviceName] = false;
                const isReportingActive = activeDevicesForReporting.includes(deviceName);

                try {
                    if (!device) {
                        this.console.log(`Device ${deviceName} is not available anymore`);
                        return;
                    }


                    const deviceId = device.id;
                    const deviceSettings = await device.getSettings();

                    if (activeDevicesForReporting.includes(deviceName) && !this.autodiscoveryPublishedMap[deviceName]) {
                        await this.mqttClient?.setupDeviceAutodiscovery({
                            device,
                            deviceSettings,
                            detectionClasses: detectionClassesToPublish,
                            console: deviceLogger,
                            localIp: this.storageSettings.values.localIp,
                        });
                        this.autodiscoveryPublishedMap[deviceName] = true;
                    }

                    const { findAllowedDetection, pickElegibleDetections } = this.getAllowedDetectionFinder(device, deviceSettings)

                    const {
                        cameraDevice,
                        isBooleanSensor,
                        isCamera,
                        isDoorbelButton,
                    } = await this.getDeviceFlags(device);

                    const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value as string[]) ?? [];
                    const isOnlyMotion = isCamera && detectionClasses.length === 1 && detectionClasses[0] === 'motion';
                    const event = isCamera ? isOnlyMotion ? ScryptedInterface.MotionSensor : ScryptedInterface.ObjectDetector : ScryptedInterface.BinarySensor;
                    const minDelay = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:minDelayTime')?.value as number ?? 30;

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

                        const relevantDetections = pickElegibleDetections(data.detections);

                        // deviceLogger.debug(`Event received: ${JSON.stringify(data)}. delayReportDone is ${delayReportDone} and delayDetectionDone is ${delayDetectionDone}`);

                        const isReportLocked = deviceReportLockMap[deviceName] && isReportingActive;

                        try {
                            if (!isReportLocked && relevantDetections.length > 0) {
                                deviceReportLockMap[deviceName] = true;
                                this.deviceLastDetectionsUpdate[deviceName] = currentTime;
                                deviceLogger.debug(`Starting executeReport, ${JSON.stringify(relevantDetections)}`);

                                await this.executeReport({ currentTime, device: cameraDevice, detections: relevantDetections, deviceName });
                            } else {
                                deviceLogger.debug(`Skip executeReport, ${JSON.stringify({ isReportLocked, isReportingActive, relevantDetections })}`);
                            }
                        } finally {
                            deviceReportLockMap[deviceName] = false;
                        }

                        const { delayDetectionDone } = this.checkDeviceLastDetection(deviceName, minDelay, currentTime);

                        const canContinue = delayDetectionDone || isDoorbelButton;
                        if (!canContinue) {
                            deviceLogger.debug(`Skip notifiers, ${JSON.stringify({ delayDetectionDone, isDoorbelButton, canContinue })}`);
                            return;
                        }

                        let foundDetection: ObjectDetectionResult;
                        if (isCamera && !isOnlyMotion) {
                            foundDetection = findAllowedDetection(relevantDetections ?? pickElegibleDetections(data.detections));
                        }

                        // TODO - Add configuration to check the event data
                        if (
                            isOnlyMotion ||
                            (isCamera && foundDetection) ||
                            ((isBooleanSensor || isDoorbelButton) && data)
                        ) {
                            deviceLogger.log(`Allowed detection found`);
                            deviceLogger.log(`${JSON.stringify({
                                isOnlyMotion,
                                isCamera,
                                foundDetection,
                                isBooleanSensor,
                                isDoorbelButton,
                            })}`);

                            const isNotifierActive = allActiveDevicesForNotifications.includes(deviceName);
                            this.deviceLastDetectionMap[isDoorbelButton ? cameraDevice.name : deviceName] = currentTime;
                            const notifiers = this.storageSettings.getItem('notifiers') as string[];

                            const { image, b64Image } = await this.getCameraSnapshot({ cameraDevice, snapshotHeight, snapshotWidth });
                            const imageUrl = image ? await mediaManager.convertMediaObjectToUrl(image, 'image/jpeg') : undefined;

                            const { externalUrl } = this.getUrls(cameraDevice.id, currentTime);

                            if (activeDevicesForReporting.includes(deviceName)) {
                                await this.startMotionTimeoutAndPublish({
                                    device,
                                    detection: foundDetection,
                                    imageUrl,
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
                                    try {
                                        await this.notifyCamera({ device, notifierId, time: currentTime, image, detection: foundDetection });
                                    } catch (e) {
                                        deviceLogger.log(`Error on notifier ${notifierId}`, e);
                                    }
                                }
                            } else {
                                deviceLogger.log(`Skip notify`);
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