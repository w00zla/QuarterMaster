// Matching UEX refinery terminals to catalog locations (pure).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocationEntry } from '../src/stock/lookup.ts';
import { matchRefineries, uexTerminals } from '../src/uex/refineries.ts';

const loc = (uuid: string, name: string, system: string | null): LocationEntry =>
  ({ uuid, name, nameEn: name, body: null, system, label: name, short: name });

const row = (id: number, system: string, station: string | null, city: string | null = null) => ({
  id_terminal: id, terminal_name: `Refinery ${id}`, star_system_name: system, space_station_name: station, city_name: city,
});

describe('UEX refineries', () => {
  it('collects distinct terminals, station or city as the place', () => {
    const terminals = uexTerminals([row(1, 'Nyx', null, 'Levski'), row(1, 'Nyx', null, 'Levski'), row(2, 'Pyro', 'Ruin Station'), { id_terminal: 'x' }]);
    assert.deepEqual(terminals.map((t) => [t.id, t.place, t.system]), [[1, 'Levski', 'Nyx'], [2, 'Ruin Station', 'Pyro']]);
  });

  it('matches by name within the system, without "(System)" and a trailing "Station"', () => {
    const locations = [
      loc('levski', 'Levski', 'Nyx'), loc('ruin', 'Ruin Station', 'Pyro'), loc('checkmate', 'Checkmate', 'Pyro'),
      loc('nyx-gw-pyro', 'Nyx Gateway', 'Pyro'), loc('nyx-gw-stanton', 'Nyx Gateway', 'Stanton'), loc('hur-l1', 'HUR-L1 Green Glade Station', 'Stanton'),
    ];
    const { matched, unmatched } = matchRefineries(uexTerminals([
      row(1, 'Nyx', 'Levski'), row(2, 'Pyro', 'Ruin Station'), row(3, 'Pyro', 'Checkmate Station'), row(4, 'Stanton', 'Nyx Gateway (Stanton)'),
      row(5, 'Stanton', 'HUR-L1 Green Glade Station'), row(6, 'Pyro', 'Nowhere'), row(7, 'Nyx', 'Ruin Station'),
    ]), locations);
    assert.deepEqual([...matched].map(([uuid, t]) => [uuid, t.id]).sort(), [['checkmate', 3], ['hur-l1', 5], ['levski', 1], ['nyx-gw-stanton', 4], ['ruin', 2]]);
    assert.deepEqual(unmatched.map((t) => t.id), [6, 7]);
  });
});
