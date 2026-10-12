/**
 * origin の URL から owner/repo を読む（Issue #789）。
 */

/** origin の URL から `owner/repo` を読む。読めなければ null（`my.repo` の . は残す） */
export function parseRepositoryUrl(url: string): string | null {
  const s = url.trim().replace(/\/$/, '').replace(/\.git$/, '').replace(/\/$/, '');
  const m = s.match(/github\.com[:/]([^/]+)\/([^/]+)$/) ?? s.match(/\/git\/([^/]+)\/([^/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export type RepositoryResult = { ok: true; repository: string } | { ok: false; error: string };

/** GITHUB_REPOSITORY があればそれ（origin は読まない）。無ければ origin の URL から読む */
export function resolveRepository(githubRepository: string | undefined, originUrl: () => string): RepositoryResult {
  if (githubRepository) return { ok: true, repository: githubRepository };
  const url = originUrl();
  const repository = parseRepositoryUrl(url);
  return repository ? { ok: true, repository } : { ok: false, error: `origin から owner/repo を判別できません: ${url}` };
}
