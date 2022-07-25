import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { dirname } from 'path'

import inject from '@rollup/plugin-inject'

// TODO: replce with `import.meta.resolve()` once this is supported without
// any experimental flags
const require = createRequire(import.meta.url)

const PROCESS_PATH = require.resolve('process-es6')
const BUFFER_PATH = require.resolve('buffer-es6')
const BROWSER_PATH = require.resolve('./assets/browser.js')
const DIRNAME = '\0node-globals:dirname'
const FILENAME = '\0node-globals:filename'

/** @type {{ [str: string]: string | [string, string] }} */
const injections = {
  'process.nextTick': [PROCESS_PATH, 'nextTick'],
  'process.browser': [BROWSER_PATH, 'browser'],
  'Buffer.isBuffer': [BUFFER_PATH, 'isBuffer'],
  process: PROCESS_PATH,
  Buffer: [BUFFER_PATH, 'Buffer'],
  __filename: FILENAME,
  __dirname: DIRNAME,
}

/** @returns {import("rollup").Plugin} */
export const nodeGlobals = function () {
  const dirs = new Map()
  return {
    ...inject({
      modules: injections,
    }),
    name: 'rollup-plugin-node-globals-netlify',
    load(id) {
      if (dirs.has(id)) {
        return `export default '${dirs.get(id)}'`
      }
    },
    resolveId: (importee, importer) => {
      if (importee === DIRNAME) {
        const id = randomBytes(15).toString('hex')
        dirs.set(id, dirname(importer))
        return id
      }
      if (importee === FILENAME) {
        const id = randomBytes(15).toString('hex')
        dirs.set(id, importer)
        return id
      }
    },
  }
}
