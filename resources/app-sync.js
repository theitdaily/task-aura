(() => {
    const SYNC_KEY = 'appSync';
    const DATA_KEY = 'appData';
    const SYNC_PATH = '/api/task-aura/sync';
    const BACKUPS_PATH = '/api/task-aura/backups';
    const PUSH_DELAY = 5000;
    const POLL_DELAY = 60000;

    const elements = {
        status: document.getElementById('appSyncStatus'),
        deviceName: document.getElementById('appSyncDeviceName'),
        syncNow: document.getElementById('appSyncNowBtn'),
        refreshBackups: document.getElementById('appSyncRefreshBackupsBtn'),
        backups: document.getElementById('appSyncBackups'),
        conflict: document.getElementById('appSyncConflictModal'),
        conflictDetails: document.getElementById('appSyncConflictDetails'),
        useServer: document.getElementById('appSyncUseServerBtn'),
        useLocal: document.getElementById('appSyncUseLocalBtn'),
        indicator: document.getElementById('appSyncIndicator'),
        indicatorIcon: document.getElementById('appSyncIndicatorIcon'),
        indicatorTitle: document.getElementById('appSyncIndicatorTitle'),
        indicatorSubtitle: document.getElementById('appSyncIndicatorSubtitle'),
    };
    if (!elements.status) return;
    if (window.taskAuraSync?.initialized) return;

    const translations = {
        checking: document.getElementById('externalAuth')?.dataset.syncChecking,
        waiting: document.getElementById('externalAuth')?.dataset.syncWaiting,
        choice: document.getElementById('externalAuth')?.dataset.syncChoice,
        synced: document.getElementById('externalAuth')?.dataset.syncSynced,
        offline: document.getElementById('externalAuth')?.dataset.syncOffline,
        authRequired: document.getElementById('externalAuth')?.dataset.syncAuthRequired,
        local: document.getElementById('externalAuth')?.dataset.syncLocal,
        server: document.getElementById('externalAuth')?.dataset.syncServer,
        noBackups: document.getElementById('externalAuth')?.dataset.syncNoBackups,
        restore: document.getElementById('externalAuth')?.dataset.syncRestore,
        indicatorOffline: document.getElementById('externalAuth')?.dataset.indicatorOffline,
        indicatorOfflineSubtitle: document.getElementById('externalAuth')?.dataset.indicatorOfflineSubtitle,
        indicatorPending: document.getElementById('externalAuth')?.dataset.indicatorPending,
        indicatorPendingSubtitle: document.getElementById('externalAuth')?.dataset.indicatorPendingSubtitle,
        indicatorSyncing: document.getElementById('externalAuth')?.dataset.indicatorSyncing,
        indicatorSynced: document.getElementById('externalAuth')?.dataset.indicatorSynced,
    };
    const text = (key, fallback) => translations[key] || fallback;

    let pushTimer = null;
    let requestInProgress = false;
    let pendingConflict = null;
    let localChangeVersion = 0;
    let nextPushAt = 0;
    let syncRequested = false;
    let indicatorHideTimer = null;

    const indicatorStates = {
        offline: ['bi-cloud-slash', 'indicatorOffline', 'Offline', 'indicatorOfflineSubtitle', 'data is saved on this device'],
        pending: ['bi-arrow-repeat', 'indicatorPending', 'Waiting for synchronization', 'indicatorPendingSubtitle', 'will send when connected'],
        syncing: ['bi-arrow-repeat', 'indicatorSyncing', 'Synchronization...', null, ''],
        synced: ['bi-check-circle-fill', 'indicatorSynced', 'Synchronized', null, ''],
    };

    const setIndicator = (state = null) => {
        if (!elements.indicator) return;
        clearTimeout(indicatorHideTimer);
        indicatorHideTimer = null;
        elements.indicator.className = 'app-sync-indicator';
        if (!state || !indicatorStates[state]) return;
        const [icon, titleKey, titleFallback, subtitleKey, subtitleFallback] = indicatorStates[state];
        elements.indicator.classList.add(state, 'show');
        elements.indicatorIcon.className = `bi ${icon} app-sync-indicator-icon`;
        elements.indicatorTitle.textContent = text(titleKey, titleFallback);
        elements.indicatorSubtitle.textContent = subtitleKey ? text(subtitleKey, subtitleFallback) : '';
        if (state === 'synced') {
            indicatorHideTimer = window.setTimeout(() => setIndicator(), 2500);
        }
    };

    const createId = () => {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };

    const defaultDeviceName = (deviceId) => {
        const platform = navigator.userAgentData?.platform || navigator.platform || 'Browser';
        const brands = navigator.userAgentData?.brands?.map((brand) => brand.brand).join(' ') || '';
        const userAgent = `${brands} ${navigator.userAgent || ''}`;
        const browserName = /Edg\//.test(userAgent) ? 'Edge'
            : (/Firefox\//.test(userAgent) ? 'Firefox'
                : (/Chrome\//.test(userAgent) || /Chromium/.test(userAgent) ? 'Chrome'
                    : (/Safari\//.test(userAgent) ? 'Safari' : 'Browser')));
        return `${platform} · ${browserName} [${deviceId}]`;
    };

    const uniqueDeviceName = (name, deviceId) => {
        const suffix = `[${deviceId}]`;
        const baseName = String(name || '')
            .replace(/\s*\[[0-9a-f-]{8,36}\]$/i, '')
            .trim() || defaultDeviceName(deviceId).replace(/\s*\[[0-9a-f-]{8,36}\]$/i, '');
        return `${baseName} ${suffix}`;
    };

    const readSync = () => {
        let stored = {};
        try { stored = JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { stored = {}; }
        const deviceId = stored.device_id || createId();
        const sync = {
            revision: Number.isFinite(Number(stored.revision)) && stored.revision !== null ? Number(stored.revision) : null,
            dirty: stored.dirty === true,
            timezone: stored.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            device_id: deviceId,
            device_name: uniqueDeviceName(stored.device_name, deviceId),
            local_updated_at: stored.local_updated_at || null,
        };
        localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
        return sync;
    };

    let syncState = readSync();
    elements.deviceName.value = syncState.device_name;

    const writeSync = (changes = {}) => {
        syncState = { ...syncState, ...changes };
        localStorage.setItem(SYNC_KEY, JSON.stringify(syncState));
    };

    const setStatus = (message, kind = 'muted') => {
        elements.status.textContent = message;
        elements.status.className = `small mb-2 text-${kind}`;
    };

    const parseApiResponse = async (response) => {
        const text = await response.text();
        let payload = {};
        if (text) {
            try { payload = JSON.parse(text); } catch { payload = { message: text }; }
        }
        if (!response.ok) {
            const error = new Error(payload.message || `API request failed (${response.status})`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    };

    const api = async (path, options = {}) => {
        if (!window.taskAuraApi || !window.taskAuraAuth?.isAuthenticated()) throw new Error(text('authRequired', 'Authentication is required'));
        const headers = { Accept: 'application/json', ...options.headers };
        if (options.body) headers['Content-Type'] = 'application/json';
        try {
            return await parseApiResponse(await window.taskAuraApi(path, { ...options, headers }));
        } catch (error) {
            error.requestMethod = (options.method || 'GET').toUpperCase();
            throw error;
        }
    };

    const serverVersion = () => api(SYNC_PATH, { method: 'GET', cache: 'no-store' });
    const serverData = (server) => server.data ?? server.app_data ?? null;
    const serverRevision = (server, required = false) => {
        if (required && server.revision === undefined) throw new Error('Missing server revision');
        const revision = Number(server.revision ?? 0);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid server revision');
        return revision;
    };
    const hasServerData = (server) => serverData(server) !== null;

    const replaceWithServer = (server) => {
        const data = serverData(server);
        if (data !== null) localStorage.setItem(DATA_KEY, typeof data === 'string' ? data : JSON.stringify(data));
        else localStorage.removeItem(DATA_KEY);
        writeSync({ revision: serverRevision(server), dirty: false, local_updated_at: null });
        window.location.reload();
    };

    const formatVersion = (label, time, device) => {
        const row = document.createElement('p');
        row.className = 'mb-1';
        const strong = document.createElement('strong');
        strong.textContent = `${label}: `;
        row.append(strong, document.createTextNode(`${time || '—'} · ${device || '—'}`));
        return row;
    };

    const showConflict = (server, initial = false) => {
        pendingConflict = { server, initial };
        elements.conflictDetails.replaceChildren(
            formatVersion(text('local', 'Local version'), syncState.local_updated_at, syncState.device_name),
            formatVersion(text('server', 'Server version'), server.updated_at || server.modified_at, server.device_name),
        );
        bootstrap.Modal.getOrCreateInstance(elements.conflict).show();
        setStatus(text('choice', 'Synchronization needs your choice'), 'warning');
        setIndicator('pending');
    };

    const closeConflict = () => bootstrap.Modal.getOrCreateInstance(elements.conflict).hide();

    const schedulePush = (delay = PUSH_DELAY) => {
        clearTimeout(pushTimer);
        nextPushAt = Date.now() + delay;
        pushTimer = window.setTimeout(() => {
            pushTimer = null;
            synchronize();
        }, delay);
    };

    const markDirty = () => {
        localChangeVersion += 1;
        writeSync({ dirty: true, local_updated_at: new Date().toISOString() });
        setStatus(text('waiting', 'Local changes are waiting to synchronize'));
        setIndicator('pending');
        schedulePush();
    };

    const push = async (force = false) => {
        const serializedData = localStorage.getItem(DATA_KEY);
        if (serializedData === null) return;
        const pushedChangeVersion = localChangeVersion;
        const payload = {
            data: JSON.parse(serializedData),
            base_revision: syncState.revision ?? 0,
            timezone: syncState.timezone,
            device_id: syncState.device_id,
            device_name: syncState.device_name,
        };
        if (force) payload.force = true;
        const result = await api(SYNC_PATH, { method: 'PUT', body: JSON.stringify(payload) });
        const newRevision = serverRevision(result, true);
        const unchanged = localChangeVersion === pushedChangeVersion
            && localStorage.getItem(DATA_KEY) === serializedData;
        writeSync({
            revision: newRevision,
            dirty: !unchanged,
            local_updated_at: unchanged ? null : syncState.local_updated_at,
        });
        if (!unchanged && !pushTimer) schedulePush(Math.max(0, nextPushAt - Date.now()));
        if (unchanged) nextPushAt = 0;
        return result;
    };

    const reconcile = async (server) => {
        const localExists = localStorage.getItem(DATA_KEY) !== null;
        const remoteExists = hasServerData(server);
        const remoteRevision = serverRevision(server);

        if (!localExists && remoteExists) return replaceWithServer(server);
        if (localExists && remoteExists && syncState.revision === null) return showConflict(server, true);
        if (remoteRevision > Number(syncState.revision ?? 0)) {
            if (syncState.dirty) return showConflict(server);
            return replaceWithServer(server);
        }
        if (localExists && (syncState.dirty || !remoteExists)) {
            if (syncState.dirty && nextPushAt > Date.now()) {
                schedulePush(nextPushAt - Date.now());
                setStatus(text('waiting', 'Local changes are waiting to synchronize'));
                setIndicator('pending');
                return;
            }
            await push(false);
        }
        else writeSync({ revision: remoteRevision });
        setStatus(
            syncState.dirty ? text('waiting', 'Local changes are waiting to synchronize') : text('synced', 'Data is synchronized'),
            syncState.dirty ? 'muted' : 'success',
        );
        setIndicator(syncState.dirty ? 'pending' : 'synced');
    };

    async function synchronize() {
        if (requestInProgress) {
            syncRequested = true;
            return;
        }
        if (pendingConflict || !window.taskAuraAuth?.isAuthenticated()) return;
        requestInProgress = true;
        clearTimeout(pushTimer);
        pushTimer = null;
        setStatus(text('checking', 'Checking server version...'));
        setIndicator('syncing');
        try {
            await reconcile(await serverVersion());
        } catch (error) {
            if (error.status === 409) {
                try {
                    showConflict(await serverVersion());
                } catch (refreshError) {
                    console.warn('Could not load TaskAura conflict version', refreshError);
                    setStatus(text('offline', 'Offline. Local changes will be synchronized later.'), 'warning');
                    setIndicator('offline');
                }
            } else if (error.status === 401 && !['GET', 'HEAD', 'OPTIONS'].includes(error.requestMethod)) {
                nextPushAt = Date.now() + 1000;
                setStatus(text('waiting', 'Local changes are waiting to synchronize'));
                setIndicator('pending');
            } else {
                console.warn('TaskAura synchronization is offline', error);
                setStatus(text('offline', 'Offline. Local changes will be synchronized later.'), 'warning');
                setIndicator('offline');
            }
        } finally {
            requestInProgress = false;
            if (syncRequested && !pendingConflict) {
                syncRequested = false;
                schedulePush(0);
            } else if (syncState.dirty && !pendingConflict && !pushTimer && nextPushAt > Date.now()) {
                schedulePush(nextPushAt - Date.now());
            }
        }
    }

    const loadBackups = async () => {
        elements.backups.replaceChildren();
        try {
            const result = await api(BACKUPS_PATH, { method: 'GET', cache: 'no-store' });
            const backups = Array.isArray(result) ? result : (result.backups || []);
            if (!backups.length) elements.backups.textContent = text('noBackups', 'No backups');
            backups.forEach((backup) => {
                const row = document.createElement('div');
                row.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
                const description = document.createElement('span');
                description.textContent = `${backup.created_at || backup.updated_at || '—'} · ${backup.device_name || '—'} · r${backup.revision ?? '—'}`;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-primary btn-sm';
                button.textContent = text('restore', 'Restore');
                button.addEventListener('click', async () => {
                    if (requestInProgress || pendingConflict) return;
                    button.disabled = true;
                    requestInProgress = true;
                    clearTimeout(pushTimer);
                    pushTimer = null;
                    setIndicator('syncing');
                    try {
                        await api(`${BACKUPS_PATH}/${encodeURIComponent(backup.id)}/restore`, { method: 'POST' });
                        replaceWithServer(await serverVersion());
                    } catch (error) {
                        setStatus(error.message, 'danger');
                        setIndicator(!error.status || error.status >= 500 ? 'offline' : (syncState.dirty ? 'pending' : 'synced'));
                        button.disabled = false;
                    } finally {
                        requestInProgress = false;
                    }
                });
                row.append(description, button);
                elements.backups.append(row);
            });
        } catch (error) {
            setStatus(error.message, 'warning');
        }
    };

    elements.useServer.addEventListener('click', () => {
        const conflict = pendingConflict;
        pendingConflict = null;
        closeConflict();
        if (conflict) replaceWithServer(conflict.server);
    });
    elements.useLocal.addEventListener('click', async () => {
        if (requestInProgress) return;
        elements.useLocal.disabled = true;
        requestInProgress = true;
        setIndicator('syncing');
        try {
            await push(true);
            pendingConflict = null;
            closeConflict();
            setStatus(
                syncState.dirty ? text('waiting', 'Local changes are waiting to synchronize') : text('synced', 'Data is synchronized'),
                syncState.dirty ? 'muted' : 'success',
            );
            setIndicator(syncState.dirty ? 'pending' : 'synced');
        } catch (error) {
            setStatus(error.message, 'warning');
            setIndicator(!error.status || error.status >= 500 ? 'offline' : 'pending');
        } finally {
            requestInProgress = false;
            elements.useLocal.disabled = false;
            if (syncState.dirty && !pendingConflict && !pushTimer) schedulePush();
        }
    });
    elements.deviceName.addEventListener('change', () => {
        const name = uniqueDeviceName(elements.deviceName.value, syncState.device_id);
        elements.deviceName.value = name;
        writeSync({ device_name: name });
        markDirty();
    });
    elements.syncNow.addEventListener('click', synchronize);
    elements.refreshBackups.addEventListener('click', loadBackups);
    window.addEventListener('taskaura:app-data-changed', markDirty);
    window.addEventListener('taskaura:auth-changed', () => {
        if (!window.taskAuraAuth?.isAuthenticated()) {
            setIndicator();
            return;
        }
        synchronize();
        loadBackups();
    });
    window.addEventListener('online', synchronize);
    window.addEventListener('offline', () => {
        if (window.taskAuraAuth?.isAuthenticated()) setIndicator('offline');
    });

    window.taskAuraSync = { initialized: true, markDirty, synchronize, loadBackups };
    window.setInterval(synchronize, POLL_DELAY);
    if (syncState.dirty) setIndicator('pending');
    synchronize();
    if (window.taskAuraAuth?.isAuthenticated()) loadBackups();
})();
