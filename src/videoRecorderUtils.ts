import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { classnamePrio, DetectionClass } from "./detectionClasses";
import { sortBy } from "lodash";

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

export const detectionClassIndex = {
    [DetectionClass.Motion]: 0,
    [DetectionClass.Person]: 1,
    [DetectionClass.Vehicle]: 2,
    [DetectionClass.Animal]: 3,
    [DetectionClass.Face]: 4,
    [DetectionClass.Plate]: 5,
    [DetectionClass.Package]: 6,
}

export const detectionClassIndexReversed = Object.entries(detectionClassIndex)
    .reduce((tot, [detectionClass, index]) => ({ ...tot, [index]: detectionClass }), {});

export const getVideoClipName = (props: {
    startTime: number,
    endTime: number,
    logger: Console,
    classesDetected: string[]
}) => {
    const { startTime, classesDetected, endTime, logger } = props;
    const detectionsHashComponents = new Array(10).fill(0);
    Object.entries(detectionClassIndex).forEach(([detectionClass, index]) => {
        if (classesDetected.includes(detectionClass) || detectionClass === DetectionClass.Motion) {
            detectionsHashComponents[index] = 1;
        }
    });
    const detectionsHash = detectionsHashComponents.join('');
    const filename = `${startTime}_${endTime}_${detectionsHash}`;

    logger.log(`Filename calculated: ${JSON.stringify({
        filename,
        detectionsHashComponents,
        classesDetected,
        detectionsHash
    })}`)

    return filename;
}

export const getMainDetectionClass = (detectionClasses: DetectionClass[]) => {
    if (detectionClasses.includes(DetectionClass.Face)) {
        return DetectionClass.Face;
    }
    if (detectionClasses.includes(DetectionClass.Plate)) {
        return DetectionClass.Plate;
    }
    if (detectionClasses.includes(DetectionClass.Package)) {
        return DetectionClass.Package;
    }
    if (detectionClasses.includes(DetectionClass.Person)) {
        return DetectionClass.Person;
    }
    if (detectionClasses.includes(DetectionClass.Animal)) {
        return DetectionClass.Animal;
    }
    if (detectionClasses.includes(DetectionClass.Vehicle)) {
        return DetectionClass.Vehicle;
    }
    if (detectionClasses.includes(DetectionClass.Motion)) {
        return DetectionClass.Motion;
    }
}

export const parseVideoFileName = (videoClipName: string) => {
    const [startTime, endTime, detectionsHash] = videoClipName.split('_');

    const detectionClasses: DetectionClass[] = [];
    const detectionFlags = detectionsHash.split('');
    detectionFlags.forEach((flag, index) => flag === '1' && detectionClasses.push(detectionClassIndexReversed[index]));
    const sortedClassnames = sortBy(detectionClasses,
        (classname) => classnamePrio[classname] ?? 100,
    );
    const startTimeNumber = Number(startTime);
    const endTimeNumber = Number(endTime);

    const eventName = getMainDetectionClass(detectionClasses);

    const duration = endTimeNumber - startTimeNumber;

    return {
        startTime: startTimeNumber,
        endTime: endTimeNumber,
        detectionClasses: sortedClassnames,
        eventName,
        duration,
    };
}