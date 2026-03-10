# Advanced Notifier — Piano di Miglioramento

## Panoramica Codebase

| File | LOC | Problema |
|------|-----|----------|
| cameraMixin.ts | 6,669 | God class: 43+ metodi, 8 responsabilità, 13 metodi >100 LOC |
| utils.ts | 6,631 | God file: 120+ export, settings/rules/text/notifier mischiati |
| main.ts | 5,910 | God class: HTTP/MQTT/FS/DB/media/HA in un unico file |
| mqtt-utils.ts | 2,719 | 5 subscribe fn e 5 setup fn quasi identiche |

---

## 1. Memory Leak — Priorità CRITICA

### 1.1 Cache embedding senza limiti (main.ts)
- `imageEmbeddingCache: Record<string, Buffer>` — mai pulita
- `textEmbeddingCache: Record<string, Buffer>` — mai pulita
- **Fix:** Implementare LRU con max ~100 entry, o Map con TTL

### 1.2 State maps mai potate (cameraMixin.ts)
- `detectionIdEventIdMap` — cresce a ogni detection, mai pulita
- `objectIdLastReport` — per object ID, senza TTL
- `audioRuleSamples` — array `{timestamp, dBs}[]` per regola, mai trimmati
- `occupancyState` — contiene `b64Image` per regola, mai rilasciate
- `snoozeUntilDic` — entry mai rimosse
- `clipGenerationTimeout` — se la regola viene rimossa, il timeout resta
- **Fix:** TTL-based cleanup periodico (ogni 5 min), trim audioRuleSamples a max 1000 entry

### 1.3 Doppio caching immagine
- `lastFrame: Buffer` + `lastB64Image: string` — stessa immagine in due formati (~33% overhead)
- **Fix:** Tenere solo `lastB64Image`, decodificare on-demand se serve Buffer

### 1.4 State non pulite su device removal (main.ts)
- `cameraStates` — entry mai rimosse su releaseMixin
- `lastCameraAutodiscoveryMap` — entry per camera mai rimosse
- **Fix:** Pulire in `releaseMixin()`

### 1.5 release() incompleto (cameraMixin.ts)
- `release()` pulisce listener/interval ma NON: occupancyState, audioRuleSamples, detectionIdEventIdMap, maps vari
- **Fix:** Aggiungere cleanup completo in release()

---

## 2. Complessità Metodi — Priorità ALTA

### 2.1 Metodi >200 LOC da spezzare

| Metodo | LOC | Dove | Estrarre in |
|--------|-----|------|-------------|
| `onRequest()` | ~1,300 | main.ts | `HttpRouter` class con handler separati per route |
| `manualCheckOccupancyRule()` | ~853 | cameraMixin.ts | `OccupancyChecker.evaluate()` |
| `onRestart()` | ~745 | cameraMixin.ts | Separare occupancy check da restart logic |
| `startCheckInterval()` | ~580 | cameraMixin.ts | `enableRules()`, `setupMqtt()`, `scheduleMaintenance()` |
| `getDetectionRulesSettings()` | ~500 | utils.ts | `SettingsBuilder` class |
| `executeDetection()` | ~497 | cameraMixin.ts | `DetectionExecutor.run()` |
| `processDetections()` | ~460 | cameraMixin.ts | `acquireImage()`, `reportDetections()`, `matchRules()`, `storeData()` |

### 2.2 processDetections() — Pipeline
Attualmente è un metodo monolitico. Dovrebbe diventare una pipeline:
```
1. acquireDetectionImage(detect, eventSource) → {b64Image, image, imageSource}
2. reportBasicDetections(candidates, b64Image) → void (MQTT side-effect)
3. matchAndTriggerRules(candidates, image) → MatchRule[]
4. storeDetectionData(candidates, b64Image, eventSource) → void (FS side-effect)
```

---

## 3. Duplicazione Codice — Priorità ALTA

### 3.1 mqtt-utils.ts — 5 subscribe fn identiche
`subscribeToPluginMqttTopics`, `subscribeToAlarmSystemMqttTopics`, `subscribeToCameraMqttTopics`, `subscribeToNotifierMqttTopics`, `subscribeToSensorMqttTopics` — stesso pattern:
```
check mqttClient → getEntities → for each → getMqttTopics → subscribe → check payload → callback → publish
```
**Fix:** Creare `MqttSubscriptionBuilder`:
```typescript
new MqttSubscriptionBuilder(mqttClient)
  .addSwitch('recording', switchRecordingCb)
  .addSwitch('snapshots', switchSnapshotsCb)
  .subscribe()
```

### 3.2 mqtt-utils.ts — 5 setup/autodiscovery fn simili
`setupPluginAutodiscovery`, `setupAlarmSystemAutodiscovery`, `setupCameraAutodiscovery`, `setupNotifierAutodiscovery`, `setupSensorAutodiscovery`
**Fix:** Estrarre template comune `setupEntityAutodiscovery(type, entities, mqttClient)`

### 3.3 utils.ts — 6 pattern rules identici
`getDetectionRules`, `getDeviceOccupancyRules`, `getDeviceTimelapseRules`, `getDeviceAudioRules`, `getRecordingRules`, `getDevicePatrolRules` — tutti:
```
storage.getItem() → safeParseJson() → loop/filter → return {availableRules, allowedRules}
```
**Fix:** `createRuleProcessor(ruleType, storageKey, parser)` factory

### 3.4 cameraMixin.ts — switch subscribe duplicati (righe 1376-1435)
5 blocchi `if (switchXyzCb)` identici per rebroadcast, recording, snapshots, privacy, notifications
**Fix:** Usa il `MqttSubscriptionBuilder` del punto 3.1

---

## 4. Estrazione Moduli — Priorità MEDIA

### 4.1 Da cameraMixin.ts (6,669 LOC → ~5 file)

| Modulo | Responsabilità | LOC stimato |
|--------|----------------|-------------|
| `DetectionProcessor` | processDetections, executeDetection, checkRuleMatches | ~1,200 |
| `OccupancyChecker` | checkOccupancyData, manualCheckOccupancyRule | ~1,000 |
| `RecordingManager` | startRecording, stopRecording, getVideoClips | ~500 |
| `AudioAnalyzer` | startAudioAnalyzer, audio level, audio classification | ~400 |
| `DecoderManager` | initDecoderStream, startDecoder, stopDecoder, cleanup | ~300 |

### 4.2 Da main.ts (5,910 LOC → ~4 file)

| Modulo | Responsabilità | LOC stimato |
|--------|----------------|-------------|
| `HttpRouter` | onRequest, route matching, SPA serving | ~1,500 |
| `FilesystemStorage` | getFsPaths, getRulePaths, store*, clear* | ~800 |
| `MediaGenerator` | generateTimelapse, generateVideoclip, generateGif | ~400 |
| `QueueProcessor` | dbWriteQueue, clearVideoclipsQueue, autodiscoveryQueue | ~300 |

### 4.3 Da utils.ts (6,631 LOC → ~3 file)

| Modulo | Responsabilità | LOC stimato |
|--------|----------------|-------------|
| `ruleUtils.ts` | Tutti i rule getter, rule parsing, rule keys | ~2,000 |
| `settingsUtils.ts` | getTextSettings, getMixinBaseSettings, getRuleSettings | ~2,500 |
| `textUtils.ts` | Template text, i18n keys, text rendering | ~500 |

---

## 5. Anti-pattern da Correggere — Priorità BASSA

### 5.1 Fire-and-forget promises
```typescript
setupPluginAutodiscovery({...}).catch(logger.error);  // no retry
publishPluginValues({...}).catch(logger.error);        // silently fails
```
**Fix:** Implementare retry con backoff per operazioni critiche

### 5.2 Nested callback in notifyDetectionEvent
```typescript
const executeNotify = async (props) => { ... }
checkIfClipRequired({ cb: executeNotify, ... })
```
**Fix:** Linearizzare con async/await: `const clipRequired = await checkIfClipRequired(); if (clipRequired) await executeNotify();`

### 5.3 getBasicMqttEntities() non memoizzato
Crea 25+ entity definitions da zero a ogni chiamata.
**Fix:** Memoizzare a livello modulo (le entity non cambiano a runtime)

### 5.4 audioLabels hardcoded (285 righe)
Array da 285 righe in detectionClasses.ts
**Fix:** Spostare in file JSON esterno

---

## Ordine di Esecuzione Consigliato

### Fase 1 — Memory (impatto immediato su stabilità)
- [ ] 1.1 LRU su embedding cache
- [ ] 1.2 TTL cleanup su state maps cameraMixin
- [ ] 1.3 Rimuovere lastFrame, tenere solo lastB64Image
- [ ] 1.4 Cleanup in releaseMixin()
- [ ] 1.5 Completare release()

### Fase 2 — Duplicazione (riduce LOC, facilita manutenzione)
- [ ] 3.1 MqttSubscriptionBuilder
- [ ] 3.3 createRuleProcessor factory
- [ ] 3.2 Template autodiscovery comune

### Fase 3 — Estrazione moduli (architettura)
- [ ] 4.1 DetectionProcessor da cameraMixin
- [ ] 4.1 OccupancyChecker da cameraMixin
- [ ] 4.2 HttpRouter da main.ts
- [ ] 4.3 ruleUtils.ts e settingsUtils.ts da utils.ts

### Fase 4 — Complessità metodi
- [ ] 2.2 Pipeline processDetections
- [ ] 2.1 Spezzare metodi >200 LOC

### Fase 5 — Cleanup
- [ ] 5.1 Retry su promise critiche
- [ ] 5.2 Linearizzare callback
- [ ] 5.3 Memoizzare getBasicMqttEntities
