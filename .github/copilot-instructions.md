# Copilot / Cursor instructions (Scrypted Advanced Notifier)

> Compatible with **GitHub Copilot** and **Cursor** agents.

**Language:** Use **English only** for UI strings, comments, commit messages, and documentation (plugin and frontend).

## Big picture
- This repo is a Scrypted plugin. The main entrypoint is [src/main.ts](src/main.ts) and it implements multiple Scrypted interfaces (Settings/DeviceProvider/MixinProvider/HttpRequestHandler/VideoClips/PushHandler).
- Most “real” device behavior lives in mixins:
  - Camera logic in [src/cameraMixin.ts](src/cameraMixin.ts)
  - Notifier logic in [src/notifierMixin.ts](src/notifierMixin.ts)
  - Sensors in [src/sensorMixin.ts](src/sensorMixin.ts) (if you change sensor flows, update MQTT discovery accordingly)
- MQTT + Home Assistant autodiscovery are centralized in [src/mqtt-utils.ts](src/mqtt-utils.ts). If you add/remove a published value, update both discovery + state publishing.
- Shared types/constants/helpers are in [src/utils.ts](src/utils.ts) (rule types, activation sources, IDs, limits like `MAX_RPC_OBJECTS_PER_CAMERA`, helper utilities).

## Key flows to follow
- **Settings pattern:** plugin + mixins use `StorageSettingsDict` + `StorageSettings` and often rebuild settings dynamically via `convertSettingsToStorageSettings` (see [src/notifierMixin.ts](src/notifierMixin.ts) and [src/cameraMixin.ts](src/cameraMixin.ts)). When adding a setting, ensure:
  - it has a stable key in the relevant `...SettingKey` union
  - `refreshSettings()` hides/updates dependent settings correctly
- **MQTT entities:** topics, discovery IDs, and entity naming conventions are owned by `idPrefix` and helpers in [src/mqtt-utils.ts](src/mqtt-utils.ts). Prefer extending existing entity builders over inventing new topic shapes.
- **Event storage:** detection events are stored as per-day JSON DB files via `node-json-db` in [src/db.ts](src/db.ts). If you change event schema (`DbDetectionEvent`), update writers/readers and any cleanup/retention logic.
- **Images/media:** snapshots/clips/GIFs are generated and post-processed across camera mixin + drawing utilities. Image filtering uses ffmpeg-based helpers (e.g. `ffmpegFilterImageBuffer`) and post-processing options in [src/utils.ts](src/utils.ts) / [src/drawingUtils.ts](src/drawingUtils.ts).

## Repo-specific conventions
- Device IDs / native IDs are centralized in [src/utils.ts](src/utils.ts) (`NOTIFIER_NATIVE_ID`, `CAMERA_NATIVE_ID`, etc). Reuse these constants.
- The plugin relies on sibling local packages (not published deps), e.g. `../../scrypted-apocaliss-base/...` and `../../scrypted-frigate-bridge/...` imports. Avoid refactors that break those paths unless you also update the mono-repo layout.
- Mixins store runtime state in plugin-owned maps (e.g. `currentCameraMixinsMap`, `currentNotifierMixinsMap` in [src/main.ts](src/main.ts)); when creating/releasing devices, keep those maps consistent.

## Dev workflows (what to run)
- Build bundle: `npm run build` (runs `scrypted-webpack`). See [package.json](package.json).
- Deploy + debug from VS Code: run the task `scrypted: deploy+debug` (it runs `npm run scrypted-vscode-launch`).
- Production build used for publish: `npm run prepublishOnly`.

## Editing tips (to avoid regressions)
- Prefer small, targeted changes in the relevant layer:
  - rule evaluation/notification behavior → [src/cameraMixin.ts](src/cameraMixin.ts)
  - notifier payload manipulation/translations/AI toggles → [src/notifierMixin.ts](src/notifierMixin.ts)
  - MQTT entity add/remove → [src/mqtt-utils.ts](src/mqtt-utils.ts)
- Keep defaults + “immediate” settings behavior consistent with existing settings (many toggles are `immediate: true`).
- Watch for load/size constraints: this plugin enforces soft/hard limits for RPC objects in [src/utils.ts](src/utils.ts).

## Quick checklists

### When you add/change an MQTT entity
- Start in [src/mqtt-utils.ts](src/mqtt-utils.ts): extend existing entity builders and keep `idPrefix` naming consistent.
- Update **both**: Home Assistant autodiscovery config (config topics) and state publishing (state/image topics). Don’t add “publish-only” values.
- If the entity is per-camera/per-rule, ensure the camera mixin publishes it (see [src/cameraMixin.ts](src/cameraMixin.ts)).
- If you change entity IDs/names, expect users may need to clear retained discovery/state topics; the plugin also exposes a “Reset all MQTT topics” action (see `mqttResetAllTopics` in [src/main.ts](src/main.ts)).

### When you add/change a setting or rule option
- Add a stable key to the correct `...SettingKey` union (plugin keys in [src/main.ts](src/main.ts), camera keys in [src/cameraMixin.ts](src/cameraMixin.ts), notifier keys in [src/notifierMixin.ts](src/notifierMixin.ts)).
- Add it to `initStorage` and (if it is conditional) wire it into `refreshSettings()` via `convertSettingsToStorageSettings`.
- If it should take effect immediately, set `immediate: true` and/or implement `onPut` to trigger the relevant refresh/publish.
- If it affects MQTT behavior, ensure you also update autodiscovery/publishing paths (see [src/mqtt-utils.ts](src/mqtt-utils.ts)).

---

## Events App / Frontend (scrypted-advanced-notifier-frontend-v2)

The events app frontend is a separate project (`scrypted-advanced-notifier-frontend-v2`) intended for a **rework from scratch**. It is served by the plugin via `HttpRequestHandler.onRequest` and the `eventsApp` path (see [src/utils.ts](src/utils.ts) `getWebhooks` → `eventsApp`).

### How the plugin serves the frontend
- Base URL is `{privatePathnamePrefix}` where `privatePathnamePrefix = {privatePathname}{eventsApp}` (e.g. `/endpoint/.../eventsApp`).
- The plugin responds with `response.sendFile('dist/index.html')` for the SPA and `response.sendFile('dist/{deviceId}')` for device-specific assets.
- The frontend build is copied to `fs/dist/` in the plugin; the plugin serves static files from `dist/`.

### Authentication
- For `webhook === eventsApp` (public path) the plugin calls `checkUserLogin(request)` ([src/utils.ts](src/utils.ts)).
- Requires header `Authorization: Basic {base64(username:password)}`.
- Uses `loginScryptedClient` (Scrypted) with `baseUrl` from `sdk.endpointManager.getLocalEndpoint()`.
- If not authenticated: `response.send('Unauthorized', { code: 401 })`.

### API and data exposed by the plugin
- **Events:** the `AdvancedNotifierDataFetcher` device (nativeId: `DATA_FETCHER_NATIVE_ID`) implements `EventRecorder.getRecordedEvents(options)`. **To extend:** add pagination params (`limit`, `offset` or cursor) based on viewport; return total count; frontend will request paginated data and use heavy browser cache.
  - `options`: `{ startTime, endTime }` (timestamp ms).
  - Returns `RecordedEvent[]` with `details: { eventId, eventTime }` and `data: DbDetectionEvent` (see [src/db.ts](src/db.ts)).
  - `DbDetectionEvent` includes: `id`, `timestamp`, `classes`, `label`, `thumbnailUrl`, `imageUrl`, `videoUrl`, `source` (ScryptedEventSource: NVR, Frigate, RawDetection), `deviceName`, `deviceId`, `detections`.
- **Videoclips:** `EventRecorder` / `VideoClips.getVideoClips(options)` with `{ startTime, endTime }`.
  - Each clip has `videoId`, `thumbnailId`, `detectionClasses`, `startTime`, `duration`, and `videoclipHref` (full URL).
- **Media URLs:**
  - Thumbnail/image: `{privatePathnamePrefix}/eventThumbnail/{deviceId}/{eventId}/{source}` or `eventImage` for full-size.
  - For NVR: `?path=...` with encoded endpoint URL.
  - Videoclip: `{privatePathnamePrefix}/eventVideoclip/{deviceId}/{videoId}` → redirect or stream.

### Frontend ↔ plugin interaction
1. The frontend must use **Scrypted credentials** (username/password) for login.
2. After login, all requests must include `Authorization: Basic ...`.
3. For events and videoclips: the frontend must call Scrypted device methods (typically via `@scrypted/client` or Scrypted API).
4. URLs `thumbnailUrl`, `imageUrl`, `videoUrl`/`videoclipHref` are ready to use: use them as returned, with the same credentials in the request.

For detailed frontend rework instructions, see `.github/copilot-instructions.md` in **scrypted-advanced-notifier-frontend-v2**. The **scrypted-an-frontend** project in this workspace is the reference implementation for Scrypted communication (client, API, takePicture, WebRTC).
