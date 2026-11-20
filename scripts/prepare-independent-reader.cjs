/* Pinned upstream Windows x64 library, independent of WeFlow's old native engines. */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), JSZip = require('jszip')
const root = path.resolve(__dirname, '../resources/independent-reader')
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'PROVENANCE.json'), 'utf8'))
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
async function main() {
  const target = path.join(root, 'win32/x64/sqlite3mc.dll')
  if (fs.existsSync(target) && hash(fs.readFileSync(target)) === provenance.files['win32/x64/sqlite3mc.dll']) {
    console.log('Independent reader dependency verified'); return
  }
  const response = await fetch(`https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v${provenance.version}/${provenance.archive}`, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Dependency download failed (${response.status})`)
  const data = Buffer.from(await response.arrayBuffer())
  if (hash(data) !== provenance.archiveSha256) throw new Error('Archive checksum mismatch')
  const zip = await JSZip.loadAsync(data)
  const library = await zip.file('dll/sqlite3mc_x64.dll').async('nodebuffer')
  if (hash(library) !== provenance.files['win32/x64/sqlite3mc.dll']) throw new Error('Library checksum mismatch')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, library)
  for (const name of ['LICENSE', 'LICENSE.spdx']) fs.writeFileSync(path.join(root, name), await zip.file(name).async('nodebuffer'))
  console.log('Independent reader dependency prepared and verified')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
