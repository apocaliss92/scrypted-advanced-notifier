import { describe, expect, it } from "vitest";
import {
  collectPluginZoneChoices,
  getTriggerZone,
} from "../src/triggerZone";

const DEVICE = "Device" as const;
const PLUGIN = "Plugin" as const;

describe("getTriggerZone", () => {
  it("falls back to the first detected zone when the whitelist is an empty array", () => {
    // Empty arrays are truthy in JS, so `if (rule.whitelistedZones)` used to
    // skip this fallback and leave the notification zone blank.
    expect(
      getTriggerZone(
        { zones: ["Eingangsbereich", "Nordgarten"] },
        { source: PLUGIN, whitelistedZones: [] },
      ),
    ).toBe("Eingangsbereich");
  });

  it("falls back to the first detected zone when the whitelist is missing", () => {
    expect(
      getTriggerZone(
        { zones: ["Eingangsbereich"] },
        { source: PLUGIN },
      ),
    ).toBe("Eingangsbereich");
  });

  it("returns undefined when there are no detected zones and no whitelist", () => {
    expect(getTriggerZone({ zones: [] }, { source: DEVICE, whitelistedZones: [] })).toBeUndefined();
    expect(getTriggerZone({}, { source: DEVICE })).toBeUndefined();
  });

  it("picks the first detected zone that is on a device-rule whitelist", () => {
    expect(
      getTriggerZone(
        { zones: ["Nordgarten", "Eingangsbereich"] },
        { source: DEVICE, whitelistedZones: ["Eingangsbereich"] },
      ),
    ).toBe("Eingangsbereich");
  });

  it("matches plugin-rule whitelist entries by the zone name after Camera::", () => {
    expect(
      getTriggerZone(
        { zones: ["Nordgarten", "Eingangsbereich"] },
        {
          source: PLUGIN,
          whitelistedZones: ["Front door::Eingangsbereich"],
        },
      ),
    ).toBe("Eingangsbereich");
  });

  it("returns undefined when none of the detected zones are whitelisted", () => {
    expect(
      getTriggerZone(
        { zones: ["Nordgarten"] },
        { source: DEVICE, whitelistedZones: ["Eingangsbereich"] },
      ),
    ).toBeUndefined();
  });
});

describe("collectPluginZoneChoices", () => {
  const cameras = [
    { id: "114", name: "Front door", zoneNames: ["Eingangsbereich"] },
    { id: "120", name: "Garden", zoneNames: ["Nordgarten", "Ausgeschlossen1"] },
    { id: "126", name: "Driveway", zoneNames: ["Einfahrt"] },
  ];

  it("includes every camera's zones when no devices are selected", () => {
    expect(collectPluginZoneChoices({ selectedDeviceIds: [], cameras })).toEqual([
      "Front door::Eingangsbereich",
      "Garden::Nordgarten",
      "Garden::Ausgeschlossen1",
      "Driveway::Einfahrt",
    ]);
  });

  it("includes only the selected cameras' zones", () => {
    expect(
      collectPluginZoneChoices({
        selectedDeviceIds: ["120", "126"],
        cameras,
      }),
    ).toEqual(["Garden::Nordgarten", "Garden::Ausgeschlossen1", "Driveway::Einfahrt"]);
  });

  it("skips selected device ids that have no camera data", () => {
    expect(
      collectPluginZoneChoices({
        selectedDeviceIds: ["120", "missing"],
        cameras,
      }),
    ).toEqual(["Garden::Nordgarten", "Garden::Ausgeschlossen1"]);
  });
});
