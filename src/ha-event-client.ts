/**
 * HaEventClient — IHaClient implementation for the HA WebSocket transport.
 *
 * Scrypted connects as a CLIENT to HA's native WebSocket API (/api/websocket).
 * - publish() → fires custom HA events (scrypted_an_state_update / scrypted_an_entity_change)
 * - subscribe() → registers in-memory callbacks invoked by the REST POST /public/ha/command endpoint
 * - Reconnects automatically on disconnect.
 */

import { IHaClient, HaMessageCb } from '../../scrypted-apocaliss-base/src/ha-client';

const HA_WS_PATH = '/api/websocket';
const HA_EVENT_STATE_UPDATE = 'scrypted_an_state_update';
const HA_EVENT_ENTITY_CHANGE = 'scrypted_an_entity_change';
const HA_EVENT_HEARTBEAT = 'scrypted_an_heartbeat';
const HEARTBEAT_INTERVAL_MS = 30_000;

type GetHaUrl = () => Promise<{ url: string; accessToken: string }>;

export class HaEventClient implements IHaClient {
    private ws: WebSocket | null = null;
    private msgId = 0;
    private authenticated = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongReceived = true;
    private stopped = false;
    /** topic → cb[] — used by the REST command endpoint to route incoming commands */
    private subscribers: Map<string, HaMessageCb[]> = new Map();
    /** State cache: topic → last published value. Avoids firing state_update when value hasn't changed. */
    private stateCache: Map<string, string> = new Map();
    /** Track pending fire_event results to detect failures */
    private pendingResults: Map<number, string> = new Map();
    /** Called each time the WS authenticates (first connect or reconnect). */
    onAuthenticated?: () => void;

    constructor(
        private readonly getHaUrl: GetHaUrl,
        private readonly logger: Console,
    ) {}

    /** Returns the next unique message id for the HA WS protocol. */
    private nextId(): number {
        return ++this.msgId;
    }

    /** Connect (or reconnect) to HA WebSocket. Called automatically. */
    async connect(): Promise<void> {
        if (this.stopped || this.ws) return;
        let haUrl: string;
        let accessToken: string;
        try {
            ({ url: haUrl, accessToken } = await this.getHaUrl());
        } catch (e) {
            this.logger.warn('[HaEventClient] Cannot get HA URL, will retry in 30s:', e);
            this.scheduleReconnect(30_000);
            return;
        }

        const wsUrl = haUrl.replace(/^http/, 'ws').replace(/\/$/, '') + HA_WS_PATH;
        this.logger.log('[HaEventClient] Connecting to HA WS:', wsUrl);

        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            this.logger.warn('[HaEventClient] WebSocket construct failed:', e);
            this.scheduleReconnect(10_000);
            return;
        }

        ws.onmessage = (event) => {
            let data: any;
            try { data = JSON.parse(event.data as string); } catch { return; }

            if (data.type === 'auth_required') {
                ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }));
                return;
            }
            if (data.type === 'auth_ok') {
                this.authenticated = true;
                this.logger.log('[HaEventClient] Authenticated with HA WebSocket');
                this.startHeartbeat();
                this.startPing();
                this.replayStateCache();
                this.onAuthenticated?.();
                return;
            }
            if (data.type === 'auth_invalid') {
                this.logger.error('[HaEventClient] HA auth invalid — check access token');
                ws.close();
                return;
            }
            // Track fire_event results
            if (data.type === 'result') {
                this.pongReceived = true; // Any message from HA counts as alive
                const label = this.pendingResults.get(data.id);
                if (label) {
                    this.pendingResults.delete(data.id);
                    if (!data.success) {
                        this.logger.warn(`[HaEventClient] fire_event FAILED for ${label}: ${JSON.stringify(data.error)}`);
                    }
                }
                return;
            }
            // HA sends pong responses
            if (data.type === 'pong') {
                this.pongReceived = true;
                return;
            }
        };

        ws.onerror = (e) => {
            this.logger.warn('[HaEventClient] WebSocket error:', (e as any)?.message ?? e);
        };

        ws.onclose = () => {
            this.authenticated = false;
            this.ws = null;
            this.stopHeartbeat();
            this.stopPing();
            this.logger.log('[HaEventClient] HA WS closed, reconnecting in 10s');
            if (!this.stopped) this.scheduleReconnect(10_000);
        };

        this.ws = ws;
    }

    private scheduleReconnect(delayMs: number): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch(e => this.logger.warn('[HaEventClient] Reconnect error:', e));
        }, delayMs);
    }

    private fireEvent(eventType: string, eventData: Record<string, unknown>): void {
        if (!this.ws || !this.authenticated) return;
        const id = this.nextId();
        try {
            this.pendingResults.set(id, eventType);
            this.ws.send(JSON.stringify({
                id,
                type: 'fire_event',
                event_type: eventType,
                event_data: eventData,
            }));
        } catch (e) {
            this.pendingResults.delete(id);
            this.logger.warn('[HaEventClient] Failed to fire event:', e);
            // Send failure likely means dead connection — force reconnect
            this.forceReconnect();
        }
    }

    private forceReconnect(): void {
        this.logger.warn('[HaEventClient] Forcing reconnect due to dead connection');
        this.stopHeartbeat();
        this.stopPing();
        this.authenticated = false;
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        if (!this.stopped) this.scheduleReconnect(5_000);
    }

    async publish(topic: string, value: any, _retain?: boolean): Promise<void> {
        const strValue = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));

        if (topic.startsWith('homeassistant/device/')) {
            // Skip empty-value publishes (clearRetainedTopic no-ops in WS mode)
            if (!strValue) return;
            const parts = topic.split('/');
            const deviceId = parts[2];
            // Lightweight notification — HA will fetch full details via REST
            this.fireEvent(HA_EVENT_ENTITY_CHANGE, { device_id: deviceId });
        } else {
            // Large payloads (base64 images): send lightweight signal, image served from disk via REST
            if (strValue.length >= 2048) {
                this.fireEvent(HA_EVENT_STATE_UPDATE, { topic, value: `__image_updated__:${Date.now()}` });
                return;
            }
            // Only fire state_update if value changed (prevents HA event storm).
            const cached = this.stateCache.get(topic);
            if (cached === strValue) return;
            this.stateCache.set(topic, strValue);
            this.fireEvent(HA_EVENT_STATE_UPDATE, { topic, value: strValue });
        }
    }

    async subscribe(topics: string[], cb: HaMessageCb): Promise<void> {
        for (const topic of topics) {
            const existing = this.subscribers.get(topic) ?? [];
            existing.push(cb);
            this.subscribers.set(topic, existing);
        }
    }

    async unsubscribe(topics: string[]): Promise<void> {
        for (const topic of topics) {
            this.subscribers.delete(topic);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.logger.log('[HaEventClient] Starting heartbeat timer (every 30s)');
        this.heartbeatTimer = setInterval(() => {
            this.logger.log('[HaEventClient] Sending heartbeat');
            this.fireEvent(HA_EVENT_HEARTBEAT, { ts: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
        // Send first heartbeat immediately
        this.logger.log('[HaEventClient] Sending initial heartbeat');
        this.fireEvent(HA_EVENT_HEARTBEAT, { ts: Date.now() });
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /** Ping HA every 30s to detect dead connections. HA supports { type: 'ping' } → { type: 'pong' }. */
    private startPing(): void {
        this.stopPing();
        this.pongReceived = true;
        this.pingTimer = setInterval(() => {
            if (!this.pongReceived) {
                this.logger.warn('[HaEventClient] No pong received — connection seems dead');
                this.forceReconnect();
                return;
            }
            this.pongReceived = false;
            if (this.ws && this.authenticated) {
                try {
                    this.ws.send(JSON.stringify({ id: this.nextId(), type: 'ping' }));
                } catch {
                    this.forceReconnect();
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    /** Replay all cached state values after reconnection so HA gets current values. */
    private replayStateCache(): void {
        if (this.stateCache.size === 0) return;
        this.logger.log(`[HaEventClient] Replaying ${this.stateCache.size} cached states`);
        for (const [topic, value] of this.stateCache) {
            this.fireEvent(HA_EVENT_STATE_UPDATE, { topic, value });
        }
    }

    async disconnect(): Promise<void> {
        this.stopped = true;
        this.stopHeartbeat();
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        this.authenticated = false;
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
        for (const [pattern, patternCbs] of this.subscribers.entries()) {
            if (pattern !== topic && this.topicMatches(pattern, topic)) {
                for (const cb of patternCbs) {
                    cb(topic, value).catch(e => this.logger.warn('[HaEventClient] Wildcard cb error:', e));
                }
            }
        }
    }

    get isConnected(): boolean {
        return this.authenticated;
    }

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
