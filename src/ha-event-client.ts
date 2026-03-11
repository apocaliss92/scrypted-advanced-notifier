/**
 * HaEventClient — IHaClient implementation for the HA REST push transport.
 *
 * Instead of maintaining a WebSocket connection to HA's /api/websocket and
 * firing events with an admin token, the plugin POSTs state updates to the
 * HA custom integration's push endpoint at /api/scrypted_an/push.
 *
 * - publish()   → batches state updates and flushes via REST POST every ~1s
 * - subscribe() → registers in-memory callbacks (commands still arrive via REST from HA)
 * - Heartbeat   → periodic REST POST (no WS ping/pong)
 * - No HA admin token needed — auth via shared ha_secret
 */

import axios from 'axios';
import * as https from 'https';
import { IHaClient, HaMessageCb } from '../../scrypted-apocaliss-base/src/ha-client';

const PUSH_PATH = '/api/scrypted_an/push';
const HEARTBEAT_INTERVAL_MS = 30_000;
const BATCH_FLUSH_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export type GetHaPushConfig = () => Promise<{ haUrl: string; haSecret: string }>;

export class HaEventClient implements IHaClient {
    private batchBuffer: Array<Record<string, unknown>> = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    /** topic → cb[] — used by the REST command endpoint to route incoming commands */
    private subscribers: Map<string, HaMessageCb[]> = new Map();
    /** State cache: topic → last published value. Avoids redundant POSTs. */
    private stateCache: Map<string, string> = new Map();
    private connected = false;
    private consecutiveFailures = 0;
    /** Called after the first successful push (analogous to WS onAuthenticated). */
    onAuthenticated?: () => void;
    private onAuthenticatedFired = false;

    constructor(
        private readonly getConfig: GetHaPushConfig,
        private readonly logger: Console,
    ) {}

    /** Start the REST push transport: verify connectivity and start heartbeat. */
    async connect(): Promise<void> {
        if (this.stopped) return;
        this.logger.log('[HaEventClient] Starting REST push transport');

        // Verify connectivity with an initial heartbeat
        try {
            const { haUrl, haSecret } = await this.getConfig();
            if (!haSecret) {
                this.logger.warn('[HaEventClient] HA Secret is empty — push transport will not work. Click "Regenerate HA Secret" in the plugin Homeassistant settings.');
                return;
            }
            await axios.post(
                `${haUrl}${PUSH_PATH}`,
                { type: 'heartbeat', ts: Date.now() },
                {
                    headers: { 'Authorization': `Bearer ${haSecret}` },
                    timeout: REQUEST_TIMEOUT_MS,
                    httpsAgent,
                },
            );
            this.connected = true;
            this.consecutiveFailures = 0;
            this.logger.log('[HaEventClient] REST push endpoint reachable');
        } catch (e: any) {
            const status = e?.response?.status;
            if (status === 401) {
                this.logger.warn('[HaEventClient] HA Secret mismatch (401). Update the secret in HA → Settings → Integrations → Scrypted Advanced Notifier → Configure → "Update HA Secret", or click "Regenerate HA Secret" in the plugin.');
            } else {
                this.logger.warn('[HaEventClient] REST push endpoint not reachable (will retry on next heartbeat):', (e as Error)?.message ?? e);
            }
        }

        this.startHeartbeat();

        // Fire onAuthenticated so autodiscovery runs
        if (!this.onAuthenticatedFired) {
            this.onAuthenticatedFired = true;
            this.onAuthenticated?.();
        }
    }

    async publish(topic: string, value: any, _retain?: boolean): Promise<void> {
        const strValue = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));

        if (topic.startsWith('homeassistant/device/')) {
            // Entity change — skip empty-value publishes (clearRetainedTopic no-ops in push mode)
            if (!strValue) return;
            const parts = topic.split('/');
            const deviceId = parts[2];
            // Entity changes are rare and important — flush batch first, then send immediately
            await this.flushBatch();
            await this.postPush({ type: 'entity_change', device_id: deviceId });
        } else {
            // Large payloads (base64 images): send lightweight signal
            if (strValue.length >= 2048) {
                this.addToBatch({ type: 'state_update', topic, value: `__image_updated__:${Date.now()}` });
                return;
            }
            // Only send if value changed
            const cached = this.stateCache.get(topic);
            if (cached === strValue) return;
            this.stateCache.set(topic, strValue);
            this.addToBatch({ type: 'state_update', topic, value: strValue });
        }
    }

    async subscribe(topics: string[], cb: HaMessageCb): Promise<void> {
        for (const topic of topics) {
            // Replace callbacks for the topic to prevent accumulation on reconnect
            this.subscribers.set(topic, [cb]);
        }
    }

    async unsubscribe(topics: string[]): Promise<void> {
        for (const topic of topics) {
            this.subscribers.delete(topic);
        }
    }

    async disconnect(): Promise<void> {
        this.stopped = true;
        this.stopHeartbeat();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Flush remaining buffered items
        await this.flushBatch();
        this.connected = false;
    }

    async cleanupAutodiscoveryTopics(_activeTopics: string[]): Promise<void> {
        // No-op: entity lifecycle managed by HA integration via events
    }

    /**
     * Route an incoming REST command to registered subscribers.
     * Called by the plugin's POST /public/ha/command handler.
     */
    routeCommand(topic: string, value: string): void {
        const cbs = this.subscribers.get(topic) ?? [];
        for (const cb of cbs) {
            cb(topic, value).catch(e => this.logger.warn('[HaEventClient] Command cb error:', e));
        }
        // Wildcard matching
        for (const [pattern, patternCbs] of Array.from(this.subscribers.entries())) {
            if (pattern !== topic && this.topicMatches(pattern, topic)) {
                for (const cb of patternCbs) {
                    cb(topic, value).catch(e => this.logger.warn('[HaEventClient] Wildcard cb error:', e));
                }
            }
        }
    }

    get isConnected(): boolean {
        return this.connected;
    }

    // ── Batching ──────────────────────────────────────────────────────────

    private addToBatch(item: Record<string, unknown>): void {
        this.batchBuffer.push(item);
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flushBatch(), BATCH_FLUSH_MS);
        }
    }

    private async flushBatch(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.batchBuffer.length === 0) return;
        const items = this.batchBuffer.splice(0);
        await this.postPush({ type: 'batch', items });
    }

    // ── HTTP ──────────────────────────────────────────────────────────────

    private async postPush(data: Record<string, unknown>): Promise<void> {
        try {
            const { haUrl, haSecret } = await this.getConfig();
            await axios.post(
                `${haUrl}${PUSH_PATH}`,
                data,
                {
                    headers: { 'Authorization': `Bearer ${haSecret}` },
                    timeout: REQUEST_TIMEOUT_MS,
                    httpsAgent,
                },
            );
            if (!this.connected) {
                this.connected = true;
                this.logger.log('[HaEventClient] REST push connection restored');
            }
            this.consecutiveFailures = 0;
        } catch (e: any) {
            this.consecutiveFailures++;
            const status = e?.response?.status;
            if (status === 401 && this.consecutiveFailures === 1) {
                this.logger.warn('[HaEventClient] HA Secret mismatch (401). Update the secret in HA → Settings → Integrations → Scrypted Advanced Notifier → Configure → "Update HA Secret", or click "Regenerate HA Secret" in the plugin.');
            } else if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
                this.logger.warn(`[HaEventClient] REST push failed (${this.consecutiveFailures}x):`, (e as Error)?.message ?? e);
            }
            if (this.connected) {
                this.connected = false;
            }
        }
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.postPush({ type: 'heartbeat', ts: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private topicMatches(pattern: string, topic: string): boolean {
        const pp = pattern.split('/');
        const tp = topic.split('/');
        for (let i = 0; i < pp.length; i++) {
            if (pp[i] === '#') return true;
            if (pp[i] === '+') continue;
            if (pp[i] !== tp[i]) return false;
        }
        return pp.length === tp.length;
    }
}
