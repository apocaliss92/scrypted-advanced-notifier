import { EventEmitter } from 'events';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export enum AudioSensitivity {
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
}

export const sensitivityDbThresholds = {
    [AudioSensitivity.Low]: -20,
    [AudioSensitivity.Medium]: -35,
    [AudioSensitivity.High]: -50,
}

export const getDecibelsFromRtp_PCMU8 = (rtpPacket: Buffer) => {
    const RTP_HEADER_SIZE = 12;
    if (rtpPacket.length <= RTP_HEADER_SIZE) return null;

    const payload = rtpPacket.slice(RTP_HEADER_SIZE);
    const sampleCount = payload.length;
    if (sampleCount === 0) return null;

    let sumSquares = 0;
    for (let i = 0; i < payload.length; i++) {
        const sample = payload[i];
        const centered = sample - 128;
        const normalized = centered / 128;
        sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    const db = 20 * Math.log10(rms || 0.00001);

    return { db, rms };
}

export const calculateAudioLevels = (audioAsFloat: Float32Array, audioMaxBitRange = 1.0) => {
    let sumSquares = 0;
    for (let i = 0; i < audioAsFloat.length; i++) {
        sumSquares += audioAsFloat[i] * audioAsFloat[i];
    }
    const rms = Math.sqrt(sumSquares / audioAsFloat.length);

    let db: number;
    if (rms > 0) {
        db = 20 * Math.log10(Math.abs(rms) / audioMaxBitRange);
    } else {
        db = 0;
    }

    return { rms, db };
}

export const mean = (samples: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i];
    return sum / samples.length;
}

export const stddev = (samples: Float32Array, meanVal?: number): number => {
    const m = meanVal !== undefined ? meanVal : mean(samples);
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += (samples[i] - m) ** 2;
    return Math.sqrt(sumSq / samples.length);
}

export interface AudioRtspFfmpegStreamOptions {
    rtspUrl: string;
    audioSampleRate?: number;
    audioChannels?: number;
    restartIntervalMs?: number;
    ffmpegPath?: string;
    console: Console;
}

export interface AudioChunkData {
    audio: Buffer; // chunk PCM s16le
    db: number;
    rms: number;
    int16Samples: Int16Array;
    float32Samples: Float32Array;
    mean: number;
    stddev: number;
}

export class AudioRtspFfmpegStream extends EventEmitter {
    private options: AudioRtspFfmpegStreamOptions;
    private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
    private restartTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private audioBuffer: Buffer = Buffer.alloc(0);
    private readonly chunkSamples = 15600; // per YAMNET

    constructor(options: AudioRtspFfmpegStreamOptions) {
        super();
        this.options = {
            audioSampleRate: 16000,
            audioChannels: 1,
            restartIntervalMs: 60 * 60 * 1000,
            ffmpegPath: 'ffmpeg',
            ...options,
        };
    }

    start(): number | undefined {
        this.stopped = false;
        this.spawnFfmpeg();
        this.scheduleRestart();
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

    private scheduleRestart() {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.options.console.log('ffmpeg Automatic restart');
            this.restart();
        }, this.options.restartIntervalMs);
    }

    private restart() {
        this.stop();
        this.start();
    }

    private spawnFfmpeg() {
        const {
            rtspUrl,
            audioSampleRate,
            audioChannels,
            ffmpegPath,
            console,
        } = this.options;

        const args = [
            '-hide_banner',
            '-rtsp_transport', 'tcp',
            '-analyzeduration', '0',
            '-probesize', '512',
            '-i', rtspUrl,
            '-acodec', 'pcm_s16le',
            '-ac', String(audioChannels),
            '-ar', String(audioSampleRate),
            '-f', 's16le',
            '-dn', '-sn', '-vn',
            'pipe:1',
        ];

        console.log('ffmpeg start:', ffmpegPath, args.join(' '));
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.ffmpegProcess = ffmpeg;

        ffmpeg.stdout.on('data', (data: Buffer) => {
            this.audioBuffer = Buffer.concat([this.audioBuffer, data]);
            const chunkBytes = this.chunkSamples * 2;
            while (this.audioBuffer.length >= chunkBytes) {
                const audio = this.audioBuffer.slice(0, chunkBytes);
                this.audioBuffer = this.audioBuffer.slice(chunkBytes);

                // PCM s16le -> Float32Array
                const int16Samples = new Int16Array(audio.buffer, audio.byteOffset, audio.length / 2);
                const float32Samples = new Float32Array(int16Samples.length);
                for (let i = 0; i < int16Samples.length; i++) {
                    float32Samples[i] = int16Samples[i] / 32768.0;
                }
                const { rms, db } = calculateAudioLevels(float32Samples);
                const meanVal = mean(float32Samples);
                const stddevVal = stddev(float32Samples, meanVal);

                this.emit('audio', { audio, db, rms, mean: meanVal, stddev: stddevVal, int16Samples, float32Samples } as AudioChunkData);
            }
        });
        ffmpeg.stderr.on('data', (data: Buffer) => {
            console.debug('[ffmpeg stderr]', data.toString());
        });
        ffmpeg.on('exit', (code, signal) => {
            console.log(`ffmpeg terminated (code=${code}, signal=${signal})`);
            this.ffmpegProcess = null;
            if (!this.stopped) {
                setTimeout(() => this.spawnFfmpeg(), 2000);
            }
        });
        ffmpeg.on('error', (err) => {
            console.error('ffmpeg error:', err);
            this.ffmpegProcess = null;
            if (!this.stopped) {
                setTimeout(() => this.spawnFfmpeg(), 2000);
            }
        });
    }
}
