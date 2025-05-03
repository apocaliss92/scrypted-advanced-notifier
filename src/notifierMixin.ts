import sdk, { NotifierOptions, MediaObject, Setting, Settings, Notifier } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getTextSettings } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

export class AdvancedNotifierNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings, Notifier {
    storageSettings = new StorageSettings(this, {
        enabled: {
            title: 'Enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        addSnoozeActions: {
            title: 'Add snoozing actions',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        ...getTextSettings(true) as any,
    });

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

        this.plugin.currentNotifierMixinsMap[this.id] = this;
    }

    sendNotification(title: string, options?: NotifierOptions, media?: MediaObject | string, icon?: MediaObject | string): Promise<void> {
        let canNotify = true;

        const cameraDevice = sdk.systemManager.getDeviceByName(title);
        const notifierDevice = sdk.systemManager.getDeviceByName(this.id);
        if (cameraDevice) {
            const cameraMixin = this.plugin.currentCameraMixinsMap[cameraDevice.id];
            if (cameraMixin) {
                const logger = this.plugin.getLogger();
                const notificationsEnabled = cameraMixin.storageSettings.values.notificationsEnabled;

                if (!notificationsEnabled) {
                    canNotify = false;
                    logger.log(`Skipping NVR notification for ${cameraDevice.name} from notifier ${notifierDevice.name} because disabled`);
                }
            }

        }

        if (canNotify) {
            return this.mixinDevice.sendNotification(title, options, media, icon);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}