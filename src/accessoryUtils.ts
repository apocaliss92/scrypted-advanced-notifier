/**
 * Utility for camera accessories: types, matchers per pluginId, and switch lookup.
 * Centralizes all functions and config for accessories (Siren, Light, PIR, etc.).
 */

import sdk, {
  ScryptedDevice,
  ScryptedDeviceBase,
  ScryptedInterface,
} from "@scrypted/sdk";
import type { OnOff } from "@scrypted/sdk";

/** Camera accessory kinds exposed as switches on Home Assistant. */
export type CameraNativeIdAccessoryKind =
  | "siren_on_motion"
  | "siren"
  | "light_on_motion"
  | "light"
  | "pir"
  | "autotracking";

export interface CameraNativeIdAccessorySwitch {
  kind: CameraNativeIdAccessoryKind;
  nativeId: string;
  deviceId?: string;
  device?: ScryptedDevice & ScryptedDeviceBase & OnOff;
  matches: string[];
}

export type CameraAccessoryMatcher = {
  kind: CameraNativeIdAccessoryKind;
  keywords: string[];
};

/** Default matchers: for any other plugin (floodlight -> light, siren -> siren). */
const DEFAULT_CAMERA_ACCESSORY_MATCHERS: CameraAccessoryMatcher[] = [
  { kind: "light", keywords: ["floodlight"] },
  { kind: "siren", keywords: ["siren"] },
];

/**
 * Matchers per pluginId. nativeId shape: '{deviceNativeId}-<suffix>'.
 * Order: more specific matchers first (e.g. motion-siren before siren).
 */
export const cameraAccessoryMatchersByPluginId: Record<
  string,
  CameraAccessoryMatcher[]
> = {
  "@scrypted/hikvision": [
    { kind: "siren_on_motion", keywords: ["alarm"] },
    { kind: "light_on_motion", keywords: ["supplementlight"] },
  ],
  "@apocaliss92/scrypted-reolink-native": [
    { kind: "siren_on_motion", keywords: ["motion-siren"] },
    { kind: "light_on_motion", keywords: ["motion-floodlight"] },
    { kind: "autotracking", keywords: ["autotracking"] },
    { kind: "light", keywords: ["floodlight"] },
    { kind: "siren", keywords: ["siren"] },
    { kind: "pir", keywords: ["pir"] },
  ],
  "@scrypted/reolink": [
    { kind: "light", keywords: ["floodlight"] },
    { kind: "siren", keywords: ["siren"] },
    { kind: "pir", keywords: ["pir"] },
  ],
};

/** Config for one accessory switch entity (name, id, icon for HA/MQTT). */
export interface CameraAccessorySwitchEntityConfig {
  entity: string;
  name: string;
  icon: string;
}

/** Accessory switch entity config for each kind. */
export const cameraAccessorySwitchEntityConfig: Record<
  CameraNativeIdAccessoryKind,
  CameraAccessorySwitchEntityConfig
> = {
  siren_on_motion: {
    entity: "accessory_siren_on_motion",
    name: "Siren on motion",
    icon: "mdi:alarm-light",
  },
  siren: {
    entity: "accessory_siren",
    name: "Siren",
    icon: "mdi:alarm-bell",
  },
  light_on_motion: {
    entity: "accessory_light_on_motion",
    name: "Light on motion",
    icon: "mdi:lightbulb-auto",
  },
  light: {
    entity: "accessory_light",
    name: "Light",
    icon: "mdi:lightbulb",
  },
  pir: {
    entity: "accessory_pir",
    name: "PIR",
    icon: "mdi:motion-sensor",
  },
  autotracking: {
    entity: "accessory_autotracking",
    name: "Autotracking",
    icon: "mdi:radar",
  },
};

const getMatchersForPluginId = (pluginId: string): CameraAccessoryMatcher[] =>
  cameraAccessoryMatchersByPluginId[pluginId] ?? DEFAULT_CAMERA_ACCESSORY_MATCHERS;

const getAccessoryMatches = (
  nativeId: string,
  matchers: CameraAccessoryMatcher[],
) => {
  const lower = nativeId.toLowerCase();
  return matchers
    .map(({ kind, keywords }) => ({
      kind,
      matches: keywords.filter((k) => lower.includes(k)),
    }))
    .filter((entry) => entry.matches.length > 0);
};

/**
 * Returns the switch entity configs for the requested kinds.
 */
export const getCameraAccessorySwitchConfigs = (
  kinds?: CameraNativeIdAccessoryKind[],
): CameraAccessorySwitchEntityConfig[] => {
  if (!kinds?.length) {
    return [];
  }
  const uniqKinds = [...new Set(kinds)];
  return uniqKinds
    .map((kind) => cameraAccessorySwitchEntityConfig[kind])
    .filter(Boolean);
};

export interface FindCameraAccessorySwitchesResult {
  cameraNativeId: string | undefined;
  relatedNativeIds: string[];
  switches: CameraNativeIdAccessorySwitch[];
  siren_on_motion: CameraNativeIdAccessorySwitch[];
  siren: CameraNativeIdAccessorySwitch[];
  light_on_motion: CameraNativeIdAccessorySwitch[];
  light: CameraNativeIdAccessorySwitch[];
  pir: CameraNativeIdAccessorySwitch[];
  autotracking: CameraNativeIdAccessorySwitch[];
}

/**
 * Finds accessory switches for a camera by nativeId and matchers for the device's pluginId.
 */
export const findCameraAccessorySwitchesByNativeId = (props: {
  device: ScryptedDeviceBase;
  console?: Console;
}): FindCameraAccessorySwitchesResult => {
  const { device, console } = props;

  const cameraNativeId = device?.nativeId;

  if (!cameraNativeId) {
    return {
      cameraNativeId,
      relatedNativeIds: [],
      switches: [],
      siren_on_motion: [],
      siren: [],
      light_on_motion: [],
      light: [],
      pir: [],
      autotracking: [],
    };
  }

  const matchers = getMatchersForPluginId(device.pluginId ?? "");

  const state = sdk.systemManager.getSystemState();
  const relatedNativeIds = Object.entries(state)
    .filter(([_, d]) => d.nativeId?.value.includes(cameraNativeId))
    .map(([_, d]) => d.nativeId?.value);

  const switches: CameraNativeIdAccessorySwitch[] = [];
  for (const nativeId of relatedNativeIds) {
    const matches = getAccessoryMatches(nativeId, matchers);

    if (!matches.length) {
      continue;
    }

    for (const matcher of matchers) {
      const matchInfo = matches.find((m) => m.kind === matcher.kind);
      if (!matchInfo) {
        continue;
      }

      const resolved = sdk.systemManager.getDeviceById(
        device.pluginId,
        nativeId,
      );

      if (!resolved) {
        console?.warn?.(
          `Accessory nativeId found but device not resolved: ${nativeId}`,
        );
        continue;
      }

      if (!resolved.interfaces?.includes(ScryptedInterface.OnOff)) {
        console?.debug?.(
          `Accessory nativeId found but device is not OnOff: ${nativeId}`,
        );
        continue;
      }

      switches.push({
        kind: matcher.kind,
        nativeId,
        deviceId: resolved.id,
        device: resolved as unknown as ScryptedDevice &
          ScryptedDeviceBase &
          OnOff,
        matches: matchInfo.matches,
      });

      break;
    }
  }

  return {
    cameraNativeId,
    relatedNativeIds,
    switches,
    siren_on_motion: switches.filter((s) => s.kind === "siren_on_motion"),
    siren: switches.filter((s) => s.kind === "siren"),
    light_on_motion: switches.filter((s) => s.kind === "light_on_motion"),
    light: switches.filter((s) => s.kind === "light"),
    pir: switches.filter((s) => s.kind === "pir"),
    autotracking: switches.filter((s) => s.kind === "autotracking"),
  };
};
