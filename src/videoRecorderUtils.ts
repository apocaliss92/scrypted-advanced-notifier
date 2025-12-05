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
        this.spawnFfmpeg();
        return this.ffmpegProcess?.pid;
    }

    stop() {
        this.stopped = true;
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGKILL');
            this.ffmpegProcess = null;
        }
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
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
            ...(h264 ? [
                '-c:v', 'libx264',
                '-c:a', 'copy',
                '-preset', 'veryfast',
                '-crf', '23'
            ] :
                ['-c', 'copy']
            ),
            '-f', 'mp4',
            '-y',
            this.outputPath
        ];

        console.log('ffmpeg start recording:', ffmpegPath, args.join(' '));
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpegProcess = ffmpeg;

        ffmpeg.stderr.on('data', (data: Buffer) => {
            console.debug('[ffmpeg stderr]', data.toString());
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
