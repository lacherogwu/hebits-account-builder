import { expect, test } from 'vitest';
import { isDiscOrRemux, seasonInfo } from '../src/parse';

test('isDiscOrRemux', () => {
  expect(isDiscOrRemux('Gandhi.1982.2160p.UHD.BluRay.REMUX.HDR.HEVC')).toBe(true);
  expect(isDiscOrRemux('Inception.2010.2160p.UHD.Blu-ray.HEVC.DTS-HD.MA.5.1.TAiCHi')).toBe(true);
  expect(isDiscOrRemux('Game.Of.Thrones.S08.COMPLETE.UHD.BLURAY-MIXED')).toBe(true);
  expect(isDiscOrRemux('Game.of.Thrones.S01.2160p.UHD.BluRay.HDR.HEVC.Atmos-HDBEE')).toBe(true);
  expect(isDiscOrRemux('Reacher.S04.2160p.AMZN.WEB-DL.DDP5.1.DV.HDR.HEVC-NTb')).toBe(false);
  expect(isDiscOrRemux('Inception.2010.1080p.BluRay.DD+5.1.x264-playHD')).toBe(false);
  expect(isDiscOrRemux('Inception.2010.REPACK.2160p.UHD.BluRay.DTS-MA.5.1.HDR.x265-BlzT')).toBe(false);
  expect(isDiscOrRemux('Tequila.Sunrise.1988.BluRay.1080p.DTS-HD.MA.5.1.AVC.x264')).toBe(false);
});

test('seasonInfo', () => {
  expect(seasonInfo('Haborer.S04E12.720p.HDTV.x264-iLM')).toEqual({ kind: 'episode', season: 4, episode: 12 });
  expect(seasonInfo('Haborer.S02.1080p.WEB-DL')).toEqual({ kind: 'season', from: 2, to: 2 });
  expect(seasonInfo('Haborer.S01-S04.XviD-iLM')).toEqual({ kind: 'season', from: 1, to: 4 });
  expect(seasonInfo('Ninjago.Masters.of.Spinjitzu.S01-09.1080p')).toEqual({ kind: 'season', from: 1, to: 9 });
  expect(seasonInfo('Galis.Complete.WS.PDTV-TVNETIL')).toEqual({ kind: 'complete' });
  expect(seasonInfo('The.Lion.Guard.COMPLETE.1080p')).toEqual({ kind: 'complete' });
  expect(seasonInfo('Inception.2010.1080p.BluRay')).toBe(null);
});
