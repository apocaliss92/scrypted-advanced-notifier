
import sdk, { Camera, MediaObject, PictureOptions, RequestPictureOptions, ResponsePictureOptions, ScryptedDeviceBase, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import fs from 'fs';
import path from 'path';
import { CameraBase } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { UrlMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import { ffmpegFilterImage, ffmpegFilterImageBuffer } from '../../scrypted/plugins/snapshot/src/ffmpeg-image-filter';
import AdvancedNotifierPlugin from './main';
import { BaseRule, getWebHookUrls } from './utils';

export class AdvancedNotifierCamera extends CameraBase<UrlMediaStreamOptions> implements Camera, VideoCamera, VideoClips {
    picture: Promise<MediaObject>;

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId, null);
    }

    getfont() {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
        const unzippedFs = path.join(pluginVolume, 'zip/unzipped/fs');
        const fontFile = path.join(unzippedFs, 'Lato-Bold.ttf');

        return fontFile;
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const logger = this.plugin.getLogger();
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
                // const buf = await ffmpegFilterImage([
                //     '-f', 'lavfi',
                //     '-i', 'color=black:size=1920x1080',
                // ], {
                //     ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
                //     text: {
                //         fontFile: undefined,
                //         text: 'Advanced notifier clips',
                //     },
                //     timeout: 10000,
                // });

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

        const logger = this.plugin.getLogger();
        for (const cameraFolder of cameraFolders) {
            const cameraDevice = sdk.systemManager.getDeviceByName<ScryptedDeviceBase>(cameraFolder);
            const { rulesPath } = this.plugin.getRulePaths({ cameraName: cameraFolder });

            try {
                await fs.promises.access(rulesPath);
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
                                const { timelapseStreamUrl, timelapseThumbnailUrl } = await getWebHookUrls({
                                    device: cameraDevice,
                                    rule: { name: ruleFolder } as BaseRule,
                                    clipName: fileName
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
                                            href: timelapseThumbnailUrl
                                        },
                                        video: {
                                            href: timelapseStreamUrl
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            } catch { }
        }

        return videoClips;
    }

    async getVideoClip(fileId: string): Promise<MediaObject> {
        const logger = this.plugin.getLogger();
        logger.log('Fetching videoId ', fileId);

        const [cameraName, ruleName, fileName] = fileId.split('_');
        const { videoclipPath } = this.plugin.getRulePaths({
            cameraName,
            fileName,
            ruleName
        });

        const fileURLToPath = `file://${videoclipPath}`
        const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        return videoclipMo;
    }

    async getVideoClipThumbnail(fileId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.plugin.getLogger();

        try {
            const [cameraName, ruleName, fileName] = fileId.split('_');
            const { snapshotPath } = this.plugin.getRulePaths({
                cameraName,
                fileName,
                ruleName
            });
            logger.log('Fetching thumbnailId ', fileId, cameraName, ruleName, fileName, snapshotPath);

            const fileURLToPath = `file://${snapshotPath}`;
            const thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            const buf = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
            const mo = await sdk.mediaManager.createMediaObject(buf, 'image/jpeg')

            return mo;
        } catch (e) {
            logger.log('Error in getVideoClipThumbnail', fileId, e);
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
