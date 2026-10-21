import { createHash } from 'node:crypto';
import { groundedFieldValue } from './application-profile.mjs';
import { classifyFieldSemantics } from './application-form-policy.mjs';
import { validateNarrativeProvenanceRecord } from './application-evidence.mjs';

export const FINAL_TOKEN = /(?:^|[^\p{L}\p{N}_])(?:apply|submit|send|complete|finish|finali[sz]e|confirm|absenden|senden|bewerben|abschicken|verzenden|versturen|solliciteren|indsend|ansøg|lähetä|hae|valmis|skicka|ansök|envoyer|postuler|soumettre|valider)(?=$|[^\p{L}\p{N}_])/iu;
export const PROGRESSION_ACTION_LABEL = /^(?:next|continue|save (?:and|&) continue|proceed|continue application|review application|seuraava|jatka|nästa|fortsätt|volgende|doorgaan|næste|fortsæt|weiter)$/i;
const LOGIN_WORDS = /\b(sign in to apply|log in to apply|login to apply|create an account to apply|sign in or create|login or register|verify (?:your )?email|one[- ]time code|mfa|two[- ]factor)\b/i;
const LEGAL_WORDS = /\b(certify|declare|privacy|terms|accurate|truthful|consent|signature|background check|data processing)\b/i;
const CAPTCHA_SIGNAL_WORDS = /\b(captcha|recaptcha|hcaptcha|turnstile|are you human|human verification)\b/i;

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export const HUMAN_GATE_CAUSES = Object.freeze(['captcha', 'login', 'account_creation', 'mfa', 'email_verification', 'uncertain']);
export const HUMAN_GATE_SIGNALS = Object.freeze([
  'captcha_blocking', 'captcha_uncertain', 'password_field', 'login_text', 'authentication_path',
  'account_creation_text', 'account_creation_path', 'one_time_code_field', 'mfa_text',
  'email_verification_text', 'human_verification_text', 'legacy_login_gate', 'conflicting_gate_signals',
]);

// Credentials and challenge responses must never be treated as candidate answers,
// even when their labels overlap a grounded application-field semantic.
export function classifyHumanOnlyField(field = {}) {
  const text = clean([field.type, field.name, field.id, field.label, field.text,
    field.questionText, field.placeholder, field.autocomplete, field.semantic].join(' '));
  if (/captcha|turnstile|challenge[-_ ]?response/i.test(text)) return 'captcha_response';
  if (/one[-_ ]?time[-_ ]?(?:code|password)|(?:^|[^a-z])otp(?:[^a-z]|$)|(?:verification|security|authentication|authenticator|mfa)[-_ ]?code|(?:sms|email)[-_ ]?code/i.test(text)) return 'one_time_code';
  if (clean(field.type).toLowerCase() === 'password' || /password/i.test(text)) return 'password';
  return null;
}

export function sanitizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:', 'about:'].includes(url.protocol)) throw new Error('Invalid human gate URL');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href;
}

// Retain the public handoff helper for callers and old batches.
export const sanitizeHumanGateUrl = sanitizeUrl;

export function sanitizePersistedUrls(value) {
  if (typeof value === 'string') {
    return value.replace(/(?:https?:\/\/|about:)[^\s<>"']+/g, (url) => {
      try { return sanitizeUrl(url); } catch { return url; }
    });
  }
  if (Array.isArray(value)) return value.map(sanitizePersistedUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePersistedUrls(item)]));
  }
  return value;
}

// Some ATSs (e.g. SuccessFactors) create the candidate account inside the application form itself. Its password
// fields stay human-only and are never filled, but they are not a login wall in front of the form. Pure login and
// bare sign-up pages have too few applicant fields to qualify and remain gated.
export function isApplicationFormWithAccountCreation(pageSignals = {}) {
  if (!pageSignals.applicationFormId) return false;
  const fields = (pageSignals.fields || []).filter((field) => field.visible !== false);
  if (!fields.some((field) => classifyHumanOnlyField(field) === 'password')) return false;
  const applicantFields = fields.filter((field) => !classifyHumanOnlyField(field));
  const describe = (field) => clean([field.type, field.label, field.text, field.name, field.placeholder].join(' ')).toLowerCase();
  const signals = [/first name|given name/, /last name|family name|surname/, /e-?mail/, /phone|mobile/]
    .filter((pattern) => applicantFields.some((field) => pattern.test(describe(field)))).length;
  return signals >= 3 && applicantFields.length >= 8;
}

export function classifyHumanGate(pageSignals = {}) {
  const body = clean(pageSignals.bodyText).toLowerCase();
  const fields = (pageSignals.fields || []).filter((field) => field.visible !== false);
  const url = String(pageSignals.currentUrl || pageSignals.url || '');
  const evidence = [];
  const causes = new Set();
  const add = (cause, signal) => { causes.add(cause); evidence.push(signal); };
  const captcha = pageSignals.captcha || classifyCaptchaState(pageSignals.captchaSignals || {
    present: CAPTCHA_SIGNAL_WORDS.test(body), textSignal: CAPTCHA_SIGNAL_WORDS.test(body),
    bodySignalText: body, totalNormalFields: fields.length,
    accessibleNormalFields: fields.filter((field) => !field.disabled).length,
  });
  if (!captcha.completed && captcha.present) {
    if (captcha.classification === 'active_blocking') add('captcha', 'captcha_blocking');
    else if (captcha.classification === 'uncertain') add('uncertain', 'captcha_uncertain');
  }
  const accountCreationInForm = isApplicationFormWithAccountCreation(pageSignals);
  if (!accountCreationInForm && fields.some((field) => classifyHumanOnlyField(field) === 'password')) add('login', 'password_field');
  if (/(?:sign|log)\s*in to (?:apply|continue)|login to (?:apply|continue)|einloggen|weiter mit e-mail-adresse|weiter als gast/.test(body)
      // A bare "Sign in" / "Log in" nav link on a job listing is not a wall; it needs a login-shaped field too.
      || (!pageSignals.applicationFormId && /\b(?:(?:sign|log)\s*in|login)\b/.test(body)
        && fields.some((field) => /e-?mail|user ?name|password/i.test(clean([field.type, field.label, field.text, field.name, field.placeholder].join(' ')))))) add('login', 'login_text');
  if (/\/(?:login|signin|sign-in|(?:application|apply)\/authentication)(?:[/?#]|$)/i.test(url)
      && fields.some((field) => /e-?mail/i.test(clean([field.type, field.label, field.text, field.name].join(' '))))) add('login', 'authentication_path');
  if (/\b(?:create (?:an? |your )?account|account creation|register to apply|sign up to (?:apply|continue))\b/.test(body)) add('account_creation', 'account_creation_text');
  if (/\/(?:register|signup|sign-up|create-account)(?:[/?#]|$)/i.test(url)
      && fields.some((field) => ['password', 'email'].includes(clean(field.type).toLowerCase()))) add('account_creation', 'account_creation_path');
  if (fields.some((field) => classifyHumanOnlyField(field) === 'one_time_code')) add('mfa', 'one_time_code_field');
  if (/\b(?:mfa|two[- ]factor|multi[- ]factor|one[- ]time (?:code|password)|enter (?:the |your )?(?:verification|security|authentication) code|authenticator (?:app|code))\b/.test(body)) add('mfa', 'mfa_text');
  if (/\b(?:verify (?:your |the )?(?:e-?mail|email address)|email verification|check your (?:e-?mail|inbox)|verification (?:e-?mail|link)|confirm your (?:e-?mail|email address))\b/.test(body)) add('email_verification', 'email_verification_text');
  if (!causes.size && /\b(?:verify (?:your identity|you are human)|verification required|checking your browser|just a moment|access denied|unusual traffic)\b/.test(body)) add('uncertain', 'human_verification_text');
  if (!causes.size && pageSignals.loginGate && !accountCreationInForm) add('uncertain', 'legacy_login_gate');
  // A password is expected on registration and MFA can follow login. Those
  // combinations identify the more specific step; unrelated gates are ambiguous.
  if (causes.has('account_creation') || causes.has('mfa')) causes.delete('login');
  if (!causes.size) return { gate: null };
  if (causes.size > 1) evidence.push('conflicting_gate_signals');
  return { gate: { cause: causes.size === 1 ? [...causes][0] : 'uncertain', evidence: [...new Set(evidence)] } };
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
  } else if ((signals.scriptCount || elements.length) && !visibleChallenge
      && (accessibleFields > 0 || (totalFields === 0 && !signals.textSignal))) {
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

function controlLabel(control) {
  return clean(control?.label || control?.text || control?.value || '').replace(/\s*&\s*/g, ' & ');
}

export function applicationControlSignature(control) {
  return {
    controlId: clean(control?.controlId),
    formId: clean(control?.formId),
    label: controlLabel(control),
    type: clean(control?.type).toLowerCase(),
    formAction: clean(control?.formAction),
    formMethod: clean(control?.formMethod || 'get').toLowerCase(),
  };
}

export function classifyApplicationControl(control) {
  const tag = clean(control?.tag).toLowerCase();
  const type = clean(control?.type).toLowerCase();
  const role = clean(control?.role).toLowerCase();
  const inputAction = ['submit', 'button', 'image', 'reset'].includes(type);
  if (['textarea', 'select'].includes(tag) || (tag === 'input' && !inputAction)
      || ['textbox', 'checkbox', 'radio', 'combobox', 'listbox'].includes(role)) return 'ambiguous';
  if (!['button', 'a'].includes(tag) && !(tag === 'input' && inputAction)
      && !['button', 'link'].includes(role) && !(!tag && inputAction)) return 'ambiguous';
  const label = controlLabel(control);
  const insideForm = Boolean(control?.insideApplicationForm);
  if (FINAL_TOKEN.test(clean([label, control?.text, control?.value].join(' ')))) return insideForm ? 'final' : 'ambiguous';
  if (!PROGRESSION_ACTION_LABEL.test(label)) return 'ambiguous';
  if (clean(control?.type).toLowerCase() !== 'submit' || control?.invokesSubmit) return 'ambiguous';
  if (label.toLowerCase() === 'review application' && control?.type === 'submit') return 'ambiguous';
  const verifiedContext = insideForm
    && Number(control?.candidateFieldCount || 0) > 0
    && Boolean(control?.hasRemainingStep)
    && Number.isInteger(control?.stepIndicator?.current) && control.stepIndicator.current > 0
    && Number.isInteger(control?.stepIndicator?.total) && control.stepIndicator.current < control.stepIndicator.total
    && Boolean(control?.workflowVerified)
    && clean(control?.formId)
    && clean(control?.applicationFormId) === clean(control?.formId);
  if (!verifiedContext) return 'ambiguous';
  if (control?.formActionLooksTerminal) return 'ambiguous';
  return 'progression';
}

export function isSemanticFinalAction(control) {
  return classifyApplicationControl(control) === 'final';
}

export function applicationFormStateFingerprint(snapshot) {
  let url = clean(snapshot?.url);
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    url = `${parsed.origin}${parsed.pathname}`;
  } catch {}
  const hasVerifiedFormKey = Object.prototype.hasOwnProperty.call(snapshot || {}, 'applicationFormId');
  const applicationFormId = clean(snapshot?.applicationFormId);
  const applicationFields = (snapshot?.fields || []).filter((field) => (
    !hasVerifiedFormKey || (applicationFormId && clean(field.formId) === applicationFormId && field.applicationFormOwned !== false)
  ));
  const applicationControls = (snapshot?.controls || []).filter((control) => (
    !hasVerifiedFormKey || (applicationFormId && clean(control.formId) === applicationFormId)
  ));
  return digest({
    url,
    applicationFormId,
    workflowId: snapshot?.applicationWorkflowId || applicationFormId || null,
    step: snapshot?.stepIndicator || null,
    fields: applicationFields.filter((field) => field.visible !== false).map((field) => ({
      id: field.name || field.id || field.label,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
    })),
    controls: applicationControls.map((control) => ({
      label: controlLabel(control),
      type: control.type,
      formAction: control.formAction || '',
      formMethod: control.formMethod || 'get',
      formId: control.formId || '',
    })),
  });
}

export function classifyField(field) {
  if (classifyHumanOnlyField(field)) return 'human_action';
  const label = clean([field.questionText, field.groupLabel, field.label, field.name, field.placeholder].filter(Boolean).join(' ')).toLowerCase();
  const semantics = classifyFieldSemantics(field);
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
  if (String(field.type || '').toLowerCase() === 'tel') return 'phone';
  if ((field.tag === 'select' || field.role === 'combobox' || field.autocomplete === 'list' || (field.options || []).length)
      && /phone country|country code|dial(?:ing)? code|calling code|phone prefix/.test(label)) return 'phone_country';
  if (/phone|mobile|telephone/.test(label)) return 'phone';
  if (/linkedin/.test(label)) return 'linkedin';
  if (/github/.test(label)) return 'github';
  if (/portfolio|website|personal site/.test(label)) return 'website';
  if (/how did you hear|where did you hear|application source|referral source/.test(label)) return 'application_source';
  if (/sponsor|employer support|support from (?:the )?employer|immigration support|visa support/.test(label)) return 'sponsorship';
  if (/work authori[sz](?:ation|ed)?|authori[sz]ed to work|eligible to work|right to work|legally authori[sz](?:ed)?/.test(label)) return 'work_authorization';
  if (semantics.semantic === 'preferred_location') return 'preferred_location';
  if (/current location|\blocation\b/.test(label)) return 'current_location';
  if (/city|municipality/.test(label)) return 'city';
  if (/country/.test(label)) return 'country';
  if (/university|school|institution/.test(label)) return 'university';
  if (/degree|qualification/.test(label)) return 'degree';
  if (/graduat/.test(label)) return 'graduation';
  if (/available|start date|notice period/.test(label)) return 'availability';
  if (/relocat/.test(label)) return 'relocation';
  if (semantics.category === 'salary') return semantics.semantic;
  if (/cover letter|motivation letter|supporting statement/.test(label) && field.tag === 'textarea') return 'cover_letter_text';
  if (field.type === 'checkbox' || field.type === 'radio') return LEGAL_WORDS.test(label) ? 'legal_consent' : 'choice';
  if (['textarea', 'text'].includes(field.type) || field.tag === 'textarea') return 'free_text';
  return 'unknown';
}

export function inspectUploadTopology(snapshot) {
  const hasVerifiedFormKey = Object.prototype.hasOwnProperty.call(snapshot || {}, 'applicationFormId');
  const applicationFormId = clean(snapshot?.applicationFormId);
  const uploads = (snapshot.fields || []).filter((field) => field.visible !== false && !field.disabled && field.type === 'file'
    && (!hasVerifiedFormKey || (applicationFormId && clean(field.formId) === applicationFormId && field.applicationFormOwned !== false)));
  const semantics = uploads.map((field) => ({
    fieldId: field.fieldId,
    formId: field.formId || '',
    applicationFormOwned: field.applicationFormOwned !== false,
    label: field.label,
    semantic: classifyField(field),
  }));
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

function dropdownValue(semantic, profile, context) {
  if (semantic === 'phone_country') return 'Finland';
  if (semantic === 'country') return profile.location.country || 'Finland';
  return groundedFieldValue(profile, semantic, context);
}

export function buildFormPlan(snapshot, profile, artifacts, { candidateId = null, context = {}, ...options } = {}) {
  const formContext = { ...context, ...options };
  const actions = [];
  const unresolvedFields = [];
  const hasVerifiedFormKey = Object.prototype.hasOwnProperty.call(snapshot || {}, 'applicationFormId');
  const applicationFormId = clean(snapshot?.applicationFormId);
  if (hasVerifiedFormKey && !applicationFormId) {
    unresolvedFields.push({
      fieldId: 'application-form-unverified',
      label: 'Application form',
      semantic: 'application_form',
      reason: 'No uniquely verified application form is available; no fields were filled.',
    });
  }
  const applicationFields = snapshot.fields.filter((item) => !hasVerifiedFormKey
    || (applicationFormId && clean(item.formId) === applicationFormId && item.applicationFormOwned !== false));
  for (const field of applicationFields.filter((item) => item.visible !== false && !item.disabled)) {
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
      actions.push({ fieldId: field.fieldId, formId: field.formId || '', id: field.id, label: field.label, name: field.name, semantic, action: 'upload', artifact });
      continue;
    }
    let value;
    let unresolvedReason = null;
    const fieldContext = {
      ...formContext, question: [field.questionText, field.groupLabel, field.label].filter(Boolean).join(' '),
    };
    if (semantic === 'cover_letter_text' && artifacts.coverLetterTextContent && artifacts.coverLetterTextProvenance) {
      const exactCandidateId = clean(candidateId);
      if (!exactCandidateId) {
        unresolvedReason = 'Legacy form preparation has no explicit current candidate identity for cover-letter provenance.';
      } else {
        try {
          validateNarrativeProvenanceRecord(profile, artifacts.coverLetterTextProvenance, {
            candidateId: exactCandidateId,
            normalizedQuestion: 'cover letter document',
            answer: artifacts.coverLetterTextContent,
          });
          value = artifacts.coverLetterTextContent;
        } catch (error) {
          unresolvedReason = `Bound cover-letter provenance is invalid for the current candidate: ${clean(error.message)}`;
        }
      }
    } else if (semantic === 'free_text') value = null;
    else if (['phone_country', 'country', 'sponsorship', 'work_authorization', 'relocation'].includes(semantic)) value = dropdownValue(semantic, profile, fieldContext);
    else value = groundedFieldValue(profile, semantic, fieldContext);

    if (!value) {
      if (field.required) unresolvedFields.push({
        fieldId: field.fieldId,
        label: field.label,
        semantic,
        reason: unresolvedReason || 'No grounded canonical answer is available.',
      });
      continue;
    }
    if (semantic === 'phone' && applicationFields.some((item) => classifyField(item) === 'phone_country')) {
      value = clean(value).replace(/^\+?358[\s-]*/, '');
    }
    const control = field.tag === 'select' ? 'select'
      : (field.role === 'combobox' || field.autocomplete === 'list') ? 'autocomplete'
        : (field.type === 'checkbox' || field.type === 'radio') ? 'choice' : 'fill';
    actions.push({
      fieldId: field.fieldId,
      formId: field.formId || '',
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
  const applicationControls = snapshot.controls.filter((control) => !hasVerifiedFormKey
    || (applicationFormId && clean(control.formId) === applicationFormId));
  const finalActions = applicationControls.filter(isSemanticFinalAction).map((control) => ({
    label: control.label || control.text || control.value || '(unlabelled submit control)',
    semanticClass: control.type === 'submit' ? 'form_submit' : 'terminal_action',
  }));
  const progressionActions = applicationControls.filter((control) => classifyApplicationControl(control) === 'progression');
  const ambiguousActions = applicationControls.filter((control) => (
    classifyApplicationControl(control) === 'ambiguous'
    && (control.type === 'submit' || control.formAction || control.invokesSubmit
      || PROGRESSION_ACTION_LABEL.test(controlLabel(control)) || FINAL_TOKEN.test(controlLabel(control)))
  ));
  const uploadTopology = inspectUploadTopology(snapshot);
  if (uploadTopology.mode === 'ambiguous') {
    for (const row of uploadTopology.fields) {
      if (!unresolvedFields.some((field) => field.fieldId === row.fieldId)) unresolvedFields.push({ ...row, reason: uploadTopology.reason });
    }
  }
  return { actions, unresolvedFields, finalActions, progressionActions, ambiguousActions, uploadTopology, snapshotHash: digest(snapshot) };
}

export async function inspectApplicationForm(page, { gateOnly = false } = {}) {
  const snapshot = await page.evaluate(({ finalTokenSource, finalTokenFlags, gateOnly }) => {
    const finalToken = new RegExp(finalTokenSource, finalTokenFlags);
    const controlSelector = 'button, input[type="submit"], input[type="button"], input[type="image"], input[type="reset"], a, [role="button"], [role="link"]';
    const visible = (element) => {
      if (!element || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
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
    globalThis.__careerOpsFieldCounter = Number(globalThis.__careerOpsFieldCounter || 0);
    globalThis.__careerOpsFormCounter = Number(globalThis.__careerOpsFormCounter || 0);
    globalThis.__careerOpsControlCounter = Number(globalThis.__careerOpsControlCounter || 0);
    // Formless application pages (Ashby, Workday) render fields in plain containers. When no visible <form> holds
    // applicant fields, the smallest container holding them and a submit-like control acts as the form.
    const fieldSelector = 'input, textarea, select, [role="combobox"]';
    // Workday hides the real file input behind a visible drop zone with a "Select files" button.
    const fileInVisibleUploadArea = (element) => {
      if ((element.type || '').toLowerCase() !== 'file') return false;
      let area = element.parentElement;
      for (let depth = 0; area && depth < 4; depth += 1, area = area.parentElement) {
        if (visible(area)) return [...area.querySelectorAll('button, [role="button"]')].some(visible);
      }
      return false;
    };
    const applicantField = (element) => (visible(element) || fileInVisibleUploadArea(element))
      && !['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes((element.type || '').toLowerCase());
    // Only a real form that looks like an application suppresses discovery (a newsletter box or a header job
    // search with keyword/location/department fields does not): applicant-named fields or a file input.
    const applicantNamed = /(?:first.?name|last.?name|full.?name|e-?mail|phone|linkedin|resume|r[ée]sum[ée]|\bcv\b|cover letter)/i;
    const realFormHasFields = [...document.querySelectorAll('form')].some((form) => {
      if (!visible(form)) return false;
      const fields = [...form.querySelectorAll(fieldSelector)].filter(applicantField);
      if (fields.some((field) => (field.type || '').toLowerCase() === 'file')) return true;
      return fields.length >= 3 && fields.filter((field) => applicantNamed.test(textFor(field))).length >= 2;
    });
    // Only a verified application progress indicator may widen a virtual form or give it identity: Workday's own
    // progress bar or an explicit step hook. A generic aria-current="step" (product tours, onboarding) never does.
    // Workday's step text ("current step 1 of 6") is a screen-reader-only label inside the visible active step.
    const inVisibleWorkdayActiveStep = (element) => {
      const active = element.closest('[data-automation-id="progressBarActiveStep"]');
      return Boolean(active && active.closest('[data-automation-id="progressBar"]') && visible(active));
    };
    const applicationStepElement = (element) => (visible(element) || inVisibleWorkdayActiveStep(element))
      && !element.closest('[role="dialog"], [role="alertdialog"], [role="tooltip"], dialog, [aria-modal="true"]')
      && (element.hasAttribute('data-career-ops-step')
        || Boolean(element.closest('[data-automation-id="progressBarActiveStep"]')?.closest('[data-automation-id="progressBar"]')));
    const isVirtualForm = (element) => Boolean(element?.hasAttribute?.('data-career-ops-virtual-form'));
    if (!realFormHasFields && !document.querySelector('[data-career-ops-virtual-form]')) {
      const loose = [...document.querySelectorAll(fieldSelector)].filter((element) => applicantField(element) && !element.closest('form'));
      // After a Workday upload the input is gone; the tile naming the uploaded file stands in for it.
      const uploadedTiles = [...document.querySelectorAll('[data-automation-id="file-upload-item-name"]')]
        .filter((element) => visible(element) && !element.closest('form'));
      if (!loose.length && uploadedTiles.length) loose.push(...uploadedTiles);
      if (loose.length >= 3 || loose.some((element) => (element.type || '').toLowerCase() === 'file' || uploadedTiles.includes(element))) {
        let container = loose[0].parentElement;
        while (container && !loose.every((element) => container.contains(element))) container = container.parentElement;
        const submitLike = (root) => [...root.querySelectorAll('button, [role="button"], input[type="submit"]')]
          .some((control) => visible(control) && (finalToken.test(control.innerText || control.value || control.getAttribute('aria-label') || '')
            || /\b(?:save and continue|continue|next)\b/i.test(control.innerText || control.value || '')));
        for (let depth = 0; container && depth < 12 && !submitLike(container); depth += 1) container = container.parentElement;
        // Include the workflow's step indicator when it sits just above (Workday: progress bar in applyFlowPage).
        // Only a structured step element counts (not any "step 2 of 3" text elsewhere on the page).
        const structuredStep = '[data-automation-id="progressBarActiveStep"], [aria-current="step"], [data-career-ops-step]';
        const hasStep = (root) => [...(root?.querySelectorAll(structuredStep) || [])].some(applicationStepElement);
        if (container && !hasStep(container)) {
          let ancestor = container.parentElement;
          for (let depth = 0; ancestor && depth < 3 && !hasStep(ancestor); depth += 1) ancestor = ancestor.parentElement;
          if (ancestor && hasStep(ancestor) && !['BODY', 'HTML'].includes(ancestor.tagName)) container = ancestor;
        }
        if (container && !['BODY', 'HTML'].includes(container.tagName) && submitLike(container)) {
          container.setAttribute('data-career-ops-virtual-form', '1');
        }
      }
    }
    const forms = [...document.querySelectorAll('form, [data-career-ops-virtual-form]')];
    for (const form of forms) {
      if (!form.getAttribute('data-career-ops-form-id')) {
        form.setAttribute('data-career-ops-form-id', `form-${++globalThis.__careerOpsFormCounter}`);
      }
    }
    // Workday "Select One" dropdowns are buttons that open a listbox (Country, Phone Device Type).
    const isWorkdayListbox = (element) => element.tagName === 'BUTTON' && element.getAttribute('aria-haspopup') === 'listbox';
    const fieldElements = [...document.querySelectorAll('input, textarea, select, [role="combobox"], button[aria-haspopup="listbox"]')]
      .filter((element) => isWorkdayListbox(element)
        || !['hidden', 'submit', 'button', 'reset', 'image'].includes((element.type || '').toLowerCase()));
    const usedFieldIds = new Set();
    for (const element of fieldElements) {
      const existing = String(element.getAttribute('data-career-ops-field-id') || '').trim();
      if (!existing) continue;
      // Gate detection does not trust field identities. Exact interaction and
      // ordinary form inspection still reject duplicates independently.
      if (usedFieldIds.has(existing) && !gateOnly) throw new Error(`Duplicate Career-Ops field identity detected: ${existing}`);
      usedFieldIds.add(existing);
      const generated = existing.match(/^field-(\d+)$/);
      if (generated) globalThis.__careerOpsFieldCounter = Math.max(globalThis.__careerOpsFieldCounter, Number(generated[1]));
    }
    // Files an ATS lists next to an upload control. Read per visible text node: a node that is a file name, or a name
    // followed only by an upload status, gives that exact name; any other mention of a file is unreadable. In a
    // container shared by several file inputs, a name inside another control's own area belongs to that control; any
    // other listed name cannot be tied to one control and is ambiguous. Unreadable/ambiguous names never equal the
    // bound file, so the upload is withheld for review.
    // Text-node visibility from its own rects (display:contents wrappers have none, their text does);
    // display:contents elements are transparent like inline ones.
    const textShown = (item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getClientRects().length > 0;
    };
    const inlineLike = (element) => {
      const display = getComputedStyle(element).display;
      return display.startsWith('inline') || display === 'contents';
    };
    const namesIn = (root, skip = [], used = new Set()) => {
      // Text nodes are first joined into tokens: adjacent nodes in the same block element that touch without whitespace
      // (<span>Archived_</span><span>CV.pdf</span>) form one token, so a name is always read whole.
      const blockOf = (element) => {
        let node = element;
        while (node.parentElement && node !== root && inlineLike(node)) node = node.parentElement;
        return node;
      };
      const tokens = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let item = walker.nextNode(); item; item = walker.nextNode()) {
        const parent = item.parentElement;
        if (!parent || parent.closest('script, style, template') || !textShown(item)) continue;
        if (skip.some((region) => region.contains(parent))) continue;
        const raw = item.textContent || '';
        const block = blockOf(parent);
        const last = tokens[tokens.length - 1];
        if (last && last.block === block && /\S$/.test(last.raw) && /^\S/.test(raw)) {
          last.raw += raw;
          last.items.push(item);
          last.listed = last.listed || Boolean(parent.closest('[data-automation-id="file-upload-item-name"]'));
        } else {
          tokens.push({ raw, block, items: [item], listed: Boolean(parent.closest('[data-automation-id="file-upload-item-name"]')) });
        }
      }
      // A token is a whole name only when it stands alone in its block: its nearest non-whitespace neighbours are block
      // elements, form controls (or areas holding them), another control's area, or nothing. Inline text beside it
      // ("<span>Archived </span><span>CV.pdf</span>") makes it a fragment, read as unreadable.
      const boundary = (node) => {
        if (!node) return true;
        if (node.nodeType === Node.TEXT_NODE) return !/\S/.test(node.textContent || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return true;
        if (skip.some((region) => region === node || region.contains(node) || node.contains(region))) return true;
        if (node.matches('input, textarea, select, button') || node.querySelector('input, textarea, select, button')) return true;
        if (!inlineLike(node)) return true;
        return !/\S/.test(node.textContent || '');
      };
      const neighbour = (node, block, forward) => {
        for (let current = node; current && current !== block; current = current.parentElement) {
          let sibling = forward ? current.nextSibling : current.previousSibling;
          // Whitespace, comments and empty inline elements are not neighbours (they never isolate a fragment).
          while (sibling && ((sibling.nodeType === Node.TEXT_NODE && !/\S/.test(sibling.textContent || ''))
            || (sibling.nodeType !== Node.TEXT_NODE && sibling.nodeType !== Node.ELEMENT_NODE)
            || (sibling.nodeType === Node.ELEMENT_NODE && inlineLike(sibling)
              && !/\S/.test(sibling.textContent || '') && !sibling.matches('input, textarea, select, button')
              && !sibling.querySelector('input, textarea, select, button')))) {
            sibling = forward ? sibling.nextSibling : sibling.previousSibling;
          }
          if (sibling) return sibling;
        }
        return null;
      };
      const isolated = (token) => boundary(neighbour(token.items[0], token.block, false))
        && boundary(neighbour(token.items[token.items.length - 1], token.block, true));
      const found = [];
      for (const token of tokens) {
        const text = token.raw.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // A file name has a non-separator character right before the extension ("Old CV ().pdf") or a letter or digit in
        // its segment before it (spaces and dots allowed: "Old CV .pdf");
        // bare type hints (".pdf, .docx", "(.pdf)", "types: .pdf") do not.
        if (!token.listed && !/(?:[^\s,;:(\/]|(?:^|[,;:(\/])[^,;:(\/]*[\p{L}\p{N}][^,;:(\/]*)\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip)(?![\p{L}\p{N}])/iu.test(text)) continue;
        const lead = token.listed ? [text, text] : text.match(/^(.+\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip))(?:\s+(?:(?:was\s+)?(?:successfully\s+)?(?:uploaded|attached)(?:\s+successfully)?[.!]?))?$/i);
        found.push(lead && isolated(token) ? lead[1] : `(unreadable file name) ${text}`);
        for (const item of token.items) used.add(item);
      }
      return found;
    };
    // A file name split across elements (<span>Name</span><span>.pdf</span>) is caught on the joined text of the
    // visible text nodes; when the per-node reading found nothing, it is unreadable and withholds the upload.
    const joinedHasFile = (root, skip = [], used = new Set()) => {
      let joined = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let item = walker.nextNode(); item; item = walker.nextNode()) {
        const parent = item.parentElement;
        if (!parent || parent.closest('script, style, template') || !textShown(item)) continue;
        if (skip.some((region) => region.contains(parent)) || used.has(item)) continue;
        joined += item.textContent || '';
      }
      return /(?:[^\s,;:(\/]|(?:^|[,;:(\/])[^,;:(\/]*[\p{L}\p{N}][^,;:(\/]*)\.(?:pdf|docx?|rtf|odt|ott|txt|html?|pages|md|png|jpe?g|gif|tiff?|xlsx?|pptx?|zip)(?![\p{L}\p{N}])/iu.test(joined);
    };
    const regionOf = (other, top) => {
      let region = other;
      while (region.parentElement && region.parentElement !== top
        && region.parentElement.querySelectorAll('input[type="file"]').length === 1) region = region.parentElement;
      return region;
    };
    const listedNames = (input) => {
      for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        const inputs = [...node.querySelectorAll('input[type="file"]')];
        if (inputs.length > 1) {
          const others = inputs.filter((other) => other !== input);
          const regions = others.map((other) => regionOf(other, node));
          // A shared-area name that another input actually holds (e.g. RoleForge's own CV upload) belongs to it.
          const heldElsewhere = new Set(others.flatMap((other) => [...(other.files || [])].map((file) => file.name)));
          const used = new Set();
          const sharedNames = namesIn(node, regions, used).filter((name) => !heldElsewhere.has(name));
          const split = joinedHasFile(node, regions, used) ? ['(unreadable file name)'] : [];
          return [...new Set([...sharedNames, ...split].map((name) => `(ambiguous attachment) ${name}`))];
        }
        const used = new Set();
        const names = [...namesIn(node, [], used), ...(joinedHasFile(node, [], used) ? ['(unreadable file name)'] : [])];
        if (names.length) return [...new Set(names)];
        if (node.matches('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]')) break;
      }
      return [];
    };
    const fields = fieldElements.map((element) => {
        let fieldId = String(element.getAttribute('data-career-ops-field-id') || '').trim();
        if (!fieldId) {
          do fieldId = `field-${++globalThis.__careerOpsFieldCounter}`;
          while (usedFieldIds.has(fieldId));
          usedFieldIds.add(fieldId);
        }
        element.setAttribute('data-career-ops-field-id', fieldId);
        let fieldText = textFor(element);
        // Upload tiles often hide an unlabelled file input; its purpose is the tile's short text ("CV", "Cover Letter").
        // Workday names the purpose in an ancestor's automation id ("resumeUpload") or a nearby heading.
        if ((element.type || '').toLowerCase() === 'file' && !/resume|r[ée]sum[ée]|\bcv\b|cover|motivation|curriculum/i.test(fieldText)) {
          for (let node = element.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
            if (depth > 0 && node.querySelectorAll('input[type="file"]').length > 1) break;
            const automationId = (node.getAttribute('data-automation-id') || '').replace(/([a-z])([A-Z])/g, '$1 $2');
            const context = `${automationId} ${(node.innerText || '').replace(/\s+/g, ' ').trim()}`.trim();
            if (context.length > 500) break;
            const cv = /resume|r[ée]sum[ée]|\bcv\b|curriculum/i.test(context);
            const cover = /cover letter|motivation letter/i.test(context);
            // A field for both documents is usable only when it accepts several files (adding never replaces).
            if ((cv || cover) && (!(cv && cover) || element.multiple)) {
              fieldText = `${fieldText} ${context}`.trim();
              break;
            }
          }
        }
        const owningForm = element.form || element.closest('form, [data-career-ops-virtual-form]');
        return {
          fieldId,
          formId: owningForm?.getAttribute('data-career-ops-form-id') || '',
          id: element.id || '',
          tag: element.tagName.toLowerCase(),
          type: isWorkdayListbox(element) ? 'listbox' : (element.type || element.tagName).toLowerCase(),
          role: element.getAttribute('role') || '',
          name: element.getAttribute('name') || '',
          label: fieldText,
          placeholder: element.getAttribute('placeholder') || '',
          required: element.required
            || element.getAttribute('aria-required') === 'true'
            || /(?:\*\s*(?:\(required\))?|\(required\)|\bmandatory\b)/i.test(fieldText),
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
          visible: visible(element),
          autocomplete: element.getAttribute('aria-autocomplete') || element.getAttribute('autocomplete') || '',
          // Workday search-and-pick widgets (country phone code, how did you hear) are inputs inside a multiselect.
          widget: isWorkdayListbox(element) ? 'workday-listbox' : element.getAttribute('data-uxi-widget-type') || '',
          // A Workday pick-from-list field keeps its search box empty; the choice is a selected-item chip. A Workday
          // dropdown button shows its choice as its text ("Select One" when empty).
          value: isWorkdayListbox(element)
            ? (/^select one$/i.test((element.innerText || '').trim()) ? '' : (element.innerText || '').replace(/\s+/g, ' ').trim())
            : element.value || (element.getAttribute('data-uxi-widget-type') === 'selectinput'
              ? [...(element.closest('[data-automation-id="multiSelectContainer"]')?.querySelectorAll('[data-automation-id="selectedItem"]') || [])]
                .filter(visible).map((item) => (item.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
              : ''),
          checked: Boolean(element.checked),
          files: element.files ? [...element.files].map((file) => file.name) : [],
          multiple: Boolean(element.multiple),
          attachedNames: (element.type || '').toLowerCase() === 'file' ? listedNames(element) : [],
          options: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value })) : [],
        };
      });
    const applicationFieldPattern = /(?:first.?name|last.?name|full.?name|e-?mail|phone|linkedin|github|resume|r[ée]sum[ée]|\bcv\b|cover letter|work authori[sz]|sponsor|current location|city|country|university|degree|salary|how did you hear)/i;
    const applicationSpecificFieldPattern = /(?:linkedin|github|resume|\bcv\b|cover letter|work authori[sz]|sponsor|how did you hear)/i;
    const stepFromElement = (element) => {
      // Workday's "current step 1 of 6" is a screen-reader-only label (hidden by CSS) inside the visible active step
      // of its progress bar; it counts when that active step is visible.
      const workdayActiveStep = element.closest('[data-automation-id="progressBarActiveStep"]');
      if (!visible(element) && !(workdayActiveStep && visible(workdayActiveStep)
        && workdayActiveStep.closest('[data-automation-id="progressBar"]'))) return null;
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      const text = ownText || (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const current = Number(element.getAttribute('data-career-ops-step') || 0);
      const total = Number(element.getAttribute('data-career-ops-total-steps') || 0);
      if (Number.isInteger(current) && current > 0 && Number.isInteger(total) && total > 0) return { current, total, text: text || `Step ${current} of ${total}` };
      const match = text.match(/\b(?:step|page)\s*(\d+)\s+(?:of|\/)\s+(\d+)(?!\d)/i);
      if (!match) return null;
      return { current: Number(match[1]), total: Number(match[2]), text: match[0] };
    };
    const localWorkflowAssociation = (form) => {
      const explicit = form.closest('[data-career-ops-wizard]');
      // A virtual form's step evidence comes only from verified application steps (never a nearby "Step 1 of 3").
      if (isVirtualForm(form) && !explicit) return null;
      if (explicit && visible(explicit)) {
        const competing = [...explicit.querySelectorAll('form')].filter((item) => item !== form && visible(item));
        if (!competing.length) {
          const step = [...explicit.querySelectorAll('[data-career-ops-step], [aria-current="step"], .step, .steps, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')]
            .map(stepFromElement).find(Boolean) || null;
          if (step) return { root: explicit, explicit: true, step };
        }
      }
      const parent = form.parentElement;
      if (!parent || ['BODY', 'MAIN', 'HTML'].includes(parent.tagName) || !visible(parent)) return null;
      const localForms = [...parent.querySelectorAll('form')].filter(visible);
      if (localForms.length !== 1 || localForms[0] !== form) return null;
      const meaningfulChildren = [...parent.children].filter((element) => !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName));
      if (meaningfulChildren.length > 2) return null;
      const stepCandidates = [...parent.querySelectorAll('*')]
        .filter((element) => !form.contains(element))
        .map((element) => ({ element, step: stepFromElement(element) }))
        .filter((row) => row.step);
      if (stepCandidates.length !== 1) return null;
      return { root: parent, explicit: false, step: stepCandidates[0].step };
    };
    const workflowAssociations = new Map(forms.map((form) => [form, localWorkflowAssociation(form)]));
    const scoredForms = forms.map((form) => {
      const candidates = [...form.querySelectorAll('input, textarea, select, [role="combobox"]')]
        .filter((field) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((field.type || '').toLowerCase()));
      const visibleCandidates = candidates.filter((field) => visible(field) || fileInVisibleUploadArea(field));
      const visibleControls = [...form.querySelectorAll(controlSelector)]
        .filter(visible);
      const score = visibleCandidates.filter((field) => applicationFieldPattern.test(textFor(field))
        || ['email', 'tel', 'file'].includes((field.type || '').toLowerCase())).length;
      const applicationSpecificSignals = visibleCandidates.filter((field) => applicationSpecificFieldPattern.test(textFor(field))).length;
      const controlText = visibleControls
        .map((control) => `${control.getAttribute('aria-label') || ''} ${control.innerText || ''} ${control.value || ''}`)
        .join(' ');
      const hasApplicationAction = /\b(?:apply|application)\b/i.test(controlText);
      const hasTerminalAction = finalToken.test(controlText);
      const visibleText = visible(form) ? (form.innerText || '') : '';
      const formApplicationContext = /\b(?:application|candidate|privacy|data notice|certif(?:y|ication)|resume|\bcv\b|cover letter|work authori[sz]|sponsor)\b/i.test(visibleText);
      const workflowAssociation = workflowAssociations.get(form);
      const structurallyAssociated = Boolean(workflowAssociation);
      const hasFormStepEvidence = isVirtualForm(form)
        ? [...form.querySelectorAll('[data-career-ops-step], [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')].some(applicationStepElement)
        : [...form.querySelectorAll('[data-career-ops-step], [aria-current="step"], [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')].some(visible)
          || /\b(?:step|page)\s*\d+\s+(?:of|\/)\s+\d+(?!\d)/i.test(visibleText);
      const independentApplicationIdentity = hasApplicationAction
        || (applicationSpecificSignals > 0 && (hasTerminalAction || structurallyAssociated || hasFormStepEvidence))
        || (formApplicationContext && hasTerminalAction)
        // A virtual form exists only on a form-less page with applicant fields and a submit-like control; inside a
        // numbered application workflow (Workday "step 3 of 6") that is the application.
        || (form.hasAttribute('data-career-ops-virtual-form')
          && [...form.querySelectorAll('[data-automation-id="progressBarActiveStep"], [aria-current="step"], [data-career-ops-step]')].some(applicationStepElement));
      // Workday Autofill after an upload: the input is replaced by a tile naming the uploaded file.
      const workdayUploadedStep = isVirtualForm(form) && hasFormStepEvidence
        && [...form.querySelectorAll('[data-automation-id="file-upload-item-name"]')].some(visible);
      const associationBonus = structurallyAssociated || hasFormStepEvidence || hasApplicationAction ? 100 : 0;
      return {
        form,
        score: score + applicationSpecificSignals * 4 + associationBonus,
        applicationQualified: visible(form)
          && ((candidates.length > 0 && (visibleCandidates.length > 0 || hasApplicationAction)) || workdayUploadedStep)
          && independentApplicationIdentity,
      };
    }).filter((row) => row.applicationQualified).sort((a, b) => b.score - a.score);
    const uniqueTopForm = scoredForms.length && (scoredForms.length === 1 || scoredForms[0].score > scoredForms[1].score)
      ? scoredForms[0].form : null;
    const applicationFormId = uniqueTopForm?.getAttribute('data-career-ops-form-id') || '';
    const applicationWizard = uniqueTopForm ? workflowAssociations.get(uniqueTopForm)?.root || null : null;
    if (applicationWizard && !applicationWizard.getAttribute('data-career-ops-workflow-id')) {
      applicationWizard.setAttribute('data-career-ops-workflow-id', `workflow-${applicationFormId}`);
    }
    const applicationWorkflowId = applicationWizard?.getAttribute('data-career-ops-workflow-id') || applicationFormId;
    for (const field of fields) field.applicationFormOwned = Boolean(applicationFormId && field.formId === applicationFormId);
    const parseStep = (root, selector) => {
      const candidates = [...root.querySelectorAll(selector)].filter(isVirtualForm(root) ? applicationStepElement : visible);
      for (const element of candidates) {
        const step = stepFromElement(element);
        if (step) return step;
      }
      return workflowAssociations.get(uniqueTopForm)?.root === root
        ? workflowAssociations.get(uniqueTopForm)?.step || null
        : null;
    };
    const applicationStepIndicator = applicationWizard
      ? parseStep(applicationWizard, '[data-career-ops-step], [aria-current="step"], [role="progressbar"], .step, .steps, .progress, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')
      : parseStep(uniqueTopForm || document.createElement('div'), '[data-career-ops-step], [aria-current="step"], .step, .steps, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *');
    const controls = [...document.querySelectorAll(controlSelector)]
      .filter(visible)
      .map((element) => {
        if (!element.getAttribute('data-career-ops-control-id')) {
          element.setAttribute('data-career-ops-control-id', `control-${++globalThis.__careerOpsControlCounter}`);
        }
        const form = element.form || element.closest('form, [data-career-ops-virtual-form]');
        const formFields = form ? [...form.querySelectorAll('input, textarea, select, [role="combobox"]')]
          .filter((field) => !['hidden', 'submit', 'button', 'reset', 'image'].includes((field.type || '').toLowerCase())) : [];
        const wizardScope = form === uniqueTopForm ? applicationWizard : null;
        const scopedStep = wizardScope
          ? parseStep(wizardScope, '[data-career-ops-step], [aria-current="step"], [role="progressbar"], .step, .steps, .progress, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *')
          : parseStep(form || document.createElement('div'), '[data-career-ops-step], [aria-current="step"], .step, .steps, [data-automation-id="progressBarActiveStep"], [data-automation-id="progressBarActiveStep"] *');
        const stepIndicator = form === uniqueTopForm ? scopedStep : null;
        const formAction = element.getAttribute('formaction') || form?.getAttribute('action') || '';
        return {
          controlId: element.getAttribute('data-career-ops-control-id'),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          formId: form?.getAttribute('data-career-ops-form-id') || '',
          label: (element.getAttribute('aria-label') || element.innerText || element.value || textFor(element)).replace(/\s+/g, ' ').trim(),
          text: element.innerText || '',
          value: element.value || '',
          type: (element.type || '').toLowerCase(),
          formAction,
          formMethod: (element.getAttribute('formmethod') || form?.getAttribute('method') || 'get').toLowerCase(),
          formActionLooksTerminal: /(?:submit|send|complete|finish|finali[sz]e|confirm|apply)(?:[-_\/]|[A-Z]|\?|$)/i.test(formAction),
          insideApplicationForm: Boolean(form),
          // A Workday step whose upload became a tile naming the uploaded file still holds that field.
          candidateFieldCount: formFields.filter(visible).length + (isVirtualForm(form)
            ? [...form.querySelectorAll('[data-automation-id="file-upload-item-name"]')].filter(visible).length : 0),
          applicationFormId,
          workflowVerified: Boolean(form && form === uniqueTopForm),
          hasRemainingStep: Boolean(stepIndicator && stepIndicator.total > stepIndicator.current),
          stepIndicator,
          invokesSubmit: Boolean(element.getAttribute('onclick')?.match(/submit|requestSubmit/i)),
        };
      });
    const bodyText = document.body?.innerText || '';
    const validationErrorEvidence = [...document.querySelectorAll('[role="alert"], .error, .validation-error, [aria-invalid="true"]')]
      .filter(visible)
      // Workday's screen-reader live region announces upload status ("<file> loading", "Successfully Uploaded").
      .filter((element) => !element.closest('[data-automation-id="ariaLive"]'))
      .map((element) => {
        const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
        const owningForm = element.form || element.closest('form, [data-career-ops-virtual-form]');
        const formId = owningForm?.getAttribute('data-career-ops-form-id') || '';
        const inApplicationWorkflow = Boolean(uniqueTopForm && (
          owningForm ? owningForm === uniqueTopForm : applicationWizard?.contains(element)
        ));
        const associatedElsewhere = Boolean(owningForm && owningForm !== uniqueTopForm);
        return { text, formId, inApplicationWorkflow, associatedElsewhere };
      }).filter((row) => row.text);
    const validationErrors = validationErrorEvidence
      .filter((row) => row.inApplicationWorkflow || !row.associatedElsewhere)
      .map((row) => row.text);
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
      applicationFormId,
      applicationWorkflowId,
      stepIndicator: applicationStepIndicator,
      validationErrors,
      validationErrorEvidence,
      loginGate: /sign in to apply|log in to apply|login to apply|create an account to apply|sign in or create|login or register|verify (?:your )?email|one[- ]time code|two[- ]factor|mfa/i.test(bodyText)
        || fields.some((field) => field.visible && field.type === 'password'),
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
      progressionSubmits: Number(globalThis.__careerOpsProgressionSubmits || 0),
    };
  }, { finalTokenSource: FINAL_TOKEN.source, finalTokenFlags: FINAL_TOKEN.flags, gateOnly });
  return { ...snapshot, captcha: classifyCaptchaState(snapshot.captchaSignals) };
}

async function installSubmissionGuard(page) {
  await page.evaluate(() => {
    if (globalThis.__careerOpsSubmissionGuard) return;
    globalThis.__careerOpsSubmitAttempts = 0;
    const block = (event) => {
      globalThis.__careerOpsSubmitAttempts += 1;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      throw new Error('Career-Ops blocked a final form submission attempt');
    };
    const nativeSubmit = HTMLFormElement.prototype.submit;
    const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    globalThis.__careerOpsSubmissionGuard = { block, nativeSubmit, nativeRequestSubmit };
    document.addEventListener('submit', block, true);
    HTMLFormElement.prototype.submit = function guardedSubmit() { block(); };
    HTMLFormElement.prototype.requestSubmit = function guardedRequestSubmit() { block(); };
  });
}

export async function removeSubmissionGuard(page) {
  await page.evaluate(() => {
    const guard = globalThis.__careerOpsSubmissionGuard;
    if (!guard) return;
    document.removeEventListener('submit', guard.block, true);
    HTMLFormElement.prototype.submit = guard.nativeSubmit;
    HTMLFormElement.prototype.requestSubmit = guard.nativeRequestSubmit;
    delete globalThis.__careerOpsSubmissionGuard;
  });
}

async function exactLocator(page, action) {
  let locator;
  const scope = action.formId
    ? page.locator(`[data-career-ops-form-id="${action.formId.replace(/"/g, '\\"')}"]`)
    : page;
  const stamped = scope.locator(`[data-career-ops-field-id="${action.fieldId.replace(/"/g, '\\"')}"]`);
  const stampedCount = await stamped.count();
  if (stampedCount === 1) return stamped;
  if (stampedCount > 1) throw new Error(`Career-Ops exact field identity is ambiguous for ${action.semantic}`);
  if (action.id) {
    locator = scope.locator(`[id="${action.id.replace(/"/g, '\\"')}"]`);
    if (await locator.count() === 1 && await locator.getAttribute('data-career-ops-field-id') === action.fieldId) return locator;
  }
  if (action.name) {
    locator = scope.locator(`[name="${action.name.replace(/"/g, '\\"')}"]`);
    if (await locator.count() === 1 && await locator.getAttribute('data-career-ops-field-id') === action.fieldId) return locator;
  }
  if (action.label && action.formId) {
    locator = scope.getByLabel(action.label, { exact: true });
    if (await locator.count() === 1 && await locator.getAttribute('data-career-ops-field-id') === action.fieldId) return locator;
  }
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
    const liveField = await locator.evaluate((element) => ({
      type: element.type, name: element.name, id: element.id,
      label: [...(element.labels || [])].map((label) => label.innerText).join(' '),
      autocomplete: element.getAttribute('autocomplete'),
      text: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'),
    }));
    if (classifyHumanOnlyField(action) || classifyHumanOnlyField(liveField)) {
      unresolvedFields.push({ fieldId: action.fieldId, label: action.label, semantic: action.semantic,
        reason: 'Credential or challenge field requires the human.' });
      continue;
    }
    if (isSemanticFinalAction(await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      type: element.type,
      formAction: element.getAttribute('formaction'),
      insideApplicationForm: Boolean(element.closest('form, [data-career-ops-virtual-form]')),
      label: element.getAttribute('aria-label') || element.innerText || element.value,
      text: element.innerText || '',
      value: element.value || '',
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

export async function reviewApplicationForm(page, profile, artifacts, execution, options = {}) {
  const snapshot = await inspectApplicationForm(page);
  const plan = buildFormPlan(snapshot, profile, artifacts, options);
  const applicationFields = snapshot.fields.filter((field) => snapshot.applicationFormId
    && field.formId === snapshot.applicationFormId && field.applicationFormOwned !== false);
  const requiredMissing = applicationFields.filter((field) => field.visible !== false && field.required && !field.disabled
    && !clean(field.value) && !field.checked && !field.files.length)
    .map((field) => ({ fieldId: field.fieldId, label: field.label, semantic: classifyField(field), reason: 'Required field remains empty.' }));
  const unresolvedFields = [...plan.unresolvedFields, ...(execution.unresolvedFields || []), ...requiredMissing];
  const finalAction = {
    detected: plan.finalActions.length > 0,
    label: plan.finalActions.map((item) => item.label).join(' | ') || null,
    semanticClass: plan.finalActions.map((item) => item.semanticClass).join(' | ') || null,
    activated: snapshot.submitAttempts > 0,
  };
  const classifiedGate = classifyHumanGate(snapshot).gate;
  const gate = classifiedGate ? { state: 'human_action_required', ...classifiedGate,
    stage: 'form_review', currentUrl: sanitizeUrl(snapshot.url),
    reason: `Human action required: ${classifiedGate.cause}.` } : null;
  const userActionRequired = Boolean(gate) || snapshot.loginGate || snapshot.captcha.manualActionRequired || unresolvedFields.length > 0;
  const evidence = sanitizePersistedUrls({
    schemaVersion: 1,
    inspectedAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
    currentUrl: sanitizeUrl(snapshot.url),
    formFingerprint: digest(applicationFields.map((field) => ({ label: field.label, type: field.type, required: field.required }))),
    requiredFieldCount: applicationFields.filter((field) => field.visible !== false && field.required).length,
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
  });
  evidence.evidenceHash = digest(evidence);
  return { snapshot, plan, evidence, ...(gate ? { gate } : {}) };
}

async function prepareApplicationFormGuarded(page, profile, artifacts, { maxPasses = 4, ...options } = {}) {
  const aggregate = { completed: [], uploadedArtifacts: [], committedSelections: [], unresolvedFields: [] };
  const completedIds = new Set();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const snapshot = await inspectApplicationForm(page);
    const gate = classifyUserGate(snapshot);
    if (gate) return { gate, ...(await reviewApplicationForm(page, profile, artifacts, aggregate, options)) };
    const plan = buildFormPlan(snapshot, profile, artifacts, options);
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
  const reviewed = await reviewApplicationForm(page, profile, artifacts, aggregate, options);
  if (reviewed.gate?.state === 'human_action_required') return reviewed;
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

export async function prepareApplicationForm(page, profile, artifacts, options = {}) {
  try {
    return await prepareApplicationFormGuarded(page, profile, artifacts, options);
  } finally {
    await removeSubmissionGuard(page);
  }
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
