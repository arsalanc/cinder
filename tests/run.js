// CINDER — parallel test runner
// Runs every smoke-*.js suite in this directory as its own node process
// (suites are fully independent: each builds a fresh vm context), a few at
// a time, and aggregates PASS/FAIL lines. Usage:
//   node tests/run.js            all suites
//   node tests/run.js boss evo   only suites whose name contains a term
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const terms = process.argv.slice(2).map(s => s.toLowerCase());
const files = fs.readdirSync(__dirname)
  .filter(f => f.startsWith('smoke') && f.endsWith('.js'))
  .filter(f => terms.length === 0 || terms.some(t => f.toLowerCase().includes(t)))
  .sort();

const CONCURRENCY = 6;
const t0 = Date.now();
let cursor = 0;
let running = 0;
let pass = 0;
let fail = 0;
const failures = [];
const slow = [];

function launch() {
  while (running < CONCURRENCY && cursor < files.length) {
    const file = files[cursor++];
    running++;
    const started = Date.now();
    execFile('node', [path.join(__dirname, file)],
      { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        running--;
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        let p = 0, f = 0;
        for (const line of String(stdout).split('\n')) {
          if (line.startsWith('PASS')) p++;
          else if (line.startsWith('FAIL')) { f++; failures.push(file + ': ' + line); }
        }
        if (err && f === 0) { f++; failures.push(file + ': crashed — ' + String(stderr || err).slice(0, 300)); }
        pass += p;
        fail += f;
        slow.push([file, +secs]);
        console.log((f ? 'FAIL' : 'ok  ') + ' ' + file.padEnd(22) + p + ' pass' + (f ? ', ' + f + ' FAIL' : '') + '  (' + secs + 's)');
        if (cursor < files.length) launch();
        else if (running === 0) done();
      });
  }
}

function done() {
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(50));
  for (const line of failures) console.log('  ' + line);
  console.log('TOTAL PASS=' + pass + ' FAIL=' + fail + ' suites=' + files.length + ' wall=' + total + 's');
  process.exit(fail > 0 ? 1 : 0);
}

if (files.length === 0) { console.log('no suites matched'); process.exit(1); }
launch();
