import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTitleFilter, createTitleRejectedCollector, writeTitleRejectedDiagnostic } from '../scan.mjs';

const FILTER_WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}_]`;

// Frozen copy of the title matcher before separator normalization and
// combination keywords were added. These tests use it as the behavior oracle.
function normalizeToday(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapeToday(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileToday(kw) {
  const keyword = normalizeToday(kw).trim();
  if (!keyword) return () => false;
  const pieces = keyword.split(/(\s+)/u);
  let wildcardAtEnd = false;
  const pattern = pieces.map((piece, index) => {
    if (/^\s+$/u.test(piece)) return String.raw`\s+`;
    if (piece.endsWith('*')) {
      const prefix = piece.slice(0, -1);
      if (!prefix) return escapeToday(piece);
      wildcardAtEnd = index === pieces.length - 1;
      return `${escapeToday(prefix)}${FILTER_WORD_CHAR}*`;
    }
    return escapeToday(piece);
  }).join('');
  const plural = !wildcardAtEnd && /\p{L}$/u.test(keyword) ? '(?:e?s)?' : '';
  const source = `(?<!${FILTER_WORD_CHAR})${pattern}${wildcardAtEnd ? '' : `${plural}(?!${FILTER_WORD_CHAR})`}`;
  const re = new RegExp(source, 'u');
  return text => re.test(normalizeToday(text));
}

function buildToday(config) {
  const normalize = values => (Array.isArray(values) ? values : [])
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean)
    .map(compileToday);
  const positive = normalize(config?.positive);
  const negative = normalize(config?.negative);
  return title => {
    const lower = normalizeToday(title || '');
    const hasPositive = positive.length === 0 || positive.some(match => match(lower));
    const hasNegative = negative.some(match => match(lower));
    return hasPositive && !hasNegative;
  };
}

const titles = [
  'Software Engineer', 'Senior Software Engineer', 'Staff Software Engineer',
  'Principal Data Engineer', 'Head of AI', 'Engineering Manager', 'Lead Software Engineer',
  'Junior AI Engineer', 'Junior AI-Engineer', 'AI Engineer II', 'Machine Learning Engineer',
  'Data Scientist', 'Data Analysts', 'Senior/Staff Engineer', 'Lead-Software Engineer',
  'Engineering, Lead', 'Tech–Lead Platform Engineer', 'Software—Engineer',
  'Backend/Software Engineer', 'Data, Engineer', 'AI‐Engineer', 'AI‑Engineer',
  'AI‒Engineer', 'AI―Engineer', 'AI−Engineer', 'AI Engineer (m/w/d)',
  'Sr. Engineer', 'Sr./Senior Engineer', 'Senior, Data Engineer', 'Lead / Software Engineer',
  'Principal—Platform Engineer', 'Head, Product Engineer', 'Manager/Software Engineer',
  'C++ Developer', 'C# Engineer', '.NET Developer', 'Senior C++ Developer',
  'Künstliche Intelligenz Engineer', 'Kesätyö Data Engineer', 'Werkstudentin Data',
  'Softwareentwicklerin', 'Data Engineering', 'Metadata Engineer', 'ASAP Data Engineer',
  'Junior, AI Engineer', 'Junior AI / Engineer', 'Junior AI–Engineer',
  'Research Scientist', 'Machine-Learning Engineer', 'AI and ML Engineer',
  'Lead Engineer, Data Platform', 'Software Engineer, Lead Gen',
  'Senior Product Manager', 'Principal/Staff Data Engineer', 'Team Lead Software Engineer',
];

const keywordLists = [
  { positive: ['Software Engineer', 'AI Engineer', 'Data Engineer'], negative: ['Senior', 'Staff', 'Lead Software', 'Principal', 'Head', 'Manager'] },
  { positive: ['C++', 'C#', '.NET', 'AI', 'Data Scientist'], negative: ['Senior', 'Principal'] },
  { positive: ['Werkstudent*', 'Softwareentwickler*', 'Kesatyo', 'Machine Learning'], negative: ['Lead', 'Manager'] },
  { positive: ['Sr. Engineer', 'Platform Engineer', 'Research Scientist'], negative: ['Head', 'Team Lead'] },
];

const replaceTitleSeparatorsWithSpaces = value => String(value)
  .replace(/[-\u2010-\u2015\u2212/,]/gu, ' ');

test('title separator behavior matches the legacy matcher on equivalent space-separated titles', () => {
  for (const keywords of keywordLists) {
    const actual = buildTitleFilter(keywords);
    const today = buildToday(keywords);
    for (const title of titles) {
      const containsSeparator = /[-\u2010-\u2015\u2212/,]/u.test(title);
      if (!containsSeparator) {
        assert.equal(actual(title), today(title), `unchanged title: ${title}`);
      } else {
        assert.equal(
          actual(title),
          today(replaceTitleSeparatorsWithSpaces(title)),
          `space-equivalent title: ${title}`,
        );
      }
    }
  }
});

test('separator variants keep representative senior and lead titles rejected', () => {
  const filter = buildTitleFilter({
    positive: ['Software Engineer', 'AI Engineer', 'Data Engineer'],
    negative: ['Senior', 'Staff', 'Principal', 'Head', 'Manager', 'Lead Software', 'Lead Engineer', 'Engineering Lead'],
  });
  const rejected = [
    'Senior Software Engineer', 'Staff Data Engineer', 'Principal AI Engineer',
    'Head of Software Engineer', 'Engineering Manager', 'Lead Software Engineer',
    'Lead-Software Engineer', 'Senior/Staff Engineer', 'Principal, Data Engineer',
    'Head—AI Engineer', 'Manager/Software Engineer',
  ];
  for (const title of rejected) assert.equal(filter(title), false, title);
  assert.equal(filter('Junior AI-Engineer'), true);
});

test('title rejection diagnostics count all rows and keep the first 200 per source', () => {
  const collector = createTitleRejectedCollector();
  for (let index = 0; index < 203; index += 1) {
    collector.record({ title: `Synthetic Role ${index}`, company: 'Example Oy', location: 'Helsinki' }, 'example-api');
  }
  collector.record({ title: 'Another Synthetic Role', company: 'Sample GmbH', location: 'Berlin' }, 'sample-api');
  assert.deepEqual(collector.counts(), { 'example-api': 203, 'sample-api': 1 });
  assert.equal(collector.sample().length, 201);
  assert.equal(collector.sample()[0].title, 'Synthetic Role 0');
  assert.equal(collector.sample()[199].title, 'Synthetic Role 199');
  assert.deepEqual(collector.sample()[200], {
    title: 'Another Synthetic Role', company: 'Sample GmbH', location: 'Berlin', source: 'sample-api',
  });

  const root = mkdtempSync(path.join(tmpdir(), 'title-rejected-diagnostic-'));
  try {
    const diagnosticPath = writeTitleRejectedDiagnostic({
      root,
      runId: 'scan-synthetic',
      createdAt: '2026-01-01T00:00:00.000Z',
      countsBySource: collector.counts(),
      sample: collector.sample(),
    });
    assert.equal(diagnosticPath, path.join(root, 'output', 'scan-diagnostics', 'scan-synthetic', 'title-rejected.json'));
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8'));
    assert.equal(diagnostic.schema, 'roleforge.title-rejected/1');
    assert.equal(diagnostic.run_id, 'scan-synthetic');
    assert.equal(diagnostic.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(diagnostic.cap_per_source, 200);
    assert.deepEqual(diagnostic.counts_by_source, collector.counts());
    assert.equal(diagnostic.sample.length, 201);

    const unwriteableRoot = path.join(root, 'root-file');
    writeFileSync(unwriteableRoot, 'file');
    const warnings = [];
    assert.equal(writeTitleRejectedDiagnostic({ root: unwriteableRoot, runId: 'warning-check', warn: value => warnings.push(value) }), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not write title rejection diagnostic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
