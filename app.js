'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const audio = $('audio');
  const DB_NAME = 'offline-music-v1:' + new URL('./', location.href).pathname;
  const DB_VERSION = 1;
  const TRACKS = 'tracks';
  const AUDIO = 'audio';
  const STATE_KEY = 'offline-music-state:' + new URL('./', location.href).pathname;
  const MAX_FILE_BYTES = 250 * 1024 * 1024;

  let db = null;
  let tracks = [];
  let currentId = null;
  let objectUrl = null;
  let shuffle = false;
  let repeat = 'off';
  let positions = {};
  let lastSavedSecond = -1;
  let importing = false;
  let preparedNext = null;
  let prepareGeneration = 0;
  let artworkObjectUrl = null;
  const FALLBACK_ARTWORK = new URL('./hoyul-music-icon-512-v2.png', location.href).href;

  function state() {
    return { currentId, shuffle, repeat, positions };
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state()));
    } catch {}
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.currentId === 'string') currentId = saved.currentId;
      shuffle = saved.shuffle === true;
      if (['off', 'all', 'one'].includes(saved.repeat)) repeat = saved.repeat;
      if (saved.positions && typeof saved.positions === 'object') positions = saved.positions;
    } catch {}
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TRACKS)) {
          const store = database.createObjectStore(TRACKS, { keyPath: 'id' });
          store.createIndex('fingerprint', 'fingerprint', { unique: true });
          store.createIndex('addedAt', 'addedAt');
        }
        if (!database.objectStoreNames.contains(AUDIO)) {
          database.createObjectStore(AUDIO, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error('음악 저장소를 열지 못했습니다.'));
      request.onblocked = () => reject(new Error('다른 창에서 음악 저장소를 사용 중입니다.'));
    });
  }

  function idbRequest(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const request = operation(store);
      let value;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || request.error || new Error('저장소 작업에 실패했습니다.'));
      tx.onabort = () => reject(tx.error || request.error || new Error('저장소 작업이 취소되었습니다.'));
    });
  }

  async function allTracks() {
    const result = await idbRequest(TRACKS, 'readonly', store => store.getAll());
    result.sort((a, b) => a.addedAt - b.addedAt || a.name.localeCompare(b.name, 'ko', { numeric: true }));
    return result;
  }

  async function getAudioRecord(id) {
    return idbRequest(AUDIO, 'readonly', store => store.get(id));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const min = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return min + ':' + sec;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(digits) + ' ' + units[unit];
  }

  function parseName(filename) {
    const clean = filename.replace(/\.[^.]+$/, '').trim() || filename;
    const parts = clean.split(/\s+-\s+/);
    if (parts.length >= 2) {
      return {
        artist: parts.shift().trim() || '로컬 파일',
        title: parts.join(' - ').trim() || clean
      };
    }
    return { artist: '로컬 파일', title: clean };
  }

  function fingerprint(file) {
    return [file.name, file.size, file.lastModified, file.type].join(':');
  }

  function currentIndex() {
    return tracks.findIndex(track => track.id === currentId);
  }

  function currentTrack() {
    return tracks.find(track => track.id === currentId) || null;
  }

  function setStatus(message) {
    $('playbackStatus').textContent = message;
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function renderModes() {
    const shuffleButton = $('shuffleBtn');
    const repeatButton = $('repeatBtn');

    shuffleButton.classList.toggle('active', shuffle);
    shuffleButton.setAttribute('aria-pressed', String(shuffle));
    shuffleButton.setAttribute('aria-label', shuffle ? '셔플 켜짐' : '셔플');

    repeatButton.classList.toggle('active', repeat !== 'off');
    repeatButton.classList.toggle('repeat-one', repeat === 'one');

    let repeatLabel = '반복';
    if (repeat === 'all') repeatLabel = '전체 반복';
    if (repeat === 'one') repeatLabel = '한 곡 반복';
    repeatButton.setAttribute('aria-label', repeatLabel);
  }

  function renderNow() {
    const track = currentTrack();
    const hasTrack = !!track;
    $('playBtn').disabled = !hasTrack && tracks.length === 0;
    $('prevBtn').disabled = tracks.length === 0;
    $('nextBtn').disabled = tracks.length === 0;
    $('seek').disabled = !hasTrack;

    if (!track) {
      $('nowArtist').textContent = '재생할 음악을 선택하세요';
      $('nowTitle').textContent = '음악 없음';
      $('currentTime').textContent = '0:00';
      $('duration').textContent = '0:00';
      $('seek').value = 0;
      $('playBtn').textContent = '▶';
      $('playBtn').setAttribute('aria-label', '재생');
      return;
    }

    $('nowArtist').textContent = track.artist || '로컬 파일';
    $('nowTitle').textContent = track.title || track.name;
    const duration = Number.isFinite(audio.duration) ? audio.duration : track.duration || 0;
    $('duration').textContent = formatTime(duration);
    updateTimeline();
  }

  function renderTracks() {
    $('trackCount').textContent = tracks.length + '곡';
    $('emptyState').hidden = tracks.length !== 0;
    const fragment = document.createDocumentFragment();

    tracks.forEach((track, index) => {
      const row = document.createElement('div');
      row.className = 'track-row';
      if (track.id === currentId) row.classList.add('current');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'track-main';
      main.setAttribute('aria-label', (track.title || track.name) + ' 재생');

      const num = document.createElement('span');
      num.className = 'track-index';
      num.textContent = track.id === currentId && !audio.paused ? '▶' : String(index + 1);

      const text = document.createElement('span');
      text.className = 'track-text';
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = track.title || track.name;
      const artist = document.createElement('span');
      artist.className = 'track-artist';
      artist.textContent = track.artist || '로컬 파일';
      text.append(title, artist);

      const time = document.createElement('span');
      time.className = 'track-time';
      time.textContent = track.duration ? formatTime(track.duration) : '';

      main.append(num, text, time);
      main.addEventListener('click', () => {
        void selectTrack(track.id, true);
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'track-delete';
      del.textContent = '삭제';
      del.setAttribute('aria-label', (track.title || track.name) + ' 삭제');
      del.addEventListener('click', () => {
        void deleteTrack(track.id);
      });

      row.append(main, del);
      fragment.appendChild(row);
    });

    $('trackList').replaceChildren(fragment);
  }

  function renderAll() {
    renderModes();
    renderNow();
    renderTracks();
  }

  function revokeObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function clearPreparedNext() {
    prepareGeneration++;
    if (preparedNext?.url) URL.revokeObjectURL(preparedNext.url);
    preparedNext = null;
  }

  function preparedNextIndex() {
    if (!tracks.length || repeat === 'one') return -1;
    const index = currentIndex();
    if (index < 0) return 0;
    if (!shuffle && repeat === 'off' && index === tracks.length - 1) return -1;

    if (shuffle && tracks.length > 1) {
      let candidate = index;
      for (let attempts = 0; attempts < 12 && candidate === index; attempts++) {
        candidate = Math.floor(Math.random() * tracks.length);
      }
      return candidate;
    }

    return (index + 1) % tracks.length;
  }

  async function prepareNextTrack() {
    const generation = ++prepareGeneration;
    if (preparedNext?.url) URL.revokeObjectURL(preparedNext.url);
    preparedNext = null;

    const index = preparedNextIndex();
    if (index < 0) return;
    const track = tracks[index];
    if (!track || track.id === currentId) return;

    try {
      const record = await getAudioRecord(track.id);
      if (generation !== prepareGeneration || !record?.blob) return;
      preparedNext = {
        id: track.id,
        url: URL.createObjectURL(record.blob),
        blob: record.blob
      };
    } catch {}
  }

  function updateArtworkGeometry() {
    const image = $('heroArtworkImage');
    const root = document.documentElement;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 390;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 844;

    let ratio = 1;
    if (image?.naturalWidth > 0 && image?.naturalHeight > 0) {
      ratio = image.naturalHeight / image.naturalWidth;
    }

    const isLandscape = ratio < 0.82;
    document.body.classList.toggle('landscape-art', isLandscape);

    let artHeight = viewportWidth * ratio;
    artHeight = Math.max(170, Math.min(artHeight, viewportHeight * 0.72));

    let artTop = 0;
    let contentStart;

    if (isLandscape) {
      // Center a wide cover vertically inside the upper visual zone instead of
      // pinning it to the status bar. The blurred copy remains behind it above
      // and below, so the artwork keeps its full composition.
      const visualZoneHeight = viewportHeight * 0.62;
      artTop = Math.max(
        viewportHeight * 0.12,
        (visualZoneHeight - artHeight) * 0.5
      );

      contentStart = Math.max(
        viewportHeight * 0.52,
        Math.min(
          viewportHeight * 0.66,
          artTop + artHeight * 0.86 + 42
        )
      );
    } else {
      artTop = 0;
      contentStart = Math.max(
        viewportHeight * 0.48,
        Math.min(viewportHeight * 0.64, artHeight * 0.88 + 54)
      );
    }

    const blurStart = Math.max(0, artTop + artHeight * 0.54);

    root.style.setProperty('--art-top', Math.round(artTop) + 'px');
    root.style.setProperty('--art-height', Math.round(artHeight) + 'px');
    root.style.setProperty('--blur-start', Math.round(blurStart) + 'px');
    root.style.setProperty('--content-start', Math.round(contentStart) + 'px');
  }

  function syncArtwork(url, hasArtwork) {
    const source = hasArtwork ? url : FALLBACK_ARTWORK;
    const image = $('heroArtworkImage');
    if (image) {
      image.onload = updateArtworkGeometry;
      image.src = source;
      if (image.complete) updateArtworkGeometry();
    }
    document.documentElement.style.setProperty(
      '--cover-image',
      'url("' + source.replace(/"/g, '%22') + '")'
    );
    document.body.classList.toggle('has-artwork', hasArtwork);
  }

  function setArtworkBlob(blob) {
    if (artworkObjectUrl) {
      URL.revokeObjectURL(artworkObjectUrl);
      artworkObjectUrl = null;
    }
    if (!blob) {
      syncArtwork(FALLBACK_ARTWORK, false);
      return;
    }
    artworkObjectUrl = URL.createObjectURL(blob);
    syncArtwork(artworkObjectUrl, true);
  }

  function synchsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f);
  }

  function uint32be(bytes, offset) {
    return (bytes[offset] * 0x1000000) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3];
  }

  async function extractMp3Artwork(blob) {
    if (!blob || blob.size < 10) return null;
    const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
    const version = head[3];
    if (version !== 3 && version !== 4) return null;

    const tagSize = synchsafe(head, 6);
    const end = Math.min(blob.size, 10 + tagSize);
    if (end <= 20) return null;
    const bytes = new Uint8Array(await blob.slice(0, end).arrayBuffer());

    let offset = 10;
    while (offset + 10 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;

      const frameSize = version === 4 ? synchsafe(bytes, offset + 4) : uint32be(bytes, offset + 4);
      if (!frameSize || frameSize < 4) break;
      const frameStart = offset + 10;
      const frameEnd = Math.min(frameStart + frameSize, bytes.length);

      if (id === 'APIC') {
        let p = frameStart;
        const encoding = bytes[p++];
        let mimeEnd = p;
        while (mimeEnd < frameEnd && bytes[mimeEnd] !== 0) mimeEnd++;
        const mime = new TextDecoder('latin1').decode(bytes.slice(p, mimeEnd)) || 'image/jpeg';
        p = mimeEnd + 1;
        if (p >= frameEnd) return null;
        p++;

        if (encoding === 0 || encoding === 3) {
          while (p < frameEnd && bytes[p] !== 0) p++;
          p++;
        } else {
          while (p + 1 < frameEnd && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
          p += 2;
        }

        if (p >= frameEnd) return null;
        const data = bytes.slice(p, frameEnd);
        return new Blob([data], { type: mime });
      }

      offset = frameStart + frameSize;
    }
    return null;
  }

  async function loadTrackArtwork(track, sourceBlob) {
    if (!track) {
      setArtworkBlob(null);
      return;
    }

    if (track.artworkBlob instanceof Blob) {
      if (currentId === track.id) setArtworkBlob(track.artworkBlob);
      return;
    }

    if (!sourceBlob || !/\.mp3$/i.test(track.name || '')) {
      if (currentId === track.id) setArtworkBlob(null);
      return;
    }

    try {
      const artwork = await extractMp3Artwork(sourceBlob);
      if (currentId !== track.id) return;
      if (!artwork) {
        setArtworkBlob(null);
        return;
      }

      track.artworkBlob = artwork;
      try {
        await idbRequest(TRACKS, 'readwrite', store => store.put(track));
      } catch {}
      setArtworkBlob(artwork);
      applyMediaSession(track, artworkObjectUrl);
    } catch {
      if (currentId === track.id) setArtworkBlob(null);
    }
  }

  async function updateTrackDuration(id, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return;
    const track = tracks.find(item => item.id === id);
    if (!track || Math.abs((track.duration || 0) - duration) < 0.5) return;
    track.duration = duration;
    try {
      await idbRequest(TRACKS, 'readwrite', store => store.put(track));
    } catch {}
    renderTracks();
  }

  function applyMediaSession(track, artworkSrc = null) {
    if (!('mediaSession' in navigator)) return;
    try {
      const src = artworkSrc || FALLBACK_ARTWORK;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || track.name,
        artist: track.artist || '로컬 파일',
        album: '오프라인 뮤직',
        artwork: [{ src }]
      });
    } catch {}
  }

  function setMediaPlaybackState() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    } catch {}
  }

  function updateMediaPosition() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime || 0, audio.duration)
      });
    } catch {}
  }

  async function selectTrack(id, autoplay, startFromBeginning = false) {
    const track = tracks.find(item => item.id === id);
    if (!track) return;

    rememberPosition();
    audio.pause();

    let nextUrl = null;
    let sourceBlob = null;
    if (preparedNext?.id === id && preparedNext.url) {
      nextUrl = preparedNext.url;
      sourceBlob = preparedNext.blob || null;
      preparedNext = null;
      prepareGeneration++;
    } else {
      clearPreparedNext();
      let record;
      try {
        record = await getAudioRecord(id);
      } catch (error) {
        setStatus(error.message || '음악 파일을 열지 못했습니다.');
        return;
      }

      if (!record?.blob) {
        setStatus('저장된 음악 데이터가 없습니다.');
        return;
      }
      sourceBlob = record.blob;
      nextUrl = URL.createObjectURL(record.blob);
    }

    revokeObjectUrl();
    currentId = id;
    saveState();
    objectUrl = nextUrl;
    audio.src = objectUrl;
    audio.load();
    if (track.artworkBlob instanceof Blob) setArtworkBlob(track.artworkBlob);
    else setArtworkBlob(null);
    applyMediaSession(track, artworkObjectUrl || null);
    void loadTrackArtwork(track, sourceBlob);
    renderAll();

    let playPromise = null;
    if (autoplay) {
      try {
        playPromise = audio.play();
      } catch {}
    }

    const desiredPosition = startFromBeginning ? 0 : Number(positions[id] || 0);
    const onLoaded = async () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      await updateTrackDuration(id, audio.duration);
      if (desiredPosition > 0 && Number.isFinite(audio.duration) && desiredPosition < audio.duration - 2) {
        try { audio.currentTime = desiredPosition; } catch {}
      }
      updateTimeline();
      updateMediaPosition();
      void prepareNextTrack();

      if (autoplay) {
        try {
          if (playPromise) await playPromise;
          else await audio.play();
          setStatus('재생 중');
        } catch {
          setStatus('재생 버튼을 한 번 눌러 주세요.');
        }
      }
    };
    audio.addEventListener('loadedmetadata', onLoaded);
  }

  function rememberPosition() {
    if (!currentId || !Number.isFinite(audio.currentTime)) return;
    positions[currentId] = Math.max(0, audio.currentTime);
    saveState();
  }

  function updateTimeline() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    $('currentTime').textContent = formatTime(current);
    $('duration').textContent = formatTime(duration || currentTrack()?.duration || 0);
    $('seek').value = duration > 0 ? Math.round((current / duration) * 1000) : 0;
  }

  async function playPause() {
    if (!currentId) {
      if (tracks.length) await selectTrack(tracks[0].id, true);
      return;
    }

    if (audio.paused) {
      try {
        await audio.play();
        setStatus('재생 중 · 화면을 잠그거나 다른 앱으로 이동해 보세요.');
      } catch {
        setStatus('이 기기에서 재생을 시작하지 못했습니다.');
      }
    } else {
      audio.pause();
    }
  }

  function nextIndex(direction) {
    if (!tracks.length) return -1;
    const index = currentIndex();

    if (shuffle && tracks.length > 1) {
      let candidate = index;
      for (let attempts = 0; attempts < 8 && candidate === index; attempts++) {
        candidate = Math.floor(Math.random() * tracks.length);
      }
      return candidate;
    }

    if (index < 0) return direction >= 0 ? 0 : tracks.length - 1;
    return (index + direction + tracks.length) % tracks.length;
  }

  async function nextTrack(fromEnded = false) {
    if (!tracks.length) return;
    const index = currentIndex();

    if (fromEnded && repeat === 'one') {
      audio.currentTime = 0;
      try { await audio.play(); } catch {}
      return;
    }

    if (fromEnded && repeat === 'off' && !shuffle && index === tracks.length - 1) {
      audio.pause();
      audio.currentTime = 0;
      positions[currentId] = 0;
      saveState();
      updateTimeline();
      setStatus('재생목록 끝');
      clearPreparedNext();
      return;
    }

    if (fromEnded && preparedNext?.id) {
      const id = preparedNext.id;
      await selectTrack(id, true, true);
      return;
    }

    const next = nextIndex(1);
    if (next >= 0) await selectTrack(tracks[next].id, true, fromEnded);
  }

  async function prevTrack() {
    if (!tracks.length) return;
    if (audio.currentTime > 4) {
      audio.currentTime = 0;
      updateTimeline();
      return;
    }
    const prev = nextIndex(-1);
    if (prev >= 0) await selectTrack(tracks[prev].id, true);
  }

  async function importFiles(fileList) {
    if (importing || !fileList?.length) return;
    importing = true;
    $('addBtn').disabled = true;
    $('emptyAddBtn').disabled = true;

    let added = 0;
    let duplicate = 0;
    let failed = 0;
    const existing = new Set(tracks.map(track => track.fingerprint));

    try {
      for (const file of Array.from(fileList)) {
        if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(file.name)) {
          failed++;
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          failed++;
          continue;
        }

        const fp = fingerprint(file);
        if (existing.has(fp)) {
          duplicate++;
          continue;
        }

        const id = crypto.randomUUID ? crypto.randomUUID() :
          Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        const parsed = parseName(file.name);
        const meta = {
          id,
          fingerprint: fp,
          name: file.name,
          title: parsed.title,
          artist: parsed.artist,
          type: file.type || 'audio/mpeg',
          size: file.size,
          addedAt: Date.now() + added,
          duration: 0
        };

        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction([TRACKS, AUDIO], 'readwrite');
            tx.objectStore(TRACKS).add(meta);
            tx.objectStore(AUDIO).add({ id, blob: file });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('저장 실패'));
            tx.onabort = () => reject(tx.error || new Error('저장 취소'));
          });
          existing.add(fp);
          added++;
          setStatus('음악 저장 중… ' + added + '곡');
        } catch (error) {
          if (error?.name === 'ConstraintError') duplicate++;
          else {
            failed++;
            if (error?.name === 'QuotaExceededError') {
              setStatus('기기 저장 공간이 부족합니다.');
              break;
            }
          }
        }
      }

      tracks = await allTracks();
      if (!currentId && tracks.length) {
        currentId = tracks[0].id;
        saveState();
        await selectTrack(currentId, false);
      } else {
        renderAll();
      }

      const parts = [];
      if (added) parts.push(added + '곡 추가');
      if (duplicate) parts.push(duplicate + '곡 중복');
      if (failed) parts.push(failed + '곡 실패');
      toast(parts.join(' · ') || '추가된 음악이 없습니다.');
      await showStorage();
    } finally {
      importing = false;
      $('addBtn').disabled = false;
      $('emptyAddBtn').disabled = false;
      $('fileInput').value = '';
    }
  }

  async function deleteTrack(id) {
    const track = tracks.find(item => item.id === id);
    if (!track) return;
    if (!confirm('“' + (track.title || track.name) + '”을(를) 삭제할까요?')) return;

    const wasCurrent = currentId === id;
    if (wasCurrent) {
      clearPreparedNext();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      revokeObjectUrl();
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction([TRACKS, AUDIO], 'readwrite');
      tx.objectStore(TRACKS).delete(id);
      tx.objectStore(AUDIO).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    delete positions[id];
    tracks = await allTracks();

    if (wasCurrent) {
      currentId = tracks[0]?.id || null;
      saveState();
      if (currentId) await selectTrack(currentId, false);
      else renderAll();
    } else {
      saveState();
      renderAll();
    }
    await showStorage();
  }

  async function clearAll() {
    if (!tracks.length) return;
    if (!confirm('이 기기에 저장된 음악을 모두 삭제할까요?')) return;

    clearPreparedNext();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    revokeObjectUrl();

    await new Promise((resolve, reject) => {
      const tx = db.transaction([TRACKS, AUDIO], 'readwrite');
      tx.objectStore(TRACKS).clear();
      tx.objectStore(AUDIO).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    tracks = [];
    currentId = null;
    positions = {};
    setArtworkBlob(null);
    saveState();
    renderAll();
    $('manageDialog').close();
    toast('저장된 음악을 모두 삭제했습니다.');
    await showStorage();
  }

  async function showStorage() {
    if (!navigator.storage?.estimate) {
      $('storageInfo').textContent = '이 브라우저에서는 저장 공간 정보를 확인할 수 없습니다.';
      return;
    }

    try {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage || 0;
      const quota = estimate.quota || 0;
      const musicBytes = tracks.reduce((sum, track) => sum + (track.size || 0), 0);
      let text = '음악 ' + formatBytes(musicBytes);
      if (quota > 0) text += ' · 브라우저 전체 ' + formatBytes(used) + ' / ' + formatBytes(quota);
      $('storageInfo').textContent = text;
    } catch {
      $('storageInfo').textContent = '저장 공간 정보를 확인하지 못했습니다.';
    }
  }

  async function requestPersistentStorage() {
    if (!navigator.storage?.persist) {
      $('persistInfo').textContent = 'iOS에서는 이 기능을 직접 지원하지 않을 수 있습니다.';
      return;
    }
    try {
      const granted = await navigator.storage.persist();
      $('persistInfo').textContent = granted ? '저장 공간 보호가 허용되었습니다.' : '브라우저가 저장 공간 보호를 허용하지 않았습니다.';
    } catch {
      $('persistInfo').textContent = '저장 공간 보호 요청을 사용할 수 없습니다.';
    }
  }

  function registerMediaActions() {
    if (!('mediaSession' in navigator)) return;

    const actions = {
      play: () => { void playPause(); },
      pause: () => { audio.pause(); },
      previoustrack: () => { void prevTrack(); },
      nexttrack: () => { void nextTrack(false); },
      seekbackward: details => {
        audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
      },
      seekforward: details => {
        const target = audio.currentTime + (details.seekOffset || 10);
        audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, target) : target;
      },
      seekto: details => {
        if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime;
      }
    };

    for (const [action, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    }
  }

  $('addBtn').addEventListener('click', () => $('fileInput').click());
  $('emptyAddBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => { void importFiles($('fileInput').files); });
  $('playBtn').addEventListener('click', () => { void playPause(); });
  $('prevBtn').addEventListener('click', () => { void prevTrack(); });
  $('nextBtn').addEventListener('click', () => { void nextTrack(false); });

  $('shuffleBtn').addEventListener('click', () => {
    shuffle = !shuffle;
    saveState();
    renderModes();
    void prepareNextTrack();
  });

  $('repeatBtn').addEventListener('click', () => {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    saveState();
    renderModes();
    void prepareNextTrack();
  });

  $('seek').addEventListener('input', () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const time = (Number($('seek').value) / 1000) * audio.duration;
    $('currentTime').textContent = formatTime(time);
  });

  $('seek').addEventListener('change', () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = (Number($('seek').value) / 1000) * audio.duration;
    rememberPosition();
    updateMediaPosition();
  });

  $('manageBtn').addEventListener('click', () => {
    void showStorage();
    $('persistInfo').textContent = '';
    $('manageDialog').showModal();
  });
  $('closeManageBtn').addEventListener('click', () => $('manageDialog').close());
  $('persistBtn').addEventListener('click', () => { void requestPersistentStorage(); });
  $('clearBtn').addEventListener('click', () => { void clearAll(); });

  audio.addEventListener('play', () => {
    $('playBtn').textContent = 'Ⅱ';
    $('playBtn').setAttribute('aria-label', '일시정지');
    setMediaPlaybackState();
    renderTracks();
    void prepareNextTrack();
  });

  audio.addEventListener('pause', () => {
    $('playBtn').textContent = '▶';
    $('playBtn').setAttribute('aria-label', '재생');
    rememberPosition();
    setMediaPlaybackState();
    renderTracks();
  });

  audio.addEventListener('timeupdate', () => {
    updateTimeline();
    const second = Math.floor(audio.currentTime || 0);
    if (second !== lastSavedSecond && second % 5 === 0) {
      lastSavedSecond = second;
      rememberPosition();
      updateMediaPosition();
    }
  });

  audio.addEventListener('durationchange', () => {
    updateTimeline();
    updateMediaPosition();
    if (currentId) void updateTrackDuration(currentId, audio.duration);
  });

  audio.addEventListener('ended', () => {
    positions[currentId] = 0;
    saveState();
    void nextTrack(true);
  });

  audio.addEventListener('error', () => {
    setStatus('이 음악 파일을 iPhone Safari가 재생하지 못했습니다. 다른 형식으로 변환해 보세요.');
  });

  window.addEventListener('pagehide', () => {
    rememberPosition();
    void prepareNextTrack();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      rememberPosition();
      void prepareNextTrack();
    }
  });

  window.addEventListener('resize', updateArtworkGeometry, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateArtworkGeometry, { passive: true });
  }

  async function init() {
    loadState();
    setArtworkBlob(null);
    registerMediaActions();
    renderModes();

    try {
      db = await openDB();
      tracks = await allTracks();

      if (currentId && !tracks.some(track => track.id === currentId)) currentId = null;
      if (!currentId && tracks.length) currentId = tracks[0].id;
      saveState();
      renderAll();

      if (currentId) await selectTrack(currentId, false);
      await showStorage();
    } catch (error) {
      setStatus(error?.message || '음악 저장소를 초기화하지 못했습니다.');
      $('addBtn').disabled = true;
      $('emptyAddBtn').disabled = true;
    }

    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js', { scope: './' });
      } catch {}
    }
  }

  void init();
});
