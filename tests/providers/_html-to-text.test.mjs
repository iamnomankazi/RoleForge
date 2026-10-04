import test from 'node:test';
import assert from 'node:assert/strict';
import { DESCRIPTION_MAX_CHARS, htmlToText } from '../../providers/_html-to-text.mjs';

test('htmlToText strips ordinary markup and collapses whitespace', () => {
  assert.equal(
    htmlToText('  <h2>Platform</h2>\n<ul><li>Build APIs</li><li>Ship safely</li></ul>  '),
    'Platform Build APIs Ship safely',
  );
});

test('htmlToText removes script and style blocks', () => {
  assert.equal(
    htmlToText('<p>Visible</p><script type="text/javascript">alert("secret")</script><style>.hidden { color: red }</style><p>Again</p>'),
    'Visible Again',
  );
});

test('htmlToText strips entity-escaped tags and decodes nested entities', () => {
  assert.equal(
    htmlToText('&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;&lt;script&gt;hidden&lt;/script&gt;'),
    'Tom & Jerry',
  );
});

test('htmlToText handles quoted greater-than characters in attributes', () => {
  assert.equal(
    htmlToText('<div data-condition="score > 5" title=\'a > b\'>Qualified</div><p>Next</p>'),
    'Qualified Next',
  );
});

test('htmlToText degrades safely for plain, empty, and non-string inputs', () => {
  assert.equal(htmlToText('Plain\n\ttext'), 'Plain text');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
  assert.equal(htmlToText({ html: '<p>no</p>' }), '');
});

test('htmlToText caps descriptions at the exported limit', () => {
  const result = htmlToText(`<p>${'x'.repeat(DESCRIPTION_MAX_CHARS + 200)}</p>`);
  assert.equal(DESCRIPTION_MAX_CHARS, 4_000);
  assert.equal(result.length, DESCRIPTION_MAX_CHARS);
});
