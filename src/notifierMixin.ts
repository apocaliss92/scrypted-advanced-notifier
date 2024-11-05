import { NotifierOptions, MediaObject, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ADVANCED_NOTIFIER_INTERFACE, getTextSettings } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

export class AdvancedNotifierNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings {
    storageSettings = new StorageSettings(this, {
        snapshotWidth: {
            subgroup: 'Notifier',
            title: 'Snapshot width',
            type: 'number',
            defaultValue: 1280,
        },
        snapshotHeight: {
            subgroup: 'Notifier',
            title: 'Snapshot height',
            type: 'number',
            defaultValue: 720,
        },
        ...getTextSettings(true) as any
    });

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);

        setTimeout(() => !this.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE) && this.interfaces.push(ADVANCED_NOTIFIER_INTERFACE), 0);

    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    // async sendNotification(title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string): Promise<void> {
    //     if (options?.data?.letGo) {
    //         this.mixinDevice.sendNotification(title, options, media, icon);
    //         return;
    //     }

    //     this.sendNotificationToPlugin(this.id, title, options, media, icon);
    // }
}