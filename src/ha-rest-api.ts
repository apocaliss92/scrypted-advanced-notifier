/**
 * HA REST API endpoints — extracted from main.ts to keep it clean.
 *
 * All endpoints live under /public/ha/ and are authenticated via Bearer token + Origin check.
 * - GET /public/ha/devices   — list available devices for config flow
 * - GET /public/ha/entities  — full entity discovery payload (cmps/dev/states)
 * - POST /public/ha/command  — route a command from HA to registered subscribers
 * - GET /public/ha/image     — serve detection images from disk
 */

import { HttpRequest, HttpResponse } from "@scrypted/sdk";
import fs from 'fs';
import path from 'path';
import { IHaClient, HaMessageCb } from '../../scrypted-apocaliss-base/src/ha-client';
import { HaEventClient } from './ha-event-client';
import {
    alarmSystemId,
    idPrefix,
    peopleTrackerId,
    pluginIds,
    setupAlarmSystemAutodiscovery,
    setupCameraAutodiscovery,
    setupNotifierAutodiscovery,
    setupPluginAutodiscovery,
    setupSensorAutodiscovery,
} from "./mqtt-utils";
import { getActiveRules, ALARM_SYSTEM_NATIVE_ID } from "./utils";

/**
 * DiscoveryCapture — Mock IHaClient that captures autodiscovery payloads
 * instead of sending them over a real transport.
 */
class DiscoveryCapture implements IHaClient {
    readonly captures = new Map<string, { cmps: any; dev: any }>();
    readonly initialStates: Array<{ topic: string; value: string }> = [];
    async publish(topic: string, value: any): Promise<void> {
        if (!value && value !== '') return;
        const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (topic.startsWith('homeassistant/device/')) {
            try {
                const payload = JSON.parse(strValue);
                if (!payload?.cmps) return;
                // Use dev.ids[0] as device ID (matches HA device registry), fallback to topic path
                const deviceId = payload.dev?.ids?.[0] ?? topic.split('/')[2];
                this.captures.set(deviceId, { cmps: payload.cmps, dev: payload.dev });
            } catch { /* ignore non-JSON */ }
        } else if (strValue !== '' && strValue.length < 2048) {
            // Capture state publishes (initial entity values), skip large payloads (e.g. base64 images)
            this.initialStates.push({ topic, value: strValue });
        } else if (strValue.length >= 2048) {
            // Large payloads (images): send lightweight signal so HA knows an image exists
            this.initialStates.push({ topic, value: `__image_updated__:${Date.now()}` });
        }
    }
    async subscribe(): Promise<void> {}
    async unsubscribe(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async cleanupAutodiscoveryTopics(): Promise<void> {}
}

/** Minimal interface for the plugin instance — avoids importing the full class (circular dep). */
export interface HaRestApiPlugin {
    storageSettings: { values: Record<string, any> };
    currentCameraMixinsMap: Record<string, any>;
    currentSensorMixinsMap: Record<string, any>;
    currentNotifierMixinsMap: Record<string, any>;
    wsHaClient: HaEventClient | null;
    allAvailableRules: any[] | undefined;
    getLogger(): Console;
    getKnownPeople(source: any): Promise<string[]>;
    getDevice(nativeId: string): Promise<any>;
    getFsPaths(props: { cameraId?: string; triggerTime?: number }): {
        storagePath: string;
        cameraPath?: string;
        decoderpath?: string;
        framePath?: string;
    };
}

/**
 * Handle all /public/ha/* REST requests.
 * Returns true if the request was handled, false otherwise.
 */
export async function handleHaRestApi(
    plugin: HaRestApiPlugin,
    pathname: string,
    url: URL,
    request: HttpRequest,
    response: HttpResponse,
    corsHeaders: () => Record<string, string>,
): Promise<boolean> {
    if (!pathname.includes('public/ha/')) return false;

    const logger = plugin.getLogger();
    const { haSecret, haAllowedOrigins } = plugin.storageSettings.values;
    const origin = request.headers?.['origin'] ?? '';
    const allowedOrigins = (haAllowedOrigins as string ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const originAllowed = allowedOrigins.length > 0 && allowedOrigins.some(
        (o: string) => o.replace(/\/$/, '').toLowerCase() === (origin as string).replace(/\/$/, '').toLowerCase()
    );
    const authHeader = request.headers?.['authorization'] ?? '';
    const token = (authHeader as string).replace(/^Bearer\s+/i, '');

    if (!originAllowed) {
        logger.warn(`[HA] Origin not allowed: '${origin}'. Allowed: [${allowedOrigins.join(', ')}]. Add this origin to haAllowedOrigins in plugin settings.`);
        response.send('Forbidden', { code: 403, headers: corsHeaders() });
        return true;
    }
    if (token !== haSecret) {
        response.send('Unauthorized', { code: 401, headers: corsHeaders() });
        return true;
    }

    if (pathname.includes('public/ha/devices')) {
        return handleDevices(plugin, response, corsHeaders);
    }
    if (pathname.includes('public/ha/entities')) {
        return handleEntities(plugin, url, response, corsHeaders);
    }
    if (pathname.includes('public/ha/command') && request.method === 'POST') {
        return handleCommand(plugin, request, response, corsHeaders);
    }
    if (pathname.includes('public/ha/image')) {
        return handleImage(plugin, url, response, corsHeaders);
    }

    response.send('Not found', { code: 404, headers: corsHeaders() });
    return true;
}

// ---------------------------------------------------------------------------
// /public/ha/devices
// ---------------------------------------------------------------------------

function handleDevices(
    plugin: HaRestApiPlugin,
    response: HttpResponse,
    corsHeaders: () => Record<string, string>,
): true {
    const cameraDevices = Object.values(plugin.currentCameraMixinsMap).map(mixin => ({
        device_id: `${idPrefix}-${mixin.id}`,
        device_name: `${mixin.name} (${mixin.type ?? 'Camera'})`,
    }));
    const sensorDevices = Object.values(plugin.currentSensorMixinsMap).map(mixin => ({
        device_id: `${idPrefix}-${mixin.id}`,
        device_name: `${mixin.name} (${mixin.type ?? 'Sensor'})`,
    }));
    const notifierDevices = Object.values(plugin.currentNotifierMixinsMap).map(mixin => ({
        device_id: `${idPrefix}-${mixin.id}`,
        device_name: `${mixin.name} (Notifier)`,
    }));
    const specialDevices = [
        { device_id: pluginIds, device_name: 'Advanced Notifier (Plugin)' },
        { device_id: `${idPrefix}-${peopleTrackerId}`, device_name: 'Advanced Notifier (People tracker)' },
        { device_id: `${idPrefix}-${alarmSystemId}`, device_name: 'Advanced Notifier (Alarm system)' },
    ];
    const devices = [...cameraDevices, ...sensorDevices, ...notifierDevices, ...specialDevices];
    response.send(JSON.stringify({ devices }), {
        code: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
    return true;
}

// ---------------------------------------------------------------------------
// /public/ha/entities
// ---------------------------------------------------------------------------

async function handleEntities(
    plugin: HaRestApiPlugin,
    url: URL,
    response: HttpResponse,
    corsHeaders: () => Record<string, string>,
): Promise<true> {
    const logger = plugin.getLogger();
    const requestedIds = (url.searchParams.get('device_ids') ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const shouldInclude = (id: string) => requestedIds.length === 0 || requestedIds.includes(id);
    const capture = new DiscoveryCapture();
    const { facesSourceForMqtt } = plugin.storageSettings.values;
    const rules = plugin.allAvailableRules ?? [];

    logger.log(`[HA entities] Requested device IDs: [${requestedIds.join(', ')}]`);

    // Build device_id → name map for response
    const deviceNameMap = new Map<string, string>();
    for (const m of Object.values(plugin.currentCameraMixinsMap)) deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
    for (const m of Object.values(plugin.currentSensorMixinsMap)) deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
    for (const m of Object.values(plugin.currentNotifierMixinsMap)) deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
    deviceNameMap.set(pluginIds, 'Advanced Notifier (Plugin)');
    deviceNameMap.set(`${idPrefix}-${peopleTrackerId}`, 'Advanced Notifier (People tracker)');
    deviceNameMap.set(`${idPrefix}-${alarmSystemId}`, 'Advanced Notifier (Alarm system)');

    const tasks: Promise<unknown>[] = [];

    // Plugin + people tracker
    if (shouldInclude(pluginIds) || shouldInclude(`${idPrefix}-${peopleTrackerId}`)) {
        logger.log(`[HA entities] Including plugin (${pluginIds}) / people tracker (${idPrefix}-${peopleTrackerId})`);
        tasks.push(setupPluginAutodiscovery({
            mqttClient: capture,
            people: await plugin.getKnownPeople(facesSourceForMqtt),
            console: logger,
            rules,
        }).catch(e => logger.error('[HA entities] Plugin autodiscovery error', e)));
    }

    // Alarm system
    const alarmDeviceId = `${idPrefix}-${alarmSystemId}`;
    logger.log(`[HA entities] Alarm system ID: ${alarmDeviceId}, shouldInclude: ${shouldInclude(alarmDeviceId)}`);
    if (shouldInclude(alarmDeviceId)) {
        try {
            const alarm = await plugin.getDevice(ALARM_SYSTEM_NATIVE_ID) as any;
            const supportedModes = alarm?.securitySystemState?.supportedModes ?? [];
            logger.log(`[HA entities] Alarm system found, supportedModes: [${supportedModes.join(', ')}]`);
            tasks.push(setupAlarmSystemAutodiscovery({
                mqttClient: capture,
                console: logger,
                supportedModes,
            }).catch(e => logger.error('[HA entities] Alarm autodiscovery error', e)));
        } catch (e) {
            logger.error('[HA entities] Error getting alarm system device', e);
        }
    }

    // Cameras
    for (const mixin of Object.values(plugin.currentCameraMixinsMap)) {
        if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
        tasks.push((async () => {
            try {
                const zones = await mixin.getMqttZones();
                await setupCameraAutodiscovery({
                    mqttClient: capture,
                    device: mixin.cameraDevice as any,
                    console: logger,
                    rules,
                    zones,
                    accessorySwitchKinds: (mixin as any).cameraAccessorySwitchKinds,
                    streamDestinations: mixin.getStreamDestinations(),
                });
            } catch (e) {
                logger.error(`Error capturing camera ${mixin.id} discovery`, e);
            }
        })());
    }

    // Sensors
    for (const mixin of Object.values(plugin.currentSensorMixinsMap)) {
        if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
        tasks.push((async () => {
            try {
                const { availableDetectionRules } = await getActiveRules({
                    device: mixin as any,
                    console: logger,
                    plugin: plugin as any,
                    deviceStorage: mixin.storageSettings,
                });
                await setupSensorAutodiscovery({
                    mqttClient: capture,
                    device: mixin.sensorDevice as any,
                    rules: availableDetectionRules,
                    console: logger,
                });
            } catch (e) {
                logger.error(`Error capturing sensor ${mixin.id} discovery`, e);
            }
        })());
    }

    // Notifiers
    for (const mixin of Object.values(plugin.currentNotifierMixinsMap)) {
        if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
        tasks.push(setupNotifierAutodiscovery({
            mqttClient: capture,
            device: mixin.notifierDevice as any,
            console: logger,
        }).catch(logger.error));
    }

    await Promise.all(tasks);

    logger.log(`[HA entities] Captured ${capture.captures.size} devices: [${Array.from(capture.captures.keys()).join(', ')}], ${capture.initialStates.length} initial states`);

    const devices = Array.from(capture.captures.entries()).map(([device_id, { cmps, dev }]) => ({
        device_id,
        device_name: deviceNameMap.get(device_id) ?? device_id,
        cmps,
        dev,
    }));

    for (const d of devices) {
        logger.log(`[HA entities] Device: ${d.device_id} (${d.device_name}), cmps: [${Object.keys(d.cmps).join(', ')}]`);
    }

    response.send(JSON.stringify({ devices, states: capture.initialStates }), {
        code: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
    return true;
}

// ---------------------------------------------------------------------------
// /public/ha/command
// ---------------------------------------------------------------------------

function handleCommand(
    plugin: HaRestApiPlugin,
    request: HttpRequest,
    response: HttpResponse,
    corsHeaders: () => Record<string, string>,
): true {
    let body: any;
    try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch { body = {}; }
    const topic = body?.topic ?? '';
    const value = body?.value ?? '';
    if (plugin.wsHaClient) {
        plugin.wsHaClient.routeCommand(topic, value);
    }
    response.send('{}', { code: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
    return true;
}

// ---------------------------------------------------------------------------
// /public/ha/image
// ---------------------------------------------------------------------------

async function handleImage(
    plugin: HaRestApiPlugin,
    url: URL,
    response: HttpResponse,
    corsHeaders: () => Record<string, string>,
): Promise<true> {
    const logger = plugin.getLogger();
    const topic = url.searchParams.get('topic') ?? '';
    const deviceId = url.searchParams.get('device_id') ?? '';

    if (!topic && !deviceId) {
        response.send('Missing topic or device_id', { code: 400, headers: corsHeaders() });
        return true;
    }

    let scryptedId: string;
    let classFilter: string | null = null;

    if (topic) {
        // Topic format: scrypted-an/scrypted-an-{scryptedId}/{entity}_last_image
        const parts = topic.split('/');
        if (parts.length < 3) {
            response.send('Invalid topic', { code: 400, headers: corsHeaders() });
            return true;
        }
        scryptedId = parts[1].replace(`${idPrefix}-`, '');
        classFilter = parts[2].replace(/_last_image$/, '');
    } else {
        // device_id format: scrypted-an-{scryptedId} — returns most recent image of any class
        scryptedId = deviceId.replace(`${idPrefix}-`, '');
    }

    try {
        const { storagePath } = plugin.getFsPaths({});
        const detectionsDir = path.join(storagePath, scryptedId, 'detections');
        logger.log(`[HA Image] Looking in ${detectionsDir}, classFilter=${classFilter}`);
        const files = await fs.promises.readdir(detectionsDir);
        const matching = files.filter(f => {
            if (!f.endsWith('.jpg')) return false;
            if (!classFilter) return true;
            return f.split('.')[0].split('__')[0] === classFilter;
        });
        logger.log(`[HA Image] Found ${files.length} total files, ${matching.length} matching`);

        if (matching.length > 0) {
            let bestFile = matching[0];
            let bestMtime = 0;
            for (const f of matching) {
                const stat = await fs.promises.stat(path.join(detectionsDir, f));
                if (stat.mtimeMs > bestMtime) {
                    bestMtime = stat.mtimeMs;
                    bestFile = f;
                }
            }
            logger.log(`[HA Image] Serving ${bestFile} (${path.join(detectionsDir, bestFile)})`);
            const jpeg = await fs.promises.readFile(path.join(detectionsDir, bestFile));
            response.send(jpeg, {
                code: 200,
                headers: { ...corsHeaders(), 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' },
            });
            return true;
        }
        logger.log(`[HA Image] No matching files for scryptedId=${scryptedId}, classFilter=${classFilter}, files: [${files.slice(0, 10).join(', ')}]`);
    } catch (e) {
        logger.log(`[HA Image] Error serving image: ${e}`);
    }

    response.send('Not found', { code: 404, headers: corsHeaders() });
    return true;
}
