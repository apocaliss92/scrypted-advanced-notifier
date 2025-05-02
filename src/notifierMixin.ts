import { NotifierOptions, MediaObject, Setting, Settings } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getTextSettings } from "./utils";
import HomeAssistantUtilitiesProvider from "./main";

export type SendNotificationToPluginFn = (notifierId: string, title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string) => Promise<void>

export class AdvancedNotifierNotifierMixin extends SettingsMixinDeviceBase<any> implements Settings {
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

    async getMixinSettings(): Promise<Setting[]> {
        const settings: Setting[] = await this.storageSettings.getSettings();

        return settings;
    }

    async putMixinSetting(key: string, value: string) {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
}