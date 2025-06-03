import fs from 'fs';
import { orderBy } from 'lodash';
import moment from 'moment';
import { Config, JsonDB } from 'node-json-db';
import path from 'path';
import { ScryptedEventSource } from './utils';

const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
const dbsPath = path.join(pluginVolume, 'dbs');
const eventDbsPath = path.join(dbsPath, 'events');

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
  sensorName?: string;
}

export const cleanupEvents = async (props: { logger: Console }) => {
  const { logger } = props;
  await fs.promises.rm(eventDbsPath, { recursive: true, force: true, maxRetries: 10 });

  logger.log(`All DBs pruned`);
}

const getDbForEvent = async (timestamp: number) => {
  const date = new Date(timestamp);
  const dayStr = moment(date).format('YYYYMMDD');

  try {
    await fs.promises.access(eventDbsPath);
  } catch {
    await fs.promises.mkdir(eventDbsPath, { recursive: true });
  }

  const dbPath = path.join(eventDbsPath, dayStr);
  return {
    db: new JsonDB(new Config(dbPath, true, true, '/')),
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

  await db.push('/events[]', event);
  logger.info(`Record ${JSON.stringify(event)} pushed to events DB ${dayStr}`);
}

export const getEventDays = async () => {
  const folders = await fs.promises.readdir(eventDbsPath);
  return folders.map(date => moment(date, 'YYYYMMDD').toISOString());
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
    const dayStr = current.format('YYYYMMDD')
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