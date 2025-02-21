
import sdk, { Camera, MediaObject, PictureOptions, RequestPictureOptions, ResponsePictureOptions, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import path from 'path';
import fs from 'fs';
import url from 'url';
import { Destroyable, RtspSmartCamera, UrlMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import { ffmpegFilterImage, ffmpegFilterImageBuffer } from '../../scrypted/plugins/snapshot/src/ffmpeg-image-filter';
import AdvancedNotifierPlugin from './main';
import { getWebooks } from './utils';

export class AdvancedNotifierCamera extends RtspSmartCamera implements Camera, VideoCamera, VideoClips {
    picture: Promise<MediaObject>;

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId, null);
    }

    async getVideoclipWebhookUrls(filename: string) {
        const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        const [endpoint, parameters] = cloudEndpoint.split('?') ?? '';
        const params = {
            filename,
        };
        const { timelapseStream, timelapseThumbnail } = await getWebooks();

        const videoclipUrl = `${endpoint}${timelapseStream}?params=${JSON.stringify(params)}&${parameters}`;
        const thumbnailUrl = `${endpoint}${timelapseThumbnail}?params=${JSON.stringify(params)}&${parameters}`;

        return { videoclipUrl, thumbnailUrl };
    }

    getfont() {
        const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
        const unzippedFs = path.join(pluginVolume, 'zip/unzipped/fs');
        const fontFile = path.join(unzippedFs, 'Lato-Bold.ttf');

        return fontFile;
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const fontFile = this.getfont();

        if (!this.picture) {
            const buf = await ffmpegFilterImage([
                '-f', 'lavfi',
                '-i', 'color=black:size=1920x1080',
            ], {
                ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
                text: {
                    fontFile,
                    text: 'Advanced notifier clips',
                },
                timeout: 10000,
            });

            this.picture = this.createMediaObject(buf, 'image/jpeg');
        }

        return this.picture;
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        return [];
    }

    async listenEvents(): Promise<Destroyable> {
        const ret: Destroyable = {
            on: function (eventName: string | symbol, listener: (...args: any[]) => void): void {
            },
            destroy: async () => {
            },
            emit: function (eventName: string | symbol, ...args: any[]): boolean {
                return false;
            }
        };

        return ret;
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        let { imagesPath } = this.plugin.storageSettings.values;
        const timelapsesPath = path.join(imagesPath, 'timelapses');

        const videoClips: VideoClip[] = [];
        const ruleFolders = await fs.promises.readdir(timelapsesPath);

        for (const ruleFolder of ruleFolders) {
            const ruleDir = path.join(timelapsesPath, ruleFolder)
            const stats = await fs.promises.stat(ruleDir);
            if (stats.isDirectory() && ruleFolder !== 'snapshots') {
                const generateddDir = path.join(ruleDir, 'generated');
                const clips = await fs.promises.readdir(generateddDir);

                for (const clipName of clips) {
                    const [filename, extension] = clipName.split('.');
                    if (extension === 'mp4') {
                        const [_, timestampString] = filename.split('_');
                        const timestamp = Number(timestampString);

                        if (timestamp > options.startTime && timestamp < options.endTime) {
                            const filePath = path.join(generateddDir, clipName);
                            const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(filePath);

                            videoClips.push({
                                id: filename,
                                startTime: timestamp,
                                duration: 30,
                                event: 'timelapse',
                                thumbnailId: filePath,
                                videoId: filePath,
                                resources: {
                                    thumbnail: {
                                        href: thumbnailUrl
                                    },
                                    video: {
                                        href: videoclipUrl
                                    }
                                }
                            });
                        }
                    }
                }
            }
        }

        return videoClips;
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.plugin.getLogger();
        logger.debug('Fetching videoId ', videoId);
        const fileURLToPath = url.pathToFileURL(videoId).toString();
        const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        return videoclipMo;
    }

    async getThumbnailMediaObject(props: {
        videoclipUrl: string,
        ruleName: string,
    }) {
        const logger = this.plugin.getLogger();
        const { videoclipUrl, ruleName } = props;
        const { mainTimelapsePath } = this.plugin.getTimelapseFolder({ ruleName });
        const thumbnailsPath = path.join(mainTimelapsePath, 'snapshots');
        let thumbnailMo: MediaObject;

        const filename = `${ruleName.replace(' ', '')}_${videoclipUrl.split('/').pop().replace('.mp4', '.jpg')}`;
        const thumbnailPath = path.join(thumbnailsPath, filename);
        try {
            try {
                await fs.promises.access(thumbnailsPath);
            } catch (err) {
                await fs.promises.mkdir(thumbnailsPath, { recursive: true });
            }

            try {
                await fs.promises.access(thumbnailPath);
                const stats = await fs.promises.stat(thumbnailPath);
                if (stats.size === 0) {
                    logger.log(`Thumbnail ${thumbnailPath} corrupted, removing.`);
                    await fs.promises.rm(thumbnailPath);
                }
            } catch {
                logger.log(`Thumbnail not found in ${thumbnailPath}, generating.`);

                const mo = await sdk.mediaManager.createFFmpegMediaObject({
                    inputArguments: [
                        '-ss', '00:00:05',
                        '-i', videoclipUrl,
                    ],
                });
                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                const fontFile = this.getfont();
                const buf = await ffmpegFilterImageBuffer(jpeg, {
                    ffmpegPath: await sdk.mediaManager.getFFmpegPath(),
                    blur: true,
                    brightness: -.2,
                    text: {
                        fontFile,
                        text: ruleName,
                    },
                    timeout: 10000,
                });


                if (jpeg.length) {
                    logger.log(`Saving thumbnail in ${thumbnailPath}`);
                    await fs.promises.writeFile(thumbnailPath, buf);
                } else {
                    logger.log('Not saving, image is corrupted');
                }
            }

            try {
                await fs.promises.access(thumbnailPath);
                const fileURLToPath = url.pathToFileURL(thumbnailPath).toString();
                thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            } catch { }

            return { thumbnailMo };
        } catch (e) {
            logger.error(`Error retrieving thumbnail of videoclip ${videoclipUrl}`, e);
            try {
                await fs.promises.access(thumbnailPath);
                await fs.promises.rm(thumbnailPath);
            } catch { }

            return {};
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.plugin.getLogger();
        logger.debug('Fetching thumbnailId ', thumbnailId);


        const reg = new RegExp('(.*)\/(.*)\/generated\/(.*)');
        const result = reg.exec(thumbnailId);
        const ruleName = result[2];

        const { thumbnailMo } = await this.getThumbnailMediaObject({
            videoclipUrl: thumbnailId,
            ruleName,
        });

        return thumbnailMo;
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
