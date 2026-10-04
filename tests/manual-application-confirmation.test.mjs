import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  MANUAL_SUBMISSION_SOURCE,
  ManualApplicationError,
  confirmManualApplication,
} from '../manual-application-confirmation.mjs';
import { parseTrackerRow, resolveColumns } from '../tracker-parse.mjs';

const HEADER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function fixture(body = '') {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-manual-application-'));
  const trackerPath = join(dir, 'applications.md');
  writeFileSync(trackerPath, HEADER + body);
  return {
    trackerPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function rowsAt(trackerPath) {
  const lines = readFileSync(trackerPath, 'utf8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
}

test('requires an explicit user confirmation', async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      confirmManualApplication(
        { company: 'Aiven', role: 'Software Engineer, Aiven Apps' },
        { trackerPath: fx.trackerPath, now: new Date(2026, 6, 28) },
      ),
      (error) => error instanceof ManualApplicationError && error.code === 'confirmation-required',
    );
    assert.equal(rowsAt(fx.trackerPath).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('creates an absent role with today and the canonical source', async () => {
  const fx = fixture();
  try {
    const result = await confirmManualApplication(
      {
        company: 'Aiven',
        role: 'Software Engineer, Aiven Apps',
        userConfirmed: true,
      },
      { trackerPath: fx.trackerPath, now: new Date(2026, 6, 28, 23, 59) },
    );
    assert.equal(result.created, true);
    assert.equal(result.date, '2026-07-28');
    assert.deepEqual(rowsAt(fx.trackerPath), [{
      num: 1,
      date: '2026-07-28',
      company: 'Aiven',
      role: 'Software Engineer, Aiven Apps',
      score: 'N/A',
      status: 'Applied',
      pdf: '',
      report: '',
      notes: MANUAL_SUBMISSION_SOURCE,
      raw: `| 1 | 2026-07-28 | Aiven | Software Engineer, Aiven Apps | N/A | Applied |  |  | ${MANUAL_SUBMISSION_SOURCE} |`,
    }]);
  } finally {
    fx.cleanup();
  }
});

test('is idempotent and never creates a duplicate', async () => {
  const fx = fixture();
  try {
    const options = {
      company: 'Aiven',
      role: 'Software Engineer, Aiven Context',
      userConfirmed: true,
    };
    await confirmManualApplication(options, {
      trackerPath: fx.trackerPath,
      now: new Date(2026, 6, 28),
    });
    const repeat = await confirmManualApplication(options, {
      trackerPath: fx.trackerPath,
      now: new Date(2026, 6, 29),
    });
    assert.equal(repeat.changed, false);
    assert.equal(rowsAt(fx.trackerPath).length, 1);
    assert.equal(rowsAt(fx.trackerPath)[0].date, '2026-07-28');
  } finally {
    fx.cleanup();
  }
});

test('updates an existing entry while preserving its artifacts and adding source once', async () => {
  const fx = fixture(
    '| 7 | 2026-07-20 | Aiven | Software Engineer, Aiven Apps | 4.4/5 | Evaluated | cv.pdf | [7](../reports/007.md) | Existing note |\n',
  );
  try {
    await confirmManualApplication(
      {
        company: 'Aiven',
        role: 'software engineer — aiven apps',
        date: '2026-07-27',
        userConfirmed: true,
      },
      { trackerPath: fx.trackerPath },
    );
    const [row] = rowsAt(fx.trackerPath);
    assert.equal(row.num, 7);
    assert.equal(row.date, '2026-07-27');
    assert.equal(row.status, 'Applied');
    assert.equal(row.score, '4.4/5');
    assert.equal(row.pdf, 'cv.pdf');
    assert.equal(row.report, '[7](../reports/007.md)');
    assert.equal(row.notes, `Existing note; ${MANUAL_SUBMISSION_SOURCE}`);
  } finally {
    fx.cleanup();
  }
});

test('requires clarification when company-only context matches multiple roles', async () => {
  const fx = fixture(
    '| 1 | 2026-07-20 | Aiven | Software Engineer, Aiven Apps | N/A | Evaluated |  |  |  |\n'
    + '| 2 | 2026-07-20 | Aiven | Software Engineer, Aiven Context | N/A | Evaluated |  |  |  |\n',
  );
  try {
    await assert.rejects(
      confirmManualApplication(
        { company: 'Aiven', userConfirmed: true },
        { trackerPath: fx.trackerPath },
      ),
      (error) => error instanceof ManualApplicationError
        && error.code === 'ambiguous'
        && error.details.candidates.length === 2,
    );
  } finally {
    fx.cleanup();
  }
});
