import assert from 'node:assert/strict';
import { access, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  applicationReasoningOutputSchema,
  buildCodexExecArgs,
  createConfiguredApplicationReasoningProvider,
  runCodexExecChild,
  sanitizedCodexExecEnvironment,
} from '../application-reasoning-provider.mjs';
import {
  boundedProviderCall,
  validateSemanticAnnotationResponse,
} from '../application-reasoning.mjs';

const profile = {
  formRules: {
    reasoning: {
      enabled: true,
      provider: 'codex_exec',
      model: 'gpt-5.6-luna',
    },
  },
};

function semanticRequest(kind = 'semantic_classification') {
  const common = {
    batchId: 'batch-test',
    candidateId: `cand_v1_${'a'.repeat(64)}`,
    applicationFormId: 'application',
    resolutionKey: 'resolution:test',
    questionDigest: `sha256:${'b'.repeat(64)}`,
    controlType: 'input|text||',
    question: 'Correo electrónico',
    kind,
    reasonCode: 'unknown_field',
    required: true,
    options: [],
  };
  const field = kind === 'semantic_classification'
    ? { ...common, allowedSemantics: ['email', 'phone'] }
    : {
      ...common,
      question: 'How did you hear about us?',
      options: [
        { label: 'Professional network', value: 'network' },
        { label: 'Company website', value: 'website' },
        { label: 'Employee referral', value: 'referral' },
      ],
      canonicalValue: 'LinkedIn',
      canonicalValueHash: `sha256:${'c'.repeat(64)}`,
      optionsDigest: `sha256:${'d'.repeat(64)}`,
    };
  return {
    schemaVersion: 1,
    task: 'semantic_annotations_only',
    fields: [field],
    requestDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function outputPath(args) {
  return args[args.indexOf('-o') + 1];
}

test('codex_exec uses an empty isolated cwd, stdin payload, native schema output, and no API key', async () => {
  const request = semanticRequest();
  let invocation;
  const provider = createConfiguredApplicationReasoningProvider(profile, {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CODEX_HOME: 'C:\\safe-codex-home',
      OPENAI_API_KEY: 'must-not-pass',
      OPENAI_BASE_URL: 'https://api.openai.test/v1',
      CAREER_OPS_REASONING_API_KEY: 'must-not-pass',
      CODEX_ACCESS_TOKEN: 'must-not-pass',
    },
    codexExecutable: 'codex-test.exe',
    codexRunner: async (call) => {
      invocation = call;
      assert.deepEqual(await readdir(call.cwd), []);
      await writeFile(outputPath(call.args), JSON.stringify({
        schemaVersion: 1,
        annotations: [{
          resolutionKey: request.fields[0].resolutionKey,
          kind: 'semantic_classification',
          semantic: 'email',
        }],
      }));
    },
  });

  const raw = await provider.annotate(request);
  const accepted = validateSemanticAnnotationResponse(raw, request, {
    providerIdentity: provider.identity,
  });
  assert.equal(accepted[0].annotation.semantic, 'email');
  assert.equal(invocation.executable, 'codex-test.exe');
  assert.equal(invocation.args[0], 'exec');
  for (const flag of [
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', '-o', '-m', 'gpt-5.6-luna',
  ]) assert.ok(invocation.args.includes(flag), `missing ${flag}`);
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.args.includes(request.fields[0].question), false);
  assert.match(invocation.input, /UNTRUSTED_DATA/);
  assert.match(invocation.input, /Correo electrónico/);
  assert.equal(invocation.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.env.OPENAI_BASE_URL, undefined);
  assert.equal(invocation.env.CAREER_OPS_REASONING_API_KEY, undefined);
  assert.equal(invocation.env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(invocation.env.CODEX_HOME, 'C:\\safe-codex-home');
  await assert.rejects(access(invocation.cwd));
});

test('codex_exec model override is explicit when configured and omitted for the authenticated default', () => {
  const configured = buildCodexExecArgs({
    cwd: 'work', schemaPath: 'schema', outputPath: 'output', model: 'gpt-5.6-luna',
  });
  assert.deepEqual(configured.slice(configured.indexOf('-m'), configured.indexOf('-m') + 2), ['-m', 'gpt-5.6-luna']);
  const defaulted = buildCodexExecArgs({ cwd: 'work', schemaPath: 'schema', outputPath: 'output', model: '' });
  assert.equal(defaulted.includes('-m'), false);
  assert.deepEqual(defaulted.slice(defaulted.indexOf('-c'), defaulted.indexOf('-c') + 2), [
    '-c', 'web_search="disabled"',
  ]);
});

test('codex_exec output schema restricts option mapping to exact visible options or no-match', () => {
  const schema = applicationReasoningOutputSchema(semanticRequest('option_mapping'));
  const variants = schema.properties.annotations.items.anyOf;
  assert.equal(variants.length, 2);
  assert.deepEqual(variants[0].properties.selectedVisibleOption.enum, [
    'Professional network', 'network', 'Company website', 'website', 'Employee referral', 'referral',
  ]);
  assert.equal(variants[1].properties.noSemanticMatch.const, true);
});

test('codex_exec environment sanitizer removes known API credentials without inspecting auth storage', () => {
  const sanitized = sanitizedCodexExecEnvironment({
    Path: 'path', CODEX_HOME: 'home', openai_api_key: 'secret', OpenRouter_Api_Key: 'secret', CUSTOM: 'ok',
  });
  assert.equal(sanitized.openai_api_key, undefined);
  assert.equal(sanitized.OpenRouter_Api_Key, undefined);
  assert.equal(sanitized.CODEX_HOME, 'home');
  assert.equal(sanitized.CUSTOM, 'ok');
});

test('codex_exec fails closed on missing or malformed structured output', async () => {
  const request = semanticRequest();
  const missing = createConfiguredApplicationReasoningProvider(profile, {
    env: {}, codexRunner: async () => {},
  });
  await assert.rejects(missing.annotate(request), /no structured content/);

  const malformed = createConfiguredApplicationReasoningProvider(profile, {
    env: {},
    codexRunner: async ({ args }) => writeFile(outputPath(args), '{not-json'),
  });
  await assert.rejects(malformed.annotate(request), /malformed structured content/);
});

test('codex_exec propagates a single nonzero transport failure without retrying', async () => {
  let calls = 0;
  const provider = createConfiguredApplicationReasoningProvider(profile, {
    env: {},
    codexRunner: async () => {
      calls += 1;
      throw new Error('Codex exec failed with exit code 7');
    },
  });
  await assert.rejects(provider.annotate(semanticRequest()), /exit code 7/);
  assert.equal(calls, 1);
});

test('low-level codex child runner reports nonzero exit and terminates on abort', async () => {
  await assert.rejects(runCodexExecChild({
    executable: process.execPath,
    args: ['-e', 'process.exitCode = 7'],
    cwd: process.cwd(),
    env: process.env,
    input: '',
  }), /exit code 7/);

  const controller = new AbortController();
  const running = runCodexExecChild({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: process.env,
    input: '',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, /aborted/);
});

test('bounded timeout aborts the injected child runner and remains fail-closed', async () => {
  let aborted = false;
  const provider = createConfiguredApplicationReasoningProvider(profile, {
    env: {},
    codexRunner: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('Codex exec aborted'));
      }, { once: true });
    }),
  });
  const state = {
    calls: { fallback: 0, verifier: 0, total: 0 },
    limits: { fallbackCalls: 1, verifierCalls: 1, totalCalls: 1, timeoutMs: 25 },
  };
  await assert.rejects(
    boundedProviderCall(provider, 'annotate', semanticRequest(), state),
    /timed out/,
  );
  assert.equal(aborted, true);
  assert.deepEqual(state.calls, { fallback: 1, verifier: 0, total: 1 });
});
