/**
 * Salary-answer policy shared by both application-form paths (application-form-policy canonicalFieldValue and
 * application-profile groundedFieldValue).
 *
 * The candidate's reference range (config/profile.yml compensation.target_range, gross annual) is filled
 * automatically only when every one of these is verified:
 *   1. the job country is Finland (from the job record, never from where the candidate lives);
 *   2. a verified capture of the COMPLETE posting exists (context.postingEvidence, from salary-evidence.mjs; a scan
 *      excerpt is never enough), and it, the stored description, the job record's structured salary and the
 *      evaluation report of this exact candidate (context.reportCompensation) all show no pay;
 *   3. the question explicitly asks for an annual amount in the reference currency, in a plain free-text field
 *      (not monthly, hourly, weekly, net, a single figure, digits-only or fixed options; an unstated period or
 *      currency is not assumed);
 *   4. the reference range is a gross annual range in the question's currency;
 *   5. the role is not a trainee/internship role (those keep their own, separately approved answer).
 * Every other case returns no value plus a reason and, where the rules allow one, a proposal for the candidate to
 * approve. An employer's advertised range is their budget, never an offer, and is never written as the answer.
 */

const CURRENCIES = [
  ['EUR', /€|\beur\b|\beuros?\b/i],
  ['USD', /\$|\busd\b|\bdollars?\b/i],
  ['GBP', /£|\bgbp\b|\bpounds?\b/i],
  ['SEK', /\bsek\b/i],
  ['DKK', /\bdkk\b/i],
  ['NOK', /\bnok\b/i],
  ['CHF', /\bchf\b/i],
  // Other ISO codes a form may ask in: recognised so a EUR answer is never given to them.
  ...['CAD', 'AUD', 'NZD', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ISK', 'JPY', 'CNY', 'INR', 'SGD', 'HKD', 'AED']
    .map((code) => [code, new RegExp(`\\b${code}\\b`, 'i')]),
];
const CURRENCY_TOKEN = /€|\$|£|\b(?:eur|euros?|usd|gbp|sek|dkk|nok|chf|cad|aud|nzd|pln|czk|huf|ron|bgn|isk|jpy|cny|inr|sgd|hkd|aed)\b/i;
// Pay periods other than year, month and hour: never answered with an annual range.
const OTHER_PERIOD_RE = /\b(?:week|weekly|day|daily|per diem|viiko\w*|päivä\w*|woche\w*|täglich|tag)\b|\/\s?(?:wk|week|day|d)\b/i;
const YEAR_RE = /\b(?:year|yr|yearly|annual|annually|annum|p\.?\s?a\.?|vuodessa|vuosi\w*|jahr\w*|jährlich|brutto(?:jahres)\w*|årslön|årsløn)\b|\/\s?(?:year|yr|y|v|a)\b/i;
const MONTH_RE = /\b(?:month|monthly|pcm|per mensem|kuukau\w*|kuussa|kk|monat\w*|månad\w*|måned\w*|maand\w*)\b|\/\s?(?:month|mo|kk|kuukausi|monat|mån)\b/i;
const HOUR_RE = /\b(?:hour|hourly|tunti\w*|stunde\w*|stündlich|timlön|timeløn)\b|\/\s?(?:h|hr|hour|tunti|std)\b/i;
// Net pay, including compound words (Nettogehalt, nettopalkkatoive, nettolön, nettoløn).
const NET_RE = /\b(?:net|netto\w*|nettopalk\w*|nettolön\w*|nettoløn\w*)\b/i;
const SALARY_WORD = /\b(?:salar\w*|pay|paid|wages?|compensation|remuneration|palk\w*|gehalt\w*|vergütung|verdienst|lön\w*|løn\w*|salaris|jahresgehalt|bruttogehalt)\b/i;
const AGREEMENT_WORD = /\b(?:tes|työehtosopimu\w*|collective (?:labou?r |bargaining )?agreements?|tarifvertrag\w*|tarifliche\w*|kollektivavtal\w*)\b/i;
// Explicit "no pay stated" markers an evaluation report or job record may carry instead of an amount.
const NO_PAY_STATED = /^(?:not (?:stated|disclosed|listed|specified|advertised|mentioned|provided|given)|none(?: stated)?|n\/?a)\.?$/i;
// Wording that asks for pay after tax, whatever the language.
const TAKE_HOME_RE = /\b(?:take[- ]?home|in[- ]hand|after[- ]tax(?:es)?|käteen\w*|nach steuern)\b/i;
const SPACE_CHARS =' \\u00a0\\u202f';
const NUMBER_RE = new RegExp(`(\\d{1,3}(?:[${SPACE_CHARS}.,]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)\\s*(k\\b|t€|tkr)?`, 'gi');

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function toNumber(raw, suffix) {
  let text = String(raw).replace(new RegExp(`[${SPACE_CHARS}]`, 'g'), '');
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(text)) text = text.replace(/[.,]/g, '');
  else text = text.replace(',', '.');
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return suffix ? value * 1000 : value;
}

export function salaryCurrency(text) {
  const found = CURRENCIES.filter(([, pattern]) => pattern.test(String(text ?? ''))).map(([code]) => code);
  return found.length === 1 ? found[0] : found.length > 1 ? 'MIXED' : null;
}

export function salaryPeriod(text) {
  const value = String(text ?? '');
  const periods = [['year', YEAR_RE], ['month', MONTH_RE], ['hour', HOUR_RE]].filter(([, pattern]) => pattern.test(value));
  return periods.length === 1 ? periods[0][0] : periods.length > 1 ? 'mixed' : 'unknown';
}

/**
 * Parse one salary statement ("EUR 61,000-67,000/year", "€3,000 - €3,500 per month", "45k EUR").
 * Returns null when no amount is present. Period and currency stay 'unknown'/null rather than being guessed.
 */
export function parseSalaryText(text) {
  const value = clean(text);
  const numbers = [...value.matchAll(NUMBER_RE)]
    .map((match) => ({ amount: toNumber(match[1], match[2]), index: match.index, end: match.index + match[0].length }))
    .filter((item) => item.amount !== null && item.amount > 0)
    // A bare year ("2026") is not an amount unless a currency sign sits right next to it.
    .filter((item) => !(/^(?:19|20)\d{2}$/.test(value.slice(item.index, item.end).trim())
      && !CURRENCY_TOKEN.test(value.slice(Math.max(0, item.index - 5), item.end + 5))));
  if (!numbers.length) return null;
  // Prefer money-shaped numbers (next to a currency, with a "k", or thousands-scale) over counts such as
  // "3 years of experience"; fall back to the first number only when none is money-shaped.
  const moneyShaped = numbers.filter((item) => item.amount >= 1000 || /k\b|t€|tkr/i.test(value.slice(item.index, item.end))
    || CURRENCY_TOKEN.test(value.slice(Math.max(0, item.index - 5), item.end + 5)));
  let pick = moneyShaped.length ? moneyShaped : numbers;
  // "45-50k": a bare lower bound directly joined to a money-shaped upper bound belongs to the range.
  const first = numbers.indexOf(pick[0]);
  if (first > 0 && /^\s*(?:[-–—]|to|bis|ja|till|til|tot)\s*$/i.test(value.slice(numbers[first - 1].end, pick[0].index))) {
    pick = [numbers[first - 1], ...pick];
  }
  let amounts = [pick[0].amount];
  if (pick.length >= 2) {
    const between = value.slice(pick[0].end, pick[1].index);
    if (/^\s*(?:[-–—]|to|bis|ja|till|til|tot)\s*(?:€|\$|£|eur\b|euros?\b)?\s*$/i.test(between)) amounts = [pick[0].amount, pick[1].amount];
  }
  // "45-50k": the magnitude suffix on the upper bound applies to both.
  if (amounts.length === 2 && amounts[0] < 1000 && amounts[1] >= 1000 && /k\b|t€|tkr/i.test(value.slice(pick[1].index, pick[1].end))) {
    amounts[0] *= 1000;
  }
  return {
    currency: salaryCurrency(value),
    period: salaryPeriod(value),
    net: NET_RE.test(value),
    min: Math.min(...amounts),
    max: Math.max(...amounts),
  };
}

function sentenceUnits(text) {
  return String(text ?? '').split(/\r?\n+|(?<=[.!?])\s+(?=[\p{Lu}\d€$£])/u).map(clean).filter(Boolean);
}

function hasMoneyAmount(sentence) {
  const currencyNear = new RegExp(`(?:${CURRENCY_TOKEN.source})\\s?\\d|\\d[\\d.,\\s\\u00a0]*\\s?(?:k\\s?)?(?:${CURRENCY_TOKEN.source})`, 'i');
  if (currencyNear.test(sentence)) return true;
  // A salary word with a thousands-scale number or a "k" amount, even without a currency.
  if (SALARY_WORD.test(sentence) && /\b\d{1,3}(?:[\s.,]\d{3})+\b|\b\d{4,6}\b|\b\d+(?:[.,]\d)?\s?k\b/i.test(sentence)) return true;
  // A salary word with any number and a pay period ("the salary is 25 per hour").
  return SALARY_WORD.test(sentence) && /\d/.test(sentence)
    && [YEAR_RE, MONTH_RE, HOUR_RE, OTHER_PERIOD_RE].some((pattern) => pattern.test(sentence));
}

function structuredSalary(value) {
  // A stored salary string ("EUR 60,000-70,000/year") is read like posting text; any digit makes it pay data.
  if (typeof value === 'string') {
    const parsed = /\d/.test(value) ? parseSalaryText(value) : null;
    return parsed ? { ...parsed, period: OTHER_PERIOD_RE.test(value) ? 'other' : parsed.period } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const min = Number(value.min ?? value.minimum ?? value.from);
  const max = Number(value.max ?? value.maximum ?? value.to);
  const amounts = [min, max].filter((amount) => Number.isFinite(amount) && amount > 0);
  if (!amounts.length) return null;
  const period = clean(value.period ?? value.interval ?? value.unit).toLowerCase();
  return {
    currency: clean(value.currency).toUpperCase() || null,
    period: /year|annual/.test(period) ? 'year' : /month/.test(period) ? 'month' : /hour/.test(period) ? 'hour' : 'unknown',
    // Net or unknown-basis structured pay is never treated as a gross figure.
    net: value.net === true || /\bnet/i.test(clean(value.basis ?? value.type)),
    min: Math.min(...amounts),
    max: Math.max(...amounts),
  };
}

// The structured job-record keys structuredSalary reads; an object with any other key is an unfamiliar schema.
const KNOWN_SALARY_KEYS = new Set(['min', 'max', 'minimum', 'maximum', 'from', 'to', 'currency', 'period', 'interval', 'unit', 'net', 'basis', 'type']);
const AMOUNT_KEYS = ['min', 'max', 'minimum', 'maximum', 'from', 'to'];

function safeJson(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/**
 * Recognised "no pay" job-record values: nothing stored, an explicit marker ("not stated", "N/A"), an empty list, or
 * a scanner placeholder in the known schema whose amounts are all absent or zero (e.g. {min: 0, max: 0, currency}).
 * Everything else (unknown keys, non-empty lists, bare numbers, unreadable text) is not recognised as "no pay".
 */
function recordSalaryIsNoPay(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !clean(value) || NO_PAY_STATED.test(clean(value));
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => KNOWN_SALARY_KEYS.has(key))) return false;
  const empty = (item) => item === null || item === undefined || item === '';
  // Placeholder form only: the descriptive keys may hold a currency code, a period word, a boolean or a short word,
  // never text that could itself state pay ("EUR 80,000 per year", "According to collective agreement").
  const word = (pattern) => (item) => empty(item) || (typeof item === 'string' && pattern.test(item.trim()));
  const placeholderValue = {
    currency: word(/^[A-Z]{3}$/i),
    period: word(/^(?:year|yearly|annual|month|monthly|week|weekly|day|daily|hour|hourly)$/i),
    net: (item) => empty(item) || typeof item === 'boolean',
    basis: word(/^(?:gross|net|brutto|netto|salary|base|base salary|fixed|range|annual|yearly|monthly|hourly)$/i),
  };
  placeholderValue.interval = placeholderValue.period;
  placeholderValue.unit = placeholderValue.period;
  placeholderValue.type = placeholderValue.basis;
  if (!keys.every((key) => AMOUNT_KEYS.includes(key) || placeholderValue[key](value[key]))) return false;
  return AMOUNT_KEYS.every((key) => empty(value[key]) || value[key] === 0);
}

/**
 * The job record's salary evidence. A record may carry `salary` and `compensation`; when both hold something other
 * than a recognised "no pay" value they are passed together in a shape the policy does not recognise, so the answer
 * stays manual rather than silently ignoring one of them.
 */
export function jobRecordSalary(row = {}) {
  const salary = row?.salary;
  const compensation = row?.compensation;
  if (recordSalaryIsNoPay(salary)) return recordSalaryIsNoPay(compensation) ? (salary ?? null) : compensation;
  if (recordSalaryIsNoPay(compensation)) return salary;
  return { salary, compensation };
}

/**
 * What the posting says about pay. status: 'none' (nothing found), 'advertised' (a salary statement with a known
 * currency and period), or 'uncertain' (an amount, a collective-agreement reference, or structured salary data whose
 * basis cannot be established). Detection is deliberately broad: a false positive costs one manual answer.
 */
export function detectAdvertisedSalary({ jdText = '', postingText = '', advertisedSalary = null, reportValues = [] } = {}) {
  const mentions = [];
  const structured = structuredSalary(advertisedSalary);
  if (structured) mentions.push({ source: 'job_record', text: formatStructured(structured), parsed: structured });
  // Any job-record salary that is not a recognised "no pay" value is pay evidence even when it cannot be read: a
  // text such as "According to collective agreement", an amount that looks like a year, or an object in an unfamiliar
  // schema ({range: {...}}, {min_salary, ...}, {amount: "..."}). It makes the result uncertain, never "no pay".
  else if (!recordSalaryIsNoPay(advertisedSalary)) {
    const text = typeof advertisedSalary === 'string' ? clean(advertisedSalary) : clean(safeJson(advertisedSalary));
    mentions.push({ source: 'job_record', text: text.slice(0, 240), parsed: null });
  }
  // advertised_comp from the evaluation report of this exact candidate (attached by salary-evidence.mjs).
  for (const item of reportValues) {
    const text = clean(item?.value);
    if (!text || NO_PAY_STATED.test(text)) continue;
    mentions.push({ source: 'report', text: `${text.slice(0, 240)} (report ${item?.report})`, parsed: structuredSalary(text) });
  }
  const sentences = [...new Set([...sentenceUnits(jdText), ...sentenceUnits(postingText)])];
  for (const sentence of sentences) {
    if (hasMoneyAmount(sentence)) {
      const parsed = parseSalaryText(sentence);
      const salaryContext = SALARY_WORD.test(sentence) || (parsed && parsed.period !== 'unknown');
      mentions.push({ source: 'job_description', text: sentence.slice(0, 240), parsed: salaryContext ? parsed : null });
    } else if (SALARY_WORD.test(sentence) && AGREEMENT_WORD.test(sentence)) {
      mentions.push({ source: 'job_description', text: sentence.slice(0, 240), parsed: null, agreement: true });
    }
  }
  if (!mentions.length) return { status: 'none', mentions };
  const usable = mentions.filter((item) => item.parsed && item.parsed.currency && !['MIXED'].includes(item.parsed.currency)
    && ['year', 'month'].includes(item.parsed.period) && !item.parsed.net);
  // The same range seen in the posting and in its report is one statement; anything else must agree exactly.
  const same = (a, b) => a.parsed.currency === b.parsed.currency && a.parsed.period === b.parsed.period
    && a.parsed.min === b.parsed.min && a.parsed.max === b.parsed.max;
  const consistent = usable.length > 0 && usable.length === mentions.length && usable.every((item) => same(item, usable[0]));
  return { status: consistent ? 'advertised' : 'uncertain', mentions, usable };
}

function formatStructured(parsed) {
  const range = parsed.min === parsed.max ? `${parsed.min}` : `${parsed.min}-${parsed.max}`;
  return `${parsed.currency || 'currency unknown'} ${range} (${parsed.period === 'unknown' ? 'period unknown' : `per ${parsed.period}`})`;
}

const money = (amount) => Math.round(amount).toLocaleString('en-US');
const rangeText = (currency, min, max, unit) => `${currency} ${min === max ? money(min) : `${money(min)}-${money(max)}`}/${unit}`;
const roundTo = (amount, step) => Math.round(amount / step) * step;

/** The profile's reference range, accepted only as a gross annual range with a known currency. */
export function referenceRange(profile = {}) {
  const compensation = profile?.compensation || {};
  const raw = clean(compensation.target_range);
  const parsed = raw ? parseSalaryText(raw) : null;
  const currency = clean(compensation.currency).toUpperCase() || parsed?.currency || null;
  const basis = clean(compensation.basis);
  // A stated basis must say gross annual (or at least annual and not net); the target must be a real range.
  const basisOk = !basis || (!NET_RE.test(basis) && /\b(?:annual|year|yearly)\b/i.test(basis));
  if (!parsed || parsed.net || parsed.period !== 'year' || !currency || (parsed.currency && parsed.currency !== currency)
      || !(parsed.min < parsed.max) || !basisOk) {
    return { ok: false, raw };
  }
  return { ok: true, raw, currency, min: parsed.min, max: parsed.max };
}

function questionBasis(field = {}, question = '') {
  const text = clean(question);
  const type = clean(field.type).toLowerCase();
  const tag = clean(field.tag).toLowerCase();
  const role = clean(field.role).toLowerCase();
  if (tag === 'select' || /select/i.test(clean(field.widget)) || ['radio', 'checkbox'].includes(type) || ['combobox', 'listbox'].includes(role)
      || field.autocomplete === 'list' || (Array.isArray(field.options) && field.options.length)) return 'options';
  if (NET_RE.test(text) || TAKE_HOME_RE.test(text)) return 'net';
  if (OTHER_PERIOD_RE.test(text)) return 'other_period';
  if (HOUR_RE.test(text)) return 'hourly';
  if (MONTH_RE.test(text)) return 'monthly';
  if (type === 'number' || /\b(?:single|one|exact|specific|whole)\s+(?:figure|number|amount|value)\b|\b(?:numbers?|digits?|numeric|numerals?|integers?)\s+only\b|\bonly\s+(?:numbers?|digits?|numerals?)\b|\bin (?:numbers|digits)\b|\bwithout (?:a )?range\b|\bno ranges?\b|\binteger\b/i.test(text)) {
    return 'single';
  }
  // An annual answer needs the question itself to say annual; silence about the period is not permission.
  if (!YEAR_RE.test(text)) return 'period_unverified';
  // A range answer needs a plain free-text control: a text input or textarea with no input pattern (any pattern
  // constrains the format) and no numeric keypad.
  const freeText = tag === 'textarea' || (tag === 'input' && type === 'text');
  const constrained = /numeric|decimal|tel/i.test(clean(field.inputMode)) || Boolean(clean(field.pattern));
  if (!freeText || constrained) return 'field_unverified';
  return 'annual_range';
}

const FINLAND = /^(?:finland|suomi|fi|fin)$/i;

/**
 * Decide a salary answer. Returns { value, reasonCode, reason, proposal }; value is non-null only for the fully
 * verified case described at the top of this file.
 */
export function salaryAnswerDecision(profile, {
  field = {}, question = '', jobCountry = null, jdText = '', advertisedSalary = null, trainee = false,
  postingEvidence = null, reportCompensation = null,
} = {}) {
  const manual = (reasonCode, reason, proposal = null) => ({ value: null, reasonCode, reason, proposal });
  if (trainee) {
    const answer = clean(profile?.compensation?.trainee_answer);
    return answer
      ? { value: answer, reasonCode: 'trainee_answer', reason: 'Approved trainee/internship answer from config/profile.yml.', proposal: null }
      : manual('trainee_role', 'Trainee/internship role: the general salary target is not used; enter a role-appropriate expectation.');
  }
  const reference = referenceRange(profile);
  if (!reference.ok) {
    return manual('reference_invalid', 'compensation.target_range in config/profile.yml is not a gross annual range with a known currency.');
  }
  const referenceText = rangeText(reference.currency, reference.min, reference.max, 'year');
  const asked = clean([question, field.questionText, field.groupLabel, field.label].filter(Boolean).join(' '));
  const askedCurrency = salaryCurrency(asked);
  if (askedCurrency && askedCurrency !== reference.currency) {
    return manual('question_currency_mismatch', `The question asks for ${askedCurrency}; the reference range is in ${reference.currency}. Currency conversion is your call.`);
  }
  const country = clean(jobCountry);
  if (!country) {
    return manual('job_country_unverified', 'The job country is not verified, so the Finnish reference range cannot be used automatically.',
      `${referenceText} if the job is in Finland`);
  }
  if (!FINLAND.test(country)) {
    return manual('outside_finland', `The job is in ${country}. The Finnish reference range (${referenceText}) is only a starting point; set an application-specific figure for this country.`);
  }

  // Annual basis for any proposal: the reference range, or what the advertised range implies under the owner's rules.
  let basis = { min: reference.min, max: reference.max };
  let assumption = '';
  const postingComplete = postingEvidence?.complete === true && Boolean(clean(postingEvidence.text));
  const advertised = detectAdvertisedSalary({
    jdText, postingText: postingComplete ? postingEvidence.text : '', advertisedSalary,
    reportValues: Array.isArray(reportCompensation?.values) ? reportCompensation.values : [],
  });
  let blocking = null;
  if (!['matched', 'none'].includes(reportCompensation?.status)) {
    blocking = ['report_evidence_unverified', `The evaluation-report pay for this exact candidate could not be established (${clean(reportCompensation?.reason) || 'not checked'}); check the advertised pay yourself.`];
  } else if (advertised.status === 'none' && !clean(jdText) && !postingComplete) {
    blocking = ['jd_unavailable', 'The stored job description is unavailable, so the absence of an advertised salary cannot be verified.'];
  } else if (advertised.status === 'none' && !postingComplete) {
    blocking = ['posting_unverified', `No salary appears in the stored text, but there is no verified capture of the complete posting (${clean(postingEvidence?.reason) || 'no capture recorded'}); the full posting may state pay.`];
  } else if (advertised.status === 'uncertain') {
    const quoted = advertised.mentions.map((item) => `"${item.text}"`).join('; ');
    blocking = ['advertised_uncertain', `The posting or job record mentions pay that could not be read reliably (${quoted}). Check it; if it states no salary, the reference range applies.`];
  } else if (advertised.status === 'advertised') {
    const ad = advertised.usable[0].parsed;
    if (ad.currency !== reference.currency) {
      blocking = ['advertised_conflict', `The posting advertises pay in ${ad.currency} ("${advertised.usable[0].text}"); compare it yourself.`];
      basis = null;
    } else {
      const factor = ad.period === 'month' ? 12 : 1;
      if (factor !== 1) assumption = ' The advertised monthly figure was multiplied by 12 to compare; check whether a holiday bonus applies.';
      const adMin = ad.min * factor;
      const adMax = ad.max * factor;
      const adText = `"${advertised.usable[0].text}" (the employer's budget, not an offer)`;
      if (adMin >= reference.max) {
        basis = { min: adMin, max: adMax };
        blocking = ['advertised_higher', `The posting advertises more than the reference range: ${adText}. Your rules use the employer's range rather than underbidding.${assumption}`];
      } else if (adMax <= reference.min) {
        basis = null;
        blocking = ['advertised_lower', `The posting advertises less than the reference range: ${adText}. This needs your decision.${assumption}`];
      } else {
        basis = { min: Math.max(adMin, reference.min), max: Math.min(adMax, reference.max) };
        blocking = ['advertised_overlap', `The advertised range overlaps the reference range: ${adText}. Choose an expectation within the overlap.${assumption}`];
      }
    }
  }

  const kind = questionBasis(field, asked);
  const annualProposal = basis ? rangeText(reference.currency, roundTo(basis.min, 100), roundTo(basis.max, 100), 'year') : null;
  const monthly = (divisor) => basis
    ? rangeText(reference.currency, roundTo(basis.min / divisor, 10), roundTo(basis.max / divisor, 10), 'month') : null;
  const single = basis ? `${reference.currency} ${money(roundTo((basis.min + basis.max) / 2, 500))}` : null;
  const questionReason = {
    options: ['options_question', 'The question offers fixed options; pick the one that contains the proposed range.', annualProposal],
    net: ['net_requested', 'The question asks for net pay; the reference range is gross.', null],
    hourly: ['hourly_requested', 'The question asks for an hourly rate; the reference range is annual.', null],
    other_period: ['period_not_annual', 'The question asks for pay per week or day; the reference range is annual.', null],
    monthly: ['monthly_requested', 'The question asks for monthly pay. The proposal divides the annual figure by 12; use 12.5 instead only where the employer pays the Finnish holiday bonus on top of 12 monthly salaries.',
      basis ? `${monthly(12)} gross (÷12), or ${monthly(12.5)} (÷12.5)` : null],
    single: ['single_figure_requested', 'The question asks for one figure. The top of the range is not automatically your demand.',
      single ? `${single}/year gross` : null],
    period_unverified: ['period_unverified', 'The question does not say whether it means annual, monthly or another period.', annualProposal],
    field_unverified: ['field_not_range_compatible', 'The field is not a plain free-text box (or expects digits only), so a range may not be accepted.', annualProposal],
  }[kind];
  if (blocking) {
    let proposal = annualProposal;
    if (kind === 'monthly') proposal = questionReason[2];
    if (kind === 'single') proposal = questionReason[2];
    if (['net', 'hourly', 'other_period'].includes(kind)) proposal = null;
    const extra = questionReason ? ` ${questionReason[1]}` : '';
    return manual(blocking[0], `${blocking[1]}${extra}`, proposal);
  }
  if (questionReason) return manual(questionReason[0], questionReason[1], questionReason[2]);
  // The currency must be stated by the question itself; the answer's own "EUR" does not make an unstated one safe.
  if (askedCurrency !== reference.currency) {
    return manual('currency_unverified', `The question does not state the currency; the reference range is in ${reference.currency}.`, annualProposal);
  }
  const maxLength = Number(field.maxLength || 0);
  if (maxLength && reference.raw.length > maxLength) {
    return manual('answer_too_long', `The field allows ${maxLength} characters; the reference range text is longer.`, referenceText);
  }
  return { value: reference.raw, reasonCode: 'reference_range', reason: `Finnish role; complete posting checked (${clean(postingEvidence.basis) || 'verified capture'}) with no advertised salary; free-text annual ${reference.currency} question.`, proposal: null };
}

/** One line for an unresolved-field record: the reason plus any proposal awaiting approval. */
export function salaryManualNote(decision) {
  if (!decision || decision.value) return null;
  return decision.proposal ? `${decision.reason} Proposed for your approval: ${decision.proposal}.` : decision.reason;
}
