import sdk, { HttpRequest, HttpResponse } from "@scrypted/sdk";
import AdvancedNotifierPlugin from "./main";
import fs from 'fs';



export const servePluginGeneratedThumbnail = async (props: {
    fileId: string,
    request: HttpRequest,
    response: HttpResponse,
    plugin: AdvancedNotifierPlugin
}) => {
    const { fileId, request, response, plugin } = props;

    const logger = plugin.getLogger();

    logger.info(JSON.stringify({ fileId }));

    const mo = await plugin.camera.getVideoClipThumbnail(fileId);
    const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');

    response.send(jpeg, {
        headers: {
            'Content-Type': 'image/jpeg'
        }
    });
    return;
}

export const servePluginGeneratedVideoclip = async (props: {
    fileId: string,
    request: HttpRequest,
    response: HttpResponse,
    plugin: AdvancedNotifierPlugin
}) => {
    const { fileId, request, response, plugin } = props;
    const logger = plugin.getLogger();
    const { videoclipPath } = plugin.camera.getFilePath({ fileId });

    const stat = await fs.promises.stat(videoclipPath);
    const fileSize = stat.size;
    const range = request.headers.range;

    logger.debug(`Videoclip requested: ${JSON.stringify({
        videoclipPath,
    })}`);

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoclipPath, { start, end });

        const sendVideo = async () => {
            return new Promise<void>((resolve, reject) => {
                try {
                    response.sendStream((async function* () {
                        for await (const chunk of file) {
                            yield chunk;
                        }
                    })(), {
                        code: 206,
                        headers: {
                            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': chunksize,
                            'Content-Type': 'video/mp4',
                        }
                    });

                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        };

        try {
            await sendVideo();
            return;
        } catch (e) {
            logger.log('Error fetching videoclip', e);
        }
    } else {
        response.sendFile(videoclipPath, {
            code: 200,
            headers: {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            }
        });
    }
}