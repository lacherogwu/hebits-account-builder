import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolution, isDiscOrRemux, seasonInfo, coversEpisode, pickFile, episodeOf, showName } from '../lib/parse.js';

test('resolution', () => {
  assert.equal(resolution('Haborer.S02.1080p.WEB-DL.H.264-HBRW'), 1080);
  assert.equal(resolution('Reacher.S04.2160p.AMZN.WEB-DL'), 2160);
  assert.equal(resolution('Movie.2020.UHD.BluRay.x265'), 2160);
  assert.equal(resolution('Haborer.S04.720p.HDTV.x264-iLM'), 720);
  assert.equal(resolution('Galis.Complete.WS.PDTV-TVNETIL'), 480);
  assert.equal(resolution('Haborer.S01-S04.XviD-iLM'), 480);
  assert.equal(resolution('Some.Show'), 0);
});

test('isDiscOrRemux', () => {
  assert.ok(isDiscOrRemux('Gandhi.1982.2160p.UHD.BluRay.REMUX.HDR.HEVC'));
  assert.ok(isDiscOrRemux('Inception.2010.2160p.UHD.Blu-ray.HEVC.DTS-HD.MA.5.1.TAiCHi'));
  assert.ok(isDiscOrRemux('Game.Of.Thrones.S08.COMPLETE.UHD.BLURAY-MIXED'));
  assert.ok(isDiscOrRemux('Game.of.Thrones.S01.2160p.UHD.BluRay.HDR.HEVC.Atmos-HDBEE'));
  assert.ok(!isDiscOrRemux('Reacher.S04.2160p.AMZN.WEB-DL.DDP5.1.DV.HDR.HEVC-NTb'));
  assert.ok(!isDiscOrRemux('Inception.2010.1080p.BluRay.DD+5.1.x264-playHD'));
  assert.ok(!isDiscOrRemux('Inception.2010.REPACK.2160p.UHD.BluRay.DTS-MA.5.1.HDR.x265-BlzT'));
  assert.ok(!isDiscOrRemux('Tequila.Sunrise.1988.BluRay.1080p.DTS-HD.MA.5.1.AVC.x264'));
});

test('seasonInfo', () => {
  assert.deepEqual(seasonInfo('Haborer.S04E12.720p.HDTV.x264-iLM'), { kind: 'episode', season: 4, episode: 12 });
  assert.deepEqual(seasonInfo('Haborer.S02.1080p.WEB-DL'), { kind: 'season', from: 2, to: 2 });
  assert.deepEqual(seasonInfo('Haborer.S01-S04.XviD-iLM'), { kind: 'season', from: 1, to: 4 });
  assert.deepEqual(seasonInfo('Ninjago.Masters.of.Spinjitzu.S01-09.1080p'), { kind: 'season', from: 1, to: 9 });
  assert.deepEqual(seasonInfo('Galis.Complete.WS.PDTV-TVNETIL'), { kind: 'complete' });
  assert.deepEqual(seasonInfo('The.Lion.Guard.COMPLETE.1080p'), { kind: 'complete' });
  assert.equal(seasonInfo('Inception.2010.1080p.BluRay'), null);
});

test('coversEpisode', () => {
  assert.ok(coversEpisode({ kind: 'episode', season: 4, episode: 12 }, 4, 12));
  assert.ok(!coversEpisode({ kind: 'episode', season: 4, episode: 12 }, 4, 11));
  assert.ok(coversEpisode({ kind: 'season', from: 1, to: 4 }, 3, 1));
  assert.ok(!coversEpisode({ kind: 'season', from: 2, to: 2 }, 3, 1));
  assert.ok(coversEpisode({ kind: 'complete' }, 7, 3));
  assert.ok(!coversEpisode(null, 1, 1));
});

const f = (path, length) => ({ path, length });

test('pickFile: movie takes largest video, ignores samples', () => {
  const files = [f('M/sample.mkv', 50e6), f('M/Movie.mkv', 8e9), f('M/Movie.nfo', 1e3), f('M/extras.mp4', 9e9 - 1)];
  assert.equal(pickFile(files, null).path, 'M/extras.mp4');
  const files2 = [f('M/Movie.Sample.mkv', 60e6), f('M/Movie.mkv', 8e9)];
  assert.equal(pickFile(files2, null).path, 'M/Movie.mkv');
});

test('pickFile: episode from a pack', () => {
  const files = [
    f('Show.S02/Show.S02E01.1080p.mkv', 2e9),
    f('Show.S02/Show.S02E10.1080p.mkv', 2e9),
    f('Show.S02/Show.S02E01.1080p.srt', 1e5),
  ];
  assert.equal(pickFile(files, { season: 2, episode: 1 }).path, 'Show.S02/Show.S02E01.1080p.mkv');
  assert.equal(pickFile(files, { season: 2, episode: 10 }).path, 'Show.S02/Show.S02E10.1080p.mkv');
  assert.equal(pickFile(files, { season: 2, episode: 3 }), null);
  assert.equal(pickFile(files, { season: 1, episode: 1 }), null);
});

test('pickFile: multi-season pack with season folders and 1x02 naming', () => {
  const files = [
    f('Pack/Season 1/Show 1x02.avi', 7e8),
    f('Pack/Season 2/Show 2x02.avi', 7e8),
    f('Pack/Season 2/Show 2x12.avi', 7e8),
  ];
  assert.equal(pickFile(files, { season: 2, episode: 2 }).path, 'Pack/Season 2/Show 2x02.avi');
  assert.equal(pickFile(files, { season: 1, episode: 2 }).path, 'Pack/Season 1/Show 1x02.avi');
});

test('pickFile: single-episode torrent', () => {
  const files = [f('Haborer.S04E12.720p.HDTV.x264-iLM.mkv', 9e8)];
  assert.equal(pickFile(files, { season: 4, episode: 12 }).path, files[0].path);
});

test('pickFile: episode-only names inside a season folder', () => {
  const files = [f('Galis/Season 3/Galis - E05.avi', 3e8), f('Galis/Season 2/Galis - E05.avi', 3e8)];
  assert.equal(pickFile(files, { season: 3, episode: 5 }).path, 'Galis/Season 3/Galis - E05.avi');
});

test('episodeOf', () => {
  assert.deepEqual(episodeOf('Galis.Complete/Galis.S03.WS.PDTV/Galis.S03E13.WS.PDTV.XviD-So_Up.avi'), { season: 3, episode: 13 });
  assert.deepEqual(episodeOf('GoT.S01-S05/GoT.S01.720p/game.of.thrones.s01e02.720p.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(episodeOf('Pack/Season 2/Show 2x12.avi'), { season: 2, episode: 12 });
  assert.deepEqual(episodeOf('Galis/עונה 4/גאליס פרק 7.avi'), { season: 4, episode: 7 });
  assert.equal(episodeOf('Movie.2010.1080p/Movie.2010.1080p.x264.mkv'), null);
  assert.equal(episodeOf('Show.S01/Show.S01.Extras.mkv'), null);
  assert.equal(episodeOf('Film.1920x1080.mkv'), null);
});

test('showName', () => {
  assert.equal(showName('Game.of.Thrones.S01-S05.720p.HDTV.x264-Hebits'), 'Game of Thrones');
  assert.equal(showName('Galis.Complete.WS.PDTV-TVNETIL'), 'Galis');
  assert.equal(showName('IT.Welcome.to.Derry.S01.2160p.HMAX.WEB-DL'), 'IT Welcome to Derry');
  assert.equal(showName('Inception.2010.1080p.BluRay.x264'), 'Inception');
  assert.equal(showName('Black.Sails.COMPLETE.720p.BluRay'), 'Black Sails');
});

test('daily download counter from the profile page', async () => {
  const { parseDailyDownloads } = await import('../lib/hebits.js');
  assert.deepEqual(parseDailyDownloads('<li>הורדות יומיות: <span>3</span>/10 (30%)</li>'), { used: 3, limit: 10 });
  assert.equal(parseDailyDownloads('<html>login</html>'), null);
});
