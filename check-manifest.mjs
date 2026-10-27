// Consistency checks a DSH bundle must pass before it is worth publishing.
// Run: node check-manifest.mjs
import fs from 'node:fs'

const problems = []
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const fail = (m) => problems.push(m)

if (pkg.private) fail('package.json still has "private": true — npm publish will refuse')
if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg.name)) fail(`invalid npm name: ${pkg.name}`)
if (!pkg.license) fail('missing license')
if (!pkg.engines?.dsh) fail('missing engines.dsh — the market would treat every DSH version as compatible')
if (!pkg.repository?.url) fail('missing repository.url')

// The bundle patch is what makes the package a DSH bundle at all.
const patchPath = pkg.dsh?.bundle?.patch
if (!patchPath) fail('missing dsh.bundle.patch')
else if (!fs.existsSync(patchPath)) fail(`dsh.bundle.patch points at a missing file: ${patchPath}`)
else {
  const patch = fs.readFileSync(patchPath, 'utf8')
  const names = [...patch.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
  for (const name of names) {
    if (name !== pkg.name) fail(`cordis.patch.yml declares "${name}" but the package is "${pkg.name}"`)
  }
}

// The client bundle registers itself under the package name; a mismatch means the UI never mounts.
const clientEntry = pkg.dsh?.client ? pkg.exports?.['./client'] : undefined
if (pkg.dsh?.client && !clientEntry) fail('dsh.client is set but exports["./client"] is missing')
if (clientEntry) {
  const client = fs.readFileSync(clientEntry.replace(/^\.\//, ''), 'utf8')
  const id = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1]
  if (id !== pkg.name) fail(`client.js registers id "${id}" but the package is "${pkg.name}"`)
}

// Everything npm ships must exist, and everything needed at runtime must ship.
for (const entry of pkg.files ?? []) {
  if (entry.includes('*')) continue
  if (!fs.existsSync(entry)) fail(`files lists a missing path: ${entry}`)
}
for (const needed of ['index.js', 'client.js', patchPath, 'LICENSE', 'README.md']) {
  if (needed && !(pkg.files ?? []).some((f) => f === needed || f === needed.replace(/^\.\//, ''))) {
    fail(`${needed} is required at runtime but is not in "files"`)
  }
}

if (problems.length) {
  console.log('FAIL')
  for (const p of problems) console.log('  -', p)
  process.exitCode = 1
} else {
  console.log(`OK  ${pkg.name}@${pkg.version}  engines.dsh=${pkg.engines.dsh}`)
  console.log('    patch:', patchPath, '| client:', clientEntry)
}
