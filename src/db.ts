import fs from 'fs';
import { orderBy } from 'lodash';
import moment from 'moment';
import { Config, JsonDB } from 'node-json-db';
import path from 'path';
import { ScryptedEventSource } from './utils';
import { ObjectDetectionResult } from '@scrypted/sdk';

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

/** Motion on/off transition; stored in same JSON as events (path: /motion). */
export type DbMotionEvent = {
  timestamp: number;
  deviceId: string;
  motion: 'on' | 'off';
}

const MOTION_PATH = '/motion';
const OLD_DBS_DIR = 'dbs';

/** One-time migration: move storagePath/dbs/YYYYMMDD.json (events only) to storagePath/{deviceId}/events/dbs/{day}.json. Motion is not migrated (implemented from now on). */
export const migrateDbsToPerDevice = async (props: { logger: Console; storagePath: string }) => {
  const { logger, storagePath } = props;
  const oldDbsPath = path.join(storagePath, OLD_DBS_DIR);
  try {
    await fs.promises.access(oldDbsPath);
  } catch {
    return;
  }
  const files = await fs.promises.readdir(oldDbsPath);
  const dayEvents: Record<string, Record<string, DbDetectionEvent[]>> = {};

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const dayStr = file.replace('.json', '');
    if (!moment(dayStr, dbFileFormat).isValid()) continue;
    const fullPath = path.join(oldDbsPath, file);
    let data: { events?: DbDetectionEvent[] };
    try {
      const raw = await fs.promises.readFile(fullPath, 'utf-8');
      data = JSON.parse(raw) as { events?: DbDetectionEvent[] };
    } catch (e) {
      logger.warn(`Migration: skip ${file} (read error)`);
      continue;
    }
    const events = data.events ?? [];
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (!e.deviceId) continue;
      if (!dayEvents[dayStr]) dayEvents[dayStr] = {};
      if (!dayEvents[dayStr][e.deviceId]) dayEvents[dayStr][e.deviceId] = [];
      dayEvents[dayStr][e.deviceId].push(e);
    }
  }

  for (const dayStr of Object.keys(dayEvents)) {
    for (const deviceId of Object.keys(dayEvents[dayStr])) {
      const events = dayEvents[dayStr][deviceId];
      const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
      await fs.promises.mkdir(dbsPath, { recursive: true });
      const filePath = path.join(dbsPath, `${dayStr}.json`);
      await fs.promises.writeFile(
        filePath,
        JSON.stringify({ events, motion: [] }, null, 0),
        'utf-8'
      );
    }
  }

  await fs.promises.rm(oldDbsPath, { recursive: true, force: true, maxRetries: 10 });
  logger.log(`Migration completed: events DBs moved from shared folder to per-device events/dbs`);
};

/** Remove all device event DBs (storagePath/{deviceId}/events/dbs). */
export const cleanupEvents = async (props: { logger: Console; storagePath: string }) => {
  const { logger, storagePath } = props;
  try {
    const dirs = await fs.promises.readdir(storagePath);
    for (const deviceId of dirs) {
      const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
      try {
        await fs.promises.rm(dbsPath, { recursive: true, force: true, maxRetries: 10 });
        logger.log(`Removed DBs for device ${deviceId}`);
      } catch {
        // ignore missing
      }
    }
    logger.log(`All device DBs pruned`);
  } catch (e) {
    logger.error('Error cleaning up events DBs', e);
  }
};

/** Delete old day files in a device's dbs folder (events + motion in same file). */
export const cleanupOldDeviceDbs = async (props: {
  logger: Console;
  dbsPath: string;
  thresholdTimestamp: number;
}) => {
  const { logger, dbsPath, thresholdTimestamp } = props;
  try {
    await fs.promises.access(dbsPath);
  } catch {
    return;
  }
  const files = await fs.promises.readdir(dbsPath);
  const thresholdDate = moment(thresholdTimestamp);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const dateStr = file.replace('.json', '');
    const fileDate = moment(dateStr, dbFileFormat);
    if (!fileDate.isValid() || !fileDate.isBefore(thresholdDate, 'day')) continue;

    const dbPath = path.join(dbsPath, dateStr);
    if (dailyDbCache[dbPath]) {
      delete dailyDbCache[dbPath];
    }
    try {
      await fs.promises.unlink(path.join(dbsPath, file));
      logger.log(`Removed old DB file: ${file}`);
    } catch (e) {
      logger.error(`Error removing ${file}`, e);
    }
  }
};

const dailyDbCache: Record<string, { db: JsonDB; lastUse: number }> = {};

const getDbForDay = async (timestamp: number, dbsPath: string) => {
  const date = new Date(timestamp);
  const dayStr = moment(date).format(dbFileFormat);

  try {
    await fs.promises.access(dbsPath);
  } catch {
    await fs.promises.mkdir(dbsPath, { recursive: true });
  }

  const dbPath = path.join(dbsPath, dayStr);

  let cached = dailyDbCache[dbPath];
  if (!cached) {
    cached = { db: new JsonDB(new Config(dbPath, true, true, '/')), lastUse: Date.now() };
    dailyDbCache[dbPath] = cached;
  } else {
    cached.lastUse = Date.now();
  }

  return { db: cached.db, dayStr };
};

export const addEvent = async (props: {
  event: DbDetectionEvent;
  logger: Console;
  dbsPath: string;
}) => {
  const { event, logger, dbsPath } = props;
  const { dayStr, db } = await getDbForDay(event.timestamp, dbsPath);

  try {
    await db.getData('/events');
  } catch {
    logger.log(`Initializing events DB ${dayStr}`);
    await db.push('/events', [], true);
  }

  await db.push('/events[]', event);
  logger.info(`Record ${JSON.stringify({ id: event.id, ts: event.timestamp, dev: event.deviceId, classes: event.classes })} pushed to events DB ${dayStr}`);
};

export const addMotionEvent = async (props: {
  motionEvent: DbMotionEvent;
  logger: Console;
  dbsPath: string;
}) => {
  const { motionEvent, logger, dbsPath } = props;
  const { dayStr, db } = await getDbForDay(motionEvent.timestamp, dbsPath);

  try {
    await db.getData(MOTION_PATH);
  } catch {
    logger.log(`Initializing motion in DB ${dayStr}`);
    await db.push(MOTION_PATH, [], true);
  }

  await db.push(`${MOTION_PATH}[]`, motionEvent);
  logger.info(`Motion ${motionEvent.motion} at ${motionEvent.timestamp} for device ${motionEvent.deviceId} pushed to motion DB ${dayStr}`);
};

/** Write a batch of events and motion for one device+day in a single DB update. */
export const writeEventsAndMotionBatch = async (props: {
  dbsPath: string;
  dayStr: string;
  newEvents: DbDetectionEvent[];
  newMotion: DbMotionEvent[];
  logger: Console;
}) => {
  const { dbsPath, dayStr, newEvents, newMotion, logger } = props;
  const timestampForDay = moment(dayStr, dbFileFormat).valueOf();
  const { db } = await getDbForDay(timestampForDay, dbsPath);

  let existingEvents: DbDetectionEvent[] = [];
  let existingMotion: DbMotionEvent[] = [];
  try {
    existingEvents = (await db.getData('/events')) ?? [];
  } catch {
    existingEvents = [];
  }
  try {
    existingMotion = (await db.getData(MOTION_PATH)) ?? [];
  } catch {
    existingMotion = [];
  }

  const events = orderBy([...existingEvents, ...newEvents], 'timestamp', ['asc']);
  const motion = orderBy([...existingMotion, ...newMotion], 'timestamp', ['asc']);

  await db.push('/events', events, true);
  await db.push(MOTION_PATH, motion, true);
  logger.info(`DB batch write ${dayStr}: ${newEvents.length} events, ${newMotion.length} motion`);
};

export const getMotionInRange = async (props: {
  startTimestamp: number;
  endTimestamp: number;
  storagePath: string;
  deviceIds?: string[];
}) => {
  const { startTimestamp, endTimestamp, storagePath, deviceIds } = props;
  const start = moment(startTimestamp);
  const end = moment(endTimestamp);
  const allMotion: DbMotionEvent[] = [];

  const deviceDirs = deviceIds ?? (await fs.promises.readdir(storagePath).catch(() => []));

  for (const deviceId of deviceDirs) {
    const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
    try {
      await fs.promises.access(dbsPath);
    } catch {
      continue;
    }
    let current = start.clone();
    while (current.isSameOrBefore(end, 'day')) {
      const dayStr = current.format(dbFileFormat);
      const dbPath = path.join(dbsPath, `${dayStr}.json`);
      if (fs.existsSync(dbPath)) {
        const db = new JsonDB(new Config(path.join(dbsPath, dayStr), true, true, '/'));
        try {
          const motion = await db.getObject<DbMotionEvent[]>(MOTION_PATH);
          const filtered = motion.filter(
            (m) => m.timestamp >= startTimestamp && m.timestamp <= endTimestamp
          );
          allMotion.push(...filtered);
        } catch {
          // no /motion key
        }
      }
      current.add(1, 'day');
    }
  }

  return orderBy(allMotion, 'timestamp', ['asc']);
};

export const cleanupDbCache = (idleMs = 5 * 60 * 1000) => {
  const now = Date.now();
  for (const [key, value] of Object.entries(dailyDbCache)) {
    if ((now - value.lastUse) > idleMs) {
      delete dailyDbCache[key];
    }
  }
};

export const getEventDays = async (storagePath: string, deviceIds?: string[]) => {
  const deviceDirs = deviceIds ?? (await fs.promises.readdir(storagePath).catch(() => []));
  const allDays: string[] = [];
  for (const deviceId of deviceDirs) {
    const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
    try {
      const files = await fs.promises.readdir(dbsPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const dateStr = file.replace('.json', '');
          if (moment(dateStr, dbFileFormat).isValid()) allDays.push(dateStr);
        }
      }
    } catch {
      // ignore
    }
  }
  return [...new Set(allDays)].map((d) => moment(d, dbFileFormat).toISOString());
};

export const getEventsInRange = async (props: {
  startTimestamp: number;
  endTimestamp: number;
  logger: Console;
  storagePath: string;
  deviceIds?: string[];
}) => {
  const { endTimestamp, startTimestamp, storagePath, deviceIds } = props;
  const start = moment(startTimestamp);
  const end = moment(endTimestamp);
  const allEvents: DbDetectionEvent[] = [];

  const deviceDirs = deviceIds ?? (await fs.promises.readdir(storagePath).catch(() => []));

  for (const deviceId of deviceDirs) {
    const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
    try {
      await fs.promises.access(dbsPath);
    } catch {
      continue;
    }
    let current = start.clone();
    while (current.isSameOrBefore(end, 'day')) {
      const dayStr = current.format(dbFileFormat);
      const dbPath = path.join(dbsPath, `${dayStr}.json`);
      if (fs.existsSync(dbPath)) {
        const db = new JsonDB(new Config(path.join(dbsPath, dayStr), true, true, '/'));
        try {
          const events = await db.getObject<DbDetectionEvent[]>('/events');
          const filtered = events.filter(
            (e) => e.timestamp >= startTimestamp && e.timestamp <= endTimestamp
          );
          allEvents.push(...filtered);
        } catch {
          // no /events key
        }
      }
      current.add(1, 'day');
    }
  }

  return orderBy(allEvents, 'timestamp', ['desc']);
};

export const cleanupDatabases = async (props: {
  days: number;
  logger: Console;
  storagePath: string;
}) => {
  const { days, logger, storagePath } = props;

  try {
    await fs.promises.access(storagePath);
  } catch {
    logger.log(`Skipping DB cleanup. path not existing`);
    return;
  }

  const dirs = await fs.promises.readdir(storagePath);
  const todayLessNDays = moment().subtract(days, 'days');
  let totalRemoved = 0;

  for (const deviceId of dirs) {
    const dbsPath = path.join(storagePath, deviceId, 'events', 'dbs');
    try {
      await fs.promises.access(dbsPath);
    } catch {
      continue;
    }
    const files = await fs.promises.readdir(dbsPath);
    const toDelete = files.filter((file) => {
      if (!file.endsWith('.json')) return false;
      const dateStr = file.replace('.json', '');
      const fileDate = moment(dateStr, dbFileFormat);
      return fileDate.isValid() && fileDate.isSameOrBefore(todayLessNDays);
    });
    for (const file of toDelete) {
      await fs.promises.unlink(path.join(dbsPath, file));
      totalRemoved += 1;
    }
  }

  if (totalRemoved > 0) {
    logger.log(`DBs cleanup completed: ${totalRemoved} files removed`);
  }
};
