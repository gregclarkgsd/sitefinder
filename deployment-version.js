import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
let commit = process.env.RENDER_GIT_COMMIT || null;
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* Build archives may have no Git metadata. */ }
}
export const deploymentVersion = { version, commit, mcpVersion: '1.1.0' };
