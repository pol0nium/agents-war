// Copies chase/launch_chase.js into lib/chase_script.mjs so /api/bundle?file=chase serves the current launcher. Run before deploying.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../chase/launch_chase.js'), 'utf8');
fs.writeFileSync(path.join(__dirname, '../lib/chase_script.mjs'), '// GENERATED from chase/launch_chase.js — regenerate with: node scripts/sync_chase.cjs\nexport default ' + JSON.stringify(src) + ';\n');
console.log('chase_script.mjs updated', src.length, 'bytes');
