
import sdk, { MediaObject, Notifier, NotifierOptions, ScryptedDeviceBase, ScryptedInterface, Settings } from '@scrypted/sdk';
import AdvancedNotifierPlugin from './main';
import { DeviceInterface } from './utils';
const { systemManager } = sdk;

export class AdvancedNotifierNotifier extends ScryptedDeviceBase implements Notifier {
    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);

        (async () => {
            const scryptedNvrUserDevice = systemManager.getDeviceByName('Scrypted NVR Users');
            const mixins = (this.mixins || []).slice();
            if (scryptedNvrUserDevice && !mixins.includes(scryptedNvrUserDevice.id)) {
                mixins.push(scryptedNvrUserDevice.id);
            }
            // if (!mixins.includes(this.plugin.id)) {
            //     mixins.push(this.plugin.id);
            // }
            const plugins = await systemManager.getComponent('plugins');
            await plugins.setMixins(this.id, mixins);

            setTimeout(async () => {
                const thisDevice = systemManager.getDeviceById<Settings>(this.id);
                const settings = await thisDevice.getSettings();

                const defaultNotificationsSetting = settings.find(setting => setting.key === 'nvr:defaultNotifications');
                await thisDevice.putSetting('nvr:defaultNotifications', defaultNotificationsSetting.choices);

                const allUsers = Object.keys(sdk.systemManager.getSystemState())
                    .map(deviceId => sdk.systemManager.getDeviceById<DeviceInterface>(deviceId))
                    .filter(device => device.interfaces.includes(ScryptedInterface.ScryptedUser));

                await thisDevice.putSetting('nvr:userId', allUsers[0].id);
                this.plugin.getLogger().log(`Default notifier initialized to all notification types and user ${allUsers[0].name}. The user should be enabled to all cameras to proxy them on the plugin`);
            }, 2000);
        })();
    }

    async sendNotification(title: string, options?: NotifierOptions, media?: MediaObject, icon?: MediaObject | string): Promise<void> {
        const logger = this.plugin.getLogger();
        logger.info(JSON.stringify({ title, options }));
        await this.plugin.onNvrNotification(title, options, media, icon);
    }
}
