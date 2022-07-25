import { Buffer } from 'buffer'
import { createHash } from 'crypto'
import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import { resolve as resolvePath, join, extname, basename } from 'path'
import { env, platform } from 'process'

import presetEnv from '@babel/preset-env'
import { babel } from '@rollup/plugin-babel'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import del from 'del'
import { rollup } from 'rollup'
import nodePolyfills from 'rollup-plugin-node-polyfills'
import { terser } from 'rollup-plugin-terser'

import { MANIFEST_FILE, MAIN_FILE, CONTENT_TYPE } from './consts.js'
import { nodeGlobals } from './node-compat/globals.js'
import { uploadBundle } from './upload.js'

function getShasum(buf) {
  const shasum = createHash('sha1')
  shasum.update(buf)
  return shasum.digest('hex')
}

/**
 * Generates an entrypoint for bundling the handlers
 * It also makes sure all handlers are registered with the runtime
 *
 * @param {string} EDGE_HANDLERS_SRC path to the edge handler directory
 * @returns {Promise<{ handlers: string[], mainFile: string }>} list of handlers and path to entrypoint
 */
export const assemble = async function (EDGE_HANDLERS_SRC) {
  const entries = await fsPromises.readdir(EDGE_HANDLERS_SRC, { withFileTypes: true })
  const handlers = entries.filter(isHandlerFile).map(getFilename)

  if (handlers.length === 0) {
    return { handlers }
  }

  const mainContents = handlers
    .map(
      (handler, index) => `
import * as func${index} from "${unixify(resolvePath(EDGE_HANDLERS_SRC, handler))}";
netlifyRegistry.set("${handler}", func${index});`,
    )
    .join('\n')
  // make temp dir `handlers-abc123`
  const tmpDir = await fsPromises.mkdtemp(join(tmpdir(), 'handlers-'))
  const mainFile = join(tmpDir, MAIN_FILE)
  await fsPromises.writeFile(mainFile, mainContents)
  return { handlers, mainFile }
}

// ES modules requires forward slashes
function unixify(filePath) {
  if (platform !== 'win32') {
    return filePath
  }

  return filePath.replace(UNIXIFY_REGEXP, '/')
}

const UNIXIFY_REGEXP = /\\/g

function isHandlerFile(entry) {
  return extname(entry.name) === '.js' && entry.isFile()
}

function getFilename(entry) {
  return basename(entry.name, extname(entry.name))
}

/**
 * @type {import("@rollup/plugin-babel").RollupBabelInputPluginOptions}
 */
const babelConfig = {
  exclude: 'node_modules/**',
  babelHelpers: 'bundled',
  babelrc: false,
  configFile: false,
  presets: [
    [
      presetEnv,
      {
        targets: {
          // latest beta release as of this commit (V8 8.6)
          chrome: '87',
        },
      },
    ],
  ],
}

/**
 * Creates a new rollup config bundling the given file.
 *
 * @param {string} file The file to be bundled.
 * @param {*} onWarn Optional: A callback called on a rollup warning.
 */
const rollupConfig = (file, onWarn) => ({
  input: file,
  plugins: [
    babel(babelConfig),
    nodeResolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    json({
      compact: true,
    }),
    nodeGlobals(),
    nodePolyfills(),
    terser(),
  ],
  onwarn(msg, warn) {
    if (typeof onWarn === 'function') {
      onWarn(msg, warn)
      return
    }

    warn(msg)
  },
})

/**
 * Bundles the handler code based on a generated entrypoint
 *
 * @param {string} file path of the entrypoint file
 * @returns {Promise<string>} bundled code
 */
export const bundleFunctions = async function (file, utils) {
  const options = rollupConfig(file, (msg, warn) => {
    if (msg.code === 'UNRESOLVED_IMPORT') {
      utils.build.failBuild(
        `Error in ${msg.importer}, could not resolve ${msg.source} module. Please install this dependency locally and ensure it is listed in your package.json`,
      )
    } else {
      warn(msg)
    }
  })

  try {
    const bundle = await rollup(options)
    const {
      output: [{ code }],
    } = await bundle.generate({
      format: 'iife',
      compact: true,
    })
    return code
  } catch (error) {
    // This will stop the execution of this plugin.
    // No Edge Handlers will be uploaded.
    return utils.build.failBuild('Error while bundling Edge Handlers', { error })
  }
}

/**
 * Bundles the given edge handler module for use in the CLI.
 *
 * @param {string} file path of the entrypoint file
 * @returns {Promise<string>} bundled code
 */
export const bundleFunctionsForCli = function (file) {
  return new Promise((resolve, reject) => {
    const options = rollupConfig(file, (msg, warn) => {
      if (msg.code === 'UNRESOLVED_IMPORT') {
        // eslint-disable-next-line prefer-promise-reject-errors
        reject({
          code: 'unresolved-import',
          msg: `Error in ${msg.importer}, could not resolve ${msg.source} module. Please install this dependency locally and ensure it is listed in your package.json.`,
          importee: msg.source,
          importer: msg.importer,
          success: false,
        })
      } else {
        warn(msg)
      }
    })

    rollup(options)
      // eslint-disable-next-line promise/prefer-await-to-then
      .then((bundle) =>
        bundle.generate({
          format: 'iife',
          compact: true,
        }),
      )
      // eslint-disable-next-line promise/prefer-await-to-then
      .then(({ output: [{ code }] }) => resolve(code))
      // eslint-disable-next-line promise/prefer-await-to-callbacks,promise/prefer-await-to-then
      .catch((error) =>
        // eslint-disable-next-line prefer-promise-reject-errors
        reject({
          code: 'unknown',
          msg: `Error while bundling Edge Handlers: ${error.message}`,
          success: false,
        }),
      )
  })
}

/**
 * Writes out the bundled code to disk along with any meta info
 *
 * @param {string} bundle bundled code
 * @param {string[]} handlers names of the included handlers
 * @param {string} outputDir path to the output directory (created if not exists)
 * @param {boolean} isLocal whether we're running locally or in CI
 * @param {string} apiHost Netlify API host used for uploads
 * @param {string | null} apiToken Netlify API token used for uploads
 * @returns {Promise<boolean>}
 */
export const publishBundle = async function (bundle, handlers, outputDir, isLocal, apiHost, apiToken) {
  // encode bundle into bytes
  const buf = Buffer.from(bundle, 'utf-8')
  const sha = getShasum(buf)

  /** @type {import("./upload").BundleInfo} */
  const bundleInfo = {
    sha,
    handlers,
    // needs to have length of the byte representation, not the string length
    content_length: buf.length,
    content_type: CONTENT_TYPE,
  }

  if (isLocal) {
    // cleanup previous handlers
    await del(outputDir)

    await fsPromises.mkdir(outputDir, { recursive: true })

    // bundled handlers
    const outputFile = `${outputDir}/${sha}`
    await fsPromises.writeFile(outputFile, bundle, 'utf-8')

    // manifest
    const manifestFile = `${outputDir}/${MANIFEST_FILE}`
    await fsPromises.writeFile(manifestFile, JSON.stringify(bundleInfo, null, 2))
  } else {
    const uploaded = await uploadBundle(buf, bundleInfo, env.DEPLOY_ID, apiHost, apiToken)
    if (!uploaded) {
      console.log('Bundle already exists. Skipping upload...')
    }
    return uploaded
  }

  return false
}

export const logHandlers = function (handlers, EDGE_HANDLERS_SRC) {
  const handlersString = handlers.map(serializeHandler).join('\n')
  console.log(`Packaging Edge Handlers from ${EDGE_HANDLERS_SRC} directory:\n${handlersString}`)
}

function serializeHandler(handler) {
  return ` - ${handler}`
}
