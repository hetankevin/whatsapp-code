// Held-out contract check for BugsJS ESLint 10 (inherited config validation, caching, relative and nested
// extends, one base-config cache write). Rebuilt on November 18 from the recorded edit history after a /tmp
// cleanup deleted the original; it reproduces all 22 earlier verdicts. Usage: node <this> <project dir>

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const project = path.resolve(process.argv[2] || '.');
const Config = require(path.join(project, 'lib/config'));
const Linter = require(path.join(project, 'lib/linter'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-config-preservation-'));
try {
  const errors = [];
  const invalid = path.join(dir, '.eslintrc-invalid.json');
  fs.writeFileSync(invalid, JSON.stringify({ rules: { 'no-empty': 'invalid-severity' } }));
  try {
    assert.throws(() => new Config({baseConfig:{extends:invalid}},new Linter()), /severity|invalid/i);
  } catch (error) { errors.push('Inherited invalid configuration must be rejected: ' + error.message); }

  const valid = path.join(dir, '.eslintrc-valid.json');
  fs.writeFileSync(valid, JSON.stringify({rules:{'no-empty':2}}));
  try {
    const config = new Config({baseConfig:{extends:valid}},new Linter());
    assert.equal(config.baseConfig.rules['no-empty'], 2);
    assert.ok(config.configCache.getConfig(valid), 'Expected to find the inherited config in the instance cache');
  } catch (error) { errors.push('Inherited valid configuration must be cached: ' + error.message); }
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const relative = new Config({baseConfig:{extends:'./.eslintrc-valid.json'}},new Linter());
    assert.equal(relative.baseConfig.rules['no-empty'], 2);
    assert.ok(relative.configCache.getConfig(path.join(process.cwd(), path.basename(valid))));
  } catch (error) { errors.push('Relative extends must resolve from the working directory: ' + error.message);
    console.error('FAIL Relative baseConfig extends resolution');
    console.error(error.stack.split('\n').slice(0,9).join('\n')); }
  finally { process.chdir(previousCwd); }
  const nested = path.join(dir, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested,'parent.json'), JSON.stringify({extends:'./child.json'}));
  fs.writeFileSync(path.join(nested,'child.json'), JSON.stringify({rules:{'no-empty':2}}));
  try {
    const config = new Config({baseConfig:{extends:path.join(nested,'parent.json')}},new Linter());
    assert.equal(config.baseConfig.rules['no-empty'], 2);
  } catch (error) {
    errors.push('Nested extends must resolve from the parent config directory: ' + error.message);
    console.error('FAIL Nested extends resolution');
    console.error(error.stack.split('\n').slice(0,9).join('\n'));
  }
  const ConfigCache = require(path.join(project, 'lib/config/config-cache'));
  const writes = {};
  for (const name of ['setConfig', 'setMergedVectorConfig']) {
    const original = ConfigCache.prototype[name];
    writes[name] = 0;
    ConfigCache.prototype[name] = function(file, config) {
      if (file === '') writes[name]++;
      return original.call(this, file, config);
    };
  }
  try {
    new Config({baseConfig:{extends:valid}},new Linter());
    assert.deepEqual(writes, {setConfig:1, setMergedVectorConfig:1},
      'The constructor should seed each baseConfig cache once');
  } catch (error) {
    errors.push('Base config cache population: ' + error.message);
    console.error('FAIL Base config cache population');
    console.error(error.stack.split('\n').slice(0,15).join('\n'));
  }
  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('PASS: inherited config validation and caching');
} finally {
  fs.rmSync(dir, {recursive:true, force:true});
}
