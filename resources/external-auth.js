const STORAGE = {
    verifier: 'external_auth_code_verifier',
    requestId: 'external_auth_request_id',
    accessToken: 'external_auth_access_token',
    refreshToken: 'external_auth_refresh_token',
    expiresAt: 'external_auth_expires_at',
};

const encodeBase64Url = (bytes) => {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Web Crypto digest is unavailable in some otherwise supported browsers when the
// app is opened over plain HTTP. Keep getRandomValues for the verifier, but use a
// local SHA-256 implementation as a digest fallback in that environment.
const sha256Fallback = (input) => {
    const bytes = new TextEncoder().encode(input);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);
    const rotateRight = (value, amount) => (value >>> amount) | (value << (32 - amount));

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
        for (let index = 16; index < 64; index += 1) {
            const first = words[index - 15];
            const second = words[index - 2];
            const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
            const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
            words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index] + value) >>> 0; });
    }

    const result = new Uint8Array(32);
    const resultView = new DataView(result.buffer);
    hash.forEach((value, index) => resultView.setUint32(index * 4, value, false));
    return result;
};

const sha256 = async (input, cryptoApi) => {
    if (cryptoApi.subtle?.digest) {
        const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(input));
        return new Uint8Array(digest);
    }
    return sha256Fallback(input);
};

const parseResponse = async (response) => {
    const text = await response.text();
    const body = text ? (() => {
        try { return JSON.parse(text); } catch { return { message: text }; }
    })() : {};

    if (!response.ok) {
        const error = new Error(body.message || `API request failed (${response.status})`);
        error.status = response.status;
        error.response = body;
        throw error;
    }
    return body;
};

function createExternalAuth(config, browser = window) {
    const apiUrl = (config.apiUrl || '').replace(/\/+$/, '');
    const endpoint = (path) => `${apiUrl}${path}`;
    let refreshPromise = null;

    const ensureConfigured = () => {
        if (!apiUrl || !config.clientId || !config.redirectUrl) {
            throw new Error('External authentication is not configured');
        }
    };

    const post = (path, body, headers = {}) => browser.fetch(endpoint(path), {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    }).then(parseResponse);

    const clearFlow = () => {
        browser.sessionStorage.removeItem(STORAGE.verifier);
        browser.sessionStorage.removeItem(STORAGE.requestId);
    };

    const clearTokens = () => {
        browser.localStorage.removeItem(STORAGE.accessToken);
        browser.localStorage.removeItem(STORAGE.refreshToken);
        browser.localStorage.removeItem(STORAGE.expiresAt);
    };

    const saveTokens = (tokens, fallbackRefreshToken = null) => {
        const refreshToken = tokens.refresh_token || fallbackRefreshToken;
        if (!tokens.access_token || !refreshToken || !Number.isFinite(Number(tokens.expires_in))) {
            throw new Error('The token response is incomplete');
        }
        browser.localStorage.setItem(STORAGE.accessToken, tokens.access_token);
        browser.localStorage.setItem(STORAGE.refreshToken, refreshToken);
        browser.localStorage.setItem(STORAGE.expiresAt, String(Date.now() + Number(tokens.expires_in) * 1000));
    };

    const removeCallbackParameters = () => {
        const url = new URL(browser.location.href);
        url.searchParams.delete('request_id');
        url.searchParams.delete('code');
        browser.history.replaceState({}, browser.document.title, `${url.pathname}${url.search}${url.hash}`);
    };

    const login = async () => {
        ensureConfigured();
        const random = new Uint8Array(64);
        browser.crypto.getRandomValues(random);
        const verifier = encodeBase64Url(random);
        const digest = await sha256(verifier, browser.crypto);
        const codeChallenge = encodeBase64Url(digest);

        // The verifier remains in sessionStorage and is never included in the init request.
        browser.sessionStorage.setItem(STORAGE.verifier, verifier);
        browser.sessionStorage.removeItem(STORAGE.requestId);
        try {
            const result = await post('/api/auth/init', {
                client_id: config.clientId,
                redirect_url: config.redirectUrl,
                code_challenge: codeChallenge,
            });
            if (!result.request_id || !result.authorize_url) throw new Error('The authorization response is incomplete');
            browser.sessionStorage.setItem(STORAGE.requestId, result.request_id);
            browser.location.assign(result.authorize_url);
        } catch (error) {
            clearFlow();
            throw error;
        }
    };

    const handleCallback = async () => {
        ensureConfigured();
        const params = new URL(browser.location.href).searchParams;
        const requestId = params.get('request_id');
        const code = params.get('code');
        const storedRequestId = browser.sessionStorage.getItem(STORAGE.requestId);
        const verifier = browser.sessionStorage.getItem(STORAGE.verifier);
        if (!requestId || !code || !verifier || requestId !== storedRequestId) {
            clearFlow();
            removeCallbackParameters();
            throw new Error('Invalid or expired authorization response');
        }
        try {
            const tokens = await post('/api/auth/token', {
                request_id: requestId,
                code,
                code_verifier: verifier,
            });
            saveTokens(tokens);
        } finally {
            clearFlow();
            removeCallbackParameters();
        }
    };

    const refresh = async () => {
        if (refreshPromise) return refreshPromise;
        const refreshToken = browser.localStorage.getItem(STORAGE.refreshToken);
        if (!refreshToken) throw new Error('Authentication is required');
        refreshPromise = post('/api/auth/refresh', { refresh_token: refreshToken })
            .then((tokens) => { saveTokens(tokens, refreshToken); return tokens.access_token; })
            .catch((error) => { clearTokens(); throw error; })
            .finally(() => { refreshPromise = null; });
        return refreshPromise;
    };

    const validAccessToken = async () => {
        const token = browser.localStorage.getItem(STORAGE.accessToken);
        const expiresAt = Number(browser.localStorage.getItem(STORAGE.expiresAt));
        return token && expiresAt > Date.now() + 30000 ? token : refresh();
    };

    const apiFetch = async (path, options = {}) => {
        ensureConfigured();
        const method = (options.method || 'GET').toUpperCase();
        const canRetry = ['GET', 'HEAD', 'OPTIONS'].includes(method);
        const request = async (token) => browser.fetch(endpoint(path), {
            ...options,
            headers: { Accept: 'application/json', ...options.headers, Authorization: `Bearer ${token}` },
        });
        let response = await request(await validAccessToken());
        if (response.status === 401) {
            const token = await refresh();
            if (canRetry) response = await request(token);
        }
        return response;
    };

    const logout = async () => {
        const accessToken = browser.localStorage.getItem(STORAGE.accessToken);
        const refreshToken = browser.localStorage.getItem(STORAGE.refreshToken);
        try {
            if (accessToken) await post('/api/auth/logout', { refresh_token: refreshToken }, { Authorization: `Bearer ${accessToken}` });
        } finally {
            clearFlow();
            clearTokens();
        }
    };

    return {
        login, handleCallback, refresh, apiFetch, logout,
        hasCallbackParameters: () => {
            const params = new URL(browser.location.href).searchParams;
            return params.has('request_id') || params.has('code');
        },
        isAuthenticated: () => Boolean(browser.localStorage.getItem(STORAGE.refreshToken)),
    };
}


const authRoot = document.getElementById('externalAuth');

if (authRoot) {
    const config = {
        apiUrl: authRoot.dataset.apiUrl,
        clientId: authRoot.dataset.clientId,
        redirectUrl: authRoot.dataset.redirectUrl,
    };
    const status = document.getElementById('externalAuthStatus');
    const loginButton = document.getElementById('externalLoginBtn');
    const logoutButton = document.getElementById('externalLogoutBtn');
    const auth = createExternalAuth(config);

    const render = (message = '') => {
        const authenticated = auth.isAuthenticated();
        loginButton.classList.toggle('d-none', authenticated);
        logoutButton.classList.toggle('d-none', !authenticated);
        status.textContent = message || (authenticated
            ? authRoot.dataset.authenticatedText
            : authRoot.dataset.guestText);
    };

    const run = async (button, action) => {
        button.disabled = true;
        status.textContent = authRoot.dataset.loadingText;
        try {
            await action();
            render();
        } catch (error) {
            console.error('External authentication failed', error);
            render(error.message || authRoot.dataset.errorText);
        } finally {
            button.disabled = false;
            window.dispatchEvent(new CustomEvent('taskaura:auth-changed'));
        }
    };

    loginButton.addEventListener('click', () => run(loginButton, () => auth.login()));
    logoutButton.addEventListener('click', () => run(logoutButton, () => auth.logout()));
    window.taskAuraApi = auth.apiFetch;
    window.taskAuraAuth = auth;

    render();
    if (auth.hasCallbackParameters()) {
        run(loginButton, () => auth.handleCallback());
    }
}
