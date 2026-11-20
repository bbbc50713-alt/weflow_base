// Start the usual development server, with an opt-in Electron rendering fallback.
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')
process.env.WEFLOW_SOFTWARE_RENDERING = '1'
require('./prepare-electron-runtime.cjs')
const cli = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
process.argv[1] = cli
import(pathToFileURL(cli).href).catch(error => { console.error(error); process.exitCode = 1 })
