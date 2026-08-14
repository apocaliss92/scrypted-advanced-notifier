import type { ScryptedEventSource } from "./utils";

/**
 * Kept in its own module, free of any Scrypted SDK import, so it can be tested
 * without a live host. The enum is imported as a *type* only (erased at
 * runtime); the two sentinel values are declared locally.
 */
const DEFAULT_SOURCE = "Default" as ScryptedEventSource;
const ALL_SOURCES = "All" as ScryptedEventSource;

/**
 * Does a rule's configured detection source accept an event from `eventSource`?
 *
 * Two values need resolving before a comparison means anything, and the rule
 * matcher used to compare raw values with `===`, so both silently matched
 * nothing:
 *
 * - `Default` is not a selectable choice for detection rules — it is the
 *   sentinel for "never written to storage". The settings form shows NVR as
 *   its `defaultValue`, but a `defaultValue` is display-only: leave the field
 *   untouched and storage stays empty. Rules created that way used to fall
 *   back to NVR; once that fallback was removed they began reading as
 *   `Default` and could never equal an incoming `NVR` event.
 * - `All` means "any source" and must match everything, which is already how
 *   the MQTT path treats it.
 */
export function matchesDetectionSource(props: {
  ruleSource: ScryptedEventSource | undefined;
  eventSource: ScryptedEventSource;
  defaultSource: ScryptedEventSource;
}): boolean {
  const { ruleSource, eventSource, defaultSource } = props;
  const resolved =
    !ruleSource || ruleSource === DEFAULT_SOURCE ? defaultSource : ruleSource;

  if (resolved === ALL_SOURCES) {
    return true;
  }

  return resolved === eventSource;
}
