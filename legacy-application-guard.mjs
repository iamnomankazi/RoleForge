export const LEGACY_APPLICATION_ENTRYPOINT_DISABLED = true;
export const APPLICATION_ADMIN_AUTHORITY = 'immutable_manifest_and_exact_candidate_only';

export function disableLegacyApplicationEntrypoint(entrypoint) {
  const error = new Error(
    `Legacy application entrypoint disabled: ${entrypoint}. `
    + 'Application execution requires output/application-batches/<batch-id>/manifest.json '
    + 'and an exact candidate ID. Use application-batch.mjs, legacy-queue-importer.mjs, '
    + 'and application-browser-executor.mjs; no queue/rank/hard-coded fallback is available.',
  );
  error.code = 'LEGACY_APPLICATION_ENTRYPOINT_DISABLED';
  throw error;
}
