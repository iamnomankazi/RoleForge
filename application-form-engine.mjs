import {
  classifyCaptchaState,
  classifyUserGate,
  inspectApplicationForm as inspectLegacyApplicationForm,
  isSemanticFinalAction,
} from './application-form-core.mjs';
import {
  canonicalFieldValue,
  classifyFieldSemantics,
  cleanFormText,
  containsUnresolvedPlaceholder,
  generateCustomNarrativeAnswer,
  hashFormValue,
  normalizeNarrativeText,
  normalizeFormQuestion,
  preferredDeclineOption,
  stableFieldIdentity,
  validatePlannedValueForControl,
} from './application-form-policy.mjs';
import { validateNarrativeProvenanceRecord } from './application-evidence.mjs';

const MAX_FIELD_ATTEMPTS = 2;
const MAX_CONTROLLED_RESUMES = 2;

export const DEFAULT_LIVE_FORM_LIMITS = Object.freeze({
  sessionMs: 5 * 60 * 1000,
  normalFieldMs: 10 * 1000,
  choiceMs: 20 * 1000,
  uploadMs: 30 * 1000,
  maxAttempts: MAX_FIELD_ATTEMPTS,
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveOperationalFormLimits(profile = {}, overrides = {}) {
  const configured = profile?.formRules?.time_limits || {};
  const configuredMs = (key, fallback) => positiveInteger(Number(configured[key]) * 1000, fallback);
  return {
    sessionMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.sessionMs,
      positiveInteger(overrides.sessionMs, configuredMs('session_seconds', DEFAULT_LIVE_FORM_LIMITS.sessionMs)),
    ),
    normalFieldMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.normalFieldMs,
      positiveInteger(overrides.normalFieldMs, configuredMs('normal_field_seconds', DEFAULT_LIVE_FORM_LIMITS.normalFieldMs)),
    ),
    choiceMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.choiceMs,
      positiveInteger(overrides.choiceMs, configuredMs('dropdown_autocomplete_seconds', DEFAULT_LIVE_FORM_LIMITS.choiceMs)),
    ),
    uploadMs: Math.min(
      DEFAULT_LIVE_FORM_LIMITS.uploadMs,
      positiveInteger(overrides.uploadMs, configuredMs('upload_seconds', DEFAULT_LIVE_FORM_LIMITS.uploadMs)),
    ),
    maxAttempts: Math.min(
      MAX_FIELD_ATTEMPTS,
      positiveInteger(overrides.maxAttempts, positiveInteger(configured.max_attempts, DEFAULT_LIVE_FORM_LIMITS.maxAttempts)),
    ),
  };
}

export function actionAttemptLimitMs(action, limits = DEFAULT_LIVE_FORM_LIMITS) {
  if (action?.action === 'upload') return limits.uploadMs;
  if (['select', 'autocomplete'].includes(action?.action)) return limits.choiceMs;
  return limits.normalFieldMs;
}

function digest(value) {
  return hashFormValue(JSON.stringify(value));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.stableFieldId || row.fieldId}|${row.reason || ''}|${row.semantic || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fieldQuestion(field) {
  return cleanFormText(field.questionText || field.groupLabel || field.label);
}

function optionsFor(field) {
  return (field.options || []).flatMap((option) => [
    { label: cleanFormText(option.label), value: cleanFormText(option.value) },
  ]).filter((option) => option.label || option.value);
}

function matchingOption(field, intended) {
  const normalized = normalizeFormQuestion(intended);
  return optionsFor(field).find((option) => (
    normalizeFormQuestion(option.label) === normalized
    || normalizeFormQuestion(option.value) === normalized
  )) || null;
}

function choiceMatches(field, intended) {
  const target = normalizeFormQuestion(intended);
  return [field.optionLabel, field.value, field.label]
    .map(normalizeFormQuestion)
    .some((value) => value === target || value.endsWith(` ${target}`));
}

function controlAction(field, intended) {
  if (field.type === 'checkbox') return 'check';
  if (field.type === 'radio') return choiceMatches(field, intended) ? 'radio' : null;
  if (field.tag === 'select') return 'select';
  if (field.role === 'combobox' || field.autocomplete === 'list') return 'autocomplete';
  return 'fill';
}

function groundedLocationMatches(value, action) {
  const normalized = normalizeFormQuestion(value);
  const intended = cleanFormText(action.value);
  const parts = ['city', 'country'].includes(action.semantic)
    ? [intended]
    : intended.split(',').map((part) => part.trim()).filter(Boolean);
  const tokens = parts.map(normalizeFormQuestion).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => normalized.includes(token));
}

function isCommitted(field, action) {
  if (action.action === 'upload') {
    return (field.files || []).some((filename) => filename === action.artifact.intendedFilename);
  }
  if (action.action === 'check' || action.action === 'radio') return Boolean(field.checked);
  if (action.action === 'select') {
    const option = matchingOption(field, action.value);
    return Boolean(option && (
      cleanFormText(field.value) === option.value
      || normalizeFormQuestion(field.selectedLabel) === normalizeFormQuestion(option.label)
    ));
  }
  const normalizeValue = action.category === 'custom_motivation_experience_narrative'
    ? normalizeNarrativeText
    : cleanFormText;
  const current = normalizeValue(field.value);
  if (action.action === 'autocomplete' && action.category === 'current_location') {
    return groundedLocationMatches(current, action);
  }
  return current === normalizeValue(action.value);
}

function selectArtifact(artifacts, semantic) {
  if (semantic === 'cv_upload') return artifacts.cv || null;
  if (semantic === 'cover_letter_upload') return artifacts.coverLetter || null;
  if (semantic === 'single_document_upload') return artifacts.combinedDocument || null;
  return null;
}

export async function inspectOperationalApplicationForm(page) {
  const snapshot = await inspectLegacyApplicationForm(page);
  const metadata = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-career-ops-field-id]')].map((element) => {
      const fieldset = element.closest('fieldset');
      const groupLabel = clean(fieldset?.querySelector(':scope > legend')?.innerText)
        || clean(element.closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-label'));
      const ownLabel = element.labels ? clean([...element.labels].map((label) => label.innerText).join(' ')) : '';
      const optionLabel = ['radio', 'checkbox'].includes((element.type || '').toLowerCase()) ? ownLabel : '';
      const selected = element.tagName === 'SELECT' ? element.selectedOptions?.[0]?.textContent : '';
      return {
        fieldId: element.getAttribute('data-career-ops-field-id'),
        groupLabel,
        questionText: groupLabel || ownLabel || element.getAttribute('aria-label') || element.placeholder || element.name || element.id || '',
        optionLabel,
        maxLength: Number(element.getAttribute('maxlength') || 0) || null,
        minLength: Number(element.getAttribute('minlength') || 0) || null,
        selectedLabel: clean(selected),
        ariaInvalid: element.getAttribute('aria-invalid') === 'true',
      };
    });
  });
  const byId = new Map(metadata.map((row) => [row.fieldId, row]));
  return {
    ...snapshot,
    fields: snapshot.fields.map((field) => ({ ...field, ...(byId.get(field.fieldId) || {}) })),
  };
}

export function inspectOperationalUploadTopology(snapshot) {
  const fields = (snapshot.fields || [])
    .filter((field) => !field.disabled && field.type === 'file')
    .map((field) => {
      const semantics = classifyFieldSemantics(field);
      return {
        fieldId: field.fieldId,
        stableFieldId: stableFieldIdentity(field, semantics),
        label: fieldQuestion(field),
        category: semantics.category,
        semantic: semantics.semantic,
      };
    });
  const cv = fields.filter((row) => row.semantic === 'cv_upload');
  const cover = fields.filter((row) => row.semantic === 'cover_letter_upload');
  const combined = fields.filter((row) => row.semantic === 'single_document_upload');
  const unknown = fields.filter((row) => row.semantic === 'unknown_upload');
  let mode = 'none';
  let reason = 'No visible document upload fields.';
  if (cv.length && cover.length && !combined.length && !unknown.length) {
    mode = 'separate';
    reason = 'Separate CV and cover-letter upload fields are available.';
  } else if (fields.length === 1 && combined.length === 1) {
    mode = 'single_combined';
    reason = 'Exactly one field explicitly requests combined application documents.';
  } else if (fields.length) {
    mode = 'ambiguous';
    reason = 'Document upload purpose or topology is ambiguous; no combined upload is allowed.';
  }
  return { mode, reason, fields };
}

function manualField(field, semantics, reason, missingInformation = null) {
  return {
    fieldId: field.fieldId,
    stableFieldId: stableFieldIdentity(field, semantics),
    label: fieldQuestion(field),
    category: semantics.category,
    semantic: semantics.semantic,
    reason,
    missingInformation,
    manualActionRequired: true,
  };
}

function answerForField(field, semantics, profile, snapshot, artifacts, context) {
  if (semantics.category === 'custom_motivation_experience_narrative') {
    if (semantics.semantic === 'cover_letter_text' && artifacts.coverLetterTextContent) {
      if (containsUnresolvedPlaceholder(artifacts.coverLetterTextContent)) {
        throw new Error('Bound cover letter contains an unresolved placeholder');
      }
      const provenance = artifacts.coverLetterTextProvenance;
      if (!provenance) throw new Error('Bound cover letter text has no factual provenance');
      validateNarrativeProvenanceRecord(profile, provenance, {
        candidateId: cleanFormText(context?.candidate?.candidate_id || context?.candidate?.candidateId),
        normalizedQuestion: provenance.normalizedQuestion,
        answer: artifacts.coverLetterTextContent,
      });
      return { value: artifacts.coverLetterTextContent, answerRecord: null };
    }
    const record = generateCustomNarrativeAnswer(profile, {
      question: fieldQuestion(field),
      candidate: context.candidate || {},
      jdText: context.jdText || '',
      maxLength: field.maxLength,
    });
    return { value: record.answer, answerRecord: record };
  }
  return {
    value: canonicalFieldValue(profile, semantics, { field, snapshot, context }),
    answerRecord: null,
  };
}

export function buildOperationalFormPlan(snapshot, profile, artifacts = {}, {
  context = {},
  previousEvidence = null,
} = {}) {
  const actions = [];
  const preservedFields = [];
  const preservedUploads = [];
  const unresolvedFields = [];
  const answerRecords = [];
  const priorAnswers = Array.isArray(previousEvidence?.answerRecords) ? previousEvidence.answerRecords : [];
  const effectiveProfile = { ...profile, priorApprovedAnswers: priorAnswers };
  const visibleFields = (snapshot.fields || []).filter((field) => {
    if (field.disabled) return false;
    const semantics = classifyFieldSemantics(field);
    return field.visible !== false
      || semantics.category === 'file_upload'
      || (field.required && semantics.category === 'current_location');
  });

  for (const field of visibleFields) {
    const semantics = classifyFieldSemantics(field);
    const stableFieldId = stableFieldIdentity(field, semantics);
    const base = {
      fieldId: field.fieldId,
      stableFieldId,
      id: field.id,
      label: fieldQuestion(field),
      name: field.name,
      category: semantics.category,
      semantic: semantics.semantic,
    };

    if (semantics.category === 'preferred_location') {
      unresolvedFields.push(manualField(field, semantics, 'Preferred location is application-specific and has no exact approved value.'));
      continue;
    }
    if (semantics.category === 'optional_marketing_consent') {
      if (field.required) unresolvedFields.push(manualField(field, semantics, 'Required promotional consent needs user review; Career-Ops will not opt in automatically.'));
      continue;
    }
    if (semantics.category === 'legal_declaration') {
      if (field.required) unresolvedFields.push(manualField(field, semantics, 'Legally meaningful declaration requires user review.'));
      continue;
    }
    if (semantics.category === 'demographic_eeo') {
      if (!field.required) continue;
      const decline = preferredDeclineOption(field.options);
      if (!decline) {
        unresolvedFields.push(manualField(field, semantics, 'Required EEO field has no visible Prefer not to say option.'));
        continue;
      }
      const action = controlAction(field, decline);
      if (!action) continue;
      actions.push({ ...base, action, value: decline, valueHash: hashFormValue(decline), retryBudget: 1 });
      continue;
    }
    if (semantics.category === 'privacy_data_processing_consent') {
      if (!field.required) continue;
      if (field.type === 'text' || field.type === 'textarea' || field.tag === 'textarea') {
        unresolvedFields.push(manualField(field, semantics, 'Privacy/Data Notice field asks for text instead of a standard acknowledgement.'));
        continue;
      }
      const intended = field.type === 'checkbox'
        ? 'Yes'
        : matchingOption(field, 'I agree')?.label
          || matchingOption(field, 'Accept')?.label
          || matchingOption(field, 'Yes')?.label;
      if (!intended) {
        unresolvedFields.push(manualField(field, semantics, 'Required privacy acknowledgement has no grounded acceptance control.'));
        continue;
      }
      const action = controlAction(field, intended);
      if (!action) continue;
      const planned = { ...base, action, value: intended, valueHash: hashFormValue(intended), retryBudget: 1 };
      if (isCommitted(field, planned)) preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
      else actions.push(planned);
      continue;
    }
    if (semantics.category === 'file_upload') {
      const artifact = selectArtifact(artifacts, semantics.semantic);
      if (!artifact) {
        if (field.required || semantics.semantic === 'unknown_upload') {
          unresolvedFields.push(manualField(field, semantics, 'Required exact bound artifact is unavailable or upload purpose is ambiguous.'));
        }
        continue;
      }
      const planned = { ...base, action: 'upload', artifact, retryBudget: 1 };
      if (isCommitted(field, planned)) {
        preservedFields.push({ ...base, valueHash: artifact.sha256, preserved: true });
        preservedUploads.push({
          semantic: semantics.semantic,
          filename: artifact.intendedFilename,
          sha256: artifact.sha256,
          preserved: true,
        });
      } else {
        actions.push(planned);
      }
      continue;
    }
    if (semantics.semantic === 'german_university_enrollment') {
      unresolvedFields.push(manualField(
        field,
        semantics,
        'German-university enrollment requires an explicit grounded Yes or No answer; an institution name is not a valid substitute.',
      ));
      continue;
    }
    if (semantics.category === 'unknown') {
      if (field.required) unresolvedFields.push(manualField(field, semantics, 'Field meaning is genuinely uncertain.'));
      continue;
    }

    let resolved;
    try {
      resolved = answerForField(field, semantics, effectiveProfile, snapshot, artifacts, context);
    } catch (error) {
      unresolvedFields.push(manualField(
        field,
        semantics,
        cleanFormText(error.message),
        cleanFormText(error.message).startsWith('Missing evidence') ? cleanFormText(error.message) : null,
      ));
      continue;
    }
    const normalizeValue = semantics.category === 'custom_motivation_experience_narrative'
      ? normalizeNarrativeText
      : cleanFormText;
    let value = normalizeValue(resolved.value);
    if (!value) {
      if (field.required || ['work_authorization', 'sponsorship_employer_support'].includes(semantics.category)) {
        unresolvedFields.push(manualField(
          field,
          semantics,
          'No grounded canonical answer is available.',
          ['work_authorization', 'sponsorship_employer_support'].includes(semantics.category)
            ? 'Verified job country or hiring arrangement is missing or ambiguous.'
            : 'Canonical profile evidence is missing.',
        ));
      }
      continue;
    }
    try {
      value = validatePlannedValueForControl(field, semantics, value);
    } catch (error) {
      unresolvedFields.push(manualField(field, semantics, cleanFormText(error.message)));
      continue;
    }
    if (['work_authorization', 'sponsorship'].includes(semantics.semantic) && !['Yes', 'No'].includes(value)) {
      unresolvedFields.push(manualField(field, semantics, 'Authorization and sponsorship controls require an exact Yes or No answer.'));
      continue;
    }
    const action = controlAction(field, value);
    if (!action) continue;
    const planned = {
      ...base,
      action,
      value,
      valueHash: hashFormValue(value),
      retryBudget: 1,
      sourceRef: resolved.answerRecord ? 'candidate-specific-grounded-narrative' : 'config/profile.yml',
    };
    if (isCommitted(field, planned)) {
      preservedFields.push({ ...base, valueHash: planned.valueHash, preserved: true });
    } else {
      actions.push(planned);
    }
    if (resolved.answerRecord) answerRecords.push(resolved.answerRecord);
  }

  const finalActions = (snapshot.controls || []).filter(isSemanticFinalAction).map((control) => ({
    label: control.label || control.text || control.value || '(unlabelled submit control)',
    semanticClass: control.type === 'submit' ? 'form_submit' : 'terminal_action',
  }));
  const uploadTopology = inspectOperationalUploadTopology(snapshot);
  if (uploadTopology.mode === 'ambiguous') {
    for (const row of uploadTopology.fields) {
      if (!unresolvedFields.some((field) => field.stableFieldId === row.stableFieldId)) {
        unresolvedFields.push({ ...row, reason: uploadTopology.reason, manualActionRequired: true });
      }
    }
  }
  return {
    actions,
    preservedFields,
    preservedUploads,
    unresolvedFields: dedupeRows(unresolvedFields),
    answerRecords,
    finalActions,
    uploadTopology,
    snapshotHash: digest(snapshot),
  };
}

async function installSubmissionGuard(page) {
  await page.evaluate(() => {
    if (globalThis.__careerOpsOperationalGuard) return;
    globalThis.__careerOpsSubmitAttempts = Number(globalThis.__careerOpsSubmitAttempts || 0);
    const block = (event) => {
      globalThis.__careerOpsSubmitAttempts += 1;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      throw new Error('Career-Ops blocked a final form submission attempt');
    };
    const nativeSubmit = HTMLFormElement.prototype.submit;
    const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    globalThis.__careerOpsOperationalGuard = { block, nativeSubmit, nativeRequestSubmit };
    document.addEventListener('submit', block, true);
    HTMLFormElement.prototype.submit = function guardedSubmit() { block(); };
    HTMLFormElement.prototype.requestSubmit = function guardedRequestSubmit() { block(); };
  });
}

export async function removeOperationalSubmissionGuard(page) {
  await page.evaluate(() => {
    const guard = globalThis.__careerOpsOperationalGuard;
    if (!guard) return;
    document.removeEventListener('submit', guard.block, true);
    HTMLFormElement.prototype.submit = guard.nativeSubmit;
    HTMLFormElement.prototype.requestSubmit = guard.nativeRequestSubmit;
    delete globalThis.__careerOpsOperationalGuard;
  });
}

async function exactLocator(page, action) {
  const selectors = [
    `[data-career-ops-field-id="${String(action.fieldId).replace(/"/g, '\\"')}"]`,
  ];
  if (action.id) selectors.push(`[id="${String(action.id).replace(/"/g, '\\"')}"]`);
  if (action.name) selectors.push(`[name="${String(action.name).replace(/"/g, '\\"')}"]`);
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 1) return locator;
    if (count > 1 && selector.startsWith('[data-career-ops-field-id=')) {
      throw new Error(`Career-Ops exact field identity is ambiguous for ${action.semantic}`);
    }
  }
  if (action.label && action.action !== 'upload') {
    const locator = page.getByLabel(action.label, { exact: true });
    if (await locator.count() === 1) return locator;
  }
  throw new Error(`Form control changed and could not be reacquired: ${action.semantic}`);
}

async function assertNotFinal(locator) {
  const final = await locator.evaluate((element) => ({
    type: element.type,
    formAction: element.getAttribute('formaction'),
    insideApplicationForm: Boolean(element.closest('form')),
    label: element.getAttribute('aria-label') || element.innerText || element.value,
  }));
  if (isSemanticFinalAction(final)) throw new Error('Refusing to interact with a final-action control');
}

async function validationState(locator) {
  return locator.evaluate((element) => ({
    value: element.value || '',
    checked: Boolean(element.checked),
    invalid: element.getAttribute('aria-invalid') === 'true' || (typeof element.checkValidity === 'function' && !element.checkValidity()),
    files: element.files ? [...element.files].map((file) => file.name) : [],
  }));
}

function remainingTimeout(deadlineMs, clock) {
  const remaining = Math.floor(deadlineMs - clock());
  if (remaining <= 0) {
    const error = new Error('Field attempt time limit reached.');
    error.code = 'FIELD_ATTEMPT_TIMEOUT';
    throw error;
  }
  return remaining;
}

async function chooseAutocomplete(page, action, visibleOptions, { deadlineMs, clock }) {
  let locator = await exactLocator(page, action);
  await locator.focus({ timeout: remainingTimeout(deadlineMs, clock) });
  await locator.fill('', { timeout: remainingTimeout(deadlineMs, clock) });
  await locator.pressSequentially(action.value, { delay: 20, timeout: remainingTimeout(deadlineMs, clock) });
  remainingTimeout(deadlineMs, clock);
  await page.waitForTimeout(250);
  let optionLocators = page.getByRole('option');
  const count = await optionLocators.count();
  visibleOptions.push(...(await optionLocators.allTextContents()).map(cleanFormText).filter(Boolean));
  let targetIndex = -1;
  for (let index = 0; index < count; index += 1) {
    const label = cleanFormText(await optionLocators.nth(index).innerText().catch(() => ''));
    const normalized = normalizeFormQuestion(label);
    if (action.category === 'current_location') {
      if (groundedLocationMatches(label, action)) {
        targetIndex = index;
        break;
      }
    } else if (normalizeFormQuestion(label) === normalizeFormQuestion(action.value)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) throw new Error(`Autocomplete has no grounded visible option for ${action.value}`);
  await optionLocators.nth(targetIndex).click({ timeout: remainingTimeout(deadlineMs, clock) });
  locator = await exactLocator(page, action);
  await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
  const committed = cleanFormText((await validationState(locator)).value);
  if (action.category === 'current_location') {
    const normalized = normalizeFormQuestion(committed);
    if (!groundedLocationMatches(committed, action)) {
      throw new Error(`Autocomplete committed an ungrounded location: ${committed || '(empty)'}`);
    }
  } else if (normalizeFormQuestion(committed) !== normalizeFormQuestion(action.value)) {
    throw new Error(`Autocomplete selection was not committed: ${action.value}`);
  }
  return committed;
}

async function performAction(page, action, visibleOptions, { deadlineMs, clock }) {
  let locator = await exactLocator(page, action);
  await assertNotFinal(locator);
  if (action.action === 'upload') {
    const target = await locator.elementHandle();
    if (!target) throw new Error(`Exact upload input is unavailable: ${action.semantic}`);
    try {
      const before = await target.evaluate((element) => ({
        fieldId: element.getAttribute('data-career-ops-field-id') || '',
        type: (element.type || '').toLowerCase(),
      }));
      if (before.type !== 'file') throw new Error(`Exact upload target is not a file input: ${action.semantic}`);
      if (before.fieldId && before.fieldId !== action.fieldId) {
        throw new Error(`Exact upload target identity changed before upload: ${action.semantic}`);
      }
      await locator.setInputFiles(action.artifact.resolvedPath, { timeout: remainingTimeout(deadlineMs, clock) });
      const state = await target.evaluate((element) => ({
        attached: element.isConnected,
        files: element.files ? [...element.files].map((file) => file.name) : [],
      }));
      if (state.files.length !== 1 || state.files[0] !== action.artifact.intendedFilename) {
        throw new Error(
          `Exact upload input did not accept the intended artifact for ${action.semantic}: expected ${action.artifact.intendedFilename}; observed ${state.files.join(', ') || '(none)'}`,
        );
      }
    } finally {
      await target.dispose();
    }
    return action.artifact.intendedFilename;
  }
  if (action.action === 'select') {
    const selected = await locator.evaluate((element, intended) => {
      const normalized = (value) => String(value || '').trim().toLowerCase();
      const option = [...element.options].find((item) => (
        normalized(item.textContent) === normalized(intended)
        || normalized(item.value) === normalized(intended)
      ));
      return option ? { value: option.value, label: option.textContent.trim() } : null;
    }, action.value);
    if (!selected) throw new Error(`No exact dropdown option for ${action.value}`);
    await locator.selectOption(selected.value, { timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
    const state = await validationState(locator);
    if (state.invalid || state.value !== selected.value) throw new Error(`Dropdown selection did not remain committed: ${action.value}`);
    return selected.label;
  }
  if (action.action === 'autocomplete') {
    return chooseAutocomplete(page, action, visibleOptions, { deadlineMs, clock });
  }
  if (action.action === 'check' || action.action === 'radio') {
    await locator.check({ timeout: remainingTimeout(deadlineMs, clock) });
    locator = await exactLocator(page, action);
    const state = await validationState(locator);
    if (!state.checked || state.invalid) throw new Error(`Choice did not remain committed: ${action.semantic}`);
    return action.value;
  }
  await locator.fill(action.value, { timeout: remainingTimeout(deadlineMs, clock) });
  await locator.blur({ timeout: remainingTimeout(deadlineMs, clock) });
  locator = await exactLocator(page, action);
  const state = await validationState(locator);
  const normalizeValue = action.category === 'custom_motivation_experience_narrative'
    ? normalizeNarrativeText
    : action.semantic === 'phone'
      ? (value) => cleanFormText(value).replace(/[\s().-]+/g, '')
    : cleanFormText;
  if (state.invalid || normalizeValue(state.value) !== normalizeValue(action.value)) {
    throw new Error(`Field value did not remain committed: ${action.semantic}`);
  }
  return state.value;
}

async function withinAttemptDeadline(operation, {
  timeoutMs,
  sessionBound,
}) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(sessionBound
            ? 'Whole form-filling session time limit reached.'
            : 'Field attempt time limit reached.');
          error.code = sessionBound ? 'FORM_SESSION_TIMEOUT' : 'FIELD_ATTEMPT_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeOperationalFormPlanGuarded(page, plan, {
  previousEvidence = null,
  now = () => new Date(),
  clock = () => Date.now(),
  limits = DEFAULT_LIVE_FORM_LIMITS,
  sessionDeadlineMs = null,
  performActionImpl = performAction,
} = {}) {
  const effectiveLimits = resolveOperationalFormLimits({}, limits);
  const hardDeadlineMs = sessionDeadlineMs ?? (clock() + effectiveLimits.sessionMs);
  const completed = [...(plan.preservedFields || [])];
  const uploadedArtifacts = [...(plan.preservedUploads || [])];
  const committedSelections = [];
  const unresolvedFields = [];
  const priorLedger = Array.isArray(previousEvidence?.attemptLedger) ? previousEvidence.attemptLedger : [];
  const attemptLedger = [...priorLedger];

  let sessionLimitReached = false;
  for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex += 1) {
    const action = plan.actions[actionIndex];
    if (clock() >= hardDeadlineMs) {
      sessionLimitReached = true;
      for (const pending of plan.actions.slice(actionIndex)) {
        unresolvedFields.push({
          fieldId: pending.fieldId,
          stableFieldId: pending.stableFieldId,
          label: pending.label,
          category: pending.category,
          semantic: pending.semantic,
          reason: 'Whole form-filling session time limit reached.',
          manualActionRequired: true,
        });
      }
      break;
    }
    const visibleOptions = [];
    let success = false;
    let lastReason = null;
    for (let attempt = 1; attempt <= effectiveLimits.maxAttempts; attempt += 1) {
      const attemptedAt = now().toISOString();
      try {
        const sessionRemainingMs = Math.max(0, hardDeadlineMs - clock());
        if (sessionRemainingMs <= 0) {
          const error = new Error('Whole form-filling session time limit reached.');
          error.code = 'FORM_SESSION_TIMEOUT';
          throw error;
        }
        const actionLimitMs = actionAttemptLimitMs(action, effectiveLimits);
        const timeoutMs = Math.min(sessionRemainingMs, actionLimitMs);
        const sessionBound = sessionRemainingMs <= actionLimitMs;
        const attemptDeadlineMs = clock() + timeoutMs;
        const committedValue = await withinAttemptDeadline(
          () => performActionImpl(page, action, visibleOptions, { deadlineMs: attemptDeadlineMs, clock }),
          { timeoutMs, sessionBound },
        );
        if (clock() > hardDeadlineMs) {
          const error = new Error('Whole form-filling session time limit reached.');
          error.code = 'FORM_SESSION_TIMEOUT';
          throw error;
        }
        const completedAt = now().toISOString();
        attemptLedger.push({
          batchId: cleanFormText(action.batchId) || null,
          candidateId: cleanFormText(action.candidateId) || null,
          formFingerprint: plan.formFingerprint || null,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          attemptedValueHash: action.valueHash || action.artifact?.sha256,
          attemptCount: attempt,
          success: true,
          committedValue: action.category === 'custom_motivation_experience_narrative' ? null : cleanFormText(committedValue),
          committedValueHash: action.valueHash || action.artifact?.sha256,
          validationEvidence: 'live control remained committed after blur/rerender verification',
          visibleOptions: [...new Set(visibleOptions)],
          attemptedAt,
          completedAt,
          retryReason: lastReason,
          manualActionRequired: false,
        });
        completed.push({
          fieldId: action.fieldId,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          valueHash: action.valueHash || action.artifact?.sha256,
          preserved: false,
        });
        if (action.action === 'upload') {
          uploadedArtifacts.push({
            semantic: action.semantic,
            filename: action.artifact.intendedFilename,
            sha256: action.artifact.sha256,
            preserved: false,
          });
        } else if (['select', 'autocomplete', 'check', 'radio'].includes(action.action)) {
          committedSelections.push({
            semantic: action.semantic,
            valueHash: action.valueHash,
            label: action.category === 'custom_motivation_experience_narrative' ? null : cleanFormText(committedValue),
          });
        }
        success = true;
        break;
      } catch (error) {
        const timeoutCode = clock() >= hardDeadlineMs ? 'FORM_SESSION_TIMEOUT' : error.code;
        sessionLimitReached = timeoutCode === 'FORM_SESSION_TIMEOUT';
        lastReason = timeoutCode === 'FORM_SESSION_TIMEOUT'
          ? 'Whole form-filling session time limit reached.'
          : timeoutCode === 'FIELD_ATTEMPT_TIMEOUT'
            ? 'Field attempt time limit reached.'
            : cleanFormText(error.message);
        attemptLedger.push({
          batchId: cleanFormText(action.batchId) || null,
          candidateId: cleanFormText(action.candidateId) || null,
          formFingerprint: plan.formFingerprint || null,
          stableFieldId: action.stableFieldId,
          category: action.category,
          semantic: action.semantic,
          attemptedValueHash: action.valueHash || action.artifact?.sha256,
          attemptCount: attempt,
          success: false,
          committedValue: null,
          committedValueHash: null,
          validationEvidence: lastReason,
          visibleOptions: [...new Set(visibleOptions)],
          attemptedAt,
          completedAt: now().toISOString(),
          retryReason: !sessionLimitReached && attempt < effectiveLimits.maxAttempts ? lastReason : null,
          manualActionRequired: sessionLimitReached || attempt === effectiveLimits.maxAttempts,
          limitReached: timeoutCode || null,
        });
        if (sessionLimitReached) break;
      }
    }
    if (!success) {
      unresolvedFields.push({
        fieldId: action.fieldId,
        stableFieldId: action.stableFieldId,
        label: action.label,
        category: action.category,
        semantic: action.semantic,
        reason: lastReason || 'Retry budget exhausted.',
        manualActionRequired: true,
      });
    }
    if (sessionLimitReached) {
      for (const pending of plan.actions.slice(actionIndex + 1)) {
        unresolvedFields.push({
          fieldId: pending.fieldId,
          stableFieldId: pending.stableFieldId,
          label: pending.label,
          category: pending.category,
          semantic: pending.semantic,
          reason: 'Whole form-filling session time limit reached.',
          manualActionRequired: true,
        });
      }
      break;
    }
  }
  return {
    completed,
    uploadedArtifacts,
    committedSelections,
    unresolvedFields,
    attemptLedger,
    timeLimits: effectiveLimits,
    sessionLimitReached,
  };
}

export async function executeOperationalFormPlan(page, plan, options = {}) {
  await installSubmissionGuard(page);
  try {
    return await executeOperationalFormPlanGuarded(page, plan, options);
  } finally {
    await removeOperationalSubmissionGuard(page);
  }
}

function requiredEmpty(field) {
  return field.visible !== false && field.required && !field.disabled
    && !cleanFormText(field.value) && !field.checked && !(field.files || []).length;
}

export async function reviewOperationalApplicationForm(page, profile, artifacts, execution, {
  context = {},
  previousEvidence = null,
  passId,
  resumeMode = 'initial',
} = {}) {
  const snapshot = await inspectOperationalApplicationForm(page);
  const submissionGuardActiveAtHandoff = await page.evaluate(
    () => Boolean(globalThis.__careerOpsOperationalGuard),
  ).catch(() => null);
  const plan = buildOperationalFormPlan(snapshot, profile, artifacts, { context, previousEvidence });
  const requiredMissing = snapshot.fields.filter(requiredEmpty).map((field) => {
    const semantics = classifyFieldSemantics(field);
    return manualField(field, semantics, 'Required field remains empty.');
  });
  const unresolvedFields = dedupeRows([
    ...plan.unresolvedFields,
    ...(execution.unresolvedFields || []),
    ...requiredMissing,
  ]);
  const finalAction = {
    detected: plan.finalActions.length > 0,
    label: plan.finalActions.map((item) => item.label).join(' | ') || null,
    semanticClass: plan.finalActions.map((item) => item.semanticClass).join(' | ') || null,
    activated: snapshot.submitAttempts > 0,
  };
  const answerRecords = dedupeRows([
    ...(previousEvidence?.answerRecords || []),
    ...(plan.answerRecords || []),
  ].map((row) => ({ ...row, stableFieldId: row.normalizedQuestion })));
  const userActionRequired = snapshot.loginGate || snapshot.captcha.manualActionRequired || unresolvedFields.length > 0;
  const evidence = {
    schemaVersion: 2,
    passId,
    resumeMode,
    inspectedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    currentUrl: snapshot.url,
    formFingerprint: digest(snapshot.fields.map((field) => ({
      stableFieldId: stableFieldIdentity(field, classifyFieldSemantics(field)),
      label: fieldQuestion(field),
      type: field.type,
      required: field.required,
    }))),
    requiredFieldCount: snapshot.fields.filter((field) => field.visible !== false && field.required).length,
    filledFields: execution.completed || [],
    committedSelections: execution.committedSelections || [],
    uploadedArtifacts: execution.uploadedArtifacts || [],
    unresolvedFields,
    validationErrors: snapshot.validationErrors,
    attemptLedger: execution.attemptLedger || previousEvidence?.attemptLedger || [],
    answerRecords: answerRecords.map(({ stableFieldId, ...row }) => row),
    userActionRequired,
    browserOpenRequired: userActionRequired,
    captcha: snapshot.captcha,
    finalAction,
    uploadTopology: plan.uploadTopology,
    passBudget: {
      fullPassesUsed: 1,
      fullPassesAllowed: 1,
      artifactRevisionReset: Boolean(previousEvidence?.passBudget?.artifactRevisionReset),
      controlledResumeUsed: resumeMode === 'initial'
        ? 0
        : Number(previousEvidence?.passBudget?.controlledResumeUsed || 0) + 1,
      controlledResumeAllowed: MAX_CONTROLLED_RESUMES,
      perFieldAttemptsAllowed: MAX_FIELD_ATTEMPTS,
      timeLimits: execution.timeLimits || DEFAULT_LIVE_FORM_LIMITS,
      sessionLimitReached: Boolean(execution.sessionLimitReached),
      precomputedNarrativeCount: Number(execution.precomputedNarrativeCount || 0),
    },
    browserSession: {
      ownership: 'task_created',
      manualContinuation: resumeMode !== 'process_recovery',
      processRecovery: resumeMode === 'process_recovery',
      keepOpenRequired: userActionRequired,
    },
    operationalArtifacts: {
      screenshotBefore: null,
      screenshotAfter: null,
      trace: null,
      uploadTopologyBefore: null,
      uploadTopologyAfter: plan.uploadTopology,
      submissionGuardActiveAtHandoff,
      phoneControls: snapshot.fields
        .map((field) => ({ field, semantics: classifyFieldSemantics(field) }))
        .filter(({ field, semantics }) => field.type === 'tel' || ['phone', 'phone_country', 'phone_dial_code'].includes(semantics.semantic))
        .map(({ field, semantics }) => ({
          fieldId: field.fieldId,
          id: field.id,
          name: field.name,
          tag: field.tag,
          type: field.type,
          role: field.role,
          label: field.label,
          groupLabel: field.groupLabel,
          questionText: field.questionText,
          semantic: semantics.semantic,
          value: field.value,
          selectedLabel: field.selectedLabel,
        })),
    },
    reviewComplete: !userActionRequired && !snapshot.validationErrors.length && finalAction.detected && !finalAction.activated,
  };
  evidence.evidenceHash = digest(evidence);
  return { snapshot, plan, evidence };
}

export function attachOperationalArtifacts(preparation, artifacts = {}) {
  const evidence = {
    ...preparation.evidence,
    operationalArtifacts: {
      ...preparation.evidence.operationalArtifacts,
      ...artifacts,
    },
  };
  evidence.evidenceHash = digest({ ...evidence, evidenceHash: undefined });
  return { ...preparation, evidence };
}

export async function prepareOperationalApplicationForm(page, profile, artifacts, {
  context = {},
  previousEvidence = null,
  resumeMode = 'initial',
  passId = `pass-${Date.now()}`,
  limits = null,
  clock = () => Date.now(),
  performActionImpl = performAction,
} = {}) {
  const effectiveLimits = resolveOperationalFormLimits(profile, limits || {});
  const sessionDeadlineMs = clock() + effectiveLimits.sessionMs;
  const currentArtifactHashes = new Set([
    artifacts?.cv?.sha256,
    artifacts?.coverLetter?.sha256,
    artifacts?.combinedDocument?.sha256,
  ].filter(Boolean));
  const priorUploads = Array.isArray(previousEvidence?.uploadedArtifacts) ? previousEvidence.uploadedArtifacts : [];
  const artifactSetChanged = priorUploads.some((upload) => upload?.sha256 && !currentArtifactHashes.has(upload.sha256));
  const effectivePreviousEvidence = artifactSetChanged
    ? {
      ...previousEvidence,
      uploadedArtifacts: priorUploads.filter((upload) => currentArtifactHashes.has(upload?.sha256)),
      passBudget: {
        ...(previousEvidence?.passBudget || {}),
        controlledResumeUsed: 0,
        artifactRevisionReset: true,
      },
    }
    : previousEvidence;
  if (resumeMode !== 'initial'
      && Number(effectivePreviousEvidence?.passBudget?.controlledResumeUsed || 0) >= MAX_CONTROLLED_RESUMES) {
    const snapshot = await inspectOperationalApplicationForm(page);
    const evidence = {
      ...effectivePreviousEvidence,
      schemaVersion: 2,
      passId,
      resumeMode,
      reviewedAt: new Date().toISOString(),
      currentUrl: snapshot.url,
      unresolvedFields: dedupeRows([
        ...(effectivePreviousEvidence.unresolvedFields || []),
        {
          fieldId: 'form',
          stableFieldId: 'form',
          category: 'unknown',
          semantic: 'retry_budget',
          reason: 'Candidate-wide controlled resume budget is exhausted.',
          manualActionRequired: true,
        },
      ]),
      userActionRequired: true,
      browserOpenRequired: true,
      reviewComplete: false,
    };
    evidence.evidenceHash = digest({ ...evidence, evidenceHash: undefined });
    return {
      snapshot,
      plan: { actions: [], unresolvedFields: evidence.unresolvedFields, finalActions: [], uploadTopology: effectivePreviousEvidence.uploadTopology },
      evidence,
      gate: { state: 'review_required', reason: 'Controlled resume budget is exhausted; finish unresolved fields manually.' },
    };
  }

  const snapshot = await inspectOperationalApplicationForm(page);
  const gate = classifyUserGate(snapshot);
  const emptyExecution = {
    completed: [],
    uploadedArtifacts: [],
    committedSelections: [],
    unresolvedFields: [],
    attemptLedger: effectivePreviousEvidence?.attemptLedger || [],
    timeLimits: effectiveLimits,
    sessionLimitReached: false,
    precomputedNarrativeCount: 0,
  };
  if (gate) {
    const reviewed = await reviewOperationalApplicationForm(page, profile, artifacts, emptyExecution, {
      context, previousEvidence: effectivePreviousEvidence, passId, resumeMode,
    });
    return { gate, ...reviewed };
  }

  const plan = buildOperationalFormPlan(snapshot, profile, artifacts, { context, previousEvidence: effectivePreviousEvidence });
  plan.formFingerprint = digest(snapshot.fields.map((field) => stableFieldIdentity(field, classifyFieldSemantics(field))));
  plan.actions = plan.actions.map((action) => ({
    ...action,
    batchId: context.batchId || null,
    candidateId: context.candidate?.candidate_id || null,
  }));
  const execution = await executeOperationalFormPlan(page, plan, {
    previousEvidence: effectivePreviousEvidence,
    clock,
    limits: effectiveLimits,
    sessionDeadlineMs,
    performActionImpl,
  });
  execution.precomputedNarrativeCount = plan.answerRecords.length;
  execution.completed.unshift(...plan.preservedFields.filter((row) => !execution.completed.some((item) => item.stableFieldId === row.stableFieldId)));
  execution.uploadedArtifacts.unshift(...plan.preservedUploads.filter((row) => !execution.uploadedArtifacts.some((item) => item.sha256 === row.sha256)));
  const reviewed = await reviewOperationalApplicationForm(page, profile, artifacts, execution, {
    context, previousEvidence: effectivePreviousEvidence, passId, resumeMode,
  });
  if (reviewed.evidence.captcha.manualActionRequired) {
    return {
      ...reviewed,
      gate: {
        state: 'review_required',
        reason: `CAPTCHA remains for manual completion after one controlled form pass (${reviewed.evidence.captcha.classification}).`,
      },
    };
  }
  if (reviewed.evidence.unresolvedFields.length || reviewed.evidence.validationErrors.length) {
    return {
      ...reviewed,
      gate: {
        state: 'review_required',
        reason: 'One controlled pass completed; unresolved fields require manual review without restarting the form.',
      },
    };
  }
  return reviewed;
}

export {
  classifyCaptchaState,
  classifyFieldSemantics,
  classifyUserGate,
  isSemanticFinalAction,
};
