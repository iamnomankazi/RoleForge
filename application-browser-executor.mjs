#!/usr/bin/env node

/**
 * Phase 2 browser executor for exactly one hash-verified batch candidate.
 *
 * It verifies liveness and identity, follows at most one safe listing-to-form
 * continuation, and operates only on the verified form. It may fill supported
 * fields, but never activates the semantic final submission action. User review
 * and manual submission remain required. It never reads or writes the tracker.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  ROOT,
  acquireBatchExecutionLock,
  loadExecutionContract,
  transitionCandidateState,
  recordStaleLockRecovery,
} from './application-batch.mjs';
import { checkLivenessViaApi } from './liveness-api.mjs';
import {
  checkUrlLiveness,
  LIVENESS_CONTEXT_OPTIONS,
  rejectPrivateOrInvalid,
} from './liveness-browser.mjs';
import { loadApplicationProfile } from './application-profile.mjs';
import {
  attachOperationalArtifacts,
  inspectOperationalApplicationForm,
  inspectOperationalUploadTopology,
  prepareOperationalApplicationForm,
} from './application-form-engine.mjs';
import { prepareAndBindCombinedDocument } from './application-documents.mjs';
import { createConfiguredApplicationReasoningProvider } from './application-reasoning-provider.mjs';
import { openPersistentBrowserProfile } from './browser-profile.mjs';

function inline(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}


export function buildCandidateFormContext(contract) {
  const row = contract?.sourceCandidate?.sourceRow || {};
  const location = row.location && typeof row.location === 'object' ? row.location : {};
  let jobCountry = inline(row.jobCountry ?? row.job_country ?? row.country ?? location.country);
  const locationText = inline(typeof row.location === 'string' ? row.location : row.locationText);
  if (!jobCountry && /(?:^|,|\s)finland(?:$|,|\s)/i.test(locationText)) jobCountry = 'Finland';
  const jdText = inline(row.description ?? row.jobDescription ?? row.job_description ?? row.content);
  return {
    batchId: contract?.manifest?.batchId || null,
    candidate: {
      ...(contract?.candidate || {}),
      listingUrl: contract?.candidate?.listingUrl || contract?.candidateState?.listingUrl || null,
      applyUrl: contract?.candidate?.applyUrl || null,
    },
    jobCountry: jobCountry || null,
    hiringArrangement: inline(row.hiringArrangement ?? row.hiring_arrangement ?? row.employmentArrangement) || null,
    canEmployFromFinland: row.canEmployFromFinland === true || row.can_employ_from_finland === true,
    jdText,
    verifyApplicationContinuity,
  };
}

async function safeScreenshot(page, path) {
  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}

export async function prepareFormPassWithEvidence(page, browserContext, contract, root, {
  resumeMode = 'initial',
  previousEvidence = null,
} = {}) {
  const passId = `pass-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const evidenceParent = join(dirname(contract.manifestPath), 'evidence', contract.candidate.candidate_id);
  const evidenceDir = join(evidenceParent, passId);
  mkdirSync(evidenceParent, { recursive: true });
  mkdirSync(evidenceDir);
  const beforePath = join(evidenceDir, 'before.png');
  const afterPath = join(evidenceDir, 'after.png');
  const tracePath = join(evidenceDir, 'playwright-trace.zip');
  const beforeSnapshot = await inspectOperationalApplicationForm(page);
  const screenshotBefore = await safeScreenshot(page, beforePath);
  let tracing = false;
  if (browserContext?.tracing?.start) {
    await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    tracing = true;
  }
  let preparation;
  try {
    const profile = loadApplicationProfile(root);
    const reasoningProvider = createConfiguredApplicationReasoningProvider(profile);
    const artifacts = {
      ...contract.candidate.artifacts,
      coverLetterTextContent: readFileSync(contract.candidate.artifacts.coverLetterText.resolvedPath, 'utf8'),
      coverLetterTextProvenance: contract.candidate.artifacts.coverLetterText.narrativeProvenance || null,
    };
    preparation = await prepareOperationalApplicationForm(page, profile, artifacts, {
      context: buildCandidateFormContext(contract),
      previousEvidence,
      resumeMode,
      passId,
      reasoningProvider,
    });
  } finally {
    if (tracing) await browserContext.tracing.stop({ path: tracePath }).catch(() => {});
  }
  const screenshotAfter = await safeScreenshot(page, afterPath);
  return attachOperationalArtifacts(preparation, {
    screenshotBefore,
    screenshotAfter,
    trace: tracing ? tracePath : null,
    uploadTopologyBefore: inspectOperationalUploadTopology(beforeSnapshot),
    uploadTopologyAfter: preparation.evidence.uploadTopology,
    browserSessionOwnership: {
      mode: resumeMode === 'process_recovery' ? 'fresh_process_recovery_context' : 'existing_task_context',
      keepOpenRequired: preparation.evidence.browserOpenRequired,
    },
  });
}
function normalized(value) {
  return inline(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function safeCurrentUrl(value, fallback) {
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol)) return parsed.toString();
  } catch {
    // Use the manifest URL below.
  }
  return fallback;
}

function sameUrlIgnoringHash(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return false;
  }
}

export function parseExecutorArgs(argv) {
  const options = { headless: false, keepOpen: true, resumeLogin: false, resumePreparation: false, prepareForm: true, ephemeralBrowser: false };
  let keepOpenExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headless') {
      if (options.headless) throw new Error('Duplicate option: --headless');
      options.headless = true;
      continue;
    }
    if (arg === '--resume-login') {
      if (options.resumeLogin) throw new Error('Duplicate option: --resume-login');
      options.resumeLogin = true;
      continue;
    }
    if (arg === '--resume-preparation') {
      if (options.resumePreparation) throw new Error('Duplicate option: --resume-preparation');
      options.resumePreparation = true;
      continue;
    }
    if (arg === '--ephemeral-browser') {
      if (options.ephemeralBrowser) throw new Error('Duplicate option: --ephemeral-browser');
      options.ephemeralBrowser = true;
      continue;
    }
    if (arg === '--inspect-only') {
      options.prepareForm = false;
      continue;
    }
    if (arg === '--keep-open') {
      options.keepOpen = true;
      keepOpenExplicit = true;
      continue;
    }
    if (arg === '--close-after-check') {
      options.keepOpen = false;
      keepOpenExplicit = true;
      continue;
    }
    if (!['--manifest', '--candidate-id'].includes(arg)) {
      throw new Error(`Unknown or forbidden option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    const key = arg === '--manifest' ? 'manifest' : 'candidateId';
    if (options[key]) throw new Error(`Duplicate option: ${arg}`);
    options[key] = value;
    index += 1;
  }
  if (!options.manifest) throw new Error('Explicit --manifest path is required');
  if (!options.candidateId) throw new Error('Explicit exact --candidate-id from the manifest is required');
  if (options.headless && !keepOpenExplicit) options.keepOpen = false;
  if (options.prepareForm && (options.headless || !options.keepOpen)) {
    throw new Error('Application preparation requires a headed browser that remains open for CAPTCHA or user review; use --inspect-only for close-after/headless checks');
  }
  if (options.resumeLogin && !options.candidateId) throw new Error('--resume-login requires the exact --candidate-id selector');
  if (options.resumeLogin && options.resumePreparation) throw new Error('Use one resume mode at a time');
  if (options.resumeLogin && (options.headless || !options.keepOpen)) {
    throw new Error('--resume-login requires a headed task browser that remains open');
  }
  return options;
}

export function assertExecutorState(options, contract) {
  const expected = options.resumeLogin ? ['login_required']
    : options.resumePreparation ? ['actual_form_reached', 'review_required', 'blocked'] : ['not_opened'];
  if (!expected.includes(contract.candidateState.state)) {
    throw new Error(options.resumeLogin
      ? `Login resume requires login_required state for this exact candidate, found ${contract.candidateState.state}`
      : options.resumePreparation
        ? `Preparation resume requires actual_form_reached, review_required, or blocked state, found ${contract.candidateState.state}`
        : `Candidate is already ${contract.candidateState.state}; use the explicit same-candidate resume mode when applicable`);
  }
  return contract.candidateState.state;
}

export function preparationGateState(preparation) {
  return ['login_required', 'review_required', 'blocked'].includes(preparation?.gate?.state)
    ? preparation.gate.state
    : 'review_required';
}

export function shouldKeepBrowserOpen(candidateState) {
  if (!candidateState) return false;
  if (['actual_form_reached', 'form_prepared', 'review_required', 'login_required'].includes(candidateState.state)) return true;
  return candidateState.state === 'blocked'
    && Boolean(candidateState.formPreparation?.captcha?.manualActionRequired);
}

export function verifyVisibleIdentity(snapshot, candidate) {
  const visible = normalized([
    snapshot?.documentTitle,
    ...(Array.isArray(snapshot?.headings) ? snapshot.headings : []),
    snapshot?.bodyText,
  ].filter(Boolean).join(' '));
  const company = normalized(candidate?.company);
  const title = normalized(candidate?.title);
  const genericCompanyTokens = new Set([
    'ai', 'company', 'corporation', 'corp', 'group', 'gmbh', 'inc', 'limited', 'llc', 'ltd', 'oy', 'plc', 'sa', 'software', 'tech',
  ]);
  const companyAliases = inline(candidate?.company).split(/\s*\/\s*/)
    .map((value) => normalized(value))
    .filter((value) => {
      if (!value || value.length < 4) return false;
      const meaningfulTokens = value.split(' ').filter((token) => token.length >= 3 && !genericCompanyTokens.has(token));
      return meaningfulTokens.length > 0;
    });
  const corporateSuffixAlias = normalized(candidate?.company)
    .replace(/\b(?:gmbh|inc|incorporated|llc|ltd|limited|oy|oyj|plc|ag|se|sa|corp|corporation)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (corporateSuffixAlias && corporateSuffixAlias !== company) {
    const meaningfulTokens = corporateSuffixAlias.split(' ')
      .filter((token) => token.length >= 3 && !genericCompanyTokens.has(token));
    if (meaningfulTokens.length > 0) companyAliases.push(corporateSuffixAlias);
  }
  const matchedCompany = [company, ...companyAliases].find((value) => value && visible.includes(value)) || '';
  const companyMatch = Boolean(matchedCompany);
  const titleMatch = Boolean(title && visible.includes(title));
  return {
    companyMatch,
    titleMatch,
    verified: companyMatch && titleMatch,
    reason: companyMatch && titleMatch
      ? matchedCompany === company
        ? 'visible company and title match the batch manifest'
        : 'visible compound-company alias and title match the batch manifest'
      : `identity mismatch: company=${companyMatch ? 'match' : 'missing'}, title=${titleMatch ? 'match' : 'missing'}`,
  };
}

export function classifyFormSnapshot(snapshot) {
  const body = normalized(snapshot?.bodyText);
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields.filter((field) => field.visible !== false) : [];
  const descriptors = fields.map((field) => normalized(`${field.type || ''} ${field.text || ''}`));
  const hasPassword = fields.some((field) => normalized(field.type) === 'password');
  const hasEmail = descriptors.some((descriptor) => /email|e-mail/.test(descriptor));
  const loginText = /(sign in to apply|log in to apply|login to apply|create an account to apply|sign in or create|login or register|weiter mit e-mail-adresse|weiter als gast|einloggen)/.test(body);
  const authenticationPath = /\/(?:application|apply)\/authentication(?:[/?#]|$)/i.test(snapshot?.currentUrl || '');
  const loginRequired = hasPassword || loginText || (authenticationPath && hasEmail);

  const candidatePatterns = [
    /first name|given name/,
    /last name|family name|surname/,
    /full name|your name|candidate name/,
    /email/,
    /phone|telephone|mobile/,
    /resume|curriculum vitae|\bcv\b/,
    /linkedin/,
  ];
  const signalIndexes = new Set();
  for (let patternIndex = 0; patternIndex < candidatePatterns.length; patternIndex += 1) {
    if (descriptors.some((descriptor) => candidatePatterns[patternIndex].test(descriptor))) signalIndexes.add(patternIndex);
  }
  const hasResume = descriptors.some((descriptor) => /resume|curriculum vitae|\bcv\b/.test(descriptor));
  const formCount = Number(snapshot?.formCount || 0);
  const pathLooksLikeApplication = /\/(application|apply)(?:[/?#]|$)/i.test(snapshot?.currentUrl || '');
  const hasTerminalPostControl = (snapshot?.controls || []).some((control) => (
    control.visible !== false
    && control.inForm
    && control.associatedForm
    && normalized(control.formMethod) === 'post'
    && /\b(?:submit application|send application|complete application|apply now)\b/.test(normalized(control.text))
  ));
  const actualForm = !loginRequired && (
    (signalIndexes.size >= 2 && (formCount > 0 || fields.length >= 3))
    || (hasEmail && hasResume)
    || (pathLooksLikeApplication && signalIndexes.size >= 1 && formCount > 0)
    || (pathLooksLikeApplication && formCount > 0 && fields.length >= 5 && hasTerminalPostControl)
  );

  return {
    loginRequired,
    actualForm,
    candidateFieldSignals: signalIndexes.size,
    reason: loginRequired
      ? 'login/account gate detected before the application form'
      : actualForm
        ? `actual application form detected (${signalIndexes.size} candidate field signals)`
        : 'no actual candidate application form detected',
  };
}

const ENTRY_ACTION_LABEL = /^(?:apply|apply now|apply here!?|apply for (?:this|the) (?:job|role|position)|start (?:an? |your )?application|begin (?:an? |your )?application|continue to (?:the )?application|go to (?:the )?application|bewerben|jetzt bewerben|ich bin interessiert|postuler|hae paikkaa|hae nyt|hae työpaikkaa|ansök(?: nu)?|solliciteer(?: nu)?|ansøg(?: nu)?)$/i;
const FINAL_ACTION_LABEL = /(?:^|[^\p{L}\p{N}_])(?:submit|send|complete|finish|confirm|finali[sz]e|review and apply|apply and submit|absenden|senden|abschicken|verzenden|versturen|indsend|lähetä|valmis|skicka|envoyer|soumettre|valider)(?=$|[^\p{L}\p{N}_])/iu;
const ONE_CLICK_ENTRY_LABEL = /\b(?:(?:easy|quick|instant)\s+apply|(?:1|one)[- ]?click(?:[- ]apply)?|apply\s+with\s+(?:(?:your|my|a|saved)\s+)?(?:linkedin|indeed|profile|resume|cv))\b/i;
const DANGEROUS_ACTION_PATH = /\b(?:submit|send|complete|finish|confirm|finali[sz]e)[-_ ]?(?:application)?\b/i;

export function isKnownApplicationHost(value) {
  let hostname;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return /(?:^|\.)(?:greenhouse\.io|ashbyhq\.com|lever\.co|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|workable\.com|teamtailor\.com|recruitee\.com|personio\.(?:com|de)|icims\.com|phenompeople\.com|talentadore\.com|join\.com|bamboohr\.com|breezy\.hr|jobvite\.com|successfactors\.(?:com|eu)|oraclecloud\.com|taleo\.net|eightfold\.ai)$/.test(hostname);
}

function predictedEntryDestination(control) {
  return normalized(control?.tag) === 'a' ? inline(control?.href) : '';
}

function safePredictedEntryDestination(destination, { listingUrl } = {}) {
  if (!destination || rejectPrivateOrInvalid(destination)) return false;
  let parsed;
  let listing;
  try {
    parsed = new URL(destination);
    listing = new URL(listingUrl);
  } catch {
    return false;
  }
  if (DANGEROUS_ACTION_PATH.test(`${parsed.pathname} ${parsed.search}`)) return false;
  if (parsed.hostname === listing.hostname) return true;
  return isKnownApplicationHost(destination);
}

export function classifyApplicationEntryAction(control, {
  listingUrl,
  applyUrl = null,
  currentState = null,
  actualFormReached = false,
  candidateFieldSignals = 0,
} = {}) {
  const reject = (reason) => ({ safe: false, reason, destination: null });
  if (currentState !== 'listing_verified') return reject('entry actions require listing_verified state');
  if (actualFormReached || Number(candidateFieldSignals) > 0) {
    return reject('candidate application fields are already present');
  }
  if (!control?.visible) return reject('control is not visible');
  const tag = normalized(control?.tag);
  const type = normalized(control?.type);
  if (!['a', 'button'].includes(tag) && normalized(control?.role) !== 'button' && !(tag === 'input' && type === 'button')) {
    return reject('control type is not an entry link or button');
  }
  const text = inline(control?.text);
  if (ONE_CLICK_ENTRY_LABEL.test(text)) return reject('one-click or saved-profile application controls may submit immediately; continue manually');
  if (FINAL_ACTION_LABEL.test(text)) return reject('final application actions require manual submission');
  if (!ENTRY_ACTION_LABEL.test(text)) {
    return reject('control label is not an unambiguous application-entry action');
  }
  if (type === 'submit') return reject('submit controls are never listing continuations');
  const target = inline(control?.target).toLowerCase();
  if (target && !['_self', '_blank'].includes(target)) return reject('named browsing targets are not candidate-tab isolated');
  const associatedForm = Boolean(control?.associatedForm || control?.inForm);
  const formMethod = normalized(control?.formMethod || 'get');
  if (control?.formHasCandidateFields) return reject('associated form contains candidate data');
  if (formMethod === 'post') return reject('POST-associated controls may submit candidate data');
  if (associatedForm) return reject('form-associated controls are never application-entry actions');
  if (control?.formAction) return reject('controls with a formAction may submit candidate data');
  if (tag !== 'a') return { safe: true, reason: 'listing-page application-entry button', destination: null };
  const destination = predictedEntryDestination(control);
  if (!destination) return reject('application-entry anchor has no verifiable href; metadata destinations require manual continuation');
  if (!safePredictedEntryDestination(destination, { listingUrl })) {
    return reject('entry destination is not the selected company or a known ATS route');
  }
  return {
    safe: true,
    reason: 'verified listing-page application link',
    destination,
  };
}

export function selectSafeApplyContinuation(controls, scope = {}) {
  if (!Array.isArray(controls)) return null;
  return controls
    .filter((control) => classifyApplicationEntryAction(control, scope).safe)
    .sort((left, right) => {
      const score = (control) => (control.attached !== false ? 8 : 0)
        + (control.enabled !== false ? 8 : 0)
        + (control.visible ? 4 : 0)
        + (control.topmostMatches ? 4 : 0)
        + (control.boundingBox?.width > 0 && control.boundingBox?.height > 0 ? 1 : 0);
      return score(right) - score(left) || Number(left.index || 0) - Number(right.index || 0);
    })[0] || null;
}

export function listingSnapshotConfirmsSafeEntry(snapshot, candidate, {
  listingUrl,
  applyUrl = null,
} = {}) {
  const form = classifyFormSnapshot(snapshot);
  const identity = verifyVisibleIdentity(snapshot, candidate);
  if (!identity.verified) return false;
  if (form.actualForm || form.loginRequired) return true;
  return Boolean(selectSafeApplyContinuation(snapshot?.controls, {
    listingUrl: snapshot?.currentUrl || listingUrl,
    applyUrl,
    currentState: 'listing_verified',
    actualFormReached: false,
    candidateFieldSignals: form.candidateFieldSignals,
  }));
}

export function isCompatibleApplicationEntryDestination({
  listingUrl,
  applyUrl = null,
  currentUrl,
  identity,
}) {
  if (!identity?.verified || rejectPrivateOrInvalid(currentUrl)) return false;
  let listing;
  let current;
  try {
    listing = new URL(listingUrl);
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  if (current.hostname === listing.hostname) return true;
  if (applyUrl && sameUrlIgnoringHash(applyUrl, currentUrl)) return true;
  const listingRequisition = requisitionIdentity(listingUrl);
  const currentRequisition = requisitionIdentity(currentUrl);
  if (listingRequisition && listingRequisition === currentRequisition) return true;
  return isKnownApplicationHost(currentUrl);
}

export function requisitionIdentity(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  const path = parsed.pathname;
  let match = path.match(/^\/([^/]+)\/jobs\/(\d+)/i);
  if (match && /(^|\.)greenhouse\.io$/i.test(parsed.hostname)) {
    return `greenhouse:${match[1].toLowerCase()}:${match[2]}`;
  }
  match = path.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/i);
  if (match && parsed.hostname === 'jobs.ashbyhq.com') {
    return `ashby:${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
  }
  if (match && /^jobs\.(?:eu\.)?lever\.co$/i.test(parsed.hostname)) {
    return `lever:${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
  }
  return '';
}

export function isCompatibleDestination({ listingUrl, applyUrl = null, currentUrl, identity }) {
  let listing;
  let current;
  try {
    listing = new URL(listingUrl);
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  if (current.protocol !== 'https:' && current.protocol !== 'http:') return false;
  if (sameUrlIgnoringHash(listingUrl, currentUrl)) return true;
  if (applyUrl && sameUrlIgnoringHash(applyUrl, currentUrl)) return true;
  const listingRequisition = requisitionIdentity(listingUrl);
  const currentRequisition = requisitionIdentity(currentUrl);
  if (listingRequisition && listingRequisition === currentRequisition) return true;
  return Boolean(identity?.verified);
}

export function verifyApplicationContinuity({ beforeUrl, currentUrl, snapshot, candidate }) {
  let before;
  let current;
  try {
    before = new URL(beforeUrl);
    current = new URL(currentUrl);
  } catch {
    return { verified: false, reason: 'invalid application continuity URL' };
  }
  if (before.origin !== current.origin) return { verified: false, reason: 'application origin changed' };
  const listingUrl = candidate?.listingUrl || beforeUrl;
  const listingRequisition = requisitionIdentity(listingUrl);
  const beforeRequisition = requisitionIdentity(beforeUrl);
  const currentRequisition = requisitionIdentity(currentUrl);
  const expectedRequisition = listingRequisition || beforeRequisition;
  if (expectedRequisition) {
    return currentRequisition === expectedRequisition
      ? { verified: true, reason: 'ATS requisition identity remained exact' }
      : { verified: false, reason: 'ATS requisition identity changed or disappeared' };
  }
  const identity = verifyVisibleIdentity(snapshot, candidate || {});
  if (identity.verified) return identity;
  if (sameUrlIgnoringHash(beforeUrl, currentUrl) || (candidate?.applyUrl && sameUrlIgnoringHash(candidate.applyUrl, currentUrl))) {
    return { verified: true, reason: 'same exact application URL remained active' };
  }
  return { verified: false, reason: `application continuity is unverified: ${identity.reason}` };
}

export async function collectPageSnapshot(page) {
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
    };
    const textFor = (element) => {
      const id = element.getAttribute('id');
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return [
        label?.innerText,
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        element.getAttribute('name'),
        element.getAttribute('id'),
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    };
    globalThis.__careerOpsEntryControlCounter = Number(globalThis.__careerOpsEntryControlCounter || 0);
    const controls = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"], input[type="image"]')).map((element, index) => {
      let controlId = element.getAttribute('data-career-ops-entry-id');
      if (!controlId) {
        controlId = `entry-${++globalThis.__careerOpsEntryControlCounter}`;
        element.setAttribute('data-career-ops-entry-id', controlId);
      }
      const associatedForm = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
        ? element.form
        : element.closest('form');
      const formFields = associatedForm
        ? Array.from(associatedForm.querySelectorAll('input, textarea, select'))
        : [];
      const formHasCandidateFields = formFields.some((field) => (
        /first.?name|given.?name|last.?name|family.?name|surname|full.?name|your name|candidate name|e-?mail|phone|mobile|resume|curriculum|\bcv\b|linkedin/i.test(textFor(field))
      ));
      const rect = element.getBoundingClientRect();
      const centerInViewport = rect.width > 0 && rect.height > 0
        && rect.left + rect.width / 2 >= 0 && rect.left + rect.width / 2 < innerWidth
        && rect.top + rect.height / 2 >= 0 && rect.top + rect.height / 2 < innerHeight;
      const topmost = centerInViewport
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        index,
        controlId,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.type : element.getAttribute('type') || '',
        text: [element.innerText, element.getAttribute('value'), element.getAttribute('aria-label'), element.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        href: element instanceof HTMLAnchorElement ? element.href : '',
        target: element.getAttribute('target') || associatedForm?.getAttribute('target') || '',
        dataDestination: element.getAttribute('data-href')
          || element.getAttribute('data-url')
          || element.getAttribute('data-apply-url')
          || '',
        inForm: Boolean(element.closest('form')),
        associatedForm: Boolean(associatedForm),
        formMethod: associatedForm?.method || '',
        formAction: element.getAttribute('formaction') || associatedForm?.action || '',
        formHasCandidateFields,
        visible: visible(element),
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
        attached: element.isConnected,
        topmostMatches: Boolean(topmost && (topmost === element || element.contains(topmost))),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        outerHtml: element.outerHTML.slice(0, 500),
      };
    });
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).map((element) => ({
      id: element.id || '',
      name: element.getAttribute('name') || '',
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || element.tagName.toLowerCase(),
      role: element.getAttribute('role') || '',
      text: textFor(element),
      visible: visible(element),
    }));
    const candidatePattern = /first.?name|given.?name|last.?name|family.?name|surname|full.?name|your name|candidate name|e-?mail|phone|mobile|resume|curriculum|\bcv\b|linkedin/i;
    const visibleApplicationDialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'))
      .filter(visible)
      .map((dialog) => ({
        text: String(dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        candidateFieldCount: Array.from(dialog.querySelectorAll('input, textarea, select'))
          .filter(visible)
          .filter((field) => candidatePattern.test(textFor(field))).length,
      }))
      .filter((dialog) => dialog.candidateFieldCount > 0);
    const candidateFieldFingerprint = fields
      .filter((field) => field.visible && candidatePattern.test(`${field.type} ${field.text}`))
      .map((field) => `${field.type}:${field.text}`)
      .sort()
      .join('|')
      .slice(0, 2_000);
    return {
      documentTitle: document.title || '',
      headings: Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
        .filter(visible).map((element) => element.innerText || '').filter(Boolean).slice(0, 20),
      bodyText: (document.body?.innerText || '').slice(0, 20_000),
      formCount: Array.from(document.querySelectorAll('form')).filter(visible).length,
      fields,
      controls,
      applicationSurface: {
        visibleDialogCount: visibleApplicationDialogs.length,
        dialogs: visibleApplicationDialogs,
        candidateFieldFingerprint,
      },
    };
  });
  return { ...snapshot, currentUrl: page.url() };
}

async function inspectEntryControl(locator) {
  return locator.evaluate((element) => {
      const style = window.getComputedStyle(element);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      const textFor = (field) => {
        const id = field.getAttribute('id');
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return [
          label?.innerText,
          field.getAttribute('aria-label'),
          field.getAttribute('placeholder'),
          field.getAttribute('name'),
          field.getAttribute('id'),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      };
      const associatedForm = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
        ? element.form
        : element.closest('form');
      const formHasCandidateFields = Boolean(associatedForm) && Array.from(
        associatedForm.querySelectorAll('input, textarea, select'),
      ).some((field) => (
        /first.?name|given.?name|last.?name|family.?name|surname|full.?name|your name|candidate name|e-?mail|phone|mobile|resume|curriculum|\bcv\b|linkedin/i.test(textFor(field))
      ));
      const rect = element.getBoundingClientRect();
      const centerInViewport = rect.width > 0 && rect.height > 0
        && rect.left + rect.width / 2 >= 0 && rect.left + rect.width / 2 < innerWidth
        && rect.top + rect.height / 2 >= 0 && rect.top + rect.height / 2 < innerHeight;
      const topmost = centerInViewport
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return {
        controlId: element.getAttribute('data-career-ops-entry-id') || '',
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.type : element.getAttribute('type') || '',
        text: [element.innerText, element.getAttribute('value'), element.getAttribute('aria-label'), element.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
        href: element instanceof HTMLAnchorElement ? element.href : '',
        target: element.getAttribute('target') || associatedForm?.getAttribute('target') || '',
        dataDestination: element.getAttribute('data-href')
          || element.getAttribute('data-url')
          || element.getAttribute('data-apply-url')
          || '',
        inForm: Boolean(element.closest('form')),
        associatedForm: Boolean(associatedForm),
        formMethod: associatedForm?.method || '',
        formAction: element.getAttribute('formaction') || associatedForm?.action || '',
        formHasCandidateFields,
        visible,
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
        attached: element.isConnected,
        topmostMatches: Boolean(topmost && (topmost === element || element.contains(topmost))),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        interceptor: topmost && topmost !== element && !element.contains(topmost)
          ? {
            tag: topmost.tagName.toLowerCase(),
            id: topmost.id || '',
            className: String(topmost.className || '').slice(0, 180),
            text: String(topmost.innerText || topmost.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 180),
          }
          : null,
        outerHtml: element.outerHTML.slice(0, 500),
      };
    });
}

async function reacquireSafeContinuation(page, expected, scope) {
  if (!inline(expected?.controlId)) {
    throw new Error('Verified application continuation has no Career-Ops exact control identity');
  }
  const escaped = String(expected.controlId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locator = page.locator(`[data-career-ops-entry-id="${escaped}"]`);
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`Verified application continuation exact identity resolved ${count} controls; refusing to navigate`);
  }
  const current = await inspectEntryControl(locator);
  const safe = selectSafeApplyContinuation([current], scope);
  if (!safe
      || current.controlId !== expected.controlId
      || normalized(safe.tag) !== normalized(expected.tag)
      || inline(safe.text) !== inline(expected.text)
      || predictedEntryDestination(safe) !== predictedEntryDestination(expected)) {
    throw new Error('Verified application continuation changed before activation; refusing to navigate');
  }
  return { locator, control: current };
}

function equivalentEntryAction(left, right) {
  return normalized(left?.tag) === normalized(right?.tag)
    && inline(left?.text) === inline(right?.text)
    && predictedEntryDestination(left) === predictedEntryDestination(right);
}

export async function rankSafeApplyContinuations(page, controls, scope = {}) {
  const safe = (Array.isArray(controls) ? controls : [])
    .filter((control) => classifyApplicationEntryAction(control, scope).safe);
  const ranked = [];
  for (const expected of safe) {
    try {
      let acquired = await reacquireSafeContinuation(page, expected, scope);
      await acquired.locator.scrollIntoViewIfNeeded({ timeout: 1_500 }).catch(() => {});
      acquired = await reacquireSafeContinuation(page, expected, scope);
      const navigationReady = acquired.control.attached && acquired.control.enabled && acquired.control.visible
        && (normalized(acquired.control.tag) === 'a' || acquired.control.topmostMatches);
      ranked.push({ ...acquired.control, index: expected.index, navigationReady });
    } catch (error) {
      ranked.push({ ...expected, navigationReady: false, rankingError: inline(error.message).slice(0, 300) });
    }
  }
  return ranked.sort((left, right) => {
    const score = (control) => (control.navigationReady ? 32 : 0)
      + (control.attached !== false ? 8 : 0)
      + (control.enabled !== false ? 8 : 0)
      + (control.visible ? 4 : 0)
      + (control.topmostMatches ? 4 : 0);
    return score(right) - score(left) || Number(left.index || 0) - Number(right.index || 0);
  });
}

async function inspectBenignSiteChromeActions(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const rootSelector = [
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[id*="cmp" i]', '[class*="cmp" i]', '[id*="privacy-prompt" i]', '[class*="privacy-prompt" i]',
      '#GDPRConsentManagerContainer', '#fixedfooter',
    ].join(',');
    globalThis.__careerOpsSiteChromeCounter = Number(globalThis.__careerOpsSiteChromeCounter || 0);
    return Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(visible)
      .flatMap((element) => {
        const root = element.closest(rootSelector);
        if (!root || !visible(root)) return [];
        const scopeRoot = root.closest('#GDPRConsentManagerContainer') || root;
        const rootEvidence = normalize(`${scopeRoot.id || ''} ${scopeRoot.className || ''} ${scopeRoot.innerText || ''}`);
        if (!/(?:cookie|consent|cmp|gdpr|privacy prompt|datenschutz)/.test(rootEvidence)) return [];
        const label = normalize(element.getAttribute('aria-label') || element.innerText || element.getAttribute('value'));
        let kind = null;
        if (/^(?:only the necessary cookies|reject all|reject non[- ]essential(?: cookies)?|decline all non[- ]necessary cookies|necessary only|continue without accepting|alle ablehnen|nur notwendige(?: cookies)?|nur erforderliche(?: cookies)?)$/.test(label)) {
          kind = 'privacy_preserving_dismissal';
        } else if (/^(?:einstellungen oder ablehnen|cookie preferences|manage preferences|show details)$/.test(label)) {
          kind = 'open_privacy_preferences';
        } else if (/^(?:save and exit|save settings|speichern und beenden)$/.test(label)) {
          kind = 'save_privacy_minimum';
        }
        if (!kind) return [];
        let actionId = element.getAttribute('data-career-ops-site-chrome-id');
        if (!actionId) {
          actionId = `site-chrome-${++globalThis.__careerOpsSiteChromeCounter}`;
          element.setAttribute('data-career-ops-site-chrome-id', actionId);
        }
        const checkedOptionalControls = Array.from(scopeRoot.querySelectorAll('input[type="checkbox"], [role="switch"]'))
          .filter((control) => !control.disabled && control.getAttribute('aria-disabled') !== 'true')
          .filter((control) => {
            const identity = normalize(`${control.id || ''} ${control.getAttribute('name') || ''}`);
            if (/accordion|legal-description/.test(identity)) return false;
            return control.checked === true || control.getAttribute('aria-checked') === 'true';
          }).length;
        return [{
          actionId,
          kind,
          label,
          root: {
            id: scopeRoot.id || '',
            className: String(scopeRoot.className || '').slice(0, 180),
            text: normalize(scopeRoot.innerText).slice(0, 300),
          },
          privacyMinimal: checkedOptionalControls === 0,
        }];
      });
  });
}

async function activateSiteChromeAction(page, expected) {
  const escaped = String(expected.actionId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const locator = page.locator(`[data-career-ops-site-chrome-id="${escaped}"]`);
  if (await locator.count() !== 1) throw new Error('Site-chrome action identity changed before activation');
  const current = (await inspectBenignSiteChromeActions(page)).find((action) => action.actionId === expected.actionId);
  if (!current || current.kind !== expected.kind || current.label !== expected.label) {
    throw new Error('Site-chrome action no longer matches the verified privacy-preserving control');
  }
  await locator.click({ trial: true, timeout: 2_000 });
  await locator.click({ timeout: 4_000 });
  return current;
}

export async function clearBenignListingSiteChrome(page) {
  const before = await collectPageSnapshot(page);
  const form = classifyFormSnapshot(before);
  if (form.actualForm || form.candidateFieldSignals > 0) {
    return { cleared: false, detected: false, actions: [], reason: 'Application form is already present.' };
  }
  let actions = await inspectBenignSiteChromeActions(page);
  const direct = actions.find((action) => action.kind === 'privacy_preserving_dismissal');
  if (direct) {
    const activated = await activateSiteChromeAction(page, direct);
    await page.waitForTimeout(350);
    return { cleared: true, detected: true, actions: [activated], reason: 'Privacy-preserving site-chrome dismissal activated.' };
  }
  const opener = actions.find((action) => action.kind === 'open_privacy_preferences');
  if (!opener) return { cleared: false, detected: actions.length > 0, actions: [], reason: 'No privacy-preserving CMP action is available.' };
  const opened = await activateSiteChromeAction(page, opener);
  const preferenceDeadline = Date.now() + 3_000;
  let save = null;
  do {
    await page.waitForTimeout(200);
    actions = await inspectBenignSiteChromeActions(page);
    save = actions.find((action) => action.kind === 'save_privacy_minimum' && action.privacyMinimal) || null;
  } while (!save && Date.now() < preferenceDeadline);
  if (!save) {
    return {
      cleared: false,
      detected: true,
      actions: [opened],
      reason: 'Privacy preferences opened, but a verified all-optional-off save action was unavailable.',
    };
  }
  const saved = await activateSiteChromeAction(page, save);
  await page.waitForTimeout(350);
  return { cleared: true, detected: true, actions: [opened, saved], reason: 'Privacy-minimal CMP preferences saved.' };
}

async function inspectContinuationAttempt(context, page, before, beforeUrl, expectedDestination, observationWindowMs, baselineSnapshot = null) {
  const deadline = Date.now() + observationWindowMs;
  const observedUrls = new Set([beforeUrl]);
  let created = [];
  let snapshots = [];
  do {
    created = context.pages().filter((candidatePage) => !before.has(candidatePage));
    const pages = [page, ...created];
    snapshots = await Promise.all(pages.map(async (candidatePage) => {
      await candidatePage.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {});
      try {
        const snapshot = await collectPageSnapshot(candidatePage);
        observedUrls.add(snapshot.currentUrl);
        return { page: candidatePage, snapshot };
      } catch {
        return { page: candidatePage, snapshot: null };
      }
    }));
    const meaningfulSnapshot = (snapshot) => Boolean(
      snapshot
      && (
        inline(snapshot.documentTitle)
        || inline(snapshot.bodyText).length >= 40
        || (Array.isArray(snapshot.fields) && snapshot.fields.some((field) => field.visible !== false))
        || Number(snapshot.formCount || 0) > 0
      )
    );
    const exactDestination = expectedDestination && !sameUrlIgnoringHash(expectedDestination, beforeUrl)
      ? snapshots.find(({ snapshot }) => meaningfulSnapshot(snapshot) && sameUrlIgnoringHash(snapshot.currentUrl, expectedDestination))
      : null;
    const consequential = snapshots.find(({ snapshot, page: candidatePage }) => {
      if (!snapshot) return false;
      const form = classifyFormSnapshot(snapshot);
      const baselineSurface = baselineSnapshot?.applicationSurface || {};
      const currentSurface = snapshot.applicationSurface || {};
      const applicationSurfaceChanged = Number(currentSurface.visibleDialogCount || 0) > Number(baselineSurface.visibleDialogCount || 0)
        && currentSurface.candidateFieldFingerprint
        && currentSurface.candidateFieldFingerprint !== baselineSurface.candidateFieldFingerprint;
      const verifiedNavigation = safePredictedEntryDestination(snapshot.currentUrl, { listingUrl: beforeUrl });
      return form.actualForm
        || (verifiedNavigation && form.loginRequired)
        || applicationSurfaceChanged
        || (verifiedNavigation && meaningfulSnapshot(snapshot) && candidatePage !== page && snapshot.currentUrl !== 'about:blank')
        || (verifiedNavigation && meaningfulSnapshot(snapshot) && !sameUrlIgnoringHash(snapshot.currentUrl, beforeUrl));
    });
    const outcome = exactDestination || consequential;
    if (outcome) {
      return {
        succeeded: true,
        destination: outcome.page,
        created,
        observation: {
          observedUrls: [...observedUrls],
          pageCountBefore: before.size,
          pageCountAfter: context.pages().length,
          form: classifyFormSnapshot(outcome.snapshot),
          applicationSurface: outcome.snapshot.applicationSurface || null,
        },
      };
    }
    if (Date.now() < deadline) await page.waitForTimeout(200).catch(() => {});
  } while (Date.now() < deadline);
  return {
    succeeded: false,
    destination: page,
    created,
    observation: {
      observedUrls: [...observedUrls],
      pageCountBefore: before.size,
      pageCountAfter: context.pages().length,
      form: snapshots[0]?.snapshot ? classifyFormSnapshot(snapshots[0].snapshot) : null,
      applicationSurface: snapshots[0]?.snapshot?.applicationSurface || null,
    },
  };
}

async function verifiedEmbeddedApplicationFrame(page, snapshot) {
  let listing;
  try {
    listing = new URL(snapshot?.currentUrl || page.url());
  } catch {
    return null;
  }
  const greenhouseJobId = listing.searchParams.get('gh_jid');
  const iframeLocator = page.locator('iframe[src]');
  if (typeof iframeLocator.evaluateAll !== 'function') return null;
  const frames = await iframeLocator.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      src: node.getAttribute('src') || '',
      title: node.getAttribute('title') || '',
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
    };
  })).catch(() => []);
  for (const frame of frames) {
    if (!frame.visible || !frame.src) continue;
    let destination;
    try {
      destination = new URL(frame.src, listing);
    } catch {
      continue;
    }
    if (!/(?:^|\.)greenhouse\.io$/i.test(destination.hostname)) continue;
    if (destination.pathname !== '/embed/job_app') continue;
    const token = destination.searchParams.get('token');
    const exactListingBacklink = destination.searchParams.get('b');
    if (!token || (greenhouseJobId
      ? token !== greenhouseJobId
      : !exactListingBacklink || !sameUrlIgnoringHash(exactListingBacklink, listing.toString()))) continue;
    if (!isKnownApplicationHost(destination.toString())) continue;
    return { url: destination.toString(), title: inline(frame.title) || 'Embedded Greenhouse application' };
  }
  return null;
}

export async function followSafeContinuation(context, page, control, scope, {
  observationWindowMs = 4_500,
} = {}) {
  const beforeUrl = page.url();
  const baselineSnapshot = await collectPageSnapshot(page);
  const expectedDestination = predictedEntryDestination(control);
  const method = normalized(control.tag) === 'a' ? 'verified_href_navigation' : 'playwright_click';
  let acquired = null;
  let methodError = null;
  const before = new Set(context.pages());
  try {
    const baselineForm = classifyFormSnapshot(baselineSnapshot);
    const freshScope = {
      ...scope,
      actualFormReached: scope.actualFormReached || baselineForm.actualForm,
      candidateFieldSignals: Math.max(Number(scope.candidateFieldSignals || 0), baselineForm.candidateFieldSignals),
    };
    acquired = await reacquireSafeContinuation(page, control, freshScope);
    if (!acquired.control.attached || !acquired.control.enabled) {
      throw new Error('Verified entry link is detached or disabled; refusing to navigate');
    }
    if (method === 'verified_href_navigation') {
      await page.goto(predictedEntryDestination(acquired.control), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else {
      await acquired.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      const activationForm = classifyFormSnapshot(await collectPageSnapshot(page));
      acquired = await reacquireSafeContinuation(page, control, {
        ...freshScope,
        actualFormReached: freshScope.actualFormReached || activationForm.actualForm,
        candidateFieldSignals: Math.max(freshScope.candidateFieldSignals, activationForm.candidateFieldSignals),
      });
      await acquired.locator.click({ timeout: 7_000 });
    }
  } catch (error) {
    methodError = error;
  }
  const outcome = await inspectContinuationAttempt(
    context, page, before, beforeUrl, expectedDestination, observationWindowMs, baselineSnapshot,
  );
  const attempts = [{
    method,
    control: acquired?.control || control,
    error: methodError ? inline(methodError.message).slice(0, 1_000) : null,
    observation: outcome.observation,
  }];
  if (outcome.succeeded) {
    for (const extra of outcome.created) {
      if (extra !== outcome.destination) await extra.close().catch(() => {});
    }
    await outcome.destination.waitForTimeout(750).catch(() => {});
    Object.defineProperty(outcome.destination, '__careerOpsEntryInteractionEvidence', {
      configurable: true,
      value: { successfulMethod: method, attempts },
    });
    return outcome.destination;
  }
  for (const extra of outcome.created) await extra.close().catch(() => {});
  const error = new Error('Application-entry activation did not reach the application surface');
  error.code = 'application_entry_interaction_failed';
  error.entryDiagnostics = {
    controlId: control.controlId,
    tag: control.tag,
    text: inline(control.text).slice(0, 180),
    destination: expectedDestination || null,
    duplicateCandidateCount: Number(control.duplicateCandidateCount || 1),
    urlBefore: beforeUrl,
    urlAfter: page.url(),
    attempts,
  };
  throw error;
}

function canonicalVisitedUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return inline(value);
  }
}

export async function followSafeApplicationEntryFlow(context, initialPage, initialSnapshot, candidate, {
  listingUrl,
  applyUrl = null,
  observationWindowMs = 4_500,
} = {}) {
  let page = initialPage;
  let snapshot = initialSnapshot;
  let form = classifyFormSnapshot(snapshot);
  let identity = verifyVisibleIdentity(snapshot, candidate);
  let compatible = isCompatibleApplicationEntryDestination({
    listingUrl,
    applyUrl,
    currentUrl: snapshot.currentUrl,
    identity,
  });
  const visitedUrls = new Set([canonicalVisitedUrl(snapshot.currentUrl)]);
  const usedActions = new Set();
  const hops = [];
  const siteChromeActions = [];
  let siteChromeRecoveries = 0;
  let hopLimit = 1;

  while (!form.actualForm && !form.loginRequired && hops.length < hopLimit) {
    const embeddedFrame = await verifiedEmbeddedApplicationFrame(page, snapshot);
    if (embeddedFrame) {
      const sourceUrl = snapshot.currentUrl;
      await page.goto(embeddedFrame.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(Math.min(observationWindowMs, 1_000));
      snapshot = await collectPageSnapshot(page);
      form = classifyFormSnapshot(snapshot);
      identity = verifyVisibleIdentity(snapshot, candidate);
      compatible = isCompatibleApplicationEntryDestination({
        listingUrl,
        applyUrl,
        currentUrl: snapshot.currentUrl,
        identity,
      });
      hops.push({
        sourceUrl,
        destinationUrl: snapshot.currentUrl,
        tag: 'iframe',
        text: embeddedFrame.title,
        controlId: 'verified-embedded-greenhouse-form',
        duplicateCandidateCount: 1,
        activationMethod: 'verified_iframe_navigation',
        siteChromeActions: [...siteChromeActions],
      });
      if (!compatible || (!form.actualForm && !form.loginRequired)) {
        return {
          page,
          snapshot,
          form,
          identity,
          compatible,
          hops,
          siteChromeActions,
          reason: !compatible
            ? `Embedded application destination is incompatible: ${identity.reason}`
            : 'Verified embedded Greenhouse destination did not expose an application form.',
        };
      }
      break;
    }
    const scope = {
      listingUrl: snapshot.currentUrl || listingUrl,
      applyUrl,
      currentState: 'listing_verified',
      actualFormReached: false,
      candidateFieldSignals: form.candidateFieldSignals,
    };
    const rankedContinuations = await rankSafeApplyContinuations(page, snapshot.controls, scope);
    if (!rankedContinuations.length) {
      const rejectedEntry = snapshot.controls.find((control) => control.visible && (
        ENTRY_ACTION_LABEL.test(inline(control.text)) || ONE_CLICK_ENTRY_LABEL.test(inline(control.text)) || FINAL_ACTION_LABEL.test(inline(control.text))
      ));
      const rejection = rejectedEntry ? classifyApplicationEntryAction(rejectedEntry, scope) : null;
      return {
        page,
        snapshot,
        form,
        identity,
        compatible,
        hops,
        siteChromeActions,
        ...(rejection ? { manualReviewRequired: true } : {}),
        reason: rejection
          ? `Application entry requires manual review: ${rejection.reason}.`
          : 'No safe listing-page application-entry action was found.',
      };
    }
    const preferred = rankedContinuations[0];
    const equivalentContinuations = rankedContinuations.filter((candidateControl) => equivalentEntryAction(candidateControl, preferred));
    const sourceUrl = snapshot.currentUrl;
    let continuation = null;
    let recoveredSiteChrome = false;
    const failedCandidates = [];
    for (const candidateControl of equivalentContinuations.slice(0, 3)) {
      const actionKey = [
        canonicalVisitedUrl(snapshot.currentUrl),
        candidateControl.controlId,
        normalized(candidateControl.tag),
        normalized(candidateControl.text),
        predictedEntryDestination(candidateControl),
      ].join('|');
      if (usedActions.has(actionKey)) continue;
      usedActions.add(actionKey);
      const attempted = { ...candidateControl, duplicateCandidateCount: equivalentContinuations.length };
      try {
        page = await followSafeContinuation(context, page, attempted, scope, { observationWindowMs });
        continuation = attempted;
        break;
      } catch (error) {
        if (error?.code !== 'application_entry_interaction_failed') throw error;
        failedCandidates.push(error.entryDiagnostics || { controlId: attempted.controlId, error: inline(error.message) });
        const intercepted = error.entryDiagnostics?.attempts?.some((attempt) => attempt.control?.interceptor);
        if (intercepted && siteChromeRecoveries < 2) {
          const clearance = await clearBenignListingSiteChrome(page);
          siteChromeActions.push(...clearance.actions.map((action) => ({ ...action, result: clearance.reason })));
          if (clearance.cleared) {
            siteChromeRecoveries += 1;
            const entryResnapshotDeadline = Date.now() + 3_000;
            do {
              snapshot = await collectPageSnapshot(page);
              form = classifyFormSnapshot(snapshot);
              const refreshedScope = {
                listingUrl: snapshot.currentUrl || listingUrl,
                applyUrl,
                currentState: 'listing_verified',
                actualFormReached: form.actualForm,
                candidateFieldSignals: form.candidateFieldSignals,
              };
              if (form.actualForm || form.loginRequired || selectSafeApplyContinuation(snapshot.controls, refreshedScope)) break;
              await page.waitForTimeout(200);
            } while (Date.now() < entryResnapshotDeadline);
            identity = verifyVisibleIdentity(snapshot, candidate);
            compatible = isCompatibleApplicationEntryDestination({
              listingUrl,
              applyUrl,
              currentUrl: snapshot.currentUrl,
              identity,
            });
            usedActions.clear();
            recoveredSiteChrome = true;
            break;
          }
        }
      }
    }
    if (recoveredSiteChrome) continue;
    if (!continuation) {
      return {
        page,
        snapshot,
        form,
        identity,
        compatible,
        hops,
        siteChromeActions,
        manualReviewRequired: true,
        reason: 'Verified equivalent application-entry controls could not reach the application surface.',
        diagnostics: { candidates: failedCandidates, siteChromeActions },
      };
    }
    snapshot = await collectPageSnapshot(page);
    form = classifyFormSnapshot(snapshot);
    identity = verifyVisibleIdentity(snapshot, candidate);
    compatible = isCompatibleApplicationEntryDestination({
      listingUrl,
      applyUrl,
      currentUrl: snapshot.currentUrl,
      identity,
    });
    hops.push({
      sourceUrl,
      destinationUrl: snapshot.currentUrl,
      tag: continuation.tag,
      text: continuation.text,
      controlId: continuation.controlId,
      duplicateCandidateCount: continuation.duplicateCandidateCount,
      activationMethod: page.__careerOpsEntryInteractionEvidence?.successfulMethod || null,
      siteChromeActions: [...siteChromeActions],
    });
    if (!compatible) {
      return {
        page,
        snapshot,
        form,
        identity,
        compatible,
        hops,
        siteChromeActions,
        reason: `Application-entry destination is incompatible: ${identity.reason}`,
      };
    }
    if (form.actualForm || form.loginRequired) break;

    const destinationKey = canonicalVisitedUrl(snapshot.currentUrl);
    if (visitedUrls.has(destinationKey)) {
      return {
        page,
        snapshot,
        form,
        identity,
        compatible,
        hops,
        siteChromeActions,
        reason: 'Repeated application-entry URL loop was prevented.',
      };
    }
    visitedUrls.add(destinationKey);
    if (hops.length === 1 && isKnownApplicationHost(snapshot.currentUrl)) {
      hopLimit = 2;
      continue;
    }
    break;
  }

  return {
    page,
    snapshot,
    form,
    identity,
    compatible,
    hops,
    siteChromeActions,
    reason: form.actualForm
      ? `Actual application form reached after ${hops.length} verified entry action(s).`
      : form.loginRequired
        ? `Login gate reached after ${hops.length} verified entry action(s).`
        : hops.length >= hopLimit
          ? `Application-entry hop limit (${hopLimit}) reached without an actual form.`
          : 'Application-entry action did not reach an actual form.',
  };
}

function transition(manifestPath, candidateId, toState, currentUrl, reason, expectedFrom, lockToken, details = null, formPreparation = null, root = ROOT) {
  return transitionCandidateState(manifestPath, candidateId, toState, {
    currentUrl,
    reason,
    expectedFrom,
    lockToken,
    details,
    formPreparation,
    root,
  });
}

export async function executeCandidate(options, { root = ROOT, dependencies = {} } = {}) {
  if (!options.candidateId) throw new Error('Canonical executor requires one exact candidate ID');
  const executionLock = acquireBatchExecutionLock(options.manifest, {
    root,
    candidateId: options.candidateId,
    operation: options.resumeLogin ? 'resume_login' : 'prepare_application',
  });
  if (executionLock.staleRecovery) {
    recordStaleLockRecovery(options.manifest, executionLock.staleRecovery, { root, lockToken: executionLock.token });
  }
  try {
    return await executeCandidateLocked(options, { root, executionLock, dependencies });
  } catch (error) {
    // Runtime failures that occur before the first successful browser-state
    // transition (API liveness errors, launch/page failures) are still scoped
    // to this exact locked candidate. Integrity/preflight failures cannot load
    // a valid contract here and therefore remain mutation-free.
    try {
      const contract = loadExecutionContract(options.manifest, options.candidateId, {
        root,
        requireCoverLetter: true,
      });
      if (contract.candidateState.state === 'not_opened') {
        transition(
          contract.manifestPath,
          contract.candidate.candidate_id,
          'blocked',
          contract.candidate.listingUrl,
          `Candidate execution stopped safely before opening: ${inline(error.message).slice(0, 350)}`,
          'not_opened',
          executionLock.token,
          null,
          null,
          root,
        );
      }
    } catch {
      // Preserve the original failure. If authority or CAS validation failed,
      // no secondary state write is safe.
    }
    throw error;
  } finally {
    executionLock.release();
  }
}

async function createOwnedBrowserSession(options, root, dependencies, contract) {
  let session;
  if (dependencies.openBrowserProfile) {
    session = await dependencies.openBrowserProfile({
      root,
      headless: options.headless,
      contextOptions: LIVENESS_CONTEXT_OPTIONS,
    });
  } else if (options.ephemeralBrowser || dependencies.launchBrowser) {
    const browser = dependencies.launchBrowser
      ? await dependencies.launchBrowser(options)
      : await (await import('playwright')).chromium.launch({ headless: options.headless });
    const context = dependencies.createContext
      ? await dependencies.createContext(browser, contract)
      : await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    session = {
      browser,
      context,
      async close() {
        if (browser.isConnected()) await browser.close();
      },
    };
  } else {
    session = await openPersistentBrowserProfile({
      root,
      headless: options.headless,
      contextOptions: LIVENESS_CONTEXT_OPTIONS,
    });
  }
  try {
    if (dependencies.configureContext) await dependencies.configureContext(session.context, contract);
  } catch (error) {
    await closeOwnedBrowserSession(session, session.browser);
    throw error;
  }
  return session;
}

async function closeOwnedBrowserSession(session, browser) {
  try {
    if (session?.close) await session.close();
    else if (browser?.isConnected?.()) await browser.close();
  } catch {
    // The browser may already have been closed by the user. The profile lock's
    // close handler and session cleanup both release ownership idempotently.
  }
}

/**
 * Run the canonical one-candidate executor inside a coordinator-owned browser
 * context and page. The candidate lock, immutable manifest checks, liveness,
 * identity, form preparation, evidence, and state transitions remain owned by
 * executeCandidate(); only browser lifecycle ownership is injected.
 */
export async function executeCandidateInBrowserContext(options, {
  root = ROOT,
  browser,
  context,
  page,
  dependencies = {},
} = {}) {
  if (!browser || !context || !page) {
    throw new Error('Shared browser execution requires an existing browser, context, and exact candidate page');
  }
  if (options.resumeLogin) {
    throw new Error('Shared browser execution does not automate interactive login resume');
  }
  if (typeof page.context === 'function' && page.context() !== context) {
    throw new Error('Shared candidate page does not belong to the supplied browser context');
  }
  return executeCandidate(options, {
    root,
    dependencies: {
      ...dependencies,
      browserSession: { browser, context, page },
    },
  });
}

async function executeCandidateLocked(options, { root, executionLock, dependencies }) {
  const contract = loadExecutionContract(options.manifest, options.candidateId, { root, requireCoverLetter: true });
  assertExecutorState(options, contract);

  if (options.resumeLogin) return executeLoginResume(options, contract, { root, executionLock, dependencies });
  if (options.resumePreparation) return executePreparationResume(options, contract, { root, executionLock, dependencies });

  const listingUrl = contract.candidate.listingUrl;
  const recordTransition = (manifestPath, _legacySelector, ...args) => transition(
    manifestPath, contract.candidate.candidate_id, ...args, executionLock.token, null, null, root,
  );
  const apiLiveness = await (dependencies.checkLivenessViaApi || checkLivenessViaApi)(listingUrl);
  if (apiLiveness?.result === 'expired') {
    const state = recordTransition(
      contract.manifestPath,
      contract.candidate.candidate_id,
      'closed',
      listingUrl,
      `Fresh liveness check: ${apiLiveness.reason}`,
      'not_opened',
    );
    return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
  }

  const sharedSession = dependencies.browserSession || null;
  const ownsBrowser = !sharedSession;
  const ownedBrowserSession = ownsBrowser
    ? await createOwnedBrowserSession(options, root, dependencies, contract)
    : null;
  const browser = sharedSession?.browser || ownedBrowserSession.browser;
  const context = sharedSession?.context || ownedBrowserSession.context;
  let finalState = null;
  let latestUrl = listingUrl;
  let applicationPage = null;

  try {
    const listingPage = sharedSession?.page || await context.newPage();
    if (dependencies.onCandidatePage) await dependencies.onCandidatePage(listingPage, contract);
    const browserLiveness = await (dependencies.checkUrlLiveness || checkUrlLiveness)(listingPage, listingUrl);
    const listingSnapshot = await collectPageSnapshot(listingPage);
    const listingCurrentUrl = safeCurrentUrl(listingSnapshot.currentUrl, listingUrl);
    latestUrl = listingCurrentUrl;
    const earlyForm = classifyFormSnapshot(listingSnapshot);
    const listingIdentity = verifyVisibleIdentity(listingSnapshot, contract.candidate);
    const domConfirmsSafeEntry = listingSnapshotConfirmsSafeEntry(listingSnapshot, contract.candidate, {
      listingUrl: listingCurrentUrl,
      applyUrl: contract.candidate.applyUrl,
    });
    const listingDestinationCompatible = isCompatibleDestination({
      listingUrl,
      applyUrl: contract.candidate.applyUrl,
      currentUrl: listingCurrentUrl,
      identity: listingIdentity,
    });

    if (browserLiveness.result === 'expired') {
      finalState = recordTransition(
        contract.manifestPath,
        listingUrl,
        'closed',
        listingCurrentUrl,
        `Fresh browser liveness check: ${browserLiveness.reason}`,
        'not_opened',
      );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
    }
    if (earlyForm.loginRequired) {
      finalState = listingDestinationCompatible
        ? recordTransition(
          contract.manifestPath,
          listingUrl,
          'login_required',
          listingCurrentUrl,
          earlyForm.reason,
          'not_opened',
        )
        : recordTransition(
          contract.manifestPath,
          listingUrl,
          'blocked',
          listingCurrentUrl,
          'Login redirect is not compatible with the selected manifest candidate.',
          'not_opened',
        );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
    }
    if (browserLiveness.result !== 'active' && !domConfirmsSafeEntry) {
      finalState = recordTransition(
        contract.manifestPath,
        listingUrl,
        'blocked',
        listingCurrentUrl,
        `Liveness could not be confirmed: ${browserLiveness.reason}`,
        'not_opened',
      );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
    }

    if (!listingIdentity.verified || !listingDestinationCompatible) {
      finalState = recordTransition(
        contract.manifestPath,
        listingUrl,
        'blocked',
        listingCurrentUrl,
        `Listing identity or redirect is incompatible: ${listingIdentity.reason}`,
        'not_opened',
      );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
    }

    finalState = recordTransition(
      contract.manifestPath,
      listingUrl,
      'listing_verified',
      listingCurrentUrl,
      `${browserLiveness.result === 'active' ? 'Fresh liveness active' : 'Fresh executor DOM confirmed a safe application entry'}; ${listingIdentity.reason}`,
      'not_opened',
    );

    if (earlyForm.actualForm) {
      applicationPage = listingPage;
      if (dependencies.onCandidatePage) await dependencies.onCandidatePage(applicationPage, contract);
      finalState = recordTransition(
        contract.manifestPath,
        listingUrl,
        'actual_form_reached',
        listingCurrentUrl,
        earlyForm.reason,
        'listing_verified',
      );
    } else {
      const entryFlow = await followSafeApplicationEntryFlow(
        context,
        listingPage,
        listingSnapshot,
        contract.candidate,
        {
          listingUrl: listingCurrentUrl,
          applyUrl: contract.candidate.applyUrl,
        },
      );
      const formPage = entryFlow.page;
      const formCurrentUrl = safeCurrentUrl(entryFlow.snapshot.currentUrl, listingCurrentUrl);
      latestUrl = formCurrentUrl;

      if (entryFlow.form.loginRequired) {
        finalState = entryFlow.compatible
          ? recordTransition(
            contract.manifestPath,
            listingUrl,
            'login_required',
            formCurrentUrl,
            `${entryFlow.form.reason}; ${entryFlow.reason}`,
            'listing_verified',
          )
          : recordTransition(
            contract.manifestPath,
            listingUrl,
            'blocked',
            formCurrentUrl,
            'Login redirect is not compatible with the selected manifest candidate.',
            'listing_verified',
          );
        return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
      }
      if (!entryFlow.compatible) {
        finalState = recordTransition(
          contract.manifestPath,
          listingUrl,
          'blocked',
          formCurrentUrl,
          entryFlow.reason,
          'listing_verified',
        );
        return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
      }
      if (!entryFlow.form.actualForm) {
        finalState = transition(
          contract.manifestPath,
          contract.candidate.candidate_id,
          entryFlow.manualReviewRequired ? 'review_required' : 'blocked',
          formCurrentUrl,
          entryFlow.reason,
          'listing_verified',
          executionLock.token,
          entryFlow.diagnostics ? { entryInteraction: entryFlow.diagnostics } : null,
          null,
          root,
        );
        return { batchId: contract.manifest.batchId, candidate: listingUrl, state: finalState.state };
      }

      finalState = transition(
        contract.manifestPath,
        contract.candidate.candidate_id,
        'actual_form_reached',
        formCurrentUrl,
        `${entryFlow.form.reason}; ${entryFlow.reason}`,
        'listing_verified',
        executionLock.token,
        { entryActions: entryFlow.hops },
        null,
        root,
      );
      applicationPage = formPage;
      if (dependencies.onCandidatePage) await dependencies.onCandidatePage(applicationPage, contract);
      if (formPage !== listingPage) await listingPage.close().catch(() => {});
    }

    if (finalState?.state === 'actual_form_reached' && options.prepareForm) {
      try {
        const profile = loadApplicationProfile(root);
        const artifacts = {
          ...contract.candidate.artifacts,
          coverLetterTextContent: readFileSync(contract.candidate.artifacts.coverLetterText.resolvedPath, 'utf8'),
          coverLetterTextProvenance: contract.candidate.artifacts.coverLetterText.narrativeProvenance || null,
        };
        const preparation = await prepareFormPassWithEvidence(applicationPage, context, contract, root, {
          resumeMode: 'initial', previousEvidence: null,
        });
        const evidence = preparation.evidence;
        const details = {
          requiredFieldCount: evidence.requiredFieldCount,
          unresolvedFieldCount: evidence.unresolvedFields.length,
          uploadCount: evidence.uploadedArtifacts.length,
          validationErrorCount: evidence.validationErrors.length,
          finalActionDetected: evidence.finalAction.detected,
          finalActionActivated: evidence.finalAction.activated,
          progressionTransitions: evidence.progression?.stepsAdvanced || 0,
        };
        finalState = transition(
          contract.manifestPath,
          contract.candidate.candidate_id,
          'form_inspected',
          evidence.currentUrl,
          'Inspected the complete actual application form and identified required controls.',
          'actual_form_reached',
          executionLock.token,
          details,
          evidence,
          root,
        );
        const completedSafeControls = evidence.filledFields.length
          || evidence.committedSelections.length
          || evidence.uploadedArtifacts.length;
        if (completedSafeControls) {
          finalState = transition(
            contract.manifestPath,
            contract.candidate.candidate_id,
            'fields_filled',
            evidence.currentUrl,
            'All safely completable grounded controls were filled or committed and verified.',
            finalState.state,
            executionLock.token,
            details,
            evidence,
            root,
          );
        }
        if (evidence.uploadedArtifacts.length) {
          finalState = transition(
            contract.manifestPath,
            contract.candidate.candidate_id,
            'files_uploaded',
            evidence.currentUrl,
            'Exact bound artifact filenames were uploaded and verified.',
            finalState.state,
            executionLock.token,
            details,
            evidence,
            root,
          );
        }
        if (preparation.gate || !evidence.reviewComplete) {
          const gateState = preparationGateState(preparation);
          finalState = transition(
            contract.manifestPath,
            contract.candidate.candidate_id,
            gateState,
            evidence.currentUrl,
            preparation.gate?.reason || 'User review is required for unresolved, unsupported, or consent fields.',
            finalState.state,
            executionLock.token,
            details,
            evidence,
            root,
          );
          if (evidence.uploadTopology?.mode === 'single_combined' && !contract.candidate.artifacts.combinedDocument) {
            await prepareAndBindCombinedDocument({
              manifestPath: contract.manifestPath,
              candidateId: contract.candidate.candidate_id,
              confirmFormEvidenceHash: evidence.evidenceHash,
              root,
              lockToken: executionLock.token,
            });
            console.log('Combined application document generated and bound. Preflight confirmation is invalidated; confirm the exact batch again before --resume-preparation.');
          }
        } else {
          finalState = transition(
            contract.manifestPath,
            contract.candidate.candidate_id,
            'form_prepared',
            evidence.currentUrl,
            'Whole-form review passed; required fields and uploads verified; final action detected and untouched.',
            finalState.state,
            executionLock.token,
            details,
            evidence,
            root,
          );
        }
      } catch (error) {
        if (['actual_form_reached', 'form_inspected', 'fields_filled', 'files_uploaded'].includes(finalState?.state)) {
          finalState = transition(
            contract.manifestPath,
            contract.candidate.candidate_id,
            'review_required',
            latestUrl,
            `Form preparation requires review: ${inline(error.message).slice(0, 350)}`,
            finalState.state,
            executionLock.token,
            null,
            null,
            root,
          );
        } else {
          throw error;
        }
      }
    }

    if (ownsBrowser && shouldKeepBrowserOpen(finalState) && options.keepOpen) {
      console.log(`${finalState.state}. The final action remains untouched. Close the task browser to finish.`);
      await new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
    }

    return {
      batchId: contract.manifest.batchId,
      candidate: listingUrl,
      state: finalState?.state || 'blocked',
      currentUrl: finalState?.currentUrl || listingUrl,
      cv: contract.candidate.artifacts.cv?.intendedFilename || null,
      coverLetter: contract.candidate.artifacts.coverLetter?.intendedFilename || null,
      submissionAvailable: false,
      trackerUpdated: false,
    };
  } catch (error) {
    if (['listing_verified', 'actual_form_reached', 'form_inspected', 'fields_filled', 'files_uploaded'].includes(finalState?.state)) {
      try {
        finalState = recordTransition(
          contract.manifestPath,
          listingUrl,
          'blocked',
          latestUrl,
          `Browser execution stopped safely after an error: ${inline(error.message).slice(0, 300)}`,
          finalState.state,
        );
      } catch {
        // Preserve the original execution error; state CAS/lock failures remain
        // visible on the next preflight rather than being hidden here.
      }
    }
    throw error;
  } finally {
    if (dependencies.beforeBrowserClose) {
      await dependencies.beforeBrowserClose({ browser, context, contract, ownsBrowser });
    }
    if (ownsBrowser) await closeOwnedBrowserSession(ownedBrowserSession, browser);
  }
}

async function prepareResumedForm(page, contract, root, executionLock) {
  try {
    const preparation = await prepareFormPassWithEvidence(page, page.context(), contract, root, {
      resumeMode: 'process_recovery',
      previousEvidence: contract.candidateState.formPreparation,
    });
    const evidence = preparation.evidence;
    const details = {
      requiredFieldCount: evidence.requiredFieldCount,
      unresolvedFieldCount: evidence.unresolvedFields.length,
      uploadCount: evidence.uploadedArtifacts.length,
      validationErrorCount: evidence.validationErrors.length,
      finalActionDetected: evidence.finalAction.detected,
      finalActionActivated: evidence.finalAction.activated,
      progressionTransitions: evidence.progression?.stepsAdvanced || 0,
    };
    const move = (to, from, reason) => transition(
      contract.manifestPath, contract.candidate.candidate_id, to, evidence.currentUrl,
      reason, from, executionLock.token, details, evidence, root,
    );
    let state = move('form_inspected', 'actual_form_reached', 'Inspected the complete form after fresh login revalidation.');
    const completedSafeControls = evidence.filledFields.length
      || evidence.committedSelections.length
      || evidence.uploadedArtifacts.length;
    if (completedSafeControls) {
      state = move('fields_filled', state.state, 'All safely completable grounded controls were filled or committed and verified after revalidation.');
    }
    if (evidence.uploadedArtifacts.length) {
      state = move('files_uploaded', state.state, 'Exact bound uploads were visibly verified after revalidation.');
    }
    if (preparation.gate || !evidence.reviewComplete) {
      return move(
        preparationGateState(preparation),
        state.state,
        preparation.gate?.reason || 'User review is required for unresolved, unsupported, or consent fields.',
      );
    }
    return move('form_prepared', state.state, 'Whole-form review passed after login; semantic final action remains untouched.');
  } catch (error) {
    return transition(
      contract.manifestPath, contract.candidate.candidate_id, 'review_required', page.url(),
      `Post-login form preparation requires review: ${inline(error.message).slice(0, 350)}`,
      'actual_form_reached', executionLock.token, null, null, root,
    );
  }
}

async function executePreparationResume(options, contract, { root, executionLock, dependencies }) {
  const listingUrl = contract.candidate.listingUrl;
  const fromState = contract.candidateState.state;
  const api = await (dependencies.checkLivenessViaApi || checkLivenessViaApi)(listingUrl);
  if (api?.result === 'expired') {
    const state = transition(
      contract.manifestPath, contract.candidate.candidate_id,
      'closed', listingUrl,
      `Fresh preparation-resume liveness check found the posting expired: ${api?.reason || 'expired'}`,
      fromState, executionLock.token, null, null, root,
    );
    return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
  }
  const sharedSession = dependencies.browserSession || null;
  const ownsBrowser = !sharedSession;
  const ownedBrowserSession = ownsBrowser
    ? await createOwnedBrowserSession(options, root, dependencies, contract)
    : null;
  const browser = sharedSession?.browser || ownedBrowserSession.browser;
  const context = sharedSession?.context || ownedBrowserSession.context;
  try {
    const listingPage = sharedSession?.page || await context.newPage();
    if (dependencies.onCandidatePage) await dependencies.onCandidatePage(listingPage, contract);
    const live = await (dependencies.checkUrlLiveness || checkUrlLiveness)(listingPage, listingUrl);
    const listingSnapshot = await collectPageSnapshot(listingPage);
    const identity = verifyVisibleIdentity(listingSnapshot, contract.candidate);
    const domConfirmsSafeEntry = listingSnapshotConfirmsSafeEntry(listingSnapshot, contract.candidate, {
      listingUrl,
      applyUrl: contract.candidate.applyUrl,
    });
    if ((live.result !== 'active' && !domConfirmsSafeEntry) || !identity.verified) {
      const state = transition(
        contract.manifestPath, contract.candidate.candidate_id, 'blocked', listingPage.url(),
        `Preparation resume listing revalidation failed: ${live.reason}; ${identity.reason}`,
        fromState, executionLock.token, null, null, root,
      );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
    }
    const entryFlow = await followSafeApplicationEntryFlow(
      context,
      listingPage,
      listingSnapshot,
      contract.candidate,
      { listingUrl, applyUrl: contract.candidate.applyUrl },
    );
    const page = entryFlow.page;
    if (entryFlow.form.loginRequired && entryFlow.compatible) {
      const state = transition(
        contract.manifestPath, contract.candidate.candidate_id, 'login_required', page.url(),
        `${entryFlow.form.reason}; ${entryFlow.reason}`,
        fromState, executionLock.token, { entryActions: entryFlow.hops }, null, root,
      );
      if (dependencies.onCandidatePage) await dependencies.onCandidatePage(page, contract);
      if (page !== listingPage) await listingPage.close().catch(() => {});
      if (ownsBrowser && options.keepOpen) {
        console.log('login_required after verified application entry. Complete the external authentication choice manually; Career-Ops will not continue automatically.');
        await new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
      }
      return {
        batchId: contract.manifest.batchId,
        candidate: listingUrl,
        state: state.state,
        currentUrl: state.currentUrl,
        submissionAvailable: false,
        trackerUpdated: false,
      };
    }
    if (!entryFlow.form.actualForm || !entryFlow.compatible) {
      if (entryFlow.manualReviewRequired && entryFlow.compatible) {
        const state = transition(
          contract.manifestPath, contract.candidate.candidate_id, 'review_required', page.url(),
          entryFlow.reason, fromState, executionLock.token,
          entryFlow.diagnostics ? { entryInteraction: entryFlow.diagnostics } : null,
          null, root,
        );
        return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
      }
      throw new Error(`Fresh resume did not reach the exact verified application form: ${entryFlow.reason}; ${entryFlow.identity.reason}`);
    }
    if (dependencies.onCandidatePage) await dependencies.onCandidatePage(page, contract);
    if (page !== listingPage) await listingPage.close().catch(() => {});
    if (['review_required', 'blocked'].includes(fromState)) {
      transition(
        contract.manifestPath, contract.candidate.candidate_id, 'actual_form_reached', page.url(),
        'Fresh same-candidate resume revalidated the source, artifacts, listing identity, and actual form.',
        fromState, executionLock.token, { entryActions: entryFlow.hops }, null, root,
      );
    }
    const state = await prepareResumedForm(page, contract, root, executionLock);
    if (ownsBrowser && options.keepOpen) {
      console.log(`${state.state} after preparation resume. The final action remains untouched. Close the task browser to finish.`);
      await new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
    }
    return {
      batchId: contract.manifest.batchId,
      candidate: listingUrl,
      state: state.state,
      currentUrl: state.currentUrl,
      submissionAvailable: false,
      trackerUpdated: false,
    };
  } catch (error) {
    const current = loadExecutionContract(contract.manifestPath, contract.candidate.candidate_id, { root, requireCoverLetter: true }).candidateState.state;
    if (['actual_form_reached', 'review_required'].includes(current)) {
      const state = transition(
        contract.manifestPath, contract.candidate.candidate_id, 'blocked', listingUrl,
        `Preparation resume stopped safely: ${inline(error.message).slice(0, 350)}`,
        current, executionLock.token, null, null, root,
      );
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
    }
    throw error;
  } finally {
    if (dependencies.beforeBrowserClose) {
      await dependencies.beforeBrowserClose({ browser, context, contract, ownsBrowser });
    }
    if (ownsBrowser) await closeOwnedBrowserSession(ownedBrowserSession, browser);
  }
}

async function executeLoginResume(options, contract, { root, executionLock, dependencies }) {
  const listingUrl = contract.candidate.listingUrl;
  const recordTransition = (manifestPath, _legacySelector, ...args) => transition(
    manifestPath, contract.candidate.candidate_id, ...args, executionLock.token, null, null, root,
  );
  const apiLiveness = await checkLivenessViaApi(listingUrl);
  if (apiLiveness?.result === 'expired') {
    const state = recordTransition(contract.manifestPath, listingUrl, 'closed', listingUrl,
      `Fresh liveness check before login resume: ${apiLiveness.reason}`, 'login_required');
    return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
  }
  if (apiLiveness?.result && apiLiveness.result !== 'active') {
    const state = recordTransition(contract.manifestPath, listingUrl, 'blocked', listingUrl,
      `Liveness could not be confirmed before login resume: ${apiLiveness.reason}`, 'login_required');
    return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
  }

  const ownedBrowserSession = await createOwnedBrowserSession(options, root, dependencies, contract);
  const { browser, context } = ownedBrowserSession;
  try {
    const page = await context.newPage();
    await page.goto(contract.candidateState.currentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(1_500);
    const snapshot = await collectPageSnapshot(page);
    const currentUrl = safeCurrentUrl(snapshot.currentUrl, contract.candidateState.currentUrl);
    const identity = verifyVisibleIdentity(snapshot, contract.candidate);
    const form = classifyFormSnapshot(snapshot);
    const compatible = isCompatibleDestination({
      listingUrl,
      applyUrl: contract.candidate.applyUrl,
      currentUrl,
      identity,
    });
    if (!compatible) {
      const state = recordTransition(contract.manifestPath, listingUrl, 'blocked', currentUrl,
        'Login resume redirected outside the selected candidate identity.', 'login_required');
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
    }
    if (form.actualForm && identity.verified) {
      let state = recordTransition(contract.manifestPath, listingUrl, 'actual_form_reached', currentUrl,
        `Fresh login resume revalidation: ${form.reason}; ${identity.reason}`, 'login_required');
      if (options.prepareForm) state = await prepareResumedForm(page, contract, root, executionLock);
      console.log(`${state.state} after login revalidation. The final action remains untouched. Close the task browser to finish.`);
      await new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state, currentUrl };
    }
    if (!form.loginRequired) {
      const state = recordTransition(contract.manifestPath, listingUrl, 'blocked', currentUrl,
        'Login resume did not show either the login gate or a verified application form.', 'login_required');
      return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
    }
    console.log('Login is still required. Complete login only in this task-created browser; this invocation will revalidate the destination and stop at the verified form.');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (browser.isConnected() && Date.now() < deadline) {
      try {
        await page.waitForTimeout(1_000);
        const resumedSnapshot = await collectPageSnapshot(page);
        const resumedForm = classifyFormSnapshot(resumedSnapshot);
        if (resumedForm.loginRequired) continue;
        const resumedUrl = safeCurrentUrl(resumedSnapshot.currentUrl, currentUrl);
        const resumedIdentity = verifyVisibleIdentity(resumedSnapshot, contract.candidate);
        const resumedCompatible = isCompatibleDestination({
          listingUrl,
          applyUrl: contract.candidate.applyUrl,
          currentUrl: resumedUrl,
          identity: resumedIdentity,
        });
        if (resumedCompatible && resumedIdentity.verified && resumedForm.actualForm) {
          let state = recordTransition(contract.manifestPath, listingUrl, 'actual_form_reached', resumedUrl,
            `Fresh post-login revalidation: ${resumedForm.reason}; ${resumedIdentity.reason}`, 'login_required');
          if (options.prepareForm) state = await prepareResumedForm(page, contract, root, executionLock);
          console.log(`${state.state} after login. The final action remains untouched. Close the task browser to finish.`);
          await new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
          return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state, currentUrl: resumedUrl };
        }
        const state = recordTransition(contract.manifestPath, listingUrl, 'blocked', resumedUrl,
          `Post-login destination is not the verified application form: ${resumedIdentity.reason}; ${resumedForm.reason}`,
          'login_required');
        return { batchId: contract.manifest.batchId, candidate: listingUrl, state: state.state };
      } catch (error) {
        if (!browser.isConnected()) break;
        throw error;
      }
    }
    return { batchId: contract.manifest.batchId, candidate: listingUrl, state: 'login_required', currentUrl };
  } finally {
    await closeOwnedBrowserSession(ownedBrowserSession, browser);
  }
}

function usage() {
  return 'Usage: node application-browser-executor.mjs --manifest <manifest.json> --candidate-id <exact-id> [--headless] [--close-after-check] [--inspect-only] [--resume-login|--resume-preparation] [--ephemeral-browser]';
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const options = parseExecutorArgs(process.argv.slice(2));
  const result = await executeCandidate(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
