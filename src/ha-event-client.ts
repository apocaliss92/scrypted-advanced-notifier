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

type GetHaUrl = () => Promise<{ url: string; accessToken: string }>;

export class HaEventClient implements IHaClient {
    private ws: WebSocket | null = null;
    private msgId = 0;
    private authenticated = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    /** topic → cb[] — used by the REST command endpoint to route incoming commands */
    private subscribers: Map<string, HaMessageCb[]> = new Map();
    /** State cache: topic → last published value. Avoids firing state_update when value hasn't changed. */
    private stateCache: Map<string, string> = new Map();
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
                this.stateCache.clear();
                this.logger.log('[HaEventClient] Authenticated with HA WebSocket');
                this.onAuthenticated?.();
                return;
            }
            if (data.type === 'auth_invalid') {
                this.logger.error('[HaEventClient] HA auth invalid — check access token');
                ws.close();
                return;
            }
        };

        ws.onerror = (e) => {
            this.logger.warn('[HaEventClient] WebSocket error:', (e as any)?.message ?? e);
        };

        ws.onclose = () => {
            this.authenticated = false;
            this.ws = null;
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
        try {
            this.ws.send(JSON.stringify({
                id: this.nextId(),
                type: 'fire_event',
                event_type: eventType,
                event_data: eventData,
            }));
        } catch (e) {
            this.logger.warn('[HaEventClient] Failed to fire event:', e);
        }
    }

    async publish(topic: string, value: any, _retain?: boolean): Promise<void> {
        const strValue = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));

        if (topic.startsWith('homeassistant/device/')) {
            // Skip empty-value publishes (clearRetainedTopic no-ops in WS mode)
            if (!strValue) return;
            const parts = topic.split('/');
            const deviceId = parts[2];
            let payload: any;
            try { payload = typeof value === 'object' ? value : JSON.parse(strValue); } catch { payload = strValue; }
            this.fireEvent(HA_EVENT_ENTITY_CHANGE, {
                device_id: deviceId,
                cmps: payload?.cmps,
                dev: payload?.dev,
            });
        } else {
            // Only fire state_update if value changed (prevents HA event storm).
            // Skip cache for large payloads (e.g. base64 images) to avoid costly string comparison.
            if (strValue.length < 2048) {
                const cached = this.stateCache.get(topic);
                if (cached === strValue) return;
                this.stateCache.set(topic, strValue);
            }
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

    async disconnect(): Promise<void> {
        this.stopped = true;
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
