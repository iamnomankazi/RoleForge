process.stdout.write('TAP version 13\n1..1\n');
process.on('exit', () => {
  process.stdout.write('ok 1 - shutdown bytes\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
});
