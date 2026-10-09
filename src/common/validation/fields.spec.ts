import { changedFieldNames } from './fields';

describe('changedFieldNames', () => {
  it('lists provided fields only, sorted, ignoring undefined (null is a deliberate value)', () => {
    expect(changedFieldNames({ name: 'x', email: undefined, preferredLanguage: 'en' })).toEqual([
      'name',
      'preferredLanguage',
    ]);
    expect(changedFieldNames({ latitude: null, longitude: null })).toEqual([
      'latitude',
      'longitude',
    ]);
    expect(changedFieldNames({})).toEqual([]);
  });
});
