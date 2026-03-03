# Piano: Advanced Notifier Recorder mixin e pipeline unificata

Piano per un’estensiva modifica al plugin Advanced Notifier: **sostituire** decoder, ffmpeg audio e recorder attuali con **una sola pipeline** che supporti clip on-demand, recording con retention (motion, detection, ecc.) e spostare tutta la logica eventi/recording in un nuovo mixin **Advanced Notifier Recorder**.

---

## 1. Situazione attuale (da sostituire)

### 1.1 Componenti separati

| Componente | File | Ruolo | Input | Output |
|------------|------|--------|-------|--------|
| **Decoder** | `cameraMixin.ts` | Loop frame per motion/detection | `getVideoStream(decoderStream)` (solo video, no audio) | JPEG in `lastFrame` + `storeDecoderFrame()` |
| **Audio** | `audioAnalyzerUtils.ts` | Analisi volume/classificazione | RTSP → ffmpeg `-vn -dn -sn` → PCM 16kHz mono | Eventi `audio` → `processAudioDetection` → `addMotionEvent` |
| **Recording** | `videoRecorderUtils.ts` | Clip su trigger (recording rules) | RTSP → ffmpeg `-c:v copy|libx264` (no audio in pratica) | `.mp4` in `recordedEvents/` |

Problemi:
- **Tre consumi separati** dello stream (decoder, audio ffmpeg, recording ffmpeg) = più connessioni RTSP e più carico.
- **Nessuna pipeline unica** video+audio: decoder senza audio, recorder senza audio reale, audio da secondo ffmpeg.
- **Eventi e recording** sono in `cameraMixin` + `main.ts`; nessun modulo dedicato “recorder/events”.

### 1.2 Dove vivono eventi e clip oggi

- **Scrittura eventi:** `main.ts` → `storeEventImage()`, `addMotionEvent()` → `enqueueDbWrite` → `writeEventsAndMotionBatch()` in `db.ts` (path `storagePath/{deviceId}/events/dbs/{YYYYMMDD}.json`).
- **Trigger recording:** `cameraMixin.processAccumulatedDetections()` → `startRecording({ triggerTime, rules, candidates })`; prolungamento da `ensureRecordingMotionCheckInterval()`.
- **Clip:** `cameraMixin.getVideoClipsInternal()` legge da `recordedEventsPath` e da rule-generated path; `VideoRtspFfmpegRecorder` scrive in `recordedEvents/`.

---

## 2. Obiettivi

1. **Una sola pipeline** per dispositivo camera:
   - Un input (stream video, con o senza audio).
   - Da lì: **frame per analysis** (motion/detection), **audio** (se presente), **segmenti di recording** (buffer/scratch + clip finali).
2. **Clip on-demand:** generazione clip a partire da un intervallo temporale (es. “ultimi 30 s”, o “dalle 12:00:00 per 60 s”) usando la pipeline, senza avviare un secondo ffmpeg ad hoc.
3. **Recording con retention rules:** continuare a supportare “record on motion / on detection” con regole configurabili; retention (es. “tieni 7 giorni”, “solo eventi con persona”) gestita nel nuovo mixin.
4. **Nuovo mixin “Advanced Notifier Recorder”:** contiene tutta la logica eventi + recording + clip; il camera mixin resta “analysis + notifiche”, il plugin orchestra e espone API.

---

## 3. Architettura target

### 3.1 Pipeline unica (per camera)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                  UNIFIED RECORDER PIPELINE                │
  Stream (RTSP/     │  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐  │
  getVideoStream)   │  │   Ingest    │───▶│   Circular   │───▶│   Outputs   │  │
  ─────────────────▶│  │ (demux +   │    │   Buffer     │    │ - Analysis   │  │
                    │  │  optional   │    │ (e.g. 60s)   │    │   frames     │  │
                    │  │  audio)     │    │              │    │ - Audio      │  │
                    │  └─────────────┘    └──────┬───────┘    │   chunks     │  │
                    │         │                   │           │ - Clips      │  │
                    │         │                   │           │   (on-demand │  │
                    │         │                   │           │   or rule)  │  │
                    │         │                   ▼           └─────────────┘  │
                    │         │            ┌──────────────┐                     │
                    │         └───────────│  Retention   │                     │
                    │                      │  & clip      │                     │
                    │                      │  writer      │                     │
                    └─────────────────────┴──────────────┴─────────────────────┘
```

- **Ingest:** un processo ffmpeg (o un solo consumer Scrypted) che legge **un** stream (video + audio se disponibile): demux, decode video (e opzionale audio), scrive in un **buffer circolare** (segmenti in memoria o su disco, es. anelli da 60 s).
- **Outputs dalla pipeline:**
  - **Analysis:** copia frame (o callback) verso il decoder esistente / motion / detection (così il camera mixin continua a ricevere frame senza aprire un secondo stream).
  - **Audio:** stessi chunk PCM usati per analisi (soglie, YAMNET) e, se serve, per mux nei clip.
  - **Clips:**
    - **On-demand:** da buffer circolare + eventuale “tail live” → un segmento [start, end] → file .mp4 (o altro) generato dalla pipeline (es. segmenti già in formato adatto, o un secondo pass ffmpeg breve).
    - **Retention rules:** quando una regola dice “record”, la pipeline scrive da buffer + live in un file in `recordedEvents/` (o path configurato), con possibile post-processing (thumbnail, metadati).

### 3.2 Nuovo mixin: Advanced Notifier Recorder

- **Nome proposto:** `AdvancedNotifierRecorderMixin` (file es. `src/recorderMixin.ts`).
- **Interfacce Scrypted da considerare:** `EventRecorder`, `VideoClips` (se già usate), più l’eventuale nuova interfaccia per “clip on-demand” (es. `getClipForTimeRange(deviceId, startTime, endTime)`).
- **Responsabilità:**
  - **Eventi:** ricevere “eventi” e “motion” dal camera mixin (o dalla pipeline) e scriverli nel DB (delega a `main.ts` per `enqueueDbWrite` o incorpora la logica se si sposta anche la queue nel recorder).
  - **Recording:** gestione regole di recording (motion, detection, retention); avvio/arresto segmenti di recording tramite la **pipeline unica** (non più `VideoRtspFfmpegRecorder` separato).
  - **Clip on-demand:** esporre API per “genera clip per [deviceId, start, end]” usando il buffer + writer della pipeline.
  - **Retention:** pulizia clip/segmenti secondo retention rules (giorni, tipo evento, spazio disco); possibile integrazione con “rimuovi clip più vecchi di X” già presente in `main.ts`.

### 3.3 Ruolo del camera mixin dopo il refactor

- **Conservare:** regole detection, notifiche, occupancy, timelapse, UI settings (decoder type, stream destination, ecc.).
- **Cambiare:**
  - **Decoder:** non più un loop che chiama `getVideoStream()` da solo; invece **riceve frame dalla pipeline** del recorder (o legge da un’API del recorder “get next frame for analysis”). In questo modo c’è un solo consumer dello stream.
  - **Audio:** non più `AudioRtspFfmpegStream` nel camera mixin; il recorder espone chunk audio (o callback) e il camera mixin continua a chiamare `processAudioDetection` con quei chunk.
  - **Recording:** nessuna chiamata a `startRecording` / `VideoRtspFfmpegRecorder` dal camera mixin; il camera mixin segnala al recorder “c’è un evento/motion che matcha una recording rule” e il **recorder** avvia/ prolunga il segmento tramite la pipeline.
- **Eventi:** il camera mixin può continuare a chiamare `plugin.storeEventImage()` e `plugin.addMotionEvent()`; l’implementazione di queste può essere spostata nel recorder mixin (e il plugin le delega al recorder), così tutta la “scrittura eventi” è in un posto.

### 3.4 Plugin (main.ts)

- **Composizione:** oltre a `AdvancedNotifierCameraMixin` e `AdvancedNotifierNotifierMixin`, introdurre `AdvancedNotifierRecorderMixin`.
  - Opzione A: il **recorder è un mixin sulla stessa camera** (stesso device, tre mixin: notifier, camera, recorder). La pipeline unica è di proprietà del recorder; camera e notifier la “usano” tramite il recorder.
  - Opzione B: il recorder è un **device separato** “Recorder” per camera (uno-a-uno). La pipeline vive nel device Recorder; la camera mixin comunica con esso via plugin.
- **Percorsi e storage:** `getRecordedEventPath`, `getEventPaths`, `storeEventImage`, `addMotionEvent` possono restare in `main.ts` come facade che delega al recorder mixin (per device camera), così l’API pubblica del plugin non cambia.
- **DB queue:** `dbWriteQueue` / `enqueueDbWrite` / `runDbWriteProcess` possono restare in `main.ts` o essere spostati nel recorder; il recorder in ogni caso deve poter scrivere eventi/motion nel DB.

---

## 4. Pipeline unica: dettaglio tecnico

### 4.1 Scelta implementativa

- **Opzione 1 – FFmpeg unico (demux + buffer + tee):** un processo ffmpeg che:
  - Legge RTSP (o riceve stream da Scrypted).
  - Demux video + audio.
  - Scrive in un **segment file** circolare (es. `segment_%03d.m4s` o simile) o in un **named pipe / shared memory** letto da Node.
  - Opzionale: `tee` per inviare copia a un secondo output (es. analisi).
  - Pro: un solo processo, meno connessioni. Contro: complessità buffer/segmenti e sincronizzazione con “clip da intervallo”.
- **Opzione 2 – Consumer Scrypted + buffer in Node:** un solo `getVideoStream()` (con audio se il backend lo supporta); in Node un consumer che:
  - Legge frame (e eventuale audio) e li mette in un **buffer circolare** (es. anello di segmenti in memoria o file).
  - Espone “slice del buffer” per clip on-demand e per “scrivi da start a end” per recording.
  - Pro: massimo controllo in JS. Contro: possibile overhead e complessità (codec, mux) se i frame arrivano già codificati.
- **Opzione 3 – Ibrido:** ffmpeg per ingest e buffer su disco (segmenti brevi, es. 5–10 s); un servizio in Node che tiene un indice (startTime → file) e per clip on-demand concatena/rimux con ffmpeg. Recording “su regola” = copia di segmenti già scritti + append live fino a fine evento.

Raccomandazione: partire da **Opzione 3** per avere un buffer su disco ben definito e clip on-demand affidabili; unificare comunque in **un solo ffmpeg di ingest** (video+audio) che produce segmenti, e un “RecorderPipeline” in Node che gestisce indice, retention e generazione clip.

### 4.2 Buffer circolare / segmenti

- **Formato:** segmenti brevi (es. 5–15 s) in formato adatto al concatenamento (es. fMP4 o segmenti MPEG-TS).
- **Indice:** struttura (in memoria o file) che mappa `[startTime, endTime]` → lista file segmenti.
- **Retention:** job periodico che rimuove segmenti oltre la retention (o oltre lo spazio massimo); i clip “recorded” (salvati in `recordedEvents/`) sono copie permanenti fino a quando non scatta la loro retention.

### 4.3 Clip on-demand

- **Input:** `deviceId`, `startTime`, `endTime` (timestamp Unix o ms).
- **Logica:** dalla pipeline (indice segmenti) individuare i segmenti che coprono [startTime, endTime]; concatenare (concat demuxer ffmpeg o copy) e scrivere un file .mp4; opzionale: estrarre thumbnail a metà clip.
- **Output:** path del file clip (e thumbnail) da esporre via API (es. `VideoClips.getVideoClip` o nuova `getClipForTimeRange`).

### 4.4 Recording con retention rules

- **Regole:** come oggi (motion, classi detection, ecc.) ma interpretate dal **recorder mixin**.
- **Trigger:** il camera mixin (o la pipeline) segnala “motion on” / “detection X”; il recorder confronta con le regole e decide “start recording” / “prolong”.
- **Scrittura:** invece di avviare un `VideoRtspFfmpegRecorder` separato, il recorder dice alla pipeline “da adesso scrivi in un file in `recordedEvents/` fino a fine evento (o max duration)”. La pipeline può:
  - copiare dal buffer (segmenti già scritti) per la parte “pre-trigger” (es. 30 s prima),
  - poi appendere live fino a “motion off” + post-buffer.
- **Retention:** regole tipo “conserva 7 giorni”, “solo eventi con persona”; il recorder applica la pulizia sui file in `recordedEvents/` (e eventualmente sui segmenti del buffer).

---

## 5. Piano di implementazione (fasi)

### Fase 1 – Fondamenta recorder e spostamento eventi

1. **Creare `recorderMixin.ts`** (Advanced Notifier Recorder mixin).
   - Interfacce: almeno ciò che serve per “eventi” e “clip” (EventRecorder / VideoClips se già usate).
   - Implementare **delega** di `storeEventImage` e `addMotionEvent`: il plugin, quando è un device camera con recorder mixin, inoltra al recorder; il recorder chiama la stessa logica di scrittura DB (o sposta `enqueueDbWrite` nel recorder).
2. **Registrare il mixin in `main.ts`:** per le camera, creare anche il recorder mixin (stesso device o device figlio); mantenere l’API `storeEventImage` / `addMotionEvent` sul plugin che delega al recorder.
3. **Test:** verificare che eventi e motion continuino a essere scritti e letti come oggi (Events App, Data Fetcher).

### Fase 2 – Pipeline unica (ingest + buffer)

1. **Modulo “RecorderPipeline”** (es. `src/recorderPipeline.ts` o sotto `src/recorder/`):
   - Ingest: un processo ffmpeg che legge **un** stream (RTSP o URL da `getVideoStream` se possibile) con **video + audio**, output in segmenti (fMP4 o TS).
   - Parametri: cameraId, stream URL, path directory segmenti, lunghezza segmento, lunghezza buffer (es. 60 s = 12 segmenti da 5 s).
   - Scrittura segmenti e indice (startTime/endTime per segmento).
2. **Integrazione nel recorder mixin:** all’avvio della camera (o on-demand quando serve recording/clip), avviare la pipeline per quella camera; fermarla quando la camera viene rilasciata.
3. **Sostituire l’audio analyzer:** invece di avviare `AudioRtspFfmpegStream`, il recorder legge l’audio dalla pipeline (dai segmenti o da un output ffmpeg dedicato “solo audio” tee). Fornire i chunk al camera mixin per `processAudioDetection` (stessa API).
4. **Sostituire il decoder:** il decoder non chiama più `getVideoStream()` direttamente; la pipeline espone “frame per analysis” (es. estrazione frame dai segmenti con ffmpeg, o tee video verso un output che il camera mixin consuma). Il camera mixin continua a fare motion/detection sui frame così forniti.

### Fase 3 – Recording e clip dalla pipeline

1. **Recording:** rimuovere `VideoRtspFfmpegRecorder` e `startRecording` dal camera mixin. Nel recorder:
   - Alla notifica “start recording” (da camera mixin o da regole interne), chiedere alla pipeline di “salvare da buffer[start] a live fino a stop”.
   - Implementare “prolong on motion” leggendo lo stato motion dalla pipeline/camera mixin.
2. **Clip on-demand:** implementare `getClipForTimeRange(deviceId, startTime, endTime)` (o equivalente) usando l’indice segmenti; concatenare e scrivere .mp4; restituire path o URL.
3. **Retention:** job nel recorder che applica retention rules su `recordedEvents/` e sui segmenti del buffer; integrare con la logica di rimozione clip già presente in `main.ts` (es. spostarla nel recorder).

### Fase 4 – Pulizia e opzionali

1. **Rimuovere** da `cameraMixin.ts`: `startRecording`, `stopRecording`, `ensureRecordingMotionCheckInterval`, uso di `VideoRtspFfmpegRecorder`, `AudioRtspFfmpegStream` (sostituito dalla pipeline), e il loop decoder “standalone” (sostituito da frame dalla pipeline).
2. **Deprecare** (o rimuovere) `videoRecorderUtils.ts` e `audioAnalyzerUtils.ts` nella forma attuale; eventualmente tenere helper riutilizzabili (es. estrazione thumbnail) dentro il modulo pipeline/recorder.
3. **Documentazione:** aggiornare README e doc per “single pipeline”, “recorder mixin”, “retention rules”.
4. **Settings:** spostare le impostazioni “recording rules”, “retention”, “buffer length”, “decoder source” (pipeline vs legacy, se si mantiene fallback) nel recorder mixin o in una sezione “Recording” condivisa.

---

## 6. Riepilogo file toccati / nuovi

| Azione | File |
|--------|------|
| **Nuovo** | `src/recorderMixin.ts` – Advanced Notifier Recorder mixin (eventi, recording, clip, retention). |
| **Nuovo** | `src/recorderPipeline.ts` (o `src/recorder/`) – Ingest ffmpeg, buffer segmenti, indice, export clip. |
| **Modifica** | `src/main.ts` – Registrazione recorder mixin, delega `storeEventImage`/`addMotionEvent` al recorder, eventuale spostamento DB queue. |
| **Modifica** | `src/cameraMixin.ts` – Rimuovere decoder standalone, audio analyzer, startRecording/VideoRtspFfmpegRecorder; ricevere frame e audio dalla pipeline/recorder; mantenere detection, notifiche, regole. |
| **Modifica** | `src/db.ts` – Solo se la scrittura eventi viene spostata nel recorder (stesso schema, diverso chiamante). |
| **Deprecare/rimuovere** | `src/videoRecorderUtils.ts` – Sostituito dalla pipeline. |
| **Deprecare/rimuovere** | `src/audioAnalyzerUtils.ts` – Sostituito da audio dalla pipeline. |

---

## 7. Rischi e mitigazioni

- **Compatibilità:** mantenere l’API pubblica del plugin (EventRecorder, VideoClips, getVideoClips, getRecordedEventPath, storeEventImage, addMotionEvent) così che camstack e altri client non cambino.
- **Performance:** un solo ffmpeg per camera può essere un single point of failure; prevedere restart automatico e backoff come in `VideoRtspFfmpegRecorder`/`AudioRtspFfmpegStream`.
- **Disco:** il buffer circolare su disco consuma spazio; configurare lunghezza massima e retention chiara.
- **Migrazione:** per rollout graduale, si può mantenere un “legacy mode” (decoder + audio ffmpeg + VideoRtspFfmpegRecorder) disattivabile da setting “Use unified recorder pipeline”, e abilitare la nuova pipeline solo quando il setting è on.

---

Questo piano può essere usato come base per issue, task e PR incrementali (una fase per volta).
