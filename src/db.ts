import { Config, JsonDB } from 'node-json-db';
import path from 'path';
import { ScryptedEventSource } from './utils';

const pluginVolume = process.env.SCRYPTED_PLUGIN_VOLUME;
const dbPath = path.join(pluginVolume, 'events_db');
const db = new JsonDB(new Config(dbPath, true, true, '/'));

export type DbDetectionEvent = {
  id: string;
  timestamp: number;
  classes: string[];
  label?: string;
  remoteUrl: string;
  source: ScryptedEventSource;
  deviceId: string;
}

export const initDb = async (props: { logger: Console }) => {
  const { logger } = props;
  try {
    await db.getData('/events');
  } catch (e) {
    logger.log(`Initializing table events`);
  }
}

export const cleanupEvents = async (props: { logger: Console }) => {
  const { logger } = props;
  await db.push('/events', [], true);
  logger.log(`Table events pruned`);
}

export const addEvent = async (props: {
  event: DbDetectionEvent,
  logger: Console,
}) => {
  const { event, logger } = props;

  await db.push('/events[]', event);
  logger.info(`Record ${JSON.stringify(event)} pushed to events`);
}

export const getAllEvents = async (): Promise<DbDetectionEvent[]> => {
  return await db.getData('/events');
}

export default db;
