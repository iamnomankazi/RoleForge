import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentFilter,
  buildTitleFilter,
  compileKeyword,
  matchedTitleKeywords,
} from '../scan.mjs';

test('single-token keywords use Unicode-aware whole-word boundaries', () => {
  const isApi = compileKeyword('api');
  assert.equal(isApi('an API endpoint'), true);
  assert.equal(isApi('capital investment'), false);

  const hasSap = compileKeyword('sap');
  assert.equal(hasSap('SAP administration'), true);
  assert.equal(hasSap('ASAP delivery'), false);

  const hasThesis = compileKeyword('thesis');
  assert.equal(hasThesis('thesis topic'), true);
  assert.equal(hasThesis('hypothesis-driven approach'), false);
  assert.equal(compileKeyword('embedded')('nonembedded analytics'), false);
});

test('content positives and negatives no longer match substrings', () => {
  const positives = buildContentFilter({ positive: ['api', 'etl', 'rest', 'excel'] });
  assert.equal(positives('We build an API for the data pipeline.'), true);
  assert.equal(positives('ETL jobs run nightly.'), true);
  assert.equal(positives('The REST endpoint returns JSON.'), true);
  assert.equal(positives('Excel reports are generated weekly.'), true);
  assert.equal(positives('Capital investments'), false);
  assert.equal(positives('Settle the invoice'), false);
  assert.equal(positives('Interest rates changed'), false);
  assert.equal(positives('Excellent communication skills'), false);

  const negatives = buildContentFilter({ negative: ['sap', 'php', 'thesis', 'embedded'] });
  assert.equal(negatives('We need this ASAP.'), true);
  assert.equal(negatives('A hypothesis-driven experiment.'), true);
  assert.equal(negatives('This is a nonembedded analytics role.'), true);
  assert.equal(negatives('The role uses SAP and PHP.'), false);

  const avoidEmbeddedHardware = buildContentFilter({
    positive: ['sql'],
    negative: ['embedded software', 'embedded systems', 'embedded firmware'],
  });
  assert.equal(avoidEmbeddedHardware('SQL supports embedded analytics dashboards.'), true);
});

test('phrases have boundaries at both ends', () => {
  const hasDataEngineer = compileKeyword('data engineer');
  assert.equal(hasDataEngineer('Senior Data Engineer'), true);
  assert.equal(compileKeyword('lead software')('Lead  Software Engineer'), true);
  assert.equal(hasDataEngineer('Metadata Engineer'), false);
  assert.equal(hasDataEngineer('Data Engineering'), false);
  assert.equal(hasDataEngineer('Data Engineer II'), true);
});

test('2-3 letter acronym matching remains whole-word matching', () => {
  const isAi = buildTitleFilter({ positive: ['AI'] });
  assert.equal(isAi('AI Engineer'), true);
  assert.equal(isAi('Brain Researcher'), false);
  assert.equal(compileKeyword('COO')('Coordinator'), false);
  assert.equal(compileKeyword('SDR')('SDR Analyst'), true);
});

test('title and content keywords fold diacritics consistently', () => {
  const titleFilter = { positive: ['Kesätyö'] };
  assert.equal(buildTitleFilter(titleFilter)('Kesatyo, data'), true);
  assert.deepEqual(matchedTitleKeywords('Kesatyo, data', titleFilter), ['Kesätyö']);
  assert.equal(buildContentFilter({ positive: ['Kesatyo'] })('Kesätyö in software'), true);
});

test('trailing token wildcards match Finnish and German inflections', () => {
  const titleFilter = buildTitleFilter({ positive: [
    'softwareentwickler*',
    'Werkstudent*',
    'ohjelmistokehittäj*',
    'harjoittelij*',
  ] });
  assert.equal(titleFilter('Softwareentwicklerin (m/w/d)'), true);
  assert.equal(titleFilter('Werkstudentin Data'), true);
  assert.equal(titleFilter('ohjelmistokehittäjä'), true);
  assert.equal(titleFilter('Harjoittelija, data'), true);
  assert.equal(compileKeyword('Werkstudent*')('Werkstudent*in Data'), true);
  assert.equal(compileKeyword('Werkstudent* data')('Werkstudentin Data (m/w/d)'), true);
  assert.equal(compileKeyword('Entwickler*')('Entwickler:in'), true);
});

test('keywords with punctuation still match their literal token forms', () => {
  assert.equal(compileKeyword('.NET')('.NET Core'), true);
  assert.equal(compileKeyword('.NET')('internet services'), false);
  assert.equal(compileKeyword('C++')('C++ Developer'), true);
  assert.equal(compileKeyword('C++')('ABC++ Developer'), false);
  assert.equal(compileKeyword('C#')('C# Engineer'), true);
  assert.equal(compileKeyword('L&D')('L&D platform engineer'), true);
});

test('precise leadership negatives allow Lead Gen and technical consultants', () => {
  const filter = buildTitleFilter({
    positive: ['Software Engineer', 'Software Engineering', 'Data Engineer'],
    negative: [
      'Senior', 'Staff', 'Principal', 'Director', 'Manager', 'Head',
      'Lead Software Engineer', 'Lead Data Engineer', 'Lead Engineer',
      'Engineering Lead', 'Software Engineering Lead', 'Team Lead', 'Tech Lead',
    ],
  });
  assert.equal(filter('Software Engineer - Lead Gen'), true);
  assert.equal(filter('Software Engineering Consultant'), true);
  assert.equal(filter('Lead Software Engineer'), false);
  assert.equal(filter('Senior Data Engineer'), false);
  assert.equal(filter('Staff Software Engineer'), false);
});

test('single-token keywords also match their plural', () => {
  assert.equal(compileKeyword('api')('Design public APIs'), true);
  assert.equal(compileKeyword('class')('Python classes'), true);
  assert.equal(compileKeyword('api')('rapid capital growth'), false);
  assert.equal(compileKeyword('lead')('Leadership program'), false);
});
