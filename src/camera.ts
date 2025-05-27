
import sdk, { Camera, MediaObject, PictureOptions, RequestPictureOptions, ResponsePictureOptions, ScryptedDeviceBase, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import fs from 'fs';
import path from 'path';
import { CameraBase } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { UrlMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import { ffmpegFilterImageBuffer } from '../../scrypted/plugins/snapshot/src/ffmpeg-image-filter';
import AdvancedNotifierPlugin from './main';
import { BaseRule, DETECTION_CLIP_PREFIX, getWebHookUrls, TIMELAPSE_CLIP_PREFIX } from './utils';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { sortBy } from 'lodash';

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

    getfont() {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
        const unzippedFs = path.join(pluginVolume, 'zip/unzipped/fs');
        const fontFile = path.join(unzippedFs, 'Lato-Bold.ttf');

        return fontFile;
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
        const videoClips: VideoClip[] = [];

        const imagesPath = this.plugin.getStoragePath();
        const cameraFolders = await fs.promises.readdir(imagesPath);

        const logger = this.getLogger();
        for (const cameraFolder of cameraFolders) {
            const cameraDevice = sdk.systemManager.getDeviceByName<ScryptedDeviceBase>(cameraFolder);
            const { rulesPath } = this.plugin.getRulePaths({ cameraName: cameraFolder });

            let hasRules = true;

            try {
                await fs.promises.access(rulesPath);
            } catch (e) {
                hasRules = false;
            }

            if (hasRules) {
                const rulesFolder = await fs.promises.readdir(rulesPath);

                for (const ruleFolder of rulesFolder) {
                    const { generatedPath } = this.plugin.getRulePaths({
                        cameraName: cameraFolder,
                        ruleName: ruleFolder
                    });

                    const files = await fs.promises.readdir(generatedPath);

                    for (const file of files) {
                        const [fileName, extension] = file.split('.');
                        if (extension === 'mp4') {
                            const timestamp = Number(fileName);

                            if (timestamp > options.startTime && timestamp < options.endTime) {
                                const { fileId } = this.plugin.getRulePaths({
                                    cameraName: cameraFolder,
                                    fileName,
                                    ruleName: ruleFolder
                                });
                                const { videoclipStreamUrl, videoclipThumbnailUrl } = await getWebHookUrls({
                                    fileId: fileId
                                });

                                videoClips.push({
                                    id: fileName,
                                    startTime: timestamp,
                                    duration: 30,
                                    event: 'timelapse',
                                    thumbnailId: fileId,
                                    videoId: fileId,
                                    resources: {
                                        thumbnail: {
                                            href: videoclipThumbnailUrl
                                        },
                                        video: {
                                            href: videoclipStreamUrl
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            }

            let clipsPath: string;

            let hasClips = true;
            try {
                const { generatedPath } = this.plugin.getShortClipPaths({ cameraName: cameraDevice.name });
                await fs.promises.access(generatedPath);
                clipsPath = generatedPath;
            } catch (e) {
                hasClips = false;
            }

            if (hasClips) {
                const files = await fs.promises.readdir(clipsPath);

                try {
                    for (const file of files) {
                        const [fileName, extension] = file.split('.');
                        if (extension === 'mp4') {
                            const timestamp = Number(fileName);

                            if (timestamp > options.startTime && timestamp < options.endTime) {
                                const { fileId } = this.plugin.getShortClipPaths({
                                    cameraName: cameraDevice.name,
                                    fileName,
                                });
                                const { videoclipStreamUrl, videoclipThumbnailUrl } = await getWebHookUrls({
                                    fileId: fileId
                                });

                                videoClips.push({
                                    id: fileName,
                                    startTime: timestamp,
                                    duration: 30,
                                    event: 'detection',
                                    thumbnailId: fileId,
                                    videoId: fileId,
                                    resources: {
                                        thumbnail: {
                                            href: videoclipThumbnailUrl
                                        },
                                        video: {
                                            href: videoclipStreamUrl
                                        }
                                    }
                                });
                            }
                        }
                    }
                } catch (e) {
                    logger.log(`Error fetching videoclips for camera ${cameraDevice.name}`, e);
                }
            }
        }

        return sortBy(videoClips, 'startTime');
    }

    getFilePath(props: { fileId: string }) {
        const { fileId } = props;

        if (fileId.startsWith(TIMELAPSE_CLIP_PREFIX)) {
            const [_, cameraName, ruleName, fileName] = fileId.split('_');
            return this.plugin.getRulePaths({
                cameraName,
                fileName,
                ruleName
            });
        } else if (fileId.startsWith(DETECTION_CLIP_PREFIX)) {
            const [_, cameraName, fileName] = fileId.split('_');
            return this.plugin.getShortClipPaths({
                cameraName,
                fileName,
            });
        }
    }

    async getVideoClip(fileId: string): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { videoclipPath } = this.getFilePath({ fileId });

            logger.log('Fetching videoclip ', fileId, videoclipPath);

            const fileURLToPath = `file://${videoclipPath}`
            const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            return videoclipMo;
        } catch (e) {
            logger.error(`Error fetching videoclip ${fileId}`, e.message);
        }
    }

    async getVideoClipThumbnail(fileId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { snapshotPath } = this.getFilePath({ fileId });

            logger.log('Fetching thumbnail ', fileId, snapshotPath);

            const fileURLToPath = `file://${snapshotPath}`;
            const thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            const buf = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
            const mo = await sdk.mediaManager.createMediaObject(buf, 'image/jpeg')

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
