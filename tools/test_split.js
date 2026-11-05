// Usage: node tools/test_split.js <txt file>
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'reader', 'app.js'), 'utf8').replace(/\nboot\(\);\s*$/, '\n');
const ctx = { console, TextDecoder, localStorage: { getItem: () => null, setItem() {} }, window: {} };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.splitChapters = splitChapters;', ctx);

const text = fs.readFileSync(process.argv[2], 'utf8');
const chapters = ctx.splitChapters(text);
console.log('chapters:', chapters.length);
chapters.forEach((c, i) => console.log(String(i).padStart(3), c.title, `(${c.lines.join('').length} chars)`));
