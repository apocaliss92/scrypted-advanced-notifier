
import sdk, { Camera, MediaObject, PictureOptions, RequestPictureOptions, ResponsePictureOptions, Setting, SettingValue, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import fs from 'fs';
import { sortBy } from 'lodash';
import { logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { CameraBase } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { UrlMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import { ffmpegFilterImageBuffer } from '../../scrypted/plugins/snapshot/src/ffmpeg-image-filter';
import AdvancedNotifierPlugin from './main';

type StorageKeys = 'logeLevel';

export class AdvancedNotifierCamera extends CameraBase<UrlMediaStreamOptions> implements Camera, VideoCamera, VideoClips {
    initStorage: StorageSettingsDict<StorageKeys> = {
        logeLevel: logLevelSetting,
    };

    storageSettings = new StorageSettings(this, this.initStorage);

    picture: Promise<MediaObject>;
    logger: Console;

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId, null);

        this.init().catch(this.getLogger().error);
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async init() {
        const webRtcPlugin = sdk.systemManager.getDeviceByName('WebRTC Plugin');
        setTimeout(() => {
            const dev = sdk.systemManager.getDeviceById(this.id);
            dev.setMixins(webRtcPlugin ? [webRtcPlugin.id] : []);
        }, 10000);
    }

    public getLogger() {
        if (!this.logger) {
            const newLogger = this.plugin.getLoggerInternal({
                console: this.console,
                storage: this.storageSettings,
            });

            this.logger = newLogger;
        }

        return this.logger;
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        try {
            if (!this.picture) {
                const mo = await sdk.mediaManager.createMediaObjectFromUrl('https://nvr.scrypted.app/img/scrypted/240x135-000000ff.png');
                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                const buf = await ffmpegFilterImageBuffer(jpeg, {
                    ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
                    blur: true,
                    brightness: -.2,
                    text: {
                        fontFile: undefined,
                        text: 'Advanced notifier clips',
                    },
                    timeout: 10000,
                });

                this.picture = this.createMediaObject(buf, 'image/jpeg');
            }
        } catch (e) {
            logger.log('Error in takeSmartCameraPicture', e);
        }

        return this.picture;
    }

    getRawVideoStreamOptions(): UrlMediaStreamOptions[] {
        return [];
    }
    createVideoStream(options?: UrlMediaStreamOptions): Promise<MediaObject> {
        return null;
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const logger = this.getLogger();
        try {
            const videoClips: VideoClip[] = [];

            const imagesPath = this.plugin.getStoragePath();
            const cameraFolders = await fs.promises.readdir(imagesPath);

            for (const cameraFolder of cameraFolders) {
                const cameraDevice = sdk.systemManager.getDeviceByName(cameraFolder);
                if (cameraDevice) {
                    const cameraMixin = this.plugin.currentCameraMixinsMap[cameraDevice.id];

                    if (cameraMixin) {
                        const cameraClips = await cameraMixin.getVideoClipsInternal(options);
                        videoClips.push(...cameraClips);
                    }
                }
            }

            return sortBy(videoClips, 'startTime');
        } catch (e) {
            logger.log('Error in getVideoClips', e);

            return [];
        }
    }

    async getVideoClip(fileId: string): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { videPath } = await this.plugin.decodeFileId({ fileId });

            logger.info('Fetching videoclip ', fileId, videPath);

            const fileURLToPath = `file://${videPath}`
            const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            return videoclipMo;
        } catch (e) {
            logger.error(`Error fetching videoclip ${fileId}`, e.message);
        }
    }

    async getVideoClipThumbnail(fileId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { imagePath } = await this.plugin.decodeFileId({ fileId });

            logger.info('Fetching thumbnail ', fileId, imagePath);

            const imageBuf = await fs.promises.readFile(imagePath);
            const mo = await sdk.mediaManager.createMediaObject(imageBuf, 'image/jpeg');

            return mo;
        } catch (e) {
            // TODO: Generate snapshot if not available
            logger.error(`Error fetching thumbnail ${fileId}`, e.message);
        }
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error('Method not implemented.');
    }

    takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        return this.takeSmartCameraPicture(options);
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }
}
