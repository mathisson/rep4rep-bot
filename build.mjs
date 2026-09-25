import { packager } from '@electron/packager';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Windows will not unlink a DLL that a running process has loaded, so packaging
// over a running copy dies with EPERM on d3dcompiler_47.dll. Close it first.
if (process.platform === 'win32') {
    try {
        execFileSync('tasklist', ['/FI', 'IMAGENAME eq Rep4Rep.exe', '/NH'], { encoding: 'utf8' })
            .includes('Rep4Rep.exe') || (() => { throw new Error('not running'); })();

        console.log('Closing the running Rep4Rep app first...');
        execFileSync('taskkill', ['/IM', 'Rep4Rep.exe', '/F'], { stdio: 'ignore' });
        // Give Windows a moment to release the file handles.
        await new Promise(resolve => setTimeout(resolve, 1500));
    } catch {
        // Not running, or taskkill unavailable -- nothing to close.
    }
}

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

let out;
try {
    [out] = await packager({
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
} catch (err) {
    if (err.code === 'EPERM') {
        console.error(
            '\nCould not overwrite the previous build -- a file in dist\\ is still locked.\n' +
            'Close Rep4Rep if it is open (check the taskbar), then run this again.\n' +
            `Locked file: ${err.path || 'unknown'}\n`
        );
        process.exit(1);
    }
    throw err;
}

console.log(`\nBuilt: ${out}\\Rep4Rep.exe`);
