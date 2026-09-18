const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, 'www');

if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

const copyList = [
    'index.html',
    'index_v2.html',
    'switcher.html',
    'director_suite.html',
    'guest.html',
    'ai_audio.html',
    'graphics.html',
    'demo_scenes_and_audio.html',
    'manifest.json',
    'icon-192.png',
    'icon-512.png',
    'sw.js'
];

copyList.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied ${file} -> www/${file}`);
    }
});

// Explicitly ensure www/index.html is Production Controller v2 (matching FastAPI / and Vercel routing)
const v2Src = path.join(__dirname, 'index_v2.html');
if (fs.existsSync(v2Src)) {
    fs.copyFileSync(v2Src, path.join(targetDir, 'index.html'));
    console.log(`Copied index_v2.html -> www/index.html (Capacitor Android root)`);
}

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDirRecursive(path.join(__dirname, 'js'), path.join(targetDir, 'js'));
copyDirRecursive(path.join(__dirname, 'css'), path.join(targetDir, 'css'));

console.log('✓ www directory successfully prepared!');
