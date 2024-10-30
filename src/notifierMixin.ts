import { Notifier, ScryptedDeviceType, NotifierOptions, MediaObject, ScryptedInterface, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { defaultDetectionClasses, getTextSettings } from "./utils";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

export class HomeAssistantUtilitiesNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings, Notifier {
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
        alwaysClassnames: {
            title: 'Always enabled classnames',
            description: 'Detection classes that will always trigger a notification, regardless of the device is active or not in the main selector',
            multiple: true,
            combobox: true,
            subgroup: 'Notifier',
            choices: defaultDetectionClasses,
        },
        ...getTextSettings(true) as any
    });

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        private sendNotificationToPlugin: SendNotificationToPluginFn
    ) {
        super(options);
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    async sendNotification(title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string): Promise<void> {
        if (options?.data?.letGo) {
            this.mixinDevice.sendNotification(title, options, media, icon);
            return;
        }

        this.sendNotificationToPlugin(this.id, title, options, media, icon);
    }
}