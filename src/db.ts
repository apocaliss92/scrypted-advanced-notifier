import fs from 'fs';
import { orderBy } from 'lodash';
import moment from 'moment';
import { Config, JsonDB } from 'node-json-db';
import path from 'path';
import { ScryptedEventSource } from './utils';
import { ObjectDetectionResult } from '@scrypted/sdk';

const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
const dbsPath = path.join(pluginVolume, 'dbs');
const eventDbsPath = path.join(dbsPath, 'events');
const dbFileFormat = 'YYYYMMDD';

export type DbDetectionEvent = {
  id: string;
  eventId?: string;
  timestamp: number;
  classes: string[];
  label?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  source: ScryptedEventSource;
  deviceName: string;
  deviceId: string;
  sensorName?: string;
  detections: ObjectDetectionResult[];
}

export const cleanupEvents = async (props: { logger: Console }) => {
  const { logger } = props;
  await fs.promises.rm(eventDbsPath, { recursive: true, force: true, maxRetries: 10 });

  logger.log(`All DBs pruned`);
}

const dailyDbCache: Record<string, { db: JsonDB, lastUse: number }> = {};

const getDbForEvent = async (timestamp: number) => {
  const date = new Date(timestamp);
  const dayStr = moment(date).format(dbFileFormat);

  try {
    await fs.promises.access(eventDbsPath);
  } catch {
    await fs.promises.mkdir(eventDbsPath, { recursive: true });
  }

  const dbPath = path.join(eventDbsPath, dayStr);

  let cached = dailyDbCache[dbPath];
  if (!cached) {
    cached = { db: new JsonDB(new Config(dbPath, true, true, '/')), lastUse: Date.now() };
    dailyDbCache[dbPath] = cached;
  } else {
    cached.lastUse = Date.now();
  }

  return {
    db: cached.db,
    dayStr,
  };
}

export const addEvent = async (props: {
  event: DbDetectionEvent,
  logger: Console,
}) => {
  const { event, logger } = props;
  const { dayStr, db } = await getDbForEvent(event.timestamp)

  try {
    await db.getData('/events');
  } catch (e) {
    logger.log(`Initializing events DB ${dayStr}`);
  }
  // try {
  //   const current = await db.getObject<DbDetectionEvent[]>('/events');
  //   if (Array.isArray(current) && current.length >= MAX_EVENTS_PER_DAY) {
  //     // Rimuovo il 10% più vecchio per ridurre frequenza pruning.
  //     const prune = Math.ceil(MAX_EVENTS_PER_DAY * 0.1);
  //     const trimmed = current.slice(prune);
  //     await db.push('/events', trimmed, true); // overwrite
  //     logger.log(`Pruned ${prune} events from day ${dayStr} (size -> ${trimmed.length})`);
  //   }
  // } catch {
  //   // Ignora: /events non esiste ancora
  // }

  await db.push('/events[]', event);
  logger.info(`Record ${JSON.stringify({ id: event.id, ts: event.timestamp, dev: event.deviceId, classes: event.classes })} pushed to events DB ${dayStr}`);
}

export const cleanupDbCache = (idleMs = 5 * 60 * 1000) => {
  const now = Date.now();
  for (const [key, value] of Object.entries(dailyDbCache)) {
    if ((now - value.lastUse) > idleMs) {
      delete dailyDbCache[key];
    }
  }
};

export const getEventDays = async () => {
  const folders = await fs.promises.readdir(eventDbsPath);
  return folders.map(date => moment(date, dbFileFormat).toISOString());
}

export const getEventsInRange = async (props: {
  startTimestamp: number,
  endTimestamp: number,
  logger: Console
}) => {
  const { endTimestamp, startTimestamp } = props;
  const start = moment(startTimestamp)
  const end = moment(endTimestamp)

  const allEvents: DbDetectionEvent[] = []

  let current = start.clone()

  while (current.isSameOrBefore(end, 'day')) {
    const dayStr = current.format(dbFileFormat)
    const dbPath = path.join(eventDbsPath, `${dayStr}.json`);

    if (fs.existsSync(dbPath)) {
      const db = new JsonDB(new Config(dbPath, true, true, '/'))

      try {
        const events = await db.getObject<DbDetectionEvent[]>('/events');
        const filtered = events.filter(
          e => e.timestamp >= startTimestamp && e.timestamp <= endTimestamp
        )
        allEvents.push(...filtered)
      } catch (e) {
      }
    }

    current.add(1, 'day')
  }

  return orderBy(allEvents, 'timestamp', ['desc']);
}

export const cleanupDatabases = async (props: {
  days: number,
  logger: Console
}) => {
  const { days, logger } = props;

  try {
    await fs.promises.access(eventDbsPath);

    const allDays = await fs.promises.readdir(eventDbsPath);

    const todayLessNDays = moment().subtract(days, 'days');
    const dbsToDelete = allDays.filter(dataStr => {
      const data = moment(dataStr.replace('.json', ''), dbFileFormat);
      return data.isSameOrBefore(todayLessNDays);
    });

    for (const db of dbsToDelete) {
      const pathToDb = path.join(eventDbsPath, db);
      await fs.promises.rm(pathToDb, { recursive: true, force: true, maxRetries: 10 });
    }

    if (dbsToDelete.length) {
      logger.log(`DBs cleanup completed: ${dbsToDelete.length} removed (${dbsToDelete.join(', ')})`);
    }
  } catch {
    logger.log(`Skipping DB cleanup. path not existing`);
  }
}