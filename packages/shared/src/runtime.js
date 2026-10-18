import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** True when this module is the process entrypoint, even via npm/npx bin symlinks, spaces in paths, or Windows. */
export function isMain(metaUrl) {
  try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href === metaUrl : false; }
  catch { return false; }
}
