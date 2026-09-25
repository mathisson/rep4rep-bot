import { packager } from '@electron/packager';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// These are real regexes, not shell strings. Passing them as --ignore= flags
// through an npm script breaks on Windows, where cmd.exe eats the leading ^
// and turns each anchored pattern into a substring match -- /dist then strips
// the dist folder out of every dependency and the app will not start.
const ignore = [
    /^\/\.env/,        // never ship the API token
    /^\/dist($|\/)/,
    /^\/test($|\/)/,
    /^\/\.git/,
    /^\/\.vscode/,
    /^\/build\.(cmd|mjs)$/,
    /^\/README\.md$/,
];

const [out] = await packager({
    dir: '.',
    name: 'Rep4Rep',
    platform: 'win32',
    arch: 'x64',
    out: 'dist',
    overwrite: true,
    prune: true,
    asar: true,
    appVersion: pkg.version,
    appCopyright: 'Rep4Rep CLI',
    ignore,
});

console.log(`\nBuilt: ${out}\\Rep4Rep.exe`);
