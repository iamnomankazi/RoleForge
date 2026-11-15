import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  MANUAL_SUBMISSION_SOURCE,
  ManualApplicationError,
  parseArgs,
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
        { company: 'Examplesoft', role: 'Software Engineer, Examplesoft Apps' },
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
        company: 'Examplesoft',
        role: 'Software Engineer, Examplesoft Apps',
        userConfirmed: true,
      },
      { trackerPath: fx.trackerPath, now: new Date(2026, 6, 28, 23, 59) },
    );
    assert.equal(result.created, true);
    assert.equal(result.date, '2026-07-28');
    assert.deepEqual(rowsAt(fx.trackerPath), [{
      num: 1,
      date: '2026-07-28',
      company: 'Examplesoft',
      role: 'Software Engineer, Examplesoft Apps',
      score: 'N/A',
      status: 'Applied',
      pdf: '',
      report: '',
      notes: MANUAL_SUBMISSION_SOURCE,
      raw: `| 1 | 2026-07-28 | Examplesoft | Software Engineer, Examplesoft Apps | N/A | Applied |  |  | ${MANUAL_SUBMISSION_SOURCE} |`,
    }]);
  } finally {
    fx.cleanup();
  }
});

test('is idempotent and never creates a duplicate', async () => {
  const fx = fixture();
  try {
    const options = {
      company: 'Examplesoft',
      role: 'Software Engineer, Examplesoft Context',
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
    '| 7 | 2026-07-20 | Examplesoft | Software Engineer, Examplesoft Apps | 4.4/5 | Evaluated | cv.pdf | [7](../reports/007.md) | Existing note |\n',
  );
  try {
    await confirmManualApplication(
      {
        company: 'Examplesoft',
        role: 'software engineer — examplesoft apps',
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
    '| 1 | 2026-07-20 | Examplesoft | Software Engineer, Examplesoft Apps | N/A | Evaluated |  |  |  |\n'
    + '| 2 | 2026-07-20 | Examplesoft | Software Engineer, Examplesoft Context | N/A | Evaluated |  |  |  |\n',
  );
  try {
    await assert.rejects(
      confirmManualApplication(
        { company: 'Examplesoft', userConfirmed: true },
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

test('--row and --report select exact existing tracker rows', async () => {
  const fx = fixture(
    '| 7 | 2026-07-20 | Example Oy | Backend Engineer | N/A | Evaluated |  | [12](reports/012-example.md) |  |\n',
  );
  try {
    assert.equal(parseArgs(['--row', '7', '--user-confirmed']).row, '7');
    assert.equal(parseArgs(['--report', '12', '--user-confirmed']).report, '12');
    const byRow = await confirmManualApplication({ row: 7, userConfirmed: true }, { trackerPath: fx.trackerPath });
    assert.equal(byRow.num, 7);
    assert.equal(byRow.changed, true);
    const byReport = await confirmManualApplication({ report: 12, userConfirmed: true }, { trackerPath: fx.trackerPath });
    assert.equal(byReport.num, 7);
    assert.equal(byReport.changed, false);
  } finally {
    fx.cleanup();
  }
});

test('explicit selectors accept matching optional company and role and reject mismatches', async () => {
  const fx = fixture('| 8 | 2026-07-20 | Example Oy | Backend Engineer | N/A | Evaluated |  |  |  |\n');
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    await assert.rejects(
      confirmManualApplication({ row: 8, company: 'Different Oy', role: 'Backend Engineer', userConfirmed: true }, { trackerPath: fx.trackerPath }),
      (error) => error instanceof ManualApplicationError && error.code === 'selector-mismatch' && /Company/.test(error.message),
    );
    await assert.rejects(
      confirmManualApplication({ row: 8, company: 'Example Oy', role: 'Frontend Engineer', userConfirmed: true }, { trackerPath: fx.trackerPath }),
      (error) => error instanceof ManualApplicationError && error.code === 'selector-mismatch' && /Role/.test(error.message),
    );
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('unknown exact row errors without writing', async () => {
  const fx = fixture('| 9 | 2026-07-20 | Example Oy | Backend Engineer | N/A | Evaluated |  |  |  |\n');
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    await assert.rejects(
      confirmManualApplication({ row: 99, userConfirmed: true }, { trackerPath: fx.trackerPath }),
      (error) => error instanceof ManualApplicationError && error.code === 'not-found',
    );
    await assert.rejects(
      confirmManualApplication({ report: 99, userConfirmed: true }, { trackerPath: fx.trackerPath }),
      (error) => error instanceof ManualApplicationError && error.code === 'not-found',
    );
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('an already Applied identity sibling makes confirmation idempotent and is listed', async () => {
  const id = `cand_v1_${'4'.repeat(64)}`;
  const fx = fixture(
    `| 10 | 2026-07-20 | Example Oy | Original Fictional Role | N/A | Applied |  |  | Canonical candidate ID: ${id} |\n`
    + `| 11 | 2026-07-21 | Example Oy | Renamed Fictional Role | N/A | Evaluated |  |  | Canonical candidate ID: ${id} |\n`,
  );
  try {
    const before = readFileSync(fx.trackerPath, 'utf8');
    const result = await confirmManualApplication({ row: 11, userConfirmed: true }, { trackerPath: fx.trackerPath });
    assert.equal(result.changed, false);
    assert.equal(result.idempotent, true);
    assert.equal(result.identityConflict, true);
    assert.deepEqual(result.blockingSiblings, [{ num: 10, status: 'Applied' }]);
    assert.deepEqual(result.siblings, [{ num: 10, status: 'Applied' }]);
    assert.equal(readFileSync(fx.trackerPath, 'utf8'), before);
  } finally {
    fx.cleanup();
  }
});

test('--row and --report are mutually exclusive and selectors still require user confirmation', async () => {
  assert.throws(() => parseArgs(['--row', '1', '--report', '2']), /mutually exclusive/);
  const fx = fixture('| 1 | 2026-07-20 | Example Oy | Backend Engineer | N/A | Evaluated |  |  |  |\n');
  try {
    await assert.rejects(
      confirmManualApplication({ row: 1 }, { trackerPath: fx.trackerPath }),
      (error) => error instanceof ManualApplicationError && error.code === 'confirmation-required',
    );
  } finally {
    fx.cleanup();
  }
});
