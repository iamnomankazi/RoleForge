import { createHash } from 'node:crypto';
import { answerBankMatch, groundedFieldValue } from './application-profile.mjs';

const FINAL_WORDS = /\b(submit|send|complete application|finish|confirm application|finali[sz]e)\b/i;
const LOGIN_WORDS = /\b(sign in|log in|create account|verify email|one[- ]time code|mfa|two[- ]factor)\b/i;
const LEGAL_WORDS = /\b(certify|declare|privacy|terms|accurate|truthful|consent|signature|background check|data processing)\b/i;
const CAPTCHA_SIGNAL_WORDS = /\b(captcha|recaptcha|hcaptcha|turnstile|are you human|human verification)\b/i;

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function classifyCaptchaState(signals = {}) {
  const elements = Array.isArray(signals.elements) ? signals.elements : [];
  const signalText = clean([
    signals.bodySignalText,
    ...elements.flatMap((element) => [element.kind, element.src, element.title, element.text, element.identity]),
  ].join(' ')).toLowerCase();
  const type = /hcaptcha/.test(signalText) ? 'hcaptcha'
    : /turnstile|challenges\.cloudflare/.test(signalText) ? 'turnstile'
      : /recaptcha|g-recaptcha/.test(signalText) ? 'recaptcha'
        : signals.present ? 'generic' : 'none';
  const present = Boolean(signals.present || elements.length || signals.scriptCount || signals.textSignal);
  const completed = Boolean(signals.completed);
  const visibleChallenge = elements.some((element) => element.visible && element.interactive);
  const blockingOverlay = elements.some((element) => element.visible && element.blockingOverlay);
  const totalFields = Number(signals.totalNormalFields || 0);
  const accessibleFields = Number(signals.accessibleNormalFields || 0);
  const requiredDisabledFields = Number(signals.requiredDisabledFields || 0);
  const formInaccessible = totalFields > 0 && accessibleFields === 0;

  if (!present) {
    return {
      classification: 'absent',
      type: 'none',
      present: false,
      completed: false,
      manualActionRequired: false,
      formAccessible: accessibleFields > 0,
      observedBlockingStatus: 'not_present',
      evidence: { visibleChallenge: false, blockingOverlay: false, totalFields, accessibleFields, requiredDisabledFields },
    };
  }

  let classification;
  let observedBlockingStatus;
  if (blockingOverlay || formInaccessible) {
    classification = 'active_blocking';
    observedBlockingStatus = blockingOverlay ? 'challenge_overlay_blocks_form'
      : 'normal_form_controls_inaccessible';
  } else if (visibleChallenge && accessibleFields > 0) {
    classification = 'active_non_blocking';
    observedBlockingStatus = 'visible_challenge_does_not_block_accessible_fields';
  } else if ((signals.scriptCount || elements.length) && !visibleChallenge && accessibleFields > 0) {
    classification = 'passive_invisible';
    observedBlockingStatus = 'captcha_present_without_visible_blocking_challenge';
  } else {
    classification = 'uncertain';
    observedBlockingStatus = 'captcha_signal_cannot_be_classified_safely';
  }

  return {
    classification,
    type,
    present: true,
    completed,
    manualActionRequired: !completed,
    formAccessible: accessibleFields > 0 && !blockingOverlay,
    observedBlockingStatus,
    evidence: {
      visibleChallenge,
      blockingOverlay,
      totalFields,
      accessibleFields,
      requiredDisabledFields,
      scriptCount: Number(signals.scriptCount || 0),
      elementCount: elements.length,
      textSignal: Boolean(signals.textSignal),
    },
  };
}

export function isSemanticFinalAction(control) {
  const label = clean(`${control?.label || ''} ${control?.text || ''} ${control?.value || ''}`);
  return control?.type === 'submit'
    || Boolean(control?.formAction)
    || (Boolean(control?.insideApplicationForm) && FINAL_WORDS.test(label))
    || Boolean(control?.invokesSubmit);
}

export function classifyField(field) {
  const label = clean(`${field.label || ''} ${field.name || ''} ${field.placeholder || ''}`).toLowerCase();
  if (field.type === 'file') {
    if (/cover|motivation|application letter|supporting statement/.test(label)) return 'cover_letter_upload';
    if (/resume|résumé|cv|curriculum/.test(label)) return 'cv_upload';
    if (/application documents?|application materials?|cv\s*(?:and|\+)\s*cover|resume\s*(?:and|\+)\s*cover|combined application/.test(label)) return 'single_document_upload';
    return 'unknown_upload';
  }
  if (LEGAL_WORDS.test(label) || /data notice|privacy notice/.test(label)) return 'legal_consent';
  if (/first.?name|given.?name/.test(label)) return 'first_name';
  if (/last.?name|family.?name|surname/.test(label)) return 'last_name';
  if (/full.?name|your name|candidate name/.test(label)) return 'full_name';
  if (/e-?mail/.test(label)) return 'email';
  if (/phone country|country code/.test(label)) return 'phone_country';
  if (/phone|mobile|telephone/.test(label)) return 'phone';
  if (/linkedin/.test(label)) return 'linkedin';
  if (/github/.test(label)) return 'github';
  if (/portfolio|website|personal site/.test(label)) return 'website';
  if (/how did you hear|where did you hear|application source|referral source/.test(label)) return 'application_source';
  if (/sponsor|employer support|support from (?:the )?employer|immigration support|visa support/.test(label)) return 'sponsorship';
  if (/work authori[sz](?:ation|ed)?|authori[sz]ed to work|eligible to work|right to work|legally authori[sz](?:ed)?/.test(label)) return 'work_authorization';
  if (/current location|\blocation\b/.test(label)) return 'current_location';
  if (/city|municipality/.test(label)) return 'city';
  if (/country/.test(label)) return 'country';
  if (/university|school|institution/.test(label)) return 'university';
  if (/degree|qualification/.test(label)) return 'degree';
  if (/graduat/.test(label)) return 'graduation';
  if (/available|start date|notice period/.test(label)) return 'availability';
  if (/relocat/.test(label)) return 'relocation';
  if (/salary|compensation|pay expectation/.test(label)) return 'salary';
  if (/cover letter|motivation letter|supporting statement/.test(label) && field.tag === 'textarea') return 'cover_letter_text';
  if (field.type === 'checkbox' || field.type === 'radio') return LEGAL_WORDS.test(label) ? 'legal_consent' : 'choice';
  if (['textarea', 'text'].includes(field.type) || field.tag === 'textarea') return 'free_text';
  return 'unknown';
}

export function inspectUploadTopology(snapshot) {
  const uploads = (snapshot.fields || []).filter((field) => field.visible !== false && !field.disabled && field.type === 'file');
  const semantics = uploads.map((field) => ({ fieldId: field.fieldId, label: field.label, semantic: classifyField(field) }));
  const cv = semantics.filter((row) => row.semantic === 'cv_upload');
  const cover = semantics.filter((row) => row.semantic === 'cover_letter_upload');
  const combined = semantics.filter((row) => row.semantic === 'single_document_upload');
  const unknown = semantics.filter((row) => row.semantic === 'unknown_upload');
  let mode = 'none';
  let reason = 'No visible document upload fields.';
  if (cv.length && cover.length && !combined.length && !unknown.length) {
    mode = 'separate'; reason = 'Separate CV and cover-letter upload fields are available.';
  } else if (uploads.length === 1 && combined.length === 1) {
    mode = 'single_combined'; reason = 'Exactly one field explicitly requests combined application documents.';
  } else if (uploads.length) {
    mode = 'ambiguous'; reason = 'Document upload purpose or topology is ambiguous; no combined upload is allowed.';
  }
  return { mode, reason, fields: semantics };
}

function selectArtifact(artifacts, semantic) {
  if (semantic === 'cv_upload') return artifacts.cv || null;
  if (semantic === 'cover_letter_upload') return artifacts.coverLetter || null;
  if (semantic === 'single_document_upload') return artifacts.combinedDocument || null;
  return null;
}

function dropdownValue(semantic, profile) {
  if (semantic === 'phone_country') return 'Finland';
  if (semantic === 'country') return profile.location.country || 'Finland';
  if (semantic === 'sponsorship') return groundedFieldValue(profile, semantic, { country: profile.location.country });
  return groundedFieldValue(profile, semantic);
}

export function buildFormPlan(snapshot, profile, artifacts) {
  const actions = [];
  const unresolvedFields = [];
  for (const field of snapshot.fields.filter((item) => item.visible !== false && !item.disabled)) {
    const semantic = classifyField(field);
    if (semantic === 'legal_consent') {
      unresolvedFields.push({ fieldId: field.fieldId, label: field.label, semantic, reason: 'Explicit user approval is required for this declaration.' });
      continue;
    }
    if (semantic.endsWith('_upload')) {
      const artifact = selectArtifact(artifacts, semantic);
      if (!artifact) {
        if (field.required) unresolvedFields.push({ fieldId: field.fieldId, label: field.label, semantic, reason: 'Required exact bound artifact is unavailable.' });
        continue;
      }
      actions.push({ fieldId: field.fieldId, id: field.id, label: field.label, name: field.name, semantic, action: 'upload', artifact });
      continue;
    }
    let value;
    if (semantic === 'cover_letter_text') value = artifacts.coverLetterTextContent || null;
    else if (semantic === 'free_text') value = answerBankMatch(profile, field.label);
    else if (['phone_country', 'country', 'sponsorship', 'work_authorization', 'relocation'].includes(semantic)) value = dropdownValue(semantic, profile);
    else value = groundedFieldValue(profile, semantic);

    if (!value) {
      if (field.required) unresolvedFields.push({ fieldId: field.fieldId, label: field.label, semantic, reason: 'No grounded canonical answer is available.' });
      continue;
    }
    if (semantic === 'phone' && snapshot.fields.some((item) => classifyField(item) === 'phone_country')) {
      value = clean(value).replace(/^\+?358[\s-]*/, '');
    }
    const optionLabels = (field.options || []).flatMap((option) => [option.label, option.value]).map((item) => clean(item).toLowerCase());
    if (semantic === 'work_authorization' && (
      optionLabels.some((item) => /^(yes|no)$/.test(item))
      || field.role === 'combobox'
      || field.autocomplete === 'list'
    )) {
      value = String(profile.location.country || '').toLowerCase() === 'finland' ? 'Yes' : 'No';
    }
    const control = field.tag === 'select' ? 'select'
      : (field.role === 'combobox' || field.autocomplete === 'list') ? 'autocomplete'
        : (field.type === 'checkbox' || field.type === 'radio') ? 'choice' : 'fill';
    actions.push({
      fieldId: field.fieldId,
      id: field.id,
      label: field.label,
      name: field.name,
      semantic,
      action: control,
      value: clean(value),
      valueHash: digest(clean(value)),
      sourceRef: semantic === 'free_text' ? 'output/application-answer-bank.md' : 'config/profile.yml',
    });
  }
  const finalActions = snapshot.controls.filter(isSemanticFinalAction).map((control) => ({
    label: control.label || control.text || control.value || '(unlabelled submit control)',
    semanticClass: control.type === 'submit' ? 'form_submit' : 'terminal_action',
  }));
  const uploadTopology = inspectUploadTopology(snapshot);
  if (uploadTopology.mode === 'ambiguous') {
    for (const row of uploadTopology.fields) {
      if (!unresolvedFields.some((field) => field.fieldId === row.fieldId)) unresolvedFields.push({ ...row, reason: uploadTopology.reason });
    }
  }
  return { actions, unresolvedFields, finalActions, uploadTopology, snapshotHash: digest(snapshot) };
}

export async function inspectApplicationForm(page) {
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
    };
    const textFor = (element) => {
      const labels = element.labels ? [...element.labels].map((label) => label.innerText) : [];
      const aria = element.getAttribute('aria-label') || '';
      const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText || '').join(' ');
      return [...labels, aria, labelled, element.placeholder || '', element.name || '', element.id || '']
        .join(' ').replace(/\s+/g, ' ').trim();
    };
    let counter = 0;
    const fields = [...document.querySelectorAll('input, textarea, select, [role="combobox"]')]
      .filter((element) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((element.type || '').toLowerCase()))
      .map((element) => {
        const fieldId = element.getAttribute('data-career-ops-field-id') || `field-${++counter}`;
        element.setAttribute('data-career-ops-field-id', fieldId);
        return {
          fieldId,
          id: element.id || '',
          tag: element.tagName.toLowerCase(),
          type: (element.type || element.tagName).toLowerCase(),
          role: element.getAttribute('role') || '',
          name: element.getAttribute('name') || '',
          label: textFor(element),
          placeholder: element.getAttribute('placeholder') || '',
          required: element.required || element.getAttribute('aria-required') === 'true',
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
          visible: visible(element),
          autocomplete: element.getAttribute('aria-autocomplete') || element.getAttribute('autocomplete') || '',
          value: element.value || '',
          checked: Boolean(element.checked),
          files: element.files ? [...element.files].map((file) => file.name) : [],
          options: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value })) : [],
        };
      });
    const controls = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')]
      .filter(visible)
      .map((element) => ({
        label: textFor(element),
        text: element.innerText || '',
        value: element.value || '',
        type: (element.type || '').toLowerCase(),
        formAction: element.getAttribute('formaction') || '',
        insideApplicationForm: Boolean(element.closest('form')),
        invokesSubmit: Boolean(element.getAttribute('onclick')?.match(/submit|requestSubmit/i)),
      }));
    const bodyText = document.body?.innerText || '';
    const validationErrors = [...document.querySelectorAll('[role="alert"], .error, .validation-error, [aria-invalid="true"]')]
      .filter(visible).map((element) => (element.innerText || element.getAttribute('aria-label') || '').trim()).filter(Boolean);
    const captchaSelector = [
      'iframe[src*="captcha" i]', 'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]',
      'iframe[src*="turnstile" i]', 'iframe[src*="challenges.cloudflare" i]',
      '[class*="captcha" i]', '[id*="captcha" i]', '[class*="turnstile" i]', '[id*="turnstile" i]',
      '[data-sitekey]', '[aria-label*="captcha" i]', '[title*="captcha" i]',
    ].join(',');
    const captchaElements = [...new Set([...document.querySelectorAll(captchaSelector)])];
    const normalElements = [...document.querySelectorAll('input, textarea, select, [role="combobox"]')]
      .filter((element) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((element.type || '').toLowerCase()))
      .filter((element) => !element.closest(captchaSelector));
    const captchaElementsEvidence = captchaElements.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const isVisible = visible(element);
      const identity = `${element.id || ''} ${element.className || ''}`;
      const src = element.getAttribute('src') || '';
      const title = element.getAttribute('title') || element.getAttribute('aria-label') || '';
      const text = (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const interactive = isVisible && (
        element.tagName === 'IFRAME'
        || Boolean(element.querySelector('iframe, input, button, [role="checkbox"], [tabindex]:not([tabindex="-1"])'))
        || /challenge|checkbox|verify|human/i.test(`${title} ${text}`)
      );
      const interceptsField = isVisible && normalElements.some((field) => {
        if (!visible(field) || field.disabled || field.getAttribute('aria-disabled') === 'true') return false;
        const fieldRect = field.getBoundingClientRect();
        const x = Math.max(0, Math.min(innerWidth - 1, fieldRect.left + fieldRect.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, fieldRect.top + fieldRect.height / 2));
        const top = document.elementFromPoint(x, y);
        return Boolean(top && (element === top || element.contains(top) || top.contains(element)));
      });
      const fixedOverlay = isVisible
        && ['fixed', 'sticky'].includes(style.position)
        && rect.width >= innerWidth * 0.5
        && rect.height >= innerHeight * 0.5
        && style.pointerEvents !== 'none';
      const modalAncestor = element.closest('[role="dialog"], [aria-modal="true"]');
      return {
        kind: element.tagName.toLowerCase(),
        identity,
        src,
        title,
        text,
        visible: isVisible,
        interactive,
        blockingOverlay: Boolean(interceptsField || fixedOverlay || (modalAncestor && visible(modalAncestor))),
      };
    });
    const captchaScripts = [...document.scripts].filter((script) => (
      /captcha|recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(`${script.src || ''} ${script.textContent || ''}`)
    ));
    const captchaResponse = [...document.querySelectorAll(
      'textarea[name*="captcha" i], input[name*="captcha" i], input[name*="turnstile" i], textarea[name*="turnstile" i]',
    )].some((element) => String(element.value || '').trim().length > 0);
    const accessibleNormalFields = normalElements.filter((element) => (
      visible(element)
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
      && Number(element.tabIndex) >= 0
    )).length;
    const requiredDisabledFields = normalElements.filter((element) => (
      (element.required || element.getAttribute('aria-required') === 'true')
      && (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true')
    )).length;
    const bodySignalText = (bodyText.match(/.{0,80}(?:captcha|recaptcha|hcaptcha|turnstile|are you human|human verification).{0,80}/ig) || [])
      .join(' ').slice(0, 500);
    const textSignal = /\b(captcha|recaptcha|hcaptcha|turnstile|are you human|human verification)\b/i.test(bodyText);
    return {
      url: location.href,
      title: document.title,
      bodyText,
      fields,
      controls,
      validationErrors,
      loginGate: /sign in|log in|create account|verify email|one-time code|two-factor|mfa/i.test(bodyText)
        || Boolean(document.querySelector('input[type="password"]')),
      captchaSignals: {
        present: Boolean(captchaScripts.length || captchaElementsEvidence.length || textSignal),
        completed: captchaResponse,
        scriptCount: captchaScripts.length,
        textSignal,
        bodySignalText,
        elements: captchaElementsEvidence,
        totalNormalFields: normalElements.length,
        accessibleNormalFields,
        requiredDisabledFields,
      },
      submitAttempts: Number(globalThis.__careerOpsSubmitAttempts || 0),
    };
  });
  return { ...snapshot, captcha: classifyCaptchaState(snapshot.captchaSignals) };
}

async function installSubmissionGuard(page) {
  await page.evaluate(() => {
    if (globalThis.__careerOpsSubmissionGuardInstalled) return;
    globalThis.__careerOpsSubmissionGuardInstalled = true;
    globalThis.__careerOpsSubmitAttempts = 0;
    const block = (event) => {
      globalThis.__careerOpsSubmitAttempts += 1;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      throw new Error('Career-Ops blocked a final form submission attempt');
    };
    document.addEventListener('submit', block, true);
    HTMLFormElement.prototype.submit = function guardedSubmit() { block(); };
    HTMLFormElement.prototype.requestSubmit = function guardedRequestSubmit() { block(); };
  });
}

async function exactLocator(page, action) {
  let locator;
  if (action.id) {
    locator = page.locator(`[id="${action.id.replace(/"/g, '\\"')}"]`).first();
    if (await locator.count()) return locator;
  }
  if (action.name) {
    locator = page.locator(`[name="${action.name.replace(/"/g, '\\"')}"]`).first();
    if (await locator.count()) return locator;
  }
  if (action.label) {
    locator = page.getByLabel(action.label, { exact: true }).first();
    if (await locator.count()) return locator;
  }
  locator = page.locator(`[data-career-ops-field-id="${action.fieldId.replace(/"/g, '\\"')}"]`).first();
  if (await locator.count()) return locator;
  throw new Error(`Form control changed and could not be reacquired: ${action.semantic}`);
}

export async function executeFormPlan(page, plan) {
  await installSubmissionGuard(page);
  const completed = [];
  const uploadedArtifacts = [];
  const committedSelections = [];
  const unresolvedFields = [];
  for (const action of plan.actions) {
    const locator = await exactLocator(page, action);
    if (isSemanticFinalAction(await locator.evaluate((element) => ({
      type: element.type,
      formAction: element.getAttribute('formaction'),
      insideApplicationForm: Boolean(element.closest('form')),
      label: element.getAttribute('aria-label') || element.innerText || element.value,
    })))) throw new Error('Refusing to interact with a final-action control');
    try {
      if (action.action === 'upload') {
        await locator.setInputFiles(action.artifact.resolvedPath);
        await page.waitForFunction(
          (filename) => (document.body?.innerText || '').includes(filename),
          action.artifact.intendedFilename,
          { timeout: 10000 },
        );
        const visibleText = await page.locator('body').innerText();
        if (!visibleText.includes(action.artifact.intendedFilename)) {
          throw new Error(`Uploaded filename is not visibly confirmed by the form: ${action.artifact.intendedFilename}`);
        }
        uploadedArtifacts.push({ semantic: action.semantic, filename: action.artifact.intendedFilename, sha256: action.artifact.sha256 });
      } else if (action.action === 'select') {
        const selected = await locator.evaluate((element, intended) => {
          const option = [...element.options].find((item) => item.textContent.trim().toLowerCase() === intended.toLowerCase()
            || item.value.toLowerCase() === intended.toLowerCase());
          return option ? { value: option.value, label: option.textContent.trim() } : null;
        }, action.value);
        if (!selected) throw new Error(`No exact dropdown option for ${action.value}`);
        await locator.selectOption(selected.value);
        await locator.blur();
        if (await locator.inputValue() !== selected.value) throw new Error(`Dropdown selection did not remain committed: ${action.value}`);
        committedSelections.push({ semantic: action.semantic, valueHash: action.valueHash, label: selected.label });
      } else if (action.action === 'autocomplete') {
        await locator.fill(action.value);
        let option = page.getByRole('option', { name: action.value, exact: true }).first();
        if (!await option.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
          const shorter = clean(action.value).split(',')[0];
          if (shorter && shorter.toLowerCase() !== action.value.toLowerCase()) {
            await locator.fill(shorter);
            option = page.getByRole('option', { name: new RegExp(`^${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }).first();
          }
        }
        if (!await option.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
          throw new Error(`Autocomplete has no grounded visible option: ${action.value}`);
        }
        await option.click();
        await locator.blur();
        const committed = clean(await locator.inputValue());
        const intended = clean(action.value).toLowerCase();
        const city = intended.split(',')[0];
        if (committed.toLowerCase() !== intended && !committed.toLowerCase().startsWith(city)) {
          throw new Error(`Autocomplete selection was not committed: ${action.value}`);
        }
        committedSelections.push({ semantic: action.semantic, valueHash: action.valueHash, label: committed });
      } else if (action.action === 'choice') {
        throw new Error(`Choice control requires review: ${action.semantic}`);
      } else {
        await locator.fill(action.value);
        await locator.blur();
        if (clean(await locator.inputValue()) !== action.value) throw new Error(`Field value did not remain committed: ${action.semantic}`);
      }
      completed.push({ fieldId: action.fieldId, semantic: action.semantic, valueHash: action.valueHash || action.artifact.sha256 });
    } catch (error) {
      if (action.action === 'autocomplete') await locator.fill('').catch(() => {});
      unresolvedFields.push({
        fieldId: action.fieldId,
        label: action.label,
        semantic: action.semantic,
        reason: clean(error.message),
      });
    }
  }
  return { completed, uploadedArtifacts, committedSelections, unresolvedFields };
}

export async function reviewApplicationForm(page, profile, artifacts, execution) {
  const snapshot = await inspectApplicationForm(page);
  const plan = buildFormPlan(snapshot, profile, artifacts);
  const requiredMissing = snapshot.fields.filter((field) => field.visible !== false && field.required && !field.disabled
    && !clean(field.value) && !field.checked && !field.files.length)
    .map((field) => ({ fieldId: field.fieldId, label: field.label, semantic: classifyField(field), reason: 'Required field remains empty.' }));
  const unresolvedFields = [...plan.unresolvedFields, ...(execution.unresolvedFields || []), ...requiredMissing];
  const finalAction = {
    detected: plan.finalActions.length > 0,
    label: plan.finalActions.map((item) => item.label).join(' | ') || null,
    semanticClass: plan.finalActions.map((item) => item.semanticClass).join(' | ') || null,
    activated: snapshot.submitAttempts > 0,
  };
  const userActionRequired = snapshot.loginGate || snapshot.captcha.manualActionRequired || unresolvedFields.length > 0;
  const evidence = {
    schemaVersion: 1,
    inspectedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    currentUrl: snapshot.url,
    formFingerprint: digest(snapshot.fields.map((field) => ({ label: field.label, type: field.type, required: field.required }))),
    requiredFieldCount: snapshot.fields.filter((field) => field.visible !== false && field.required).length,
    filledFields: execution.completed,
    committedSelections: execution.committedSelections,
    uploadedArtifacts: execution.uploadedArtifacts,
    unresolvedFields,
    validationErrors: snapshot.validationErrors,
    userActionRequired,
    captcha: snapshot.captcha,
    finalAction,
    uploadTopology: plan.uploadTopology,
    reviewComplete: !userActionRequired && !snapshot.validationErrors.length && finalAction.detected && !finalAction.activated,
  };
  evidence.evidenceHash = digest(evidence);
  return { snapshot, plan, evidence };
}

export async function prepareApplicationForm(page, profile, artifacts, { maxPasses = 4 } = {}) {
  const aggregate = { completed: [], uploadedArtifacts: [], committedSelections: [], unresolvedFields: [] };
  const completedIds = new Set();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const snapshot = await inspectApplicationForm(page);
    const gate = classifyUserGate(snapshot);
    if (gate) return { gate, ...(await reviewApplicationForm(page, profile, artifacts, aggregate)) };
    const plan = buildFormPlan(snapshot, profile, artifacts);
    const pending = { ...plan, actions: plan.actions.filter((action) => !completedIds.has(action.fieldId)) };
    if (!pending.actions.length) break;
    const result = await executeFormPlan(page, pending);
    for (const row of result.completed) {
      completedIds.add(row.fieldId);
      aggregate.completed.push(row);
    }
    for (const row of result.unresolvedFields) completedIds.add(row.fieldId);
    aggregate.uploadedArtifacts.push(...result.uploadedArtifacts);
    aggregate.committedSelections.push(...result.committedSelections);
    aggregate.unresolvedFields.push(...result.unresolvedFields);
  }
  const reviewed = await reviewApplicationForm(page, profile, artifacts, aggregate);
  if (reviewed.evidence.captcha.manualActionRequired) {
    return {
      ...reviewed,
      gate: {
        state: 'review_required',
        reason: `CAPTCHA remains for manual completion after safe form preparation (${reviewed.evidence.captcha.classification}).`,
      },
    };
  }
  return reviewed;
}

export function classifyUserGate(snapshot) {
  if (snapshot.loginGate || LOGIN_WORDS.test(snapshot.bodyText || '')) return { state: 'login_required', reason: 'Login, account, MFA, or email-verification gate requires user action.' };
  const captcha = snapshot.captcha || classifyCaptchaState({
    present: CAPTCHA_SIGNAL_WORDS.test(snapshot.bodyText || ''),
    textSignal: CAPTCHA_SIGNAL_WORDS.test(snapshot.bodyText || ''),
    bodySignalText: snapshot.bodyText || '',
    totalNormalFields: snapshot.fields?.length || 0,
    accessibleNormalFields: (snapshot.fields || []).filter((field) => field.visible !== false && !field.disabled).length,
  });
  if (captcha.completed || !captcha.present) return null;
  if (captcha.classification === 'active_blocking') {
    return {
      state: 'blocked',
      reason: `Active CAPTCHA blocks safe form access: ${captcha.observedBlockingStatus}.`,
    };
  }
  if (captcha.classification === 'uncertain') {
    return {
      state: 'review_required',
      reason: 'CAPTCHA state cannot be classified safely before form interaction.',
    };
  }
  return null;
}
