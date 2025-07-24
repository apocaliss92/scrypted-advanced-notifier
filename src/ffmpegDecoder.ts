import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

export interface FFmpegDecoderOptions {
    rtspUrl: string;
    frameInterval?: number; // milliseconds between frames (default: 100ms)
    restartInterval?: number; // minutes between auto restarts (default: 5 minutes)
    maxRetries?: number; // max retry attempts before giving up (default: 5)
    timeout?: number; // timeout for stream initialization (default: 10 seconds)
    outputFormat?: 'jpeg' | 'png'; // output image format (default: jpeg)
    quality?: number; // JPEG quality 1-31 (lower is better, default: 2)
    width?: number; // output width (optional, maintains aspect ratio)
    height?: number; // output height (optional, maintains aspect ratio)
}

export interface FrameData {
    buffer: Buffer;
    timestamp: number;
    frameNumber: number;
}

export class FFmpegRTSPDecoder extends EventEmitter {
    private process: ChildProcess | null = null;
    private isRunning = false;
    private shouldRestart = true;
    private retryCount = 0;
    private frameCount = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private lastFrameTime = 0;
    private startTime = 0;

    private readonly options: Required<FFmpegDecoderOptions>;

    constructor(options: FFmpegDecoderOptions) {
        super();
        
        this.options = {
            rtspUrl: options.rtspUrl,
            frameInterval: options.frameInterval || 100,
            restartInterval: options.restartInterval || 5,
            maxRetries: options.maxRetries || 5,
            timeout: options.timeout || 10000,
            outputFormat: options.outputFormat || 'jpeg',
            quality: options.quality || 2,
            width: options.width,
            height: options.height,
        };

        this.validateOptions();
    }

    private validateOptions(): void {
        if (!this.options.rtspUrl) {
            throw new Error('RTSP URL is required');
        }
        
        if (!this.options.rtspUrl.startsWith('rtsp://')) {
            throw new Error('Invalid RTSP URL format');
        }

        if (this.options.frameInterval < 10) {
            throw new Error('Frame interval must be at least 10ms');
        }

        if (this.options.quality < 1 || this.options.quality > 31) {
            throw new Error('JPEG quality must be between 1 and 31');
        }
    }

    public start(): Promise<{ processId: number }> {
        return new Promise((resolve, reject) => {
            if (this.isRunning) {
                resolve({ processId: this.process?.pid || 0 });
                return;
            }

            this.emit('starting');
            this.isRunning = true;
            this.shouldRestart = true;
            this.retryCount = 0;
            this.frameCount = 0;
            this.startTime = Date.now();

            this.startDecoder()
                .then(() => {
                    this.setupAutoRestart();
                    this.setupHealthCheck();
                    this.emit('started');
                    resolve({ processId: this.process?.pid || 0 });
                })
                .catch((error) => {
                    this.isRunning = false;
                    this.emit('error', error);
                    reject(error);
                });
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve) => {
            this.shouldRestart = false;
            this.isRunning = false;
            
            this.clearTimers();
            
            if (this.process) {
                this.process.once('exit', () => {
                    this.emit('stopped');
                    resolve();
                });
                
                // Graceful shutdown
                this.process.kill('SIGTERM');
                
                // Force kill after 5 seconds
                setTimeout(() => {
                    if (this.process && !this.process.killed) {
                        this.process.kill('SIGKILL');
                    }
                }, 5000);
            } else {
                this.emit('stopped');
                resolve();
            }
        });
    }

    public restart(): Promise<void> {
        this.emit('restarting');
        
        return new Promise((resolve, reject) => {
            this.stopDecoder()
                .then(() => {
                    // Reset counters
                    this.retryCount = 0;
                    this.frameCount = 0;
                    this.startTime = Date.now();
                    
                    return this.startDecoder();
                })
                .then(() => {
                    this.emit('restarted');
                    resolve();
                })
                .catch((error) => {
                    this.emit('error', error);
                    reject(error);
                });
        });
    }

    private async startDecoder(): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = this.buildFFmpegArgs();
            
            this.emit('debug', `Starting FFmpeg with args: ${args.join(' ')}`);
            
            this.process = spawn('ffmpeg', args, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.emit('error', new Error('FFmpeg startup timeout'));
                    reject(new Error('FFmpeg startup timeout'));
                }
            }, this.options.timeout);

            this.process.on('error', (error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    this.emit('error', error);
                    reject(error);
                }
            });

            this.process.stderr?.on('data', (data) => {
                const message = data.toString();
                this.emit('debug', `FFmpeg stderr: ${message}`);
                
                // Check for successful stream opening
                if (message.includes('Stream #0:0') && !resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
                
                // Check for errors
                if (message.includes('Connection refused') || 
                    message.includes('Invalid data found') ||
                    message.includes('No route to host')) {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(new Error(`FFmpeg error: ${message}`));
                    }
                }
            });

            this.process.on('exit', (code, signal) => {
                this.emit('debug', `FFmpeg exited with code ${code}, signal ${signal}`);
                this.process = null;
                
                if (this.shouldRestart && this.isRunning) {
                    this.handleReconnect();
                }
            });

            // Setup frame extraction
            if (this.process.stdout) {
                this.setupFrameExtraction(this.process.stdout);
            }
        });
    }

    private buildFFmpegArgs(): string[] {
        const args = [
            '-y', // Overwrite output files
            '-rtsp_transport', 'tcp', // Use TCP for better reliability
            '-i', this.options.rtspUrl,
            '-f', 'image2pipe', // Output as image pipe
            '-vcodec', this.options.outputFormat === 'png' ? 'png' : 'mjpeg',
        ];

        // Add quality settings for JPEG
        if (this.options.outputFormat === 'jpeg') {
            args.push('-q:v', this.options.quality.toString());
        }

        // Add frame rate control
        const fps = 1000 / this.options.frameInterval;
        args.push('-r', fps.toString());

        // Add scaling if specified
        if (this.options.width || this.options.height) {
            let scale = '';
            if (this.options.width && this.options.height) {
                scale = `${this.options.width}:${this.options.height}`;
            } else if (this.options.width) {
                scale = `${this.options.width}:-1`;
            } else {
                scale = `-1:${this.options.height}`;
            }
            args.push('-vf', `scale=${scale}`);
        }

        args.push('pipe:1'); // Output to stdout

        return args;
    }

    private setupFrameExtraction(stdout: Readable): void {
        let buffer = Buffer.alloc(0);
        const frameDelimiter = this.options.outputFormat === 'jpeg' ? 
            Buffer.from([0xFF, 0xD9]) : // JPEG end marker
            Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]); // PNG end marker

        stdout.on('data', (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            
            let delimiterIndex;
            while ((delimiterIndex = buffer.indexOf(frameDelimiter)) !== -1) {
                const frameEndIndex = delimiterIndex + frameDelimiter.length;
                const frameBuffer = buffer.slice(0, frameEndIndex);
                buffer = buffer.slice(frameEndIndex);
                
                if (frameBuffer.length > 100) { // Minimum frame size check
                    this.processFrame(frameBuffer);
                }
            }
            
            // Prevent buffer from growing too large
            if (buffer.length > 10 * 1024 * 1024) { // 10MB limit
                this.emit('debug', 'Buffer too large, resetting');
                buffer = Buffer.alloc(0);
            }
        });

        stdout.on('error', (error) => {
            this.emit('error', error);
        });
    }

    private processFrame(frameBuffer: Buffer): void {
        const now = Date.now();
        this.frameCount++;
        this.lastFrameTime = now;

        const frameData: FrameData = {
            buffer: frameBuffer,
            timestamp: now,
            frameNumber: this.frameCount
        };

        this.emit('frame', frameData);
        this.emit('debug', `Frame ${this.frameCount} extracted, size: ${frameBuffer.length} bytes`);
    }

    private setupAutoRestart(): void {
        if (this.options.restartInterval > 0) {
            this.restartTimer = setInterval(() => {
                if (this.isRunning) {
                    this.emit('debug', `Auto-restarting after ${this.options.restartInterval} minutes`);
                    this.restart().catch((error) => {
                        this.emit('error', error);
                    });
                }
            }, this.options.restartInterval * 60 * 1000);
        }
    }

    private setupHealthCheck(): void {
        // Check for frame activity every 30 seconds
        this.healthCheckTimer = setInterval(() => {
            const now = Date.now();
            const timeSinceLastFrame = now - this.lastFrameTime;
            
            // If no frames for more than 2 * frameInterval + 5 seconds, consider it stalled
            const stallThreshold = (this.options.frameInterval * 2) + 5000;
            
            if (this.lastFrameTime > 0 && timeSinceLastFrame > stallThreshold) {
                this.emit('debug', `Stream appears stalled, last frame ${timeSinceLastFrame}ms ago`);
                this.restart().catch((error) => {
                    this.emit('error', error);
                });
            }
        }, 30000);
    }

    private async handleReconnect(): Promise<void> {
        if (!this.shouldRestart || !this.isRunning) {
            return;
        }

        this.retryCount++;
        
        if (this.retryCount > this.options.maxRetries) {
            this.isRunning = false;
            this.emit('error', new Error(`Max retries (${this.options.maxRetries}) exceeded`));
            return;
        }

        const backoffDelay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 30000); // Exponential backoff, max 30s
        
        this.emit('debug', `Reconnecting in ${backoffDelay}ms (attempt ${this.retryCount}/${this.options.maxRetries})`);
        
        setTimeout(() => {
            if (this.shouldRestart && this.isRunning) {
                this.startDecoder().catch((error) => {
                    this.emit('error', error);
                    this.handleReconnect();
                });
            }
        }, backoffDelay);
    }

    private async stopDecoder(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.process) {
                resolve();
                return;
            }

            this.process.once('exit', () => {
                this.process = null;
                resolve();
            });

            this.process.kill('SIGTERM');
            
            // Force kill after 3 seconds
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 3000);
        });
    }

    private clearTimers(): void {
        if (this.restartTimer) {
            clearInterval(this.restartTimer);
            this.restartTimer = null;
        }
        
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    // Getter methods for status information
    public get status() {
        return {
            isRunning: this.isRunning,
            frameCount: this.frameCount,
            retryCount: this.retryCount,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            lastFrameTime: this.lastFrameTime,
            hasProcess: !!this.process,
            processId: this.process?.pid || 0
        };
    }

    public get frameRate(): number {
        if (!this.startTime || this.frameCount === 0) {
            return 0;
        }
        
        const uptimeSeconds = (Date.now() - this.startTime) / 1000;
        return this.frameCount / uptimeSeconds;
    }

    public get processId(): number {
        return this.process?.pid || 0;
    }
}

// Usage example and utility functions
export class FFmpegDecoderManager {
    private decoders = new Map<string, FFmpegRTSPDecoder>();

    public createDecoder(id: string, options: FFmpegDecoderOptions): FFmpegRTSPDecoder {
        if (this.decoders.has(id)) {
            throw new Error(`Decoder with id '${id}' already exists`);
        }

        const decoder = new FFmpegRTSPDecoder(options);
        this.decoders.set(id, decoder);

        // Auto-cleanup on stop
        decoder.once('stopped', () => {
            this.decoders.delete(id);
        });

        return decoder;
    }

    public getDecoder(id: string): FFmpegRTSPDecoder | undefined {
        return this.decoders.get(id);
    }

    public async stopAll(): Promise<void> {
        const stopPromises = Array.from(this.decoders.values()).map(decoder => decoder.stop());
        await Promise.all(stopPromises);
        this.decoders.clear();
    }

    public getStatus() {
        const status: Record<string, any> = {};
        this.decoders.forEach((decoder, id) => {
            status[id] = decoder.status;
        });
        return status;
    }
}
