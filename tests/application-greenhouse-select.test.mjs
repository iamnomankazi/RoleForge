// Greenhouse react-select controls keep their search input empty and show the selection in .select__single-value;
// the phone-country select shows only a flag and the dial code. Selections must still count as committed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { buildOperationalFormPlan, executeOperationalFormPlan, inspectOperationalApplicationForm } from '../application-form-engine.mjs';
import { attachFactualSources } from './fixtures/application-evidence-profile.mjs';

const profile = attachFactualSources({
  candidate: { full_name: 'Alex Example', email: 'alex@example.test', phone: '+358 40 0000000' },
  location: { city: 'Exampleville', country: 'Finland' },
  currentStatus: { availability: { start: 'Available immediately' } },
  education: {},
  formRules: {
    current_location: { city: 'Exampleville', country: 'Finland', combined: 'Exampleville, Finland' },
    work_authorization: { home_country: 'Finland', finland_authorized: 'Yes', outside_finland_local_authorized: 'No' },
  },
  cvText: '# Alex Example',
});
const context = { candidate: { candidate_id: 'cand_v1_example_select', company: 'Example Company', title: 'Backend Engineer' }, jobCountry: 'Germany' };

// id, label, options, display(label) -> text shown after selection
const selects = [
  ['country', 'Country', ['Germany +49', 'Finland +358', 'Sweden +46'], (label) => label.match(/\+\d+$/)[0]],
  ['candidate-location', 'Location (City)', ['Exampleville, Finland', 'Exampleville, Example Region, Finland', 'Otherton, Finland'], (label) => label],
  ['authorized', 'Are you authorized to work in the European country where you are currently living?', ['Yes', 'No'], (label) => label],
];
const FORM = `<form>
<fieldset class="phone-input"><legend>Phone</legend>${selectHtml(selects[0])}<label for="phone">Phone</label><input id="phone" type="tel" required></fieldset>
${selectHtml(selects[1])}${selectHtml(selects[2])}
<button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Submit application</button>
</form>
<script>
for (const [id, labels, display] of ${JSON.stringify(selects.map(([id, , options]) => [id, options]))}.map(([id, labels]) => [id, labels, id === 'country' ? (l) => l.match(/\\+\\d+$/)[0] : (l) => l])) {
  const input = document.getElementById(id), list = document.getElementById(id + '-options');
  const open = () => { list.replaceChildren(); for (const label of labels) {
    if (input.value && !label.toLowerCase().includes(input.value.toLowerCase().split(/[ ,]/)[0])) continue;
    const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = label;
    option.onclick = () => { input.closest('.select__container').querySelector('.select__single-value').textContent = display(label);
      input.value = ''; list.replaceChildren(); };
    list.append(option); } };
  input.oninput = open; input.onfocus = open;
}
</script>`;
function selectHtml([id, label]) {
  return `<div class="select__container"><label id="${id}-label" for="${id}">${label}</label>
<div class="select__control"><div class="select__single-value"></div>
<input id="${id}" role="combobox" aria-autocomplete="list" aria-controls="${id}-options" aria-labelledby="${id}-label" aria-required="true" value=""></div>
<div id="${id}-options" role="listbox"></div></div>`;
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('react-select selections commit, including dial-code-only display and equivalent city options', async () => {
  const page = await browser.newPage();
  await page.setContent(FORM);
  const plan = buildOperationalFormPlan(await inspectOperationalApplicationForm(page), profile, {}, { context });
  const execution = await executeOperationalFormPlan(page, plan);
  const display = async (id) => page.locator(`#${id}`).evaluate((el) => el.closest('.select__container').querySelector('.select__single-value').textContent);
  assert.equal(await display('country'), '+358');
  assert.equal(await display('candidate-location'), 'Exampleville, Finland');
  assert.equal(await display('authorized'), 'Yes');
  const unresolved = execution.unresolvedFields.filter((f) => /Country|Location|authorized/i.test(f.label || ''));
  assert.deepEqual(unresolved.map((f) => `${f.label}: ${f.reason}`), []);
  assert.equal(await page.evaluate(() => window.finalClicks || 0), 0);
  await page.close();
});
