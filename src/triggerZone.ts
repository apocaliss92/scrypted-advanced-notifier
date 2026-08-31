/**
 * Kept in its own module, free of any Scrypted SDK import, so it can be tested
 * without a live host.
 */

export type TriggerZoneRuleSource = "Plugin" | "Device";

export function getTriggerZone(
  detection: { zones?: string[] } | undefined,
  rule:
    | {
        source?: TriggerZoneRuleSource;
        whitelistedZones?: string[];
      }
    | undefined,
): string | undefined {
  const { zones } = detection ?? {};

  const whitelistedZones = rule?.whitelistedZones;
  // Empty arrays are truthy in JS, so a length check is required: an unset
  // whitelist means "any zone", which should fall back to the first detected
  // zone rather than matching against nothing.
  if (whitelistedZones?.length) {
    return detection?.zones?.find((detectedZone) =>
      whitelistedZones.find((whitelistedZone) => {
        if (rule?.source === "Device") {
          return whitelistedZone === detectedZone;
        }
        const [, zonePart] = whitelistedZone.split("::");
        return zonePart === detectedZone;
      }),
    );
  }

  return zones?.[0];
}

export function collectPluginZoneChoices(props: {
  selectedDeviceIds: string[];
  cameras: Array<{ id: string; name: string; zoneNames: string[] }>;
}): string[] {
  const cameraById = new Map(props.cameras.map((camera) => [camera.id, camera]));
  const ids = props.selectedDeviceIds.length
    ? props.selectedDeviceIds
    : props.cameras.map((camera) => camera.id);

  const choices: string[] = [];
  for (const id of ids) {
    const camera = cameraById.get(id);
    if (!camera) {
      continue;
    }
    for (const zoneName of camera.zoneNames) {
      choices.push(`${camera.name}::${zoneName}`);
    }
  }
  return choices;
}
