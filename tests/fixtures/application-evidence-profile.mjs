import { createHash } from 'node:crypto';

function sourceRecord(text, path) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    path,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length,
  };
}

export function attachFactualSources(profile, {
  cvText = profile.cvText || '',
  profileText = null,
} = {}) {
  const raw = profile.raw || {
    candidate: profile.candidate || {},
    location: profile.location || {},
    current_status: profile.currentStatus || {},
    compensation: profile.compensation || {},
    education_details: profile.education || {},
  };
  const serializedProfile = profileText || JSON.stringify(raw);
  return {
    ...profile,
    raw,
    cvText,
    sourceFiles: {
      ...(profile.sourceFiles || {}),
      cv: sourceRecord(cvText, 'fixture:cv.md'),
      profile: sourceRecord(serializedProfile, 'fixture:config/profile.yml'),
    },
  };
}
