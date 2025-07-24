import { FFmpegRTSPDecoder, FFmpegDecoderManager, FrameData } from './ffmpegDecoder';
import { createWriteStream } from 'fs';
import { join } from 'path';

/**
 * Esempio di utilizzo del decoder FFmpeg RTSP
 * Mostra come integrare il decoder nel sistema esistente
 */

export class CameraDecoderIntegration {
    private decoder: FFmpegRTSPDecoder | null = null;
    private frameBuffer: FrameData[] = [];
    private maxBufferSize = 10; // Mantieni solo gli ultimi 10 frames
    private saveFramesToDisk = false;
    private framesDirectory = '';

    constructor(
        private rtspUrl: string,
        private logger: Console,
        private options?: {
            frameInterval?: number;
            restartInterval?: number;
            saveFrames?: boolean;
            framesPath?: string;
        }
    ) {
        this.saveFramesToDisk = options?.saveFrames || false;
        this.framesDirectory = options?.framesPath || './frames';
    }

    public async start(): Promise<void> {
        if (this.decoder) {
            this.logger.log('Decoder already running');
            return;
        }

        this.decoder = new FFmpegRTSPDecoder({
            rtspUrl: this.rtspUrl,
            frameInterval: this.options?.frameInterval || 100, // 10 FPS
            restartInterval: this.options?.restartInterval || 5, // Restart ogni 5 minuti
            maxRetries: 3,
            timeout: 15000,
            outputFormat: 'jpeg',
            quality: 2,
            width: 1920, // Risoluzione fissa per consistenza
        });

        this.setupEventHandlers();

        try {
            await this.decoder.start();
            this.logger.log(`RTSP decoder started for ${this.rtspUrl}`);
        } catch (error) {
            this.logger.error(`Failed to start RTSP decoder: ${error.message}`);
            throw error;
        }
    }

    public async stop(): Promise<void> {
        if (!this.decoder) {
            return;
        }

        try {
            await this.decoder.stop();
            this.decoder = null;
            this.frameBuffer = [];
            this.logger.log('RTSP decoder stopped');
        } catch (error) {
            this.logger.error(`Error stopping decoder: ${error.message}`);
        }
    }

    public async restart(): Promise<void> {
        if (!this.decoder) {
            throw new Error('Decoder not running');
        }

        try {
            await this.decoder.restart();
            this.logger.log('RTSP decoder restarted');
        } catch (error) {
            this.logger.error(`Error restarting decoder: ${error.message}`);
            throw error;
        }
    }

    public getLatestFrame(): FrameData | null {
        return this.frameBuffer.length > 0 ? this.frameBuffer[this.frameBuffer.length - 1] : null;
    }

    public getFrameHistory(): FrameData[] {
        return [...this.frameBuffer];
    }

    public getStatus() {
        if (!this.decoder) {
            return { running: false };
        }

        return {
            running: true,
            ...this.decoder.status,
            frameRate: this.decoder.frameRate,
            bufferSize: this.frameBuffer.length,
        };
    }

    private setupEventHandlers(): void {
        if (!this.decoder) return;

        // Nuovo frame ricevuto
        this.decoder.on('frame', (frameData: FrameData) => {
            this.handleNewFrame(frameData);
        });

        // Eventi di stato
        this.decoder.on('starting', () => {
            this.logger.log('Decoder starting...');
        });

        this.decoder.on('started', () => {
            this.logger.log('Decoder started successfully');
        });

        this.decoder.on('restarting', () => {
            this.logger.log('Decoder restarting...');
        });

        this.decoder.on('restarted', () => {
            this.logger.log('Decoder restarted successfully');
        });

        this.decoder.on('stopped', () => {
            this.logger.log('Decoder stopped');
        });

        // Gestione errori
        this.decoder.on('error', (error: Error) => {
            this.logger.error(`Decoder error: ${error.message}`);
            // Puoi implementare qui la logica di recovery personalizzata
        });

        // Debug info (opzionale)
        this.decoder.on('debug', (message: string) => {
            // Decommentare per debug dettagliato
            // this.logger.log(`Decoder debug: ${message}`);
        });
    }

    private handleNewFrame(frameData: FrameData): void {
        // Aggiungi al buffer circolare
        this.frameBuffer.push(frameData);
        
        // Mantieni solo gli ultimi N frames
        if (this.frameBuffer.length > this.maxBufferSize) {
            this.frameBuffer.shift();
        }

        // Salva su disco se richiesto
        if (this.saveFramesToDisk) {
            this.saveFrameToDisk(frameData).catch(error => {
                this.logger.error(`Error saving frame: ${error.message}`);
            });
        }

        // Log ogni 100 frames per monitoraggio
        if (frameData.frameNumber % 100 === 0) {
            this.logger.log(`Processed ${frameData.frameNumber} frames, current FPS: ${this.decoder?.frameRate.toFixed(2)}`);
        }
    }

    private async saveFrameToDisk(frameData: FrameData): Promise<void> {
        try {
            const filename = `frame_${frameData.frameNumber}_${frameData.timestamp}.jpg`;
            const filepath = join(this.framesDirectory, filename);
            
            const writeStream = createWriteStream(filepath);
            writeStream.write(frameData.buffer);
            writeStream.end();
        } catch (error) {
            throw new Error(`Failed to save frame: ${error.message}`);
        }
    }

    // Metodo per ottenere un frame come MediaObject (compatibile con Scrypted)
    public async getFrameAsMediaObject(): Promise<any> {
        const latestFrame = this.getLatestFrame();
        if (!latestFrame) {
            throw new Error('No frames available');
        }

        // Assumendo che sdk.mediaManager sia disponibile nel contesto
        // return await sdk.mediaManager.createMediaObject(latestFrame.buffer, 'image/jpeg');
        
        // Per ora ritorniamo i dati grezzi
        return {
            buffer: latestFrame.buffer,
            mimeType: 'image/jpeg',
            timestamp: latestFrame.timestamp,
        };
    }
}

/**
 * Factory per creare integrazioni decoder per multiple camere
 */
export class MultiCameraDecoderManager {
    private decoders = new Map<string, CameraDecoderIntegration>();
    private globalManager = new FFmpegDecoderManager();

    constructor(private logger: Console) {}

    public async addCamera(
        cameraId: string, 
        rtspUrl: string, 
        options?: {
            frameInterval?: number;
            restartInterval?: number;
            saveFrames?: boolean;
            framesPath?: string;
        }
    ): Promise<void> {
        if (this.decoders.has(cameraId)) {
            throw new Error(`Camera decoder ${cameraId} already exists`);
        }

        const decoder = new CameraDecoderIntegration(rtspUrl, this.logger, options);
        this.decoders.set(cameraId, decoder);

        try {
            await decoder.start();
            this.logger.log(`Camera decoder ${cameraId} added and started`);
        } catch (error) {
            this.decoders.delete(cameraId);
            throw error;
        }
    }

    public async removeCamera(cameraId: string): Promise<void> {
        const decoder = this.decoders.get(cameraId);
        if (!decoder) {
            return;
        }

        await decoder.stop();
        this.decoders.delete(cameraId);
        this.logger.log(`Camera decoder ${cameraId} removed`);
    }

    public getCamera(cameraId: string): CameraDecoderIntegration | undefined {
        return this.decoders.get(cameraId);
    }

    public getAllCameraStatus(): Record<string, any> {
        const status: Record<string, any> = {};
        this.decoders.forEach((decoder, cameraId) => {
            status[cameraId] = decoder.getStatus();
        });
        return status;
    }

    public async stopAll(): Promise<void> {
        const stopPromises = Array.from(this.decoders.values()).map(decoder => decoder.stop());
        await Promise.all(stopPromises);
        this.decoders.clear();
        this.logger.log('All camera decoders stopped');
    }

    public async restartAll(): Promise<void> {
        const restartPromises = Array.from(this.decoders.values()).map(decoder => decoder.restart());
        await Promise.all(restartPromises);
        this.logger.log('All camera decoders restarted');
    }
}

// Esempio di utilizzo nel contesto del cameraMixin
export function integrateWithCameraMixin(cameraMixin: any): CameraDecoderIntegration | null {
    try {
        const rtspUrl = cameraMixin.rtspUrl;
        if (!rtspUrl) {
            cameraMixin.getLogger().log('No RTSP URL available for decoder integration');
            return null;
        }

        const decoder = new CameraDecoderIntegration(
            rtspUrl,
            cameraMixin.getLogger(),
            {
                frameInterval: 100, // 10 FPS
                restartInterval: 5, // Restart ogni 5 minuti
                saveFrames: false, // Non salvare su disco per default
            }
        );

        // Integra con il lifecycle del cameraMixin
        const originalRelease = cameraMixin.release.bind(cameraMixin);
        cameraMixin.release = async function() {
            await decoder.stop();
            return originalRelease();
        };

        // Avvia il decoder
        decoder.start().catch(error => {
            cameraMixin.getLogger().error(`Failed to start integrated decoder: ${error.message}`);
        });

        return decoder;
    } catch (error) {
        cameraMixin.getLogger().error(`Error integrating decoder: ${error.message}`);
        return null;
    }
}
