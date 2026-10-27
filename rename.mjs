// Rename the bundle in one shot. A DSH bundle's name lives in exactly three
// places; a mismatch is silent at build time and broken at runtime.
//
//   node rename.mjs <new-name> [github-owner]
//
// Rewrites package.json (name, homepage, repository, bugs), cordis.patch.yml
// and the __ModuleLoader__ id in client.js, then re-runs check-manifest.mjs.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const [name, owner] = process.argv.slice(2)
if (!name) {
  console.error('usage: node rename.mjs <new-name> [github-owner]')
  process.exit(1)
}

const pkgPath = 'package.json'
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const old = pkg.name

pkg.name = name
if (owner) {
  const repo = `https://github.com/${owner}/${name}`
  pkg.author = owner
  pkg.homepage = `${repo}#readme`
  pkg.repository = { type: 'git', url: `git+${repo}.git` }
  pkg.bugs = { url: `${repo}/issues` }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
fs.writeFileSync('cordis.patch.yml', patch.replaceAll(`'${old}'`, `'${name}'`))

const client = fs.readFileSync('client.js', 'utf8')
fs.writeFileSync('client.js', client.replaceAll(`id: '${old}'`, `id: '${name}'`))

console.log(`${old} -> ${name}`)
execFileSync(process.execPath, ['check-manifest.mjs'], { stdio: 'inherit' })
