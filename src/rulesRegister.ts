import fs from 'fs';
import path from 'path';

const REGISTER_FILENAME = 'artifacts.json';
const REGISTER_VERSION = 1;

export type RulesRegisterEntry = {
  ruleName: string;
  /** Rule type (e.g. Detection, Timelapse, Recording). */
  ruleType?: string;
  timestamp: number;
  imageUrl?: string;
  gifUrl?: string;
  videoUrl?: string;
};

type RegisterFile = { version: number; entries: RulesRegisterEntry[] };

/** Path to storage/deviceId/rules/artifacts.json */
export const getRulesRegisterPath = (storagePath: string, deviceId: string) =>
  path.join(storagePath, deviceId, 'rules', REGISTER_FILENAME);

const readRegister = async (registerPath: string): Promise<RulesRegisterEntry[]> => {
  try {
    const raw = await fs.promises.readFile(registerPath, 'utf-8');
    const data = JSON.parse(raw) as RegisterFile | { entries?: RulesRegisterEntry[] };
    const entries = Array.isArray((data as RegisterFile).entries) ? (data as RegisterFile).entries : [];
    return entries;
  } catch {
    return [];
  }
};

const writeRegister = async (registerPath: string, entries: RulesRegisterEntry[]) => {
  const dir = path.dirname(registerPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const file: RegisterFile = { version: REGISTER_VERSION, entries };
  await fs.promises.writeFile(registerPath, JSON.stringify(file, null, 0), 'utf-8');
};

/** Add or update an entry: merge URLs for the same ruleName+timestamp. */
export const addOrUpdateRuleArtifacts = async (
  registerPath: string,
  entry: RulesRegisterEntry
) => {
  const entries = await readRegister(registerPath);
  const idx = entries.findIndex(
    (e) => e.ruleName === entry.ruleName && e.timestamp === entry.timestamp
  );
  if (idx >= 0) {
    const existing = entries[idx];
    entries[idx] = {
      ruleName: entry.ruleName,
      ruleType: entry.ruleType ?? existing.ruleType,
      timestamp: entry.timestamp,
      imageUrl: entry.imageUrl ?? existing.imageUrl,
      gifUrl: entry.gifUrl ?? existing.gifUrl,
      videoUrl: entry.videoUrl ?? existing.videoUrl,
    };
  } else {
    entries.push({
      ruleName: entry.ruleName,
      ruleType: entry.ruleType,
      timestamp: entry.timestamp,
      imageUrl: entry.imageUrl,
      gifUrl: entry.gifUrl,
      videoUrl: entry.videoUrl,
    });
  }
  await writeRegister(registerPath, entries);
};

/** Remove one URL type from an entry; remove the entry if no URLs left. */
export const removeRuleArtifactUrl = async (
  registerPath: string,
  ruleName: string,
  timestamp: number,
  urlKind: 'imageUrl' | 'gifUrl' | 'videoUrl'
) => {
  try {
    await fs.promises.access(registerPath);
  } catch {
    return;
  }
  const entries = await readRegister(registerPath);
  const idx = entries.findIndex((e) => e.ruleName === ruleName && e.timestamp === timestamp);
  if (idx < 0) return;
  const e = entries[idx];
  delete e[urlKind];
  const hasAny =
    e.imageUrl !== undefined || e.gifUrl !== undefined || e.videoUrl !== undefined;
  if (hasAny) {
    entries[idx] = e;
  } else {
    entries.splice(idx, 1);
  }
  await writeRegister(registerPath, entries);
};

export const migrateDeviceRulesRegister = async (props: {
  storagePath: string;
  deviceId: string;
  getUrls: (ruleName: string, timestamp: number) => Promise<{
    imageUrl?: string;
    gifUrl?: string;
    videoUrl?: string;
  }>;
  /** Resolve rule type by name from all rules available for this device (e.g. Detection, Timelapse, Recording). */
  getRuleType?: (ruleName: string) => string | undefined;
  logger: Console;
}) => {
  const { storagePath, deviceId, getUrls, getRuleType, logger } = props;
  const rulesPath = path.join(storagePath, deviceId, 'rules');
  try {
    await fs.promises.access(rulesPath);
  } catch {
    return;
  }
  const ruleDirs = await fs.promises.readdir(rulesPath, { withFileTypes: true });
  type Pending = { ruleName: string; timestamp: number; hasImage: boolean; hasGif: boolean; hasVideo: boolean };
  const byKey = new Map<string, Pending>();
  for (const dirent of ruleDirs) {
    if (!dirent.isDirectory() || dirent.name === REGISTER_FILENAME) continue;
    const ruleName = dirent.name;
    const generatedPath = path.join(rulesPath, ruleName, 'generated');
    try {
      await fs.promises.access(generatedPath);
    } catch {
      continue;
    }
    const files = await fs.promises.readdir(generatedPath);
    for (const file of files) {
      const base = file.replace(/\.(mp4|jpg|gif)$/i, '');
      const ext = (file.match(/\.(mp4|jpg|gif)$/i)?.[1] ?? '').toLowerCase();
      const timestamp = parseInt(base, 10);
      if (Number.isNaN(timestamp)) continue;
      const key = `${ruleName}|${timestamp}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { ruleName, timestamp, hasImage: false, hasGif: false, hasVideo: false };
        byKey.set(key, entry);
      }
      if (ext === 'jpg') entry.hasImage = true;
      else if (ext === 'gif') entry.hasGif = true;
      else if (ext === 'mp4') entry.hasVideo = true;
    }
  }
  const registerPath = getRulesRegisterPath(storagePath, deviceId);
  for (const entry of byKey.values()) {
    const urls = await getUrls(entry.ruleName, entry.timestamp);
    const ruleType = getRuleType?.(entry.ruleName);
    await addOrUpdateRuleArtifacts(registerPath, {
      ruleName: entry.ruleName,
      ruleType,
      timestamp: entry.timestamp,
      imageUrl: entry.hasImage ? urls.imageUrl : undefined,
      gifUrl: entry.hasGif ? urls.gifUrl : undefined,
      videoUrl: entry.hasVideo ? urls.videoUrl : undefined,
    });
  }
  if (byKey.size > 0) {
    logger.log(`Rules register migration: ${deviceId} ${byKey.size} entries`);
  }
}
