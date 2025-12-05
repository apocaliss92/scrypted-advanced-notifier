import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";

export interface VideoRtspFfmpegRecorderOptions {
    rtspUrl: string;
    ffmpegPath?: string;
    console: Console;
    h264?: boolean;
}

export class VideoRtspFfmpegRecorder extends EventEmitter {
    private options: VideoRtspFfmpegRecorderOptions;
    private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
    private restartTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private outputPath: string | undefined;
    private startTime: number | undefined;

    constructor(options: VideoRtspFfmpegRecorderOptions) {
        super();
        this.options = {
            ffmpegPath: 'ffmpeg',
            ...options,
        };
    }

    start(outputPath: string): number | undefined {
        this.stopped = false;
        this.outputPath = outputPath;
        this.startTime = Date.now();
        this.spawnFfmpeg();
        return this.ffmpegProcess?.pid;
    }

    async stop(thumbnailPath?: string) {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.ffmpegProcess) {
            const proc = this.ffmpegProcess;
            this.ffmpegProcess = null;

            const exitPromise = new Promise<void>(resolve => proc.once('exit', () => resolve()));
            proc.kill('SIGINT');
            await exitPromise;
        }

        if (thumbnailPath && this.outputPath && this.startTime) {
            try {
                const duration = (Date.now() - this.startTime) / 1000;
                const seekTime = duration / 2;
                const { ffmpegPath, console } = this.options;

                console.log(`Extracting thumbnail from ${this.outputPath} at ${seekTime}s to ${thumbnailPath}`);

                const args = [
                    '-hide_banner',
                    '-i', this.outputPath,
                    '-ss', String(seekTime),
                    '-vframes', '1',
                    '-y',
                    thumbnailPath
                ];

                const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);

                ffmpeg.stdout?.on('data', (data: any) => console.info(`[Thumbnail stdout] ${data}`));
                ffmpeg.stderr?.on('data', (data: any) => console.info(`[Thumbnail stderr] ${data}`));

                await new Promise<void>((resolve) => {
                    ffmpeg.on('exit', (code: number) => {
                        if (code !== 0) {
                            console.error(`Thumbnail extraction failed with code ${code}`);
                        } else {
                            console.log(`Thumbnail extracted successfully in ${thumbnailPath}`);
                        }
                        resolve();
                    });
                });

            } catch (e) {
                this.options.console.error('Error extracting thumbnail', e);
            }
        }

        this.startTime = undefined;
        this.outputPath = undefined;
    }

    private spawnFfmpeg() {
        const {
            rtspUrl,
            ffmpegPath,
            console,
            h264,
        } = this.options;

        if (!this.outputPath) {
            console.error('No output path specified for video recording');
            return;
        }

        const args = [
            '-hide_banner',
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c:v', h264 ? 'libx264' : 'copy',
            ...(h264 ? ['-preset', 'veryfast', '-crf', '23'] : []),
            '-movflags', '+faststart',
            // '-c:a', 'aac',
            '-f', 'mp4',
            '-y',
            this.outputPath,
        ];

        console.info('ffmpeg start recording:', ffmpegPath, args.join(' '));
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpegProcess = ffmpeg;

        ffmpeg.stderr.on('data', (data: Buffer) => {
            console.info('[ffmpeg stderr]', data.toString());
        });
        ffmpeg.on('exit', (code, signal) => {
            console.log(`ffmpeg recording terminated (code=${code}, signal=${signal})`);
            this.ffmpegProcess = null;
            if (!this.stopped) {
                console.log('Restarting ffmpeg recording...');
                setTimeout(() => this.spawnFfmpeg(), 2000);
            }
        });
        ffmpeg.on('error', (err) => {
            console.error('ffmpeg recording error:', err);
            this.ffmpegProcess = null;
            if (!this.stopped) {
                setTimeout(() => this.spawnFfmpeg(), 2000);
            }
        });
    }
}
