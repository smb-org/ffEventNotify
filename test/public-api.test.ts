import assert from 'node:assert/strict';
import test from 'node:test';
import * as classify from '../src/classify.ts';
import * as health from '../src/health.ts';
import * as lodestone from '../src/sources/lodestone.ts';
import * as main from '../src/main.ts';
import * as seasonal from '../src/extractors/seasonal.ts';

test('redundant helper aliases and singleton health exports are absent', () => {
  assert.equal('genericTopicKey' in classify, false);
  assert.equal('isFirstStart' in classify, false);
  assert.equal('extractBannerRailLinks' in lodestone, false);
  assert.equal('extractSeasonalSpecial' in seasonal, false);
  assert.equal('runHourlyCycle' in main, false);
  assert.deepEqual(Object.keys(health), ['SourceHealthMonitor']);
});
