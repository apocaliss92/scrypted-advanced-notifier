/**
 * HA REST API endpoints — extracted from main.ts to keep it clean.
 *
 * All endpoints live under /public/ha/ and are authenticated via Bearer token + Origin check.
 * - GET /public/ha/devices   — list available devices for config flow
 * - GET /public/ha/entities  — full entity discovery payload (cmps/dev/states)
 * - POST /public/ha/command  — route a command from HA to registered subscribers
 * - GET /public/ha/image     — serve detection images from disk
 * - GET /public/ha/snapshot  — take a live snapshot via takePicture and serve it
 */

import sdk, {
  HttpRequest,
  HttpResponse,
  SecuritySystem,
  ScryptedDeviceBase,
} from "@scrypted/sdk";
import fs from "fs";
import path from "path";
import { IHaClient } from "../../scrypted-apocaliss-base/src/ha-client";
import { HaEventClient } from "./ha-event-client";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import {
  alarmSystemId,
  CameraAccessorySwitchKind,
  idPrefix,
  peopleTrackerId,
  pluginIds,
  setupAlarmSystemAutodiscovery,
  setupCameraAutodiscovery,
  setupNotifierAutodiscovery,
  setupPluginAutodiscovery,
  setupSensorAutodiscovery,
} from "./mqtt-utils";
import {
  BaseRule,
  DeviceInterface,
  getActiveRules,
  ALARM_SYSTEM_NATIVE_ID,
  ScryptedEventSource,
} from "./utils";

/**
 * DiscoveryCapture — Mock IHaClient that captures autodiscovery payloads
 * instead of sending them over a real transport.
 */
class DiscoveryCapture implements IHaClient {
  readonly captures = new Map<
    string,
    { cmps: Record<string, unknown>; dev: Record<string, unknown> }
  >();
  readonly initialStates: Array<{ topic: string; value: string }> = [];
  async publish(topic: string, value: unknown): Promise<void> {
    if (!value && value !== "") return;
    const strValue =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    if (topic.startsWith("homeassistant/device/")) {
      try {
        const payload = JSON.parse(strValue);
        if (!payload?.cmps) return;
        const deviceId = payload.dev?.ids?.[0] ?? topic.split("/")[2];
        this.captures.set(deviceId, { cmps: payload.cmps, dev: payload.dev });
      } catch {
        /* ignore non-JSON */
      }
    } else if (strValue !== "" && strValue.length < 2048) {
      this.initialStates.push({ topic, value: strValue });
    } else if (strValue.length >= 2048) {
      this.initialStates.push({
        topic,
        value: `__image_updated__:${Date.now()}`,
      });
    }
  }
  async subscribe(): Promise<void> { }
  async unsubscribe(): Promise<void> { }
  async disconnect(): Promise<void> { }
  async cleanupAutodiscoveryTopics(): Promise<void> { }
}

/** Minimal interface for the plugin instance — avoids importing the full class (circular dep). */
export interface HaRestApiPlugin {
  storageSettings: { values: Record<string, unknown> };
  currentCameraMixinsMap: Record<string, AdvancedNotifierCameraMixin>;
  currentSensorMixinsMap: Record<string, AdvancedNotifierSensorMixin>;
  currentNotifierMixinsMap: Record<string, AdvancedNotifierNotifierMixin>;
  wsHaClient: HaEventClient | null;
  allAvailableRules: BaseRule[];
  getLogger(): Console;
  getKnownPeople(source: ScryptedEventSource): Promise<string[]>;
  getDevice(nativeId: string): Promise<ScryptedDeviceBase | undefined>;
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
  if (!pathname.includes("public/ha/")) return false;

  const logger = plugin.getLogger();
  const { haSecret, haAllowedOrigins } = plugin.storageSettings.values;
  const origin = request.headers?.["origin"] ?? "";
  const allowedOrigins = String(haAllowedOrigins ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Allow empty origin (server-to-server requests from HA don't set Origin header)
  const originAllowed =
    !origin ||
    (allowedOrigins.length > 0 &&
      allowedOrigins.some(
        (o) =>
          o.replace(/\/$/, "").toLowerCase() ===
          String(origin).replace(/\/$/, "").toLowerCase(),
      ));
  const authHeader = request.headers?.["authorization"] ?? "";
  const token = String(authHeader).replace(/^Bearer\s+/i, "");

  if (!originAllowed) {
    logger.warn(
      `[HA] Origin not allowed: '${origin}'. Allowed: [${allowedOrigins.join(", ")}]. Add this origin to haAllowedOrigins in plugin settings.`,
    );
    response.send("Forbidden", { code: 403, headers: corsHeaders() });
    return true;
  }
  if (token !== haSecret) {
    response.send("Unauthorized", { code: 401, headers: corsHeaders() });
    return true;
  }

  if (pathname.includes("public/ha/devices")) {
    return handleDevices(plugin, response, corsHeaders);
  }
  if (pathname.includes("public/ha/entities")) {
    return handleEntities(plugin, url, response, corsHeaders);
  }
  if (pathname.includes("public/ha/command") && request.method === "POST") {
    return handleCommand(plugin, request, response, corsHeaders);
  }
  if (pathname.includes("public/ha/snapshot")) {
    return handleSnapshot(plugin, url, response, corsHeaders);
  }
  if (pathname.includes("public/ha/image")) {
    return handleImage(plugin, url, response, corsHeaders);
  }

  response.send("Not found", { code: 404, headers: corsHeaders() });
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
  const logger = plugin.getLogger();
  const cameraDevices = Object.values(plugin.currentCameraMixinsMap)
    .filter((mixin) => {
      if (!mixin.isEnabledForHa) {
        logger.debug(
          `[HA devices] Skipping camera "${mixin.name}" (${mixin.id}): not enabled for HA integration`,
        );
        return false;
      }
      return true;
    })
    .map((mixin) => ({
      device_id: `${idPrefix}-${mixin.id}`,
      device_name: `${mixin.name} (${mixin.type ?? "Camera"})`,
    }));
  const sensorDevices = Object.values(plugin.currentSensorMixinsMap)
    .filter((mixin) => {
      if (!mixin.isEnabledForHa) {
        logger.debug(
          `[HA devices] Skipping sensor "${mixin.name}" (${mixin.id}): not enabled for HA integration`,
        );
        return false;
      }
      return true;
    })
    .map((mixin) => ({
      device_id: `${idPrefix}-${mixin.id}`,
      device_name: `${mixin.name} (${mixin.type ?? "Sensor"})`,
    }));
  const notifierDevices = Object.values(plugin.currentNotifierMixinsMap)
    .filter((mixin) => {
      if (!mixin.isEnabledForHa) {
        logger.debug(
          `[HA devices] Skipping notifier "${mixin.name}" (${mixin.id}): not enabled for HA integration`,
        );
        return false;
      }
      return true;
    })
    .map((mixin) => ({
      device_id: `${idPrefix}-${mixin.id}`,
      device_name: `${mixin.name} (Notifier)`,
    }));
  const specialDevices = [
    { device_id: pluginIds, device_name: "Advanced Notifier (Plugin)" },
    {
      device_id: `${idPrefix}-${peopleTrackerId}`,
      device_name: "Advanced Notifier (People tracker)",
    },
    {
      device_id: `${idPrefix}-${alarmSystemId}`,
      device_name: "Advanced Notifier (Alarm system)",
    },
  ];
  const devices = [
    ...cameraDevices,
    ...sensorDevices,
    ...notifierDevices,
    ...specialDevices,
  ];
  response.send(JSON.stringify({ devices }), {
    code: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
  const requestedIds = (url.searchParams.get("device_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const shouldInclude = (id: string) =>
    requestedIds.length === 0 || requestedIds.includes(id);
  const capture = new DiscoveryCapture();
  const facesSourceForMqtt = plugin.storageSettings.values
    .facesSourceForMqtt as ScryptedEventSource;
  const rules = plugin.allAvailableRules ?? [];
  const pluginForRules = plugin as Parameters<typeof getActiveRules>[0]["plugin"];

  const deviceNameMap = new Map<string, string>();
  for (const m of Object.values(plugin.currentCameraMixinsMap))
    deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
  for (const m of Object.values(plugin.currentSensorMixinsMap))
    deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
  for (const m of Object.values(plugin.currentNotifierMixinsMap))
    deviceNameMap.set(`${idPrefix}-${m.id}`, m.name);
  deviceNameMap.set(pluginIds, "Advanced Notifier (Plugin)");
  deviceNameMap.set(
    `${idPrefix}-${peopleTrackerId}`,
    "Advanced Notifier (People tracker)",
  );
  deviceNameMap.set(
    `${idPrefix}-${alarmSystemId}`,
    "Advanced Notifier (Alarm system)",
  );

  const tasks: Promise<unknown>[] = [];

  // Plugin + people tracker
  if (
    shouldInclude(pluginIds) ||
    shouldInclude(`${idPrefix}-${peopleTrackerId}`)
  ) {
    tasks.push(
      setupPluginAutodiscovery({
        mqttClient: capture,
        people: await plugin.getKnownPeople(facesSourceForMqtt),
        console: logger,
        rules,
      }).catch((e) =>
        logger.error("[HA entities] Plugin autodiscovery error", e),
      ),
    );
  }

  // Alarm system
  const alarmDeviceId = `${idPrefix}-${alarmSystemId}`;
  if (shouldInclude(alarmDeviceId)) {
    try {
      const alarm = (await plugin.getDevice(ALARM_SYSTEM_NATIVE_ID)) as
        | (ScryptedDeviceBase & SecuritySystem)
        | undefined;
      const supportedModes = alarm?.securitySystemState?.supportedModes ?? [];
      tasks.push(
        setupAlarmSystemAutodiscovery({
          mqttClient: capture,
          console: logger,
          supportedModes,
        }).catch((e) =>
          logger.error("[HA entities] Alarm autodiscovery error", e),
        ),
      );
    } catch (e) {
      logger.error("[HA entities] Error getting alarm system device", e);
    }
  }

  // Cameras
  for (const mixin of Object.values(plugin.currentCameraMixinsMap)) {
    if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
    if (!mixin.isEnabledForHa) {
      logger.warn(
        `[HA entities] Camera "${mixin.name}" (${mixin.id}) is requested by HA but not enabled for HA integration in the plugin. Enable "HA integration" in the device settings.`,
      );
      continue;
    }
    tasks.push(
      (async () => {
        try {
          const zones = await mixin.getMqttZones();
          const accessorySwitchKinds = mixin.getAccessorySwitchKinds();
          const cameraStorageSettings = mixin.mixinState.storageSettings;
          const { allAvailableRules } = await getActiveRules({
            device: mixin,
            console: logger,
            plugin: pluginForRules,
            deviceStorage: cameraStorageSettings,
          });
          const initialCameraState = await mixin.getCameraMqttCurrentState();
          await setupCameraAutodiscovery({
            mqttClient: capture,
            device: mixin.cameraDevice,
            console: logger,
            rules: allAvailableRules ?? [],
            zones,
            accessorySwitchKinds,
            initialCameraState,
            streamDestinations: await mixin.getStreamDestinations(),
          });
        } catch (e) {
          logger.error(`Error capturing camera ${mixin.id} discovery`, e);
        }
      })(),
    );
  }

  // Sensors
  for (const mixin of Object.values(plugin.currentSensorMixinsMap)) {
    if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
    if (!mixin.isEnabledForHa) {
      logger.warn(
        `[HA entities] Sensor "${mixin.name}" (${mixin.id}) is requested by HA but not enabled for HA integration in the plugin. Enable "HA integration" in the device settings.`,
      );
      continue;
    }
    tasks.push(
      (async () => {
        try {
          const { availableDetectionRules } = await getActiveRules({
            device: mixin,
            console: logger,
            plugin: pluginForRules,
            deviceStorage: mixin.storageSettings,
          });
          await setupSensorAutodiscovery({
            mqttClient: capture,
            device: mixin.sensorDevice,
            rules: availableDetectionRules,
            console: logger,
          });
        } catch (e) {
          logger.error(`Error capturing sensor ${mixin.id} discovery`, e);
        }
      })(),
    );
  }

  // Notifiers
  for (const mixin of Object.values(plugin.currentNotifierMixinsMap)) {
    if (!shouldInclude(`${idPrefix}-${mixin.id}`)) continue;
    if (!mixin.isEnabledForHa) {
      logger.warn(
        `[HA entities] Notifier "${mixin.name}" (${mixin.id}) is requested by HA but not enabled for HA integration in the plugin. Enable "HA integration" in the device settings.`,
      );
      continue;
    }
    tasks.push(
      setupNotifierAutodiscovery({
        mqttClient: capture,
        device: mixin.notifierDevice as DeviceInterface,
        console: logger,
      }).catch(logger.error),
    );
  }

  await Promise.all(tasks);

  const devices = Array.from(capture.captures.entries()).map(
    ([device_id, { cmps, dev }]) => ({
      device_id,
      device_name: deviceNameMap.get(device_id) ?? device_id,
      cmps,
      dev,
    }),
  );

  const totalCmps = devices.reduce(
    (sum, d) => sum + Object.keys(d.cmps).length,
    0,
  );
  logger.log(
    `[HA entities] Sending ${devices.length} devices, ${totalCmps} entities, ${capture.initialStates.length} initial states`,
  );

  response.send(JSON.stringify({ devices, states: capture.initialStates }), {
    code: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
  let body: { topic?: string; value?: string };
  try {
    body =
      typeof request.body === "string"
        ? JSON.parse(request.body)
        : request.body;
  } catch {
    body = {};
  }
  const topic = body?.topic ?? "";
  const value = body?.value ?? "";
  if (plugin.wsHaClient) {
    plugin
      .getLogger()
      .info(
        `[handleCommand] Routing command: topic="${topic}" value="${value}"`,
      );
    // Extract device id from topic (format: scrypted-an/scrypted-an-{deviceId}/{entity}/set)
    const topicParts = topic.split("/");
    const deviceIdPart = topicParts[1] ?? ""; // e.g. "scrypted-an-303"
    const scryptedId = deviceIdPart.replace(`${idPrefix}-`, ""); // e.g. "303"
    // Check if the target device is enabled for HA (skip special devices like plugin, alarm-system, people-tracker)
    const specialIds = ["plugin", peopleTrackerId, alarmSystemId];
    if (!specialIds.includes(scryptedId)) {
      const cameraMixin = plugin.currentCameraMixinsMap[scryptedId];
      const sensorMixin = plugin.currentSensorMixinsMap[scryptedId];
      const notifierMixin = plugin.currentNotifierMixinsMap[scryptedId];
      const mixin = cameraMixin || sensorMixin || notifierMixin;
      if (mixin && !mixin.isEnabledForHa) {
        const errorMsg = `Command for device "${mixin.name}" (${scryptedId}) ignored: "Report to Home Assistant" is disabled in device settings (Advanced Notifier > Home Assistant). Enable it and restart the plugin.`;
        plugin.getLogger().warn(`[handleCommand] ${errorMsg}`);
        response.send(JSON.stringify({ error: errorMsg }), {
          code: 422,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
        return true;
      }
    }
    plugin.wsHaClient.routeCommand(topic, value);
  } else {
    plugin
      .getLogger()
      .warn(
        `[handleCommand] No wsHaClient available, command dropped: topic="${topic}" value="${value}"`,
      );
  }
  response.send("{}", {
    code: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
  return true;
}

// ---------------------------------------------------------------------------
// /public/ha/snapshot — take a live picture via takePicture and serve it
// ---------------------------------------------------------------------------

async function handleSnapshot(
  plugin: HaRestApiPlugin,
  url: URL,
  response: HttpResponse,
  corsHeaders: () => Record<string, string>,
): Promise<true> {
  const logger = plugin.getLogger();
  const deviceId = url.searchParams.get("device_id") ?? "";

  if (!deviceId) {
    response.send("Missing device_id", { code: 400, headers: corsHeaders() });
    return true;
  }

  const scryptedId = deviceId.replace(`${idPrefix}-`, "");
  const mixin = Object.values(plugin.currentCameraMixinsMap).find(
    (m) => m.id === scryptedId,
  );

  if (!mixin) {
    logger.log(
      `[HA Snapshot] No camera mixin found for scryptedId=${scryptedId}`,
    );
    response.send("Not found", { code: 404, headers: corsHeaders() });
    return true;
  }

  try {
    logger.info(`[HA Snapshot] Taking live snapshot for device ${scryptedId}`);
    const mo = await mixin.cameraDevice.takePicture({
      reason: "event",
      timeout: 10000,
    });
    const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(
      mo,
      "image/jpeg",
    );
    if (buffer?.length) {
      // Save to disk for future requests
      const { storagePath } = plugin.getFsPaths({});
      const deviceDir = path.join(storagePath, scryptedId, "detections");
      await fs.promises.mkdir(deviceDir, { recursive: true });
      const snapshotPath = path.join(deviceDir, "snapshot.jpg");
      await fs.promises.writeFile(snapshotPath, buffer);
      logger.info(
        `[HA Snapshot] Saved ${buffer.length} bytes to ${snapshotPath}`,
      );

      response.send(buffer, {
        code: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-cache",
        },
      });
      return true;
    }
    logger.info(
      `[HA Snapshot] takePicture returned empty buffer for ${scryptedId}`,
    );
  } catch (e) {
    logger.log(`[HA Snapshot] Error taking snapshot for ${scryptedId}: ${e}`);
  }

  response.send("Snapshot failed", { code: 500, headers: corsHeaders() });
  return true;
}

// ---------------------------------------------------------------------------
// /public/ha/image — serve detection images from disk
// ---------------------------------------------------------------------------

async function handleImage(
  plugin: HaRestApiPlugin,
  url: URL,
  response: HttpResponse,
  corsHeaders: () => Record<string, string>,
): Promise<true> {
  const logger = plugin.getLogger();
  const topic = url.searchParams.get("topic") ?? "";
  const deviceId = url.searchParams.get("device_id") ?? "";

  if (!topic && !deviceId) {
    response.send("Missing topic or device_id", {
      code: 400,
      headers: corsHeaders(),
    });
    return true;
  }

  let scryptedId: string;
  let classFilter: string | null = null;

  if (topic) {
    // Topic format: scrypted-an/scrypted-an-{scryptedId}/{entity}_last_image
    const parts = topic.split("/");
    if (parts.length < 3) {
      response.send("Invalid topic", { code: 400, headers: corsHeaders() });
      return true;
    }
    scryptedId = parts[1].replace(`${idPrefix}-`, "");
    classFilter = parts[2].replace(/_last_image$/, "");
  } else {
    // device_id format: scrypted-an-{scryptedId} — returns most recent image of any class
    scryptedId = deviceId.replace(`${idPrefix}-`, "");
  }

  try {
    const { storagePath } = plugin.getFsPaths({});
    const detectionsDir = path.join(storagePath, scryptedId, "detections");
    logger.info(
      `[HA Image] Looking in ${detectionsDir}, classFilter=${classFilter}`,
    );
    const files = await fs.promises.readdir(detectionsDir);
    const matching = files.filter((f) => {
      if (!f.endsWith(".jpg")) return false;
      if (!classFilter) return true;
      return f.split(".")[0].split("__")[0] === classFilter;
    });
    logger.info(
      `[HA Image] Found ${files.length} total files, ${matching.length} matching`,
    );

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
      logger.info(
        `[HA Image] Serving ${bestFile} (${path.join(detectionsDir, bestFile)})`,
      );
      const jpeg = await fs.promises.readFile(
        path.join(detectionsDir, bestFile),
      );
      response.send(jpeg, {
        code: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-cache",
        },
      });
      return true;
    }
    logger.info(
      `[HA Image] No matching files for scryptedId=${scryptedId}, classFilter=${classFilter}, files: [${files.slice(0, 10).join(", ")}]`,
    );
  } catch (e) {
    logger.log(`[HA Image] Error reading detections dir: ${e}`);
  }

  response.send("Not found", { code: 404, headers: corsHeaders() });
  return true;
}
