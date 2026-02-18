# Migrazione da Webhook HTTP a Socket SDK con interfaceDescriptors

Piano per esporre i metodi Events App via **interfaceDescriptors** (come [@scrypted/llm](https://github.com/scryptedapp/llm)), eliminando le chiamate REST e usando solo la socket SDK.

---

## 1. Come funziona interfaceDescriptors (LLM plugin)

Dal [package.json dell'LLM](https://github.com/scryptedapp/llm/blob/main/package.json):

```json
{
  "scrypted": {
    "interfaces": ["DeviceProvider", "UserDatabase", ...],
    "interfaceDescriptors": {
      "UserDatabase": {
        "name": "UserDatabase",
        "methods": ["openDatabase"],
        "properties": []
      }
    }
  }
}
```

- **interfaceDescriptors** dichiara interfacce custom con metodi e proprietà
- Il server Scrypted usa questi descrittori per esporre i metodi via RPC sulla socket
- Il client può chiamare `device.openDatabase()` invece di fare HTTP

---

## 2. Metodi Events App da esporre (handleEventsAppRequest)

| apimethod | payload | Note |
|-----------|---------|------|
| GetConfigs | — | |
| GetCamerasStatus | — | |
| GetEvents | fromDate, tillDate, limit, offset, sources, cameras, detectionClasses, eventSource, filter, groupingRange | |
| GetVideoclips | fromDate, tillDate, limit, offset, cameras, detectionClasses | |
| GetCameraDayData | deviceId, day | |
| GetClusteredDayData | deviceId, days, bucketMs, enabledClasses, classFilter | |
| GetClusterEvents | clusterId, deviceId, startMs, endMs | |
| GetArtifacts | deviceId, day | |
| GetLatestRuleArtifacts | deviceId, limit | |
| RemoteLog | level, message | |

---

## 3. Modifiche al plugin advanced-notifier

### 3.1 package.json — aggiungere interfaceDescriptors

```json
{
  "scrypted": {
    "interfaces": ["Settings", "DeviceProvider", "MixinProvider", "HttpRequestHandler", "Videoclips", "LauncherApplication", "PushHandler"],
    "interfaceDescriptors": {
      "EventsAppApi": {
        "name": "EventsAppApi",
        "methods": [
          "getConfigs",
          "getCamerasStatus",
          "getEvents",
          "getVideoclips",
          "getCameraDayData",
          "getClusteredDayData",
          "getClusterEvents",
          "getArtifacts",
          "getLatestRuleArtifacts",
          "remoteLog"
        ],
        "properties": []
      }
    }
  }
}
```

### 3.2 utils.ts — costante interfaccia

```ts
export const EVENTS_APP_API_INTERFACE = "EventsAppApi";
```

### 3.3 main.ts — aggiungere interfaccia al data fetcher

In `onDeviceDiscovered` per DATA_FETCHER_NATIVE_ID:

```ts
interfaces: [
  ScryptedInterface.VideoClips,
  ScryptedInterface.EventRecorder,
  ScryptedInterface.Settings,
  EVENTS_APP_API_INTERFACE,  // <-- aggiungere
],
```

### 3.4 dataFetcher.ts — implementare EventsAppApi

La classe `AdvancedNotifierDataFetcher` deve implementare i metodi pubblici che mappano 1:1 con gli apimethod. Esempio:

```ts
// EventsAppApi interface
async getConfigs(): Promise<{ cameras: ...; enabledDetectionSources: string[] }> {
  const { statusCode, body } = await this.handleEventsAppRequest('GetConfigs', {});
  if (statusCode !== 200) throw new Error(JSON.stringify(body));
  return body as any;
}
async getCamerasStatus(): Promise<CamerasStatusResponse> { ... }
async getEvents(payload: GetEventsPayload): Promise<GetEventsResponse> { ... }
// ... etc
```

Oppure, più pulito: estrarre la logica da `handleEventsAppRequest` in metodi dedicati e far sì che `handleEventsAppRequest` li chiami, così si evita duplicazione.

---

## 4. Come il server Scrypted gestisce interfaceDescriptors

Il server Scrypted (koush/scrypted) legge `interfaceDescriptors` dal `package.json` del plugin. Quando un device dichiara un'interfaccia in `interfaces`, il server:

1. Verifica che l'interfaccia sia in `interfaceDescriptors` (per interfacce custom)
2. Espone i metodi via RPC sulla socket Engine.IO
3. Il client `@scrypted/client` può chiamare `device.getConfigs()` e la chiamata viene serializzata e inviata via socket

Non serve modificare il server: il supporto è già presente. Il client deve solo usare `client.systemManager.getDeviceById(deviceId)` e chiamare i metodi sull'oggetto restituito.

---

## 5. Modifiche al client (camstack / scrypted-an-frontend)

### 5.1 Trovare il device Events App

Il device "Advanced notifier data fetcher" ha tipo `API` e implementa `EventsAppApi`. Per ottenere il suo ID:

```ts
const state = client.systemManager.getSystemState();
const eventsAppDeviceId = Object.entries(state).find(
  ([_, d]) => (d as any)?.interfaces?.includes?.('EventsAppApi')
)?.[0];
```

Oppure cercare per nome/tipo se lo stato lo espone.

### 5.2 Sostituire fetch con chiamate SDK

**Prima (HTTP):**
```ts
const res = await fetch(`${baseUrl}/eventsApp`, {
  method: 'POST',
  body: JSON.stringify({ apimethod: 'GetClusteredDayData', payload: { deviceId, days, bucketMs } }),
  headers: { 'Content-Type': 'application/json', Authorization: getAuthHeader(auth) },
});
const data = await res.json();
```

**Dopo (Socket):**
```ts
const client = await getScryptedClient(auth);
const device = client.systemManager.getDeviceById(eventsAppDeviceId) as EventsAppApi;
const data = await device.getClusteredDayData({ deviceId, days, bucketMs });
```

### 5.3 Cosa resta su HTTP

- **URL di immagini/thumbnail/video**: usati in `<Image src={url} />` e `<Video source={{ uri }} />` — devono restare URL HTTP. Il plugin continua a servire `/eventThumbnail/...`, `/eventImage/...`, `/eventVideoclip/...` via HttpRequestHandler.
- **Autenticazione**: la socket SDK usa già le credenziali del client (login con username/password). Non serve più Basic auth per le chiamate dati.

---

## 6. Ordine di implementazione

1. **Plugin**: aggiungere `interfaceDescriptors` e `EVENTS_APP_API_INTERFACE`, implementare i metodi su `AdvancedNotifierDataFetcher`
2. **Mantenere HttpRequestHandler**: per `apimethod` POST a `/eventsApp` — opzionale durante la transizione (fallback)
3. **Client**: creare `eventsAppSdk.ts` che usa la socket; `eventsAppApi.ts` può passare a usare l'SDK quando il client è connesso
4. **Rimuovere** le chiamate fetch a `/eventsApp` dal client una volta validato l'SDK

---

## 7. Riferimenti

- [LLM plugin package.json](https://github.com/scryptedapp/llm/blob/main/package.json) — esempio interfaceDescriptors
- [Scrypted Developer Docs](https://developer.scrypted.app/) — interfacce e plugin
- [@scrypted/client](https://www.npmjs.com/package/@scrypted/client) — SDK client con socket
