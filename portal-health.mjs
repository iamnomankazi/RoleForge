import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { withPortalHealthLock } from './portal-health-lock.mjs';

export const PORTAL_HEALTH_PATH = 'data/portal-health.tsv';
export const PORTAL_HEALTH_HEADER = 'timestamp\tcompany\tstatus\n';

export async function appendPortalHealth(records, filePath = PORTAL_HEALTH_PATH) {
  await withPortalHealthLock(filePath, async () => {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) writeFileSync(filePath, PORTAL_HEALTH_HEADER, 'utf8');
    const rows = records.map((record) => [record.timestamp, record.company, record.status].join('\t')).join('\n');
    if (rows) appendFileSync(filePath, `${rows}\n`, 'utf8');
  });
}

export function loadPortalHealth(filePath = PORTAL_HEALTH_PATH) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const [timestamp, company, status] = line.split('\t');
    return { timestamp, company, status };
  }).filter((record) => record.timestamp && record.company && record.status);
}

export function computeConsecutiveFailures(records) {
  const streaks = new Map();
  for (const record of records) {
    const status = String(record?.status || '');
    if (status === 'reachable' || status === 'empty' || status.startsWith('partial:')) {
      streaks.set(record.company, 0);
    }
    else streaks.set(record.company, (streaks.get(record.company) || 0) + 1);
  }
  return streaks;
}
