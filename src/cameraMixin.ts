import sdk, { ScryptedDeviceType, NotifierOptions, MediaObject, ScryptedInterface, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getWebookUrls } from "./utils";

const { systemManager } = sdk;

const getDefaultEntityId = (name: string) => {
    const convertedName = name?.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_') ?? 'not_set';

    return `binary_sensor.${convertedName}_triggered`;
}

export class HomeAssistantUtilitiesCameraMixin extends SettingsMixinDeviceBase<any> implements Settings {
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
        useNvrDetections: {
            title: 'Use NVR detections',
            description: 'If enabled, the NVR notifications will be used. Make sure to extend the notifiers with this extension',
            type: 'boolean',
            subgroup: 'Detection',
            immediate: true,
            defaultValue: this.type === ScryptedDeviceType.Camera
        },
        useNvrImages: {
            title: 'Use NVR images',
            description: 'If enabled, the NVR images coming from NVR will be used, otherwise the one defined in the plugin',
            type: 'boolean',
            subgroup: 'Detection',
            defaultValue: true,
            immediate: true,
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
        detectionClasses: {
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Detection',
            choices: [],
            defaultValue: ['person']
        },
        scoreThreshold: {
            title: 'Default score threshold',
            subgroup: 'Detection',
            type: 'number',
            defaultValue: 0.7,
            placeholder: '0.7',
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
        alwaysZones: {
            title: 'Always enabled zones',
            description: 'Zones that will trigger a notification, regardless of the device is active or not in the main selector',
            multiple: true,
            combobox: true,
            hide: true,
            subgroup: 'Notifier',
            choices: [],
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
            defaultValue: 15,
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
                const choices = detectionClasses?.value ?? detectionClasses;

                return {
                    choices,
                }
            };

            this.storageSettings.settings.whitelistedZones.hide = false;
            this.storageSettings.settings.blacklistedZones.hide = false;
            this.storageSettings.settings.alwaysZones.hide = false;
            this.storageSettings.settings.detectionClasses.hide = false;
            this.storageSettings.settings.useNvrImages.hide = !this.storageSettings.values.useNvrDetections;
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
        const useNvrDetections = this.storageSettings.values.useNvrDetections;
        this.storageSettings.settings.useNvrImages.hide = !useNvrDetections;
        const settings: Setting[] = await this.storageSettings.getSettings();

        if (this.interfaces.includes(ScryptedInterface.VideoCamera) && !useNvrDetections) {
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
            this.storageSettings.settings.scoreThreshold.hide = false;
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